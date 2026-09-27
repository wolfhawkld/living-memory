import { strict as assert } from 'node:assert';
import { createServer, request as httpRequest } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeApp, createApp, type LivingMemoryApp } from '../src/server/app.js';
import type { ReviewPlanResponse } from '../src/shared/review-plan.js';
import type { Snapshot } from '../src/shared/types.js';

interface ResponseData {
  status: number;
  body: string;
  setCookie?: string;
  json: <T>() => T;
}

interface RunningApp {
  app: LivingMemoryApp;
  dataDir: string;
  request: (path: string, options?: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
    cookie?: string;
  }) => Promise<ResponseData>;
  stop: () => Promise<void>;
  cleanup: () => void;
}

const NOW = '2026-01-02T01:00:00.000Z';

function conceptFile(title: string, summary: string): string {
  return ['---', 'type: concept', `title: ${title}`, `summary: ${summary}`, '---', '', summary, ''].join('\n');
}

async function runningApp(accountsEnabled = false): Promise<RunningApp> {
  const root = mkdtempSync(join(tmpdir(), 'living-memory-review-plan-api-source-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'living-memory-review-plan-api-data-'));
  mkdirSync(join(root, 'Math'), { recursive: true });
  writeFileSync(join(root, 'Math', 'Alpha.md'), conceptFile('Alpha', 'alpha summary'));
  writeFileSync(join(root, 'Math', 'Beta.md'), conceptFile('Beta', 'beta summary'));

  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as { port: number }).port;
  const app = createApp({ root, dataDir, port, accountsEnabled, now: () => new Date(NOW), staticDir: join(dataDir, 'no-dist') });
  server.on('request', app);
  let stopped = false;
  const request = (path: string, options: { method?: string; body?: unknown; headers?: Record<string, string>; cookie?: string } = {}) => new Promise<ResponseData>((resolve, reject) => {
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = httpRequest({
      hostname: '127.0.0.1', port, path, method: options.method ?? 'GET',
      headers: {
        host: `127.0.0.1:${port}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(options.cookie ? { cookie: options.cookie } : {}),
        ...(options.headers ?? {}),
      },
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        body: text,
        setCookie: response.headers['set-cookie']?.[0]?.split(';')[0],
        json: <T>() => JSON.parse(text) as T,
      }));
    });
    req.once('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
  return {
    app,
    dataDir,
    request,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      closeApp(app);
    },
    cleanup: () => { rmSync(root, { recursive: true, force: true }); rmSync(dataDir, { recursive: true, force: true }); },
  };
}

function headers(session: { writeToken: string; sourceId: string }, token = true): Record<string, string> {
  return { 'x-lm-source-id': session.sourceId, ...(token ? { 'x-lm-token': session.writeToken } : {}) };
}

async function session(client: RunningApp): Promise<{ writeToken: string; sourceId: string }> {
  const response = await client.request('/api/session');
  assert.equal(response.status, 200);
  return response.json<{ writeToken: string; sourceId: string }>();
}

test('review plan API applies source/auth guards, CAS idempotency, export, and daily recall accounting', async () => {
  const client = await runningApp();
  try {
    const current = await session(client);
    const initial = await client.request(`/api/review-plan?timeZone=${encodeURIComponent('Asia/Shanghai')}`, { headers: { 'x-lm-source-id': current.sourceId } });
    assert.equal(initial.status, 200);
    const initialPlan = initial.json<ReviewPlanResponse>();
    assert.equal(initialPlan.sourceId, current.sourceId);
    assert.equal(initialPlan.timeZone, 'Asia/Shanghai');
    assert.equal(initialPlan.dayKey, '2026-01-02');
    assert.deepEqual(initialPlan.plan, { revision: 0, dailyBudget: 5, concepts: {} });
    assert.deepEqual(initialPlan.completedConceptIds, []);

    const snapshot = (await client.request('/api/snapshot?scope=all')).json<Snapshot>();
    const alpha = snapshot.concepts.find((item) => item.title === 'Alpha');
    assert.ok(alpha);
    const beta = snapshot.concepts.find((item) => item.title === 'Beta');
    assert.ok(beta);
    const writeHeaders = headers(current);

    assert.equal((await client.request('/api/review-plan?timeZone=Not/AZone')).status, 400);
    assert.equal((await client.request('/api/review-plan', { method: 'PUT', body: { revision: 0, dailyBudget: 7 }, headers: headers(current, false) })).status, 401);
    assert.equal((await client.request('/api/review-plan', { method: 'PUT', body: { revision: 0, dailyBudget: 7 }, headers: { ...writeHeaders, 'x-lm-source-id': 'wrong-source' } })).status, 409);

    const budget = await client.request('/api/review-plan?timeZone=UTC', {
      method: 'PUT', headers: writeHeaders, body: { revision: 0, dailyBudget: 7 },
    });
    assert.equal(budget.status, 200);
    const budgetResponse = budget.json<ReviewPlanResponse>();
    assert.equal(budgetResponse.plan.revision, 1);
    assert.equal(budgetResponse.plan.dailyBudget, 7);
    assert.equal(budgetResponse.timeZone, 'UTC');
    assert.deepEqual((await client.request('/api/review-plan?timeZone=UTC')).json<ReviewPlanResponse>().plan, budgetResponse.plan);

    const staleSame = await client.request('/api/review-plan', {
      method: 'PUT', headers: writeHeaders, body: { revision: 0, dailyBudget: 7 },
    });
    assert.equal(staleSame.status, 200);
    assert.deepEqual(staleSame.json<ReviewPlanResponse>().plan, budgetResponse.plan);
    const staleChanged = await client.request('/api/review-plan', {
      method: 'PUT', headers: writeHeaders, body: { revision: 0, dailyBudget: 8 },
    });
    assert.equal(staleChanged.status, 409);
    assert.equal(staleChanged.json<{ error: { code: string } }>().error.code, 'REVIEW_PLAN_CONFLICT');

    const focused = await client.request('/api/review-plan?timeZone=Asia/Shanghai', {
      method: 'PUT', headers: writeHeaders,
      body: { revision: 1, concept: { conceptId: alpha.id, sourceRevision: alpha.source.revision, focus: true, deferUntil: null } },
    });
    assert.equal(focused.status, 200);
    const focusedResponse = focused.json<ReviewPlanResponse>();
    assert.equal(focusedResponse.plan.revision, 2);
    assert.deepEqual(focusedResponse.plan.concepts[alpha.id], { focus: true, deferUntil: null });
    const badVersion = await client.request('/api/review-plan', {
      method: 'PUT', headers: writeHeaders,
      body: { revision: 2, concept: { conceptId: beta.id, sourceRevision: 'wrong-revision', focus: true, deferUntil: null } },
    });
    assert.equal(badVersion.status, 409);
    assert.equal(badVersion.json<{ error: { code: string } }>().error.code, 'SOURCE_REVISION_MISMATCH');
    assert.equal((await client.request('/api/review-plan', {
      method: 'PUT', headers: writeHeaders,
      body: { revision: 2, concept: { conceptId: alpha.id, sourceRevision: alpha.source.revision, focus: false, deferUntil: '2026-01-02T00:00:00Z' } },
    })).status, 400);

    const beforeState = (await client.request('/api/snapshot?scope=all')).json<Snapshot>().states[alpha.id];
    const conceptObservation = {
      eventId: 'review-plan-concept-observation', conceptId: alpha.id, sourceRevision: alpha.source.revision,
      observedAt: '2026-01-01T16:00:00Z', configRevision: snapshot.config.revision, anchorEventId: null,
      answer: 'alpha', rating: 'clear', exposure: 'unexposed', observedExposure: false,
    };
    assert.equal((await client.request('/api/observations', { method: 'POST', headers: writeHeaders, body: conceptObservation })).status, 201);
    assert.equal((await client.request('/api/observations', { method: 'POST', headers: writeHeaders, body: {
      ...conceptObservation, eventId: 'review-plan-scenario-observation', conceptId: beta.id, sourceRevision: beta.source.revision,
      learning: { task: 'scenario', scenario: 'scenario', cue: 'independent', outcome: 'success', basis: 'application', confidence: null, confidenceAt: null },
    } })).status, 201);
    assert.equal((await client.request('/api/applications', { method: 'POST', headers: writeHeaders, body: {
      eventId: 'review-plan-application', conceptId: alpha.id, sourceRevision: alpha.source.revision,
      occurredAt: '2026-01-01T16:30:00Z', kind: 'application', context: 'context', content: 'content', outcome: 'success', assistance: 'independent',
      result: '', limitations: '', insight: '', correction: '', references: '',
    } })).status, 201);
    const asia = await client.request('/api/review-plan?timeZone=Asia/Shanghai');
    assert.deepEqual(asia.json<ReviewPlanResponse>().completedConceptIds, [alpha.id]);
    const utc = await client.request('/api/review-plan?timeZone=UTC');
    assert.deepEqual(utc.json<ReviewPlanResponse>().completedConceptIds, []);
    const afterState = (await client.request('/api/snapshot?scope=all')).json<Snapshot>().states[alpha.id];
    assert.deepEqual(afterState, beforeState, 'review-plan metadata and unanchored observations do not alter memory state');

    const exported = (await client.request('/api/export')).json<{ reviewPlan?: unknown; observations: unknown[]; applications?: unknown[] }>();
    assert.ok(exported.reviewPlan);
    assert.equal(exported.observations.length, 2);
    assert.equal(exported.applications?.length, 1);
  } finally {
    await client.stop();
    client.cleanup();
  }
});

test('account sessions keep review plans in separate private namespaces', async () => {
  const client = await runningApp(true);
  try {
    const setup = await client.request('/api/auth/setup', {
      method: 'POST', body: { username: 'owner', password: 'owner-password-2026' },
    });
    assert.equal(setup.status, 201);
    assert.ok(setup.setCookie);
    const ownerCookie = setup.setCookie!;
    const owner = await client.request('/api/session', { cookie: ownerCookie });
    const ownerSession = owner.json<{ writeToken: string; sourceId: string }>();
    const ownerHeaders = headers(ownerSession);
    const ownerUpdate = await client.request('/api/review-plan', {
      method: 'PUT', cookie: ownerCookie, headers: ownerHeaders, body: { revision: 0, dailyBudget: 9 },
    });
    assert.equal(ownerUpdate.status, 200);

    const created = await client.request('/api/admin/users', {
      method: 'POST', cookie: ownerCookie, headers: ownerHeaders,
      body: { username: 'member', password: 'member-password-2026' },
    });
    assert.equal(created.status, 201);
    const memberId = created.json<{ user: { id: string } }>().user.id;
    const memberRoot = join(client.dataDir, 'users', memberId, 'knowledge', 'Math');
    mkdirSync(memberRoot, { recursive: true });
    writeFileSync(join(memberRoot, 'Member.md'), conceptFile('Member', 'member private summary'));

    const login = await client.request('/api/auth/login', {
      method: 'POST', body: { username: 'member', password: 'member-password-2026' },
    });
    assert.equal(login.status, 200);
    assert.ok(login.setCookie);
    const memberCookie = login.setCookie!;
    const member = await client.request('/api/session', { cookie: memberCookie });
    const memberSession = member.json<{ writeToken: string; sourceId: string }>();
    assert.notEqual(memberSession.sourceId, ownerSession.sourceId);
    const memberHeaders = headers(memberSession);
    assert.equal((await client.request('/api/refresh', {
      method: 'POST', cookie: memberCookie, headers: memberHeaders, body: {},
    })).status, 200);
    const memberInitial = await client.request('/api/review-plan', { cookie: memberCookie, headers: { 'x-lm-source-id': memberSession.sourceId } });
    assert.equal(memberInitial.status, 200);
    assert.equal(memberInitial.json<ReviewPlanResponse>().plan.dailyBudget, 5);
    assert.equal((await client.request('/api/review-plan', {
      method: 'PUT', cookie: memberCookie, headers: memberHeaders, body: { revision: 0, dailyBudget: 11 },
    })).status, 200);
    const ownerPlan = await client.request('/api/review-plan', { cookie: ownerCookie, headers: { 'x-lm-source-id': ownerSession.sourceId } });
    assert.equal(ownerPlan.status, 200);
    assert.equal(ownerPlan.json<ReviewPlanResponse>().plan.dailyBudget, 9);
    const memberPlan = await client.request('/api/review-plan', { cookie: memberCookie, headers: { 'x-lm-source-id': memberSession.sourceId } });
    assert.equal(memberPlan.json<ReviewPlanResponse>().plan.dailyBudget, 11);
    assert.equal((await client.request('/api/review-plan', {
      cookie: memberCookie, headers: { 'x-lm-source-id': ownerSession.sourceId },
    })).status, 409);
  } finally {
    await client.stop();
    client.cleanup();
  }
});
