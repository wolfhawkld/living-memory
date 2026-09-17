import { strict as assert } from 'node:assert';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeApp, createApp, type LivingMemoryApp } from '../src/server/app.js';

interface ResponseData {
  status: number;
  body: string;
  json: <T>() => T;
}

interface RunningApp {
  app: LivingMemoryApp;
  server: Server;
  request: (path: string, options?: { method?: string; body?: unknown; headers?: Record<string, string> }) => Promise<ResponseData>;
  stop: () => Promise<void>;
  root: string;
  dataDir: string;
  setNow: (value: string) => void;
}

const conceptFile = (title: string, summary: string): string => [
  '---', 'type: concept', `title: ${title}`, 'aliases: [alias]', `summary: ${summary}`, '---', '', `正文：${summary}`, '',
].join('\n');

function sourceFixture(): { root: string; dataDir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'living-memory-source-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'living-memory-data-'));
  writeFileSync(join(root, 'Boolean.md'), conceptFile('布尔逻辑', '真值判断'));
  writeFileSync(join(root, 'Decision.md'), conceptFile('决策表', '条件组合'));
  return { root, dataDir, cleanup: () => { rmSync(root, { recursive: true, force: true }); rmSync(dataDir, { recursive: true, force: true }); } };
}

async function running(options: { root?: string; dataDir?: string; port?: number; now?: string } = {}): Promise<RunningApp> {
  const fixture = options.root ? null : sourceFixture();
  const root = options.root ?? fixture!.root;
  const dataDir = options.dataDir ?? fixture?.dataDir ?? mkdtempSync(join(tmpdir(), 'living-memory-data-'));
  let currentNow = options.now ?? '2026-01-01T00:00:00.000Z';
  const app = createApp({ root, dataDir, port: options.port ?? 4317, now: () => new Date(currentNow), staticDir: join(dataDir, 'no-dist') });
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  const send = (path: string, requestOptions: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) => new Promise<ResponseData>((resolve, reject) => {
    const body = requestOptions.body === undefined ? undefined : JSON.stringify(requestOptions.body);
    const req = httpRequest({
      hostname: '127.0.0.1', port, path, method: requestOptions.method ?? 'GET',
      headers: { host: `127.0.0.1:${options.port ?? 4317}`, ...(body ? { 'content-type': 'application/json' } : {}), ...(requestOptions.headers ?? {}) },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text, json: <T>() => JSON.parse(text) as T }));
    });
    req.once('error', reject);
    if (body) req.write(body);
    req.end();
  });
  return {
    app, server, request: send, root, dataDir, setNow: (value: string) => { currentNow = value; },
    stop: async () => { await new Promise<void>((resolve) => server.close(() => resolve())); closeApp(app); fixture?.cleanup(); },
  };
}

async function session(client: RunningApp): Promise<{ writeToken: string }> {
  const response = await client.request('/api/session');
  assert.equal(response.status, 200);
  return response.json();
}

const tokenHeaders = (token: string): Record<string, string> => ({ 'x-lm-token': token });

test('reviews are idempotent, queries do not reset anchors, and asOf projects time', async () => {
  const client = await running();
  try {
    const token = await session(client);
    const initial = (await client.request('/api/snapshot')).json<any>();
    const concept = initial.concepts[0];
    assert.equal(initial.states[concept.id].status, 'unknown');
    const review = { eventId: 'review-1', conceptId: concept.id, sourceRevision: concept.source.revision, kind: 'review' };
    assert.equal((await client.request('/api/reviews', { method: 'POST', headers: tokenHeaders(token.writeToken), body: review })).status, 201);
    assert.equal((await client.request('/api/reviews', { method: 'POST', headers: tokenHeaders(token.writeToken), body: review })).status, 200);
    const conflict = await client.request('/api/reviews', { method: 'POST', headers: tokenHeaders(token.writeToken), body: { ...review, kind: 'estimated', occurredAt: '2025-12-01T00:00:00Z' } });
    assert.equal(conflict.status, 409);
    assert.equal((await client.request('/api/snapshot')).json<any>().states[concept.id].anchor.eventId, 'review-1');
    assert.equal((await client.request('/api/snapshot?asOf=2026-01-10T00:00:00Z')).json<any>().states[concept.id].status, 'revisit');
    assert.equal((await client.request('/api/snapshot?asOf=2026-02-01T00:00:00Z')).json<any>().states[concept.id].status, 'stale');
  } finally { await client.stop(); }
});

test('observation freezes config/anchor, leaves anchor unchanged, and observed exposure wins', async () => {
  const client = await running();
  try {
    const token = await session(client);
    const initial = (await client.request('/api/snapshot')).json<any>();
    const concept = initial.concepts[0];
    const review = { eventId: 'review-obs', conceptId: concept.id, sourceRevision: concept.source.revision, kind: 'review' };
    await client.request('/api/reviews', { method: 'POST', headers: tokenHeaders(token.writeToken), body: review });
    const afterReview = (await client.request('/api/snapshot')).json<any>();
    const observation = { eventId: 'observation-1', conceptId: concept.id, sourceRevision: concept.source.revision, observedAt: '2026-01-01T00:00:00.000Z', configRevision: afterReview.config.revision, anchorEventId: afterReview.states[concept.id].anchor.eventId, answer: '能解释', rating: 'clear', exposure: 'unexposed', observedExposure: true };
    assert.equal((await client.request('/api/observations', { method: 'POST', headers: tokenHeaders(token.writeToken), body: observation })).status, 201);
    assert.equal((await client.request('/api/observations', { method: 'POST', headers: tokenHeaders(token.writeToken), body: { ...observation, exposure: 'exposed' } })).status, 200);
    const exported = (await client.request('/api/export')).json<any>();
    assert.equal(exported.observations[0].exposure, 'exposed');
    assert.equal(exported.observations[0].anchorEventId, 'review-obs');
    assert.equal((await client.request('/api/observations', { method: 'POST', headers: tokenHeaders(token.writeToken), body: { ...observation, eventId: 'observation-mismatch', anchorEventId: null } })).status, 409);
    const otherConcept = afterReview.concepts.find((item: any) => item.id !== concept.id);
    assert.equal((await client.request('/api/observations', { method: 'POST', headers: tokenHeaders(token.writeToken), body: { ...observation, eventId: 'observation-cross-concept', conceptId: otherConcept.id, sourceRevision: otherConcept.source.revision } })).status, 409);
    assert.equal((await client.request('/api/observations', { method: 'POST', headers: tokenHeaders(token.writeToken), body: { ...observation, eventId: 'observation-future', observedAt: '2026-01-02T00:00:00Z' } })).status, 400);
  } finally { await client.stop(); }
});

test('a review with a client-frozen occurredAt keeps its learning time across delayed retry', async () => {
  const client = await running({ now: '2026-01-03T00:00:00.000Z' });
  try {
    const token = await session(client);
    const snapshot = (await client.request('/api/snapshot')).json<any>();
    const concept = snapshot.concepts[0];
    const review = { eventId: 'delayed-review', conceptId: concept.id, sourceRevision: concept.source.revision, kind: 'review', occurredAt: '2026-01-01T00:00:00Z' };
    assert.equal((await client.request('/api/reviews', { method: 'POST', headers: tokenHeaders(token.writeToken), body: review })).status, 201);
    client.setNow('2026-01-10T00:00:00.000Z');
    assert.equal((await client.request('/api/reviews', { method: 'POST', headers: tokenHeaders(token.writeToken), body: review })).status, 200);
    const after = (await client.request('/api/snapshot')).json<any>();
    assert.equal(after.states[concept.id].anchor.occurredAt, '2026-01-01T00:00:00.000Z');
    assert.equal(after.states[concept.id].status, 'revisit');
  } finally { await client.stop(); }
});

test('a valid future projection keeps a future anchor pending until its occurrence time', async () => {
  const client = await running({ now: '2026-01-10T00:00:00.000Z' });
  try {
    const token = await session(client);
    const snapshot = (await client.request('/api/snapshot')).json<any>();
    const concept = snapshot.concepts[0];
    const review = { eventId: 'future-projection', conceptId: concept.id, sourceRevision: concept.source.revision, kind: 'review', occurredAt: '2026-01-10T00:00:00Z' };
    assert.equal((await client.request('/api/reviews', { method: 'POST', headers: tokenHeaders(token.writeToken), body: review })).status, 201);
    const before = (await client.request('/api/snapshot?asOf=2026-01-05T00:00:00Z')).json<any>();
    assert.equal(before.states[concept.id].status, 'pending');
    assert.equal(before.states[concept.id].anchor.eventId, 'future-projection');
  } finally { await client.stop(); }
});

test('configuration validates half-life and optimistic revision', async () => {
  const client = await running();
  try {
    const token = await session(client);
    assert.equal((await client.request('/api/config', { method: 'PUT', headers: tokenHeaders(token.writeToken), body: { halfLifeDays: 0, revision: 1 } })).status, 400);
    const changed = await client.request('/api/config', { method: 'PUT', headers: tokenHeaders(token.writeToken), body: { halfLifeDays: 14, revision: 1 } });
    assert.equal(changed.status, 200);
    assert.equal(changed.json<any>().revision, 2);
    assert.equal((await client.request('/api/config', { method: 'PUT', headers: tokenHeaders(token.writeToken), body: { halfLifeDays: 21, revision: 1 } })).status, 409);
    assert.equal((await client.request('/api/config', { method: 'PUT', body: { halfLifeDays: 21, revision: 2 } })).status, 401);
  } finally { await client.stop(); }
});

test('layout and learning history survive restart, and another source root is isolated', async () => {
  const fixture = sourceFixture();
  const first = await running({ root: fixture.root, dataDir: fixture.dataDir });
  const root = fixture.root;
  const dataDir = fixture.dataDir;
  let concept: any;
  try {
    const token = await session(first);
    const snapshot = (await first.request('/api/snapshot')).json<any>();
    concept = snapshot.concepts[0];
    await first.request('/api/reviews', { method: 'POST', headers: tokenHeaders(token.writeToken), body: { eventId: 'persistent-review', conceptId: concept.id, sourceRevision: concept.source.revision, kind: 'review' } });
    assert.equal((await first.request('/api/layout', { method: 'PUT', headers: tokenHeaders(token.writeToken), body: { [concept.id]: { x: 1, y: 2, z: 3 } } })).status, 200);
  } finally { await first.stop(); }
  const restarted = await running({ root, dataDir });
  try {
    const restored = (await restarted.request('/api/snapshot')).json<any>();
    assert.equal(restored.states[concept.id].status, 'recent');
    assert.deepEqual((await restarted.request('/api/layout')).json(), { [concept.id]: { x: 1, y: 2, z: 3 } });
  } finally { await restarted.stop(); }
  const otherRoot = mkdtempSync(join(tmpdir(), 'living-memory-other-source-'));
  try {
    writeFileSync(join(otherRoot, 'Other.md'), conceptFile('其他概念', '独立来源'));
    const other = await running({ root: otherRoot, dataDir });
    try {
      const otherSnapshot = (await other.request('/api/snapshot')).json<any>();
      assert.equal(otherSnapshot.states[otherSnapshot.concepts[0].id].status, 'unknown');
    } finally { await other.stop(); }
  } finally {
    rmSync(otherRoot, { recursive: true, force: true });
    fixture.cleanup();
  }
});

test('host, origin and write token protections reject unauthorized requests', async () => {
  const client = await running();
  try {
    assert.equal((await client.request('/api/session', { headers: { host: 'example.test:4317' } })).status, 403);
    assert.equal((await client.request('/api/session', { headers: { origin: 'http://example.test:5173' } })).status, 403);
    assert.equal((await client.request('/api/session', { headers: { origin: 'http://127.0.0.1:5173' } })).status, 200);
    assert.equal((await client.request('/api/refresh', { method: 'POST', body: {} })).status, 401);
  } finally { await client.stop(); }
});

test('refresh preserves old anchor and marks changed source content pending', async () => {
  const client = await running();
  try {
    const token = await session(client);
    const before = (await client.request('/api/snapshot')).json<any>();
    const concept = before.concepts[0];
    await client.request('/api/reviews', { method: 'POST', headers: tokenHeaders(token.writeToken), body: { eventId: 'source-change-review', conceptId: concept.id, sourceRevision: concept.source.revision, kind: 'review' } });
    writeFileSync(join(client.root, 'Boolean.md'), conceptFile('布尔逻辑', '内容已实质修改'));
    assert.equal((await client.request('/api/refresh', { method: 'POST', headers: tokenHeaders(token.writeToken), body: {} })).status, 200);
    const after = (await client.request('/api/snapshot')).json<any>();
    const nextConcept = after.concepts.find((item: any) => item.title === '布尔逻辑');
    assert.equal(after.states[nextConcept.id].status, 'pending');
  } finally { await client.stop(); }
});
