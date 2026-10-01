import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApp, closeApp } from '../src/server/app.js';
import { api, flushPendingWrites, getPendingWrites, queuePendingWrite } from '../src/web/api.ts';
import { MemoryLockManager } from './helpers/memory-lock-manager.ts';

class BrowserStorage implements Storage {
  private values = new Map<string, string>();
  failSet = false;
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) {
    if (this.failSet) throw new Error('browser storage unavailable');
    this.values.set(key, value);
  }
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lm-config-retry-source-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'lm-config-retry-data-'));
  writeFileSync(join(root, 'Concept.md'), '---\ntype: concept\ntitle: Test\n---\nTest content');
  const server = createServer((req, res) => app(req, res));
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as { port: number }).port;
  const options = { root, dataDir, port, accountsEnabled: false, staticDir: join(dataDir, 'no-dist') };
  let app = createApp(options);
  const storage = new BrowserStorage();
  const host = new EventTarget();
  Object.defineProperties(host, { localStorage: { value: storage }, navigator: { value: { locks: new MemoryLockManager() } } });
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const oldFetch = globalThis.fetch;
  Object.defineProperty(globalThis, 'window', { value: host, configurable: true });
  const control = { blockCleanup: false, loseResponse: false };
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), `http://127.0.0.1:${port}`);
    const response = await oldFetch(url, init);
    if (url.pathname === '/api/config' && response.ok) {
      if (control.blockCleanup) storage.failSet = true;
      if (control.loseResponse) {
        control.loseResponse = false;
        await response.arrayBuffer();
        throw new TypeError('response lost after server commit');
      }
    }
    return response;
  };
  return {
    storage, control,
    get store() { return app.livingMemory.store; },
    restart() { closeApp(app); app = createApp(options); },
    async stop() {
      globalThis.fetch = oldFetch;
      if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow);
      else Reflect.deleteProperty(globalThis, 'window');
      const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      server.closeAllConnections(); await closed; closeApp(app);
      rmSync(root, { recursive: true, force: true }); rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function queueConfig(sourceId: string, halfLifeDays = 14, revision = 1) {
  const write = await queuePendingWrite(sourceId, { id: 'legacy-config', path: '/config', method: 'PUT',
    payload: { halfLifeDays, revision }, eventId: null, conceptId: null, label: '更新半衰时间' });
  assert.ok(write);
  return write;
}

test('an old queued config survives cleanup failure and restart, then clears without reverting later settings', async () => {
  const client = await fixture();
  try {
    const session = await api.getSession();
    const write = await queueConfig(session.sourceId);
    client.control.blockCleanup = true;
    const first = await flushPendingWrites(session.writeToken, session.sourceId);
    assert.equal(first.sent, 0);
    assert.equal(first.failures[0].code, 'PENDING_STORAGE_FAILED');
    assert.equal(client.store.getConfigHistory().length, 2);
    assert.deepEqual(getPendingWrites(session.sourceId), [write]);

    client.control.blockCleanup = false;
    client.storage.failSet = false;
    const later = await api.putConfig({ halfLifeDays: 21, revision: 2 }, session.writeToken, session.sourceId);
    assert.equal(later.status, 'accepted');
    const before = client.store.exportData({ name: 'test', mode: 'local', conceptCount: 0, limit: 10, diagnostics: [] }, []);
    client.restart();
    // Reuses the old token, exercising session renewal and the original payload.
    const retry = await flushPendingWrites(session.writeToken, session.sourceId);
    assert.deepEqual(retry, { sent: 1, failed: 0, failures: [], duplicateConfigs: 1 });
    assert.deepEqual(getPendingWrites(session.sourceId), []);
    assert.deepEqual(client.store.getConfig(), later.currentConfig);
    const after = client.store.exportData(before.source, []);
    assert.deepEqual(after.configHistory, before.configHistory);
    assert.deepEqual(after.restoreMetadata?.configRecordedAt, before.restoreMetadata?.configRecordedAt);
    const receipt = await api.putConfig({ halfLifeDays: 14, revision: 1 }, session.writeToken, session.sourceId);
    assert.equal(receipt.status, 'duplicate');
    assert.equal(receipt.revision, 2);
    assert.equal(receipt.halfLifeDays, 14);
    assert.deepEqual(receipt.currentConfig, later.currentConfig);
  } finally { await client.stop(); }
});

test('a lost successful config response can be retried with the same old-format request', async () => {
  const client = await fixture();
  try {
    const session = await api.getSession();
    const original = await queueConfig(session.sourceId);
    client.control.loseResponse = true;
    const first = await flushPendingWrites(session.writeToken, session.sourceId);
    assert.equal(first.failures[0].code, 'NETWORK_OFFLINE');
    assert.equal(client.store.getConfig().revision, 2);
    assert.equal(getPendingWrites(session.sourceId)[0].createdAt, original.createdAt);
    assert.deepEqual(getPendingWrites(session.sourceId)[0].payload, original.payload);
    const retry = await flushPendingWrites(session.writeToken, session.sourceId);
    assert.equal(retry.duplicateConfigs, 1);
    assert.equal(retry.sent, 1);
    assert.equal(client.store.getConfigHistory().length, 2);
  } finally { await client.stop(); }
});

test('matching the current H is insufficient when the requested transition conflicts with history', async () => {
  const client = await fixture();
  try {
    const session = await api.getSession();
    await api.putConfig({ halfLifeDays: 14, revision: 1 }, session.writeToken, session.sourceId);
    await api.putConfig({ halfLifeDays: 21, revision: 2 }, session.writeToken, session.sourceId);
    const original = await queueConfig(session.sourceId, 21, 1);
    const result = await flushPendingWrites(session.writeToken, session.sourceId);
    assert.equal(result.sent, 0);
    assert.equal(result.failures[0].code, 'CONFIG_CONFLICT');
    assert.equal(result.duplicateConfigs, undefined);
    const retained = getPendingWrites(session.sourceId)[0];
    assert.deepEqual(retained.payload, original.payload);
    assert.equal(retained.createdAt, original.createdAt);
    assert.equal(client.store.getConfigHistory().length, 3);
    await assert.rejects(api.putConfig({ halfLifeDays: 14, revision: 1 }, session.writeToken, 'other-space'), { code: 'SOURCE_MISMATCH' });
    const unauthorized = await fetch('/api/config', { method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-lm-token': 'wrong-token', 'x-lm-source-id': session.sourceId },
      body: JSON.stringify({ halfLifeDays: 14, revision: 1 }) });
    assert.equal(unauthorized.status, 401);
  } finally { await client.stop(); }
});
