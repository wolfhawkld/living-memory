import { strict as assert } from 'node:assert';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
}

function conceptFile(title: string, summary: string, relation?: string): string {
  return [
    '---',
    'type: concept',
    `title: ${title}`,
    `summary: ${summary}`,
    '---',
    '',
    summary,
    relation ? ['', '## 关系网络', relation].join('\n') : '',
    '',
  ].join('\n');
}

function sourceFixture(): { root: string; dataDir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'living-memory-domain-source-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'living-memory-domain-data-'));
  mkdirSync(join(root, 'Cognition', 'Math'), { recursive: true });
  mkdirSync(join(root, 'Cognition', 'Model'), { recursive: true });
  writeFileSync(join(root, 'Cognition', 'Math', 'Boolean.md'), conceptFile('布尔逻辑', '真值判断', '- 相关：[[Cognition/Model/Classifier.md]] — 模型校验'));
  writeFileSync(join(root, 'Cognition', 'Math', 'Decision.md'), conceptFile('决策表', '条件组合'));
  writeFileSync(join(root, 'Cognition', 'Model', 'Classifier.md'), conceptFile('分类器', '模型分类', '- 应用：[[Cognition/Math/Decision.md]] — 规则映射'));
  writeFileSync(join(root, 'Loose.md'), conceptFile('根概念', '根目录概念'));
  return {
    root,
    dataDir,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function running(): Promise<RunningApp> {
  const fixture = sourceFixture();
  const app = createApp({
    root: fixture.root,
    dataDir: fixture.dataDir,
    includePrefix: 'Cognition/Math',
    limit: 1,
    port: 4317,
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    staticDir: join(fixture.dataDir, 'no-dist'),
  });
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  const request = (path: string, options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) => new Promise<ResponseData>((resolve, reject) => {
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path,
      method: options.method ?? 'GET',
      headers: {
        host: '127.0.0.1:4317',
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(options.headers ?? {}),
      },
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
    app,
    server,
    request,
    root: fixture.root,
    dataDir: fixture.dataDir,
    stop: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      closeApp(app);
      fixture.cleanup();
    },
  };
}

const tokenHeaders = (token: string): Record<string, string> => ({ 'x-lm-token': token });

test('scope=all exposes the complete index and allows writes for hidden domains', async () => {
  const client = await running();
  try {
    const session = (await client.request('/api/session')).json<{ writeToken: string; sourceId: string }>();
    const scoped = (await client.request('/api/snapshot')).json<any>();
    assert.equal(scoped.concepts.length, 1);
    assert.equal(scoped.source.conceptCount, 2);
    const complete = await client.request('/api/snapshot?scope=all');
    assert.equal(complete.status, 200);
    const all = complete.json<any>();
    assert.equal(all.concepts.length, 4);
    assert.equal(all.source.conceptCount, 4);
    assert.equal(all.source.initialDomainId, 'Cognition/Math');
    const model = all.concepts.find((concept: any) => concept.title === '分类器');
    assert.ok(model);
    assert.equal(all.states[model.id].status, 'unknown');

    const review = {
      eventId: 'domain-review-model',
      conceptId: model.id,
      sourceRevision: model.source.revision,
      kind: 'review',
    };
    assert.equal((await client.request('/api/reviews', { method: 'POST', headers: { ...tokenHeaders(session.writeToken), 'x-lm-source-id': session.sourceId }, body: review })).status, 201);
    const after = (await client.request('/api/snapshot?scope=all')).json<any>();
    assert.equal(after.states[model.id].status, 'recent');
    const legacy = (await client.request('/api/snapshot')).json<any>();
    assert.equal(legacy.states[model.id], undefined);
  } finally {
    await client.stop();
  }
});

test('invalid snapshot scopes are rejected and repeated reads remain read-only', async () => {
  const client = await running();
  try {
    assert.equal((await client.request('/api/snapshot?scope=math')).status, 400);
    assert.equal((await client.request('/api/snapshot?scope=all&scope=all')).status, 400);
    const before = (await client.request('/api/export')).json<any>();
    const first = (await client.request('/api/snapshot?scope=all')).json<any>();
    const second = (await client.request('/api/snapshot?scope=all')).json<any>();
    assert.deepEqual(second.states, first.states);
    const after = (await client.request('/api/export')).json<any>();
    assert.deepEqual(after.anchors, before.anchors);
    assert.deepEqual(after.observations, before.observations);
  } finally {
    await client.stop();
  }
});

test('health, refresh and export report complete source metadata', async () => {
  const client = await running();
  try {
    const health = (await client.request('/api/health')).json<any>();
    assert.equal(health.source.conceptCount, 4);
    const refresh = await client.request('/api/refresh', { method: 'POST' });
    assert.equal(refresh.status, 401);
    const session = (await client.request('/api/session')).json<{ writeToken: string; sourceId: string }>();
    const refreshed = await client.request('/api/refresh', { method: 'POST', headers: { ...tokenHeaders(session.writeToken), 'x-lm-source-id': session.sourceId }, body: {} });
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.json<any>().source.conceptCount, 4);
    const before = (await client.request('/api/export')).json<any>();
    writeFileSync(join(client.root, 'Cognition', 'Model', 'Refreshed.md'), conceptFile('刷新后概念', '刷新后加入的概念'));
    const updated = await client.request('/api/refresh', { method: 'POST', headers: { ...tokenHeaders(session.writeToken), 'x-lm-source-id': session.sourceId }, body: {} });
    assert.equal(updated.status, 200);
    assert.equal(updated.json<any>().source.conceptCount, 5);
    const all = (await client.request('/api/snapshot?scope=all')).json<any>();
    assert.equal(all.concepts.some((concept: any) => concept.title === '刷新后概念'), true);
    const after = (await client.request('/api/export')).json<any>();
    assert.deepEqual(after.anchors, before.anchors);
    assert.deepEqual(after.observations, before.observations);
    const exported = (await client.request('/api/export')).json<any>();
    assert.equal(exported.source.conceptCount, 5);
    assert.equal(exported.concepts.length, 5);
  } finally {
    await client.stop();
  }
});

test('partial layout writes preserve positions from other domains', async () => {
  const client = await running();
  try {
    const session = (await client.request('/api/session')).json<{ writeToken: string; sourceId: string }>();
    const all = (await client.request('/api/snapshot?scope=all')).json<any>();
    const math = all.concepts.find((concept: any) => concept.title === '布尔逻辑');
    const model = all.concepts.find((concept: any) => concept.title === '分类器');
    const headers = { ...tokenHeaders(session.writeToken), 'x-lm-source-id': session.sourceId };
    assert.equal((await client.request('/api/layout', { method: 'PUT', headers, body: { [math.id]: { x: 1, y: 2, z: 3 } } })).status, 200);
    assert.equal((await client.request('/api/layout', { method: 'PUT', headers, body: { [model.id]: { x: 4, y: 5, z: 6 } } })).status, 200);
    assert.deepEqual((await client.request('/api/layout')).json(), {
      [math.id]: { x: 1, y: 2, z: 3 },
      [model.id]: { x: 4, y: 5, z: 6 },
    });
  } finally {
    await client.stop();
  }
});
