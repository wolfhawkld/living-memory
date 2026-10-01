import { strict as assert } from 'node:assert';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeApp, createApp, type LivingMemoryApp } from '../src/server/app.js';

interface ResponseData { status: number; body: string; json: <T>() => T }
interface RunningApp { app: LivingMemoryApp; server: Server; root: string; request: (path: string, options?: { method?: string; body?: unknown; headers?: Record<string, string> }) => Promise<ResponseData>; stop: () => Promise<void>; cleanup: () => void }

async function runningApp(): Promise<RunningApp> {
  const root = mkdtempSync(join(tmpdir(), 'living-memory-learning-source-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'living-memory-learning-data-'));
  writeFileSync(join(root, 'Alpha.md'), ['---', 'type: concept', 'title: Alpha', 'summary: summary', '---', '', 'body', ''].join('\n'));
  const app = createApp({ root, dataDir, port: 4317, now: () => new Date('2026-01-02T00:00:00.000Z'), staticDir: join(dataDir, 'no-dist') });
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as { port: number }).port;
  const request = (path: string, options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) => new Promise<ResponseData>((resolve, reject) => {
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: { host: '127.0.0.1:4317', ...(body ? { 'content-type': 'application/json' } : {}), ...(options.headers ?? {}) } }, (response) => {
      let text = ''; response.setEncoding('utf8'); response.on('data', (chunk) => { text += chunk; }); response.on('end', () => resolve({ status: response.statusCode ?? 0, body: text, json: <T>() => JSON.parse(text) as T }));
    });
    req.once('error', reject); if (body) req.write(body); req.end();
  });
  return { app, server, root, request, cleanup: () => { rmSync(root, { recursive: true, force: true }); rmSync(dataDir, { recursive: true, force: true }); }, stop: async () => { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); closeApp(app); } };
}

function code(response: ResponseData): string {
  return response.json<{ error?: { code?: string } }>().error?.code ?? '';
}

test('observation learning evidence is validated, normalized, idempotent, summarized, and exported', async () => {
  const client = await runningApp();
  try {
    const session = (await client.request('/api/session')).json<{ writeToken: string; sourceId: string }>();
    const headers = { 'x-lm-token': session.writeToken, 'x-lm-source-id': session.sourceId };
    const snapshot = (await client.request('/api/snapshot')).json<any>();
    const concept = snapshot.concepts[0];
    const observation = {
      eventId: 'scenario-observation',
      conceptId: concept.id,
      sourceRevision: concept.source.revision,
      observedAt: '2026-01-02T00:00:00Z',
      configRevision: snapshot.config.revision,
      anchorEventId: null,
      answer: '我先从业务约束抽象出候选模型。',
      rating: 'partial',
      exposure: 'unexposed',
      observedExposure: false,
      learning: {
        task: 'scenario',
        scenario: '  需要为多智能体编排器选择一个可解释的强校验模型。  ',
        confidence: 70,
        confidenceAt: '2026-01-01T23:59:00+00:00',
        cue: 'independent',
        outcome: 'success',
        basis: 'application',
      },
    };
    assert.equal((await client.request('/api/observations', { method: 'POST', headers, body: observation })).status, 201);
    assert.equal((await client.request('/api/observations', { method: 'POST', headers, body: observation })).status, 200);
    const exported = (await client.request('/api/export')).json<any>();
    assert.equal(exported.observations.length, 1);
    assert.deepEqual(exported.observations[0].learning, {
      task: 'scenario',
      scenario: '需要为多智能体编排器选择一个可解释的强校验模型。',
      confidence: 70,
      confidenceAt: '2026-01-01T23:59:00.000Z',
      cue: 'independent',
      outcome: 'success',
      basis: 'application',
    });
    const history = (await client.request(`/api/concepts/${encodeURIComponent(concept.id)}/history`)).json<any>();
    assert.equal(history.learning.scenario.total, 1);
    assert.equal(history.learning.scenario.independentSuccess, 1);
    assert.equal(history.learning.calibration.scenario.count, 1);
    assert.equal(history.learning.calibration.scenario.meanConfidence, 70);
  } finally {
    await client.stop();
    client.cleanup();
  }
});

test('learning evidence rejects invalid confidence, time pairing, scenario text, and ungrounded outcomes', async () => {
  const client = await runningApp();
  try {
    const session = (await client.request('/api/session')).json<{ writeToken: string; sourceId: string }>();
    const headers = { 'x-lm-token': session.writeToken, 'x-lm-source-id': session.sourceId };
    const snapshot = (await client.request('/api/snapshot')).json<any>();
    const base = {
      eventId: 'invalid-learning', conceptId: snapshot.concepts[0].id, sourceRevision: snapshot.concepts[0].source.revision,
      observedAt: '2026-01-02T00:00:00Z', configRevision: 1, anchorEventId: null,
      answer: 'answer', rating: 'clear', exposure: 'unexposed', observedExposure: false,
      learning: { task: 'concept', confidence: 101, confidenceAt: '2026-01-02T00:00:00Z', cue: 'independent', outcome: 'success', basis: 'self-check' },
    };
    let response = await client.request('/api/observations', { method: 'POST', headers, body: base });
    assert.equal(response.status, 400); assert.equal(code(response), 'INVALID_LEARNING');

    response = await client.request('/api/observations', { method: 'POST', headers, body: { ...base, eventId: 'invalid-learning-time', learning: { ...base.learning, confidence: 70, confidenceAt: '2026-01-03T00:00:00Z' } } });
    assert.equal(response.status, 400); assert.equal(code(response), 'INVALID_LEARNING');
    response = await client.request('/api/observations', { method: 'POST', headers, body: { ...base, eventId: 'invalid-learning-scenario', learning: { ...base.learning, task: 'scenario', confidence: null, confidenceAt: null } } });
    assert.equal(response.status, 400); assert.equal(code(response), 'INVALID_LEARNING');
    response = await client.request('/api/observations', { method: 'POST', headers, body: { ...base, eventId: 'invalid-learning-basis', learning: { ...base.learning, confidence: null, confidenceAt: null, outcome: 'failure', basis: 'unknown' } } });
    assert.equal(response.status, 400); assert.equal(code(response), 'INVALID_LEARNING');
    assert.equal((await client.request('/api/export')).json<any>().observations.length, 0);
  } finally {
    await client.stop();
    client.cleanup();
  }
});

test('current-version observations can remain anchorless after a source refresh, while stale anchors still conflict', async () => {
  const client = await runningApp();
  try {
    const session = (await client.request('/api/session')).json<{ writeToken: string; sourceId: string }>();
    const headers = { 'x-lm-token': session.writeToken, 'x-lm-source-id': session.sourceId };
    const initial = (await client.request('/api/snapshot')).json<any>();
    const concept = initial.concepts[0];
    const review = { eventId: 'old-source-anchor', conceptId: concept.id, sourceRevision: concept.source.revision, kind: 'review', occurredAt: '2026-01-01T00:00:00Z' };
    assert.equal((await client.request('/api/reviews', { method: 'POST', headers, body: review })).status, 201);
    writeFileSync(join(client.root, 'Alpha.md'), ['---', 'type: concept', 'title: Alpha', 'summary: refreshed', '---', '', 'body changed', ''].join('\n'));
    assert.equal((await client.request('/api/refresh', { method: 'POST', headers, body: {} })).status, 200);
    const refreshed = (await client.request('/api/snapshot')).json<any>();
    const current = refreshed.concepts.find((item: any) => item.id === concept.id);
    assert.notEqual(current.source.revision, concept.source.revision);
    const base = { conceptId: current.id, sourceRevision: current.source.revision, observedAt: '2026-01-02T00:00:00Z', configRevision: refreshed.config.revision, answer: 'current', rating: 'clear', exposure: 'unexposed', observedExposure: false };
    assert.equal((await client.request('/api/observations', { method: 'POST', headers, body: { ...base, eventId: 'current-version-no-anchor', anchorEventId: null } })).status, 201);
    const stale = await client.request('/api/observations', { method: 'POST', headers, body: { ...base, eventId: 'current-version-old-anchor', anchorEventId: review.eventId } });
    assert.equal(stale.status, 409);
    assert.equal(code(stale), 'ANCHOR_CONFLICT');
  } finally {
    await client.stop();
    client.cleanup();
  }
});
