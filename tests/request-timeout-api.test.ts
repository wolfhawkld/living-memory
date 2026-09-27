import assert from 'node:assert/strict';
import { beforeEach, afterEach, test } from 'node:test';
import * as first from '../src/web/api.ts';
import { REQUEST_TIMEOUT_MS, BULK_REQUEST_TIMEOUT_MS } from '../src/web/request-deadline';
import { MemoryLockManager } from './helpers/memory-lock-manager';

const other: typeof first = await import(new URL('../src/web/api.ts?timeout-tab=other', import.meta.url).href);
const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
class StorageStub implements Storage {
  private items = new Map<string, string>();
  get length() { return this.items.size; }
  clear() { this.items.clear(); }
  getItem(key: string) { return this.items.get(key) ?? null; }
  key(index: number) { return [...this.items.keys()][index] ?? null; }
  removeItem(key: string) { this.items.delete(key); }
  setItem(key: string, value: string) { this.items.set(key, value); }
}
let host: EventTarget;
beforeEach(() => {
  host = new EventTarget();
  Object.defineProperties(host, { localStorage: { value: new StorageStub() }, navigator: { value: { locks: new MemoryLockManager() } } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: host });
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function settle() { for (let step = 0; step < 20; step++) await Promise.resolve(); }

test('write deadlines abort stalled fetches and report an unknown save result', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let transport: AbortSignal | null | undefined;
  globalThis.fetch = async (_input, init) => { transport = init?.signal; return new Promise<Response>(() => {}); };
  const pending = first.api.putConfig({ halfLifeDays: 14, revision: 1 }, 'token', 'space');
  const rejected = assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof first.ApiRequestError);
    assert.equal(error.code, 'REQUEST_TIMEOUT');
    assert.equal(error.retryable, true);
    assert.match(error.message, /保存结果尚未确认/);
    return true;
  });
  t.mock.timers.tick(REQUEST_TIMEOUT_MS);
  await rejected;
  assert.equal(transport?.aborted, true);
});

test('deadlines include JSON/error bodies and late auth errors cannot log the user out', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let authChanges = 0;
  host.addEventListener('lm-auth-required', () => authChanges++);
  for (const status of [200, 401]) {
    const body = deferred<unknown>();
    globalThis.fetch = async () => ({ ok: status === 200, status, json: () => body.promise }) as Response;
    const pending = first.api.getSnapshot(undefined, 'space');
    const rejected = assert.rejects(pending, { code: 'REQUEST_TIMEOUT', retryable: true });
    await settle();
    t.mock.timers.tick(REQUEST_TIMEOUT_MS);
    await rejected;
    body.resolve({ error: { code: 'AUTH_REQUIRED', message: 'late result' } });
    await settle();
    assert.equal(authChanges, 0);
  }
});

test('caller cancellation is preserved and internal timeouts do not abort the caller signal', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const cancelled = new AbortController();
  cancelled.abort();
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Promise<Response>(() => {}); };
  await assert.rejects(first.api.getLearningOverview('space', cancelled.signal), { name: 'AbortError' });
  assert.equal(calls, 0);
  const controller = new AbortController();
  const pending = first.api.getLearningOverview('space', controller.signal);
  const rejected = assert.rejects(pending, { code: 'REQUEST_TIMEOUT' });
  t.mock.timers.tick(REQUEST_TIMEOUT_MS);
  await rejected;
  assert.equal(controller.signal.aborted, false, 'loaders must be able to display a timeout error');
  const current = new AbortController();
  const aborting = first.api.getLearningOverview('space', current.signal);
  const aborted = assert.rejects(aborting, { name: 'AbortError' });
  current.abort();
  await aborted;

  // A caller cancellation immediately after the deadline must not relabel the
  // timeout that has already won, even before its catch microtask runs.
  const racing = new AbortController();
  const raced = first.api.getLearningOverview('space', racing.signal);
  const timedOutFirst = assert.rejects(raced, { code: 'REQUEST_TIMEOUT' });
  t.mock.timers.tick(REQUEST_TIMEOUT_MS);
  racing.abort();
  await timedOutFirst;
});

test('bulk import and export bodies use a longer but finite deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  globalThis.fetch = async () => ({ ok: true, status: 200, blob: () => new Promise<Blob>(() => {}) }) as Response;
  const exported = first.api.exportData('token', 'space');
  let completed = false;
  void exported.then(() => { completed = true; }, () => { completed = true; });
  const rejected = assert.rejects(exported, { code: 'REQUEST_TIMEOUT' });
  await settle();
  t.mock.timers.tick(REQUEST_TIMEOUT_MS);
  await settle();
  assert.equal(completed, false);
  t.mock.timers.tick(BULK_REQUEST_TIMEOUT_MS - REQUEST_TIMEOUT_MS);
  await rejected;

  globalThis.fetch = async () => new Promise<Response>(() => {});
  const imported = first.api.previewImport({ data: {}, options: { restoreLayout: false, restoreReviewPlan: false } }, 'token', 'space');
  const importRejected = assert.rejects(imported, (error: unknown) => {
    assert.ok(error instanceof first.ApiRequestError);
    assert.equal(error.code, 'REQUEST_TIMEOUT');
    assert.doesNotMatch(error.message, /保存结果/, 'a preview has not attempted to save learning data');
    return true;
  });
  t.mock.timers.tick(BULK_REQUEST_TIMEOUT_MS);
  await importRejected;
});

test('a stalled session renewal times out without replaying a late response', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sessionStarted = deferred<void>();
  const lateSession = deferred<Response>();
  let writes = 0;
  let recovered = 0;
  const unsubscribe = first.subscribeToSessionRecovery(() => recovered++);
  try {
    globalThis.fetch = async input => {
      if (String(input).endsWith('/session')) { sessionStarted.resolve(); return lateSession.promise; }
      writes++;
      return json({ error: { code: 'TOKEN_REQUIRED', message: 'expired' } }, 401);
    };
    const pending = first.api.putConfig({ revision: 1, halfLifeDays: 14 }, 'expired-token', 'renewal-space');
    const rejected = assert.rejects(pending, { code: 'REQUEST_TIMEOUT' });
    await sessionStarted.promise;
    t.mock.timers.tick(REQUEST_TIMEOUT_MS);
    await rejected;
    lateSession.resolve(json({ writeToken: 'new-token', sourceId: 'renewal-space' }));
    await settle();
    assert.equal(writes, 1);
    assert.equal(recovered, 0);
  } finally { unsubscribe(); }
});

test('a timeout stops the batch, preserves original requests and releases the sender lock for another page', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sourceId = 'timeout-space';
  const original: first.PendingWrite[] = [];
  for (const id of ['first', 'later']) {
    const write = await first.queuePendingWrite(sourceId, {
      id, path: '/reviews', method: 'POST', payload: { eventId: id, occurredAt: '2026-09-01T00:00:00Z' },
      eventId: id, conceptId: id, label: '重温记录',
    });
    assert.ok(write);
    original.push(write);
  }
  const started = deferred<void>();
  const late = deferred<Response>();
  let sent = 0;
  globalThis.fetch = async () => { sent++; started.resolve(); return late.promise; };
  const pending = first.flushPendingWrites('token', sourceId);
  await started.promise;
  assert.equal((await other.flushPendingWrites('token', sourceId)).busy, true);
  t.mock.timers.tick(REQUEST_TIMEOUT_MS);
  const result = await pending;
  assert.equal(result.sent, 0);
  assert.equal(result.failed, 1);
  assert.equal(result.failures[0].code, 'REQUEST_TIMEOUT');
  assert.equal(sent, 1, 'remaining entries must not each consume another timeout');
  const writes = first.getPendingWrites(sourceId);
  assert.deepEqual(writes.map(({ lastError: _error, ...write }) => write), original);
  assert.equal(writes[1].lastError, undefined);
  // A late success from the timed-out request must not remove the old queue.
  late.resolve(json({ status: 'accepted', eventId: 'first' }));
  await settle();
  assert.equal(first.getPendingWrites(sourceId).length, 2);
  globalThis.fetch = async (_input, init) => {
    const payload = JSON.parse(String(init?.body));
    const eventId = payload.eventId;
    assert.deepEqual(payload, original.find(write => write.id === eventId)?.payload);
    return json({ status: 'duplicate', eventId });
  };
  assert.equal((await other.flushPendingWrites('token', sourceId)).sent, 2);
  assert.equal(first.getPendingWrites(sourceId).length, 0);
});
