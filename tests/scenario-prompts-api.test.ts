import { strict as assert } from 'node:assert';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeApp, createApp, type LivingMemoryApp } from '../src/server/app.js';
import type { ScenarioPromptsResponse } from '../src/shared/scenario-prompts.js';

interface ResponseData {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
  json: <T>() => T;
}

interface RunningApp {
  root: string;
  dataDir: string;
  request: (path: string, options?: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> }) => Promise<ResponseData>;
  stop: () => Promise<void>;
}

function conceptFile(title: string, summary: string): string {
  return ['---', 'type: concept', `title: ${title}`, `summary: ${summary}`, '---', '', summary, ''].join('\n');
}

async function running(options: { accountsEnabled?: boolean } = {}): Promise<RunningApp> {
  const root = mkdtempSync(join(tmpdir(), 'living-memory-scenario-prompts-source-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'living-memory-scenario-prompts-data-'));
  writeFileSync(join(root, 'Math.md'), conceptFile('Math', 'math source'));
  writeFileSync(join(root, 'Other.md'), conceptFile('Other', 'other source'));
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as { port: number }).port;
  const app = createApp({
    root, dataDir, includePrefix: 'Math.md', limit: 1, port, accountsEnabled: options.accountsEnabled,
    now: () => new Date('2026-01-10T00:00:00.000Z'),
    staticDir: join(dataDir, 'no-dist'),
  });
  server.on('request', app);
  const request = (path: string, options: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) => new Promise<ResponseData>((resolve, reject) => {
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = httpRequest({
      hostname: '127.0.0.1', port, path, method: options.method ?? 'GET',
      headers: { host: `127.0.0.1:${port}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(options.cookie ? { cookie: options.cookie } : {}), ...(options.headers ?? {}) },
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: text, json: <T>() => JSON.parse(text) as T }));
    });
    req.once('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
  return {
    root, dataDir, request,
    stop: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      closeApp(app);
      rmSync(root, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

function errorCode(response: ResponseData): string {
  return response.json<{ error?: { code?: string } }>().error?.code ?? '';
}

test('scenario prompts expose only saved scenario text, include old revisions, and paginate the complete source index', async () => {
  const client = await running();
  try {
    const session = (await client.request('/api/session')).json<{ writeToken: string; sourceId: string }>();
    const headers = { 'x-lm-token': session.writeToken, 'x-lm-source-id': session.sourceId };
    let all = (await client.request('/api/snapshot?scope=all')).json<any>();
    let math = all.concepts.find((concept: any) => concept.title === 'Math');
    const other = all.concepts.find((concept: any) => concept.title === 'Other');
    assert.ok(math);
    assert.ok(other);
    const makeObservation = (eventId: string, concept: any, observedAt: string, scenarioRevisit = false) => ({
      eventId, conceptId: concept.id, sourceRevision: concept.source.revision, observedAt,
      configRevision: all.config.revision, anchorEventId: null, answer: 'PRIVATE ANSWER', rating: 'blank',
      exposure: 'unexposed', observedExposure: false,
      learning: {
        task: 'scenario', scenario: `PRIVATE SCENARIO ${eventId}`,
        ...(scenarioRevisit ? { scenarioRevisit: true } : {}),
        confidence: null, confidenceAt: null, cue: 'unknown', outcome: 'unverified', basis: 'unknown',
      },
    });
    const old = makeObservation('old-revision', math, '2026-01-01T00:00:00Z', true);
    assert.equal((await client.request('/api/observations', { method: 'POST', headers, body: old })).status, 201);
    writeFileSync(join(client.root, 'Math.md'), conceptFile('Math', 'math source changed'));
    assert.equal((await client.request('/api/refresh', { method: 'POST', headers, body: {} })).status, 200);
    all = (await client.request('/api/snapshot?scope=all')).json<any>();
    math = all.concepts.find((concept: any) => concept.title === 'Math');
    assert.notEqual(math.source.revision, old.sourceRevision);
    for (const eventId of ['tie-a', 'tie-m', 'tie-z']) {
      assert.equal((await client.request('/api/observations', {
        method: 'POST', headers,
        body: makeObservation(eventId, math, '2026-01-02T00:00:00Z'),
      })).status, 201, eventId);
    }
    assert.equal((await client.request('/api/observations', {
      method: 'POST', headers,
      body: makeObservation('other-domain', other, '2026-01-03T00:00:00Z'),
    })).status, 201);
    const conceptOnly = {
      ...makeObservation('concept-only', math, '2026-01-04T00:00:00Z'),
      learning: { task: 'concept', confidence: null, confidenceAt: null, cue: 'unknown', outcome: 'unverified', basis: 'unknown' },
    };
    assert.equal((await client.request('/api/observations', { method: 'POST', headers, body: conceptOnly })).status, 201);

    const before = (await client.request('/api/export')).json<any>();
    const firstResponse = await client.request('/api/scenario-prompts?limit=2', { headers: { 'x-lm-source-id': session.sourceId } });
    const afterRead = (await client.request('/api/export')).json<any>();
    const withoutExportedAt = ({ exportedAt: _exportedAt, ...rest }: any) => rest;
    assert.deepEqual(withoutExportedAt(afterRead), withoutExportedAt(before));
    assert.equal(firstResponse.status, 200);
    assert.equal(firstResponse.headers['cache-control'], 'no-store');
    const first = firstResponse.json<ScenarioPromptsResponse>();
    assert.equal(first.sourceId, session.sourceId);
    assert.equal(first.asOf, '2026-01-10T00:00:00.000Z');
    assert.equal(first.total, 5);
    assert.deepEqual(first.items.map((item) => item.eventId), ['other-domain', 'tie-z']);
    assert.deepEqual(Object.keys(first.items[0]).sort(), ['eventId', 'observedAt', 'scenario']);
    assert.match(first.items[0].scenario, /^PRIVATE SCENARIO/);
    assert.equal(firstResponse.body.includes('PRIVATE ANSWER'), false);
    assert.equal(firstResponse.body.includes('sourceRevision'), false);
    assert.ok(first.nextCursor);

    // A newly inserted newer item does not shift a keyset continuation page.
    assert.equal((await client.request('/api/observations', {
      method: 'POST', headers,
      body: makeObservation('newer', math, '2026-01-08T00:00:00Z'),
    })).status, 201);
    const second = (await client.request(`/api/scenario-prompts?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`, {
      headers: { 'x-lm-source-id': session.sourceId },
    })).json<ScenarioPromptsResponse>();
    assert.deepEqual(second.items.map((item) => item.eventId), ['tie-m', 'tie-a']);
    assert.equal(second.total, 6);
    assert.ok(second.nextCursor);
    const third = (await client.request(`/api/scenario-prompts?limit=2&cursor=${encodeURIComponent(second.nextCursor!)}`, {
      headers: { 'x-lm-source-id': session.sourceId },
    })).json<ScenarioPromptsResponse>();
    assert.deepEqual(third.items.map((item) => item.eventId), ['old-revision']);
    assert.equal(third.nextCursor, null);

    const after = (await client.request('/api/export')).json<any>();
    assert.equal(after.observations.length, before.observations.length + 1);
    assert.equal(after.observations.find((event: any) => event.eventId === 'old-revision').learning.scenarioRevisit, true);
  } finally {
    await client.stop();
  }
});

test('scenario prompt pagination validates bounds, cursors, and source isolation', async () => {
  const client = await running();
  try {
    const session = (await client.request('/api/session')).json<{ sourceId: string }>();
    const headers = { 'x-lm-source-id': session.sourceId };
    for (const query of ['?limit=0', '?limit=51', '?limit=1.5', '?limit=abc', '?limit=']) {
      const response = await client.request(`/api/scenario-prompts${query}`, { headers });
      assert.equal(response.status, 400, query);
      assert.equal(errorCode(response), 'INVALID_SCENARIO_PROMPTS_LIMIT', query);
    }
    for (const query of ['?cursor=', '?cursor=bad', '?cursor=%%%']) {
      const response = await client.request(`/api/scenario-prompts${query}`, { headers });
      assert.equal(response.status, 400, query);
      assert.equal(errorCode(response), 'INVALID_SCENARIO_PROMPTS_CURSOR', query);
    }
    const mismatch = await client.request('/api/scenario-prompts', { headers: { 'x-lm-source-id': 'kg_wrong-source' } });
    assert.equal(mismatch.status, 409);
    assert.equal(errorCode(mismatch), 'SOURCE_MISMATCH');
  } finally {
    await client.stop();
  }
});

test('scenario prompts require an account and isolate owner history and cursors from a member space', async () => {
  const client = await running({ accountsEnabled: true });
  try {
    assert.equal((await client.request('/api/scenario-prompts')).status, 401);
    const setup = await client.request('/api/auth/setup', { method: 'POST', body: { username: 'owner', password: 'owner-password-2026' } });
    assert.equal(setup.status, 201, setup.body);
    const ownerCookie = setup.headers['set-cookie']?.[0]?.split(';')[0];
    assert.ok(ownerCookie);
    const ownerSession = (await client.request('/api/session', { cookie: ownerCookie })).json<{ writeToken: string; sourceId: string }>();
    const ownerHeaders = { 'x-lm-token': ownerSession.writeToken, 'x-lm-source-id': ownerSession.sourceId };
    const snapshot = (await client.request('/api/snapshot?scope=all', { cookie: ownerCookie })).json<any>();
    const concept = snapshot.concepts[0];
    assert.equal((await client.request('/api/observations', {
      method: 'POST', cookie: ownerCookie, headers: ownerHeaders,
      body: {
        eventId: 'owner-scenario', conceptId: concept.id, sourceRevision: concept.source.revision,
        observedAt: '2026-01-01T00:00:00.000Z', configRevision: snapshot.config.revision, anchorEventId: null,
        answer: 'OWNER PRIVATE ANSWER', rating: 'blank', exposure: 'unexposed', observedExposure: false,
        learning: { task: 'scenario', scenario: 'OWNER PRIVATE SCENARIO', confidence: null, confidenceAt: null, cue: 'unknown', outcome: 'unverified', basis: 'unknown' },
      },
    })).status, 201);
    assert.equal((await client.request('/api/observations', {
      method: 'POST', cookie: ownerCookie, headers: ownerHeaders,
      body: {
        eventId: 'owner-scenario-2', conceptId: concept.id, sourceRevision: concept.source.revision,
        observedAt: '2026-01-02T00:00:00.000Z', configRevision: snapshot.config.revision, anchorEventId: null,
        answer: 'OWNER PRIVATE ANSWER 2', rating: 'blank', exposure: 'unexposed', observedExposure: false,
        learning: { task: 'scenario', scenario: 'OWNER PRIVATE SCENARIO 2', confidence: null, confidenceAt: null, cue: 'unknown', outcome: 'unverified', basis: 'unknown' },
      },
    })).status, 201);
    const ownerPrompts = (await client.request('/api/scenario-prompts?limit=1', { cookie: ownerCookie, headers: { 'x-lm-source-id': ownerSession.sourceId } })).json<ScenarioPromptsResponse>();
    assert.equal(ownerPrompts.items[0]?.eventId, 'owner-scenario-2');
    assert.ok(ownerPrompts.nextCursor);

    const created = await client.request('/api/admin/users', {
      method: 'POST', cookie: ownerCookie, headers: ownerHeaders,
      body: { username: 'member', password: 'member-password-2026' },
    });
    assert.equal(created.status, 201, created.body);
    const login = await client.request('/api/auth/login', { method: 'POST', body: { username: 'member', password: 'member-password-2026' } });
    assert.equal(login.status, 200, login.body);
    const memberCookie = login.headers['set-cookie']?.[0]?.split(';')[0];
    assert.ok(memberCookie);
    const memberSession = (await client.request('/api/session', { cookie: memberCookie })).json<{ sourceId: string }>();
    assert.notEqual(memberSession.sourceId, ownerSession.sourceId);
    const memberPrompts = await client.request('/api/scenario-prompts', { cookie: memberCookie, headers: { 'x-lm-source-id': memberSession.sourceId } });
    assert.equal(memberPrompts.status, 200);
    assert.deepEqual(memberPrompts.json<ScenarioPromptsResponse>().items, []);
    assert.doesNotMatch(memberPrompts.body, /OWNER PRIVATE/);
    const crossNamespace = await client.request(`/api/scenario-prompts?cursor=${encodeURIComponent(ownerPrompts.nextCursor!)}`, {
      cookie: memberCookie, headers: { 'x-lm-source-id': memberSession.sourceId },
    });
    assert.equal(crossNamespace.status, 400);
    assert.equal(errorCode(crossNamespace), 'INVALID_SCENARIO_PROMPTS_CURSOR');
  } finally {
    await client.stop();
  }
});
