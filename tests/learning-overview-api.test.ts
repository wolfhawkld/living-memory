import { strict as assert } from 'node:assert';
import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeApp, createApp, type LivingMemoryApp } from '../src/server/app.js';
import type { ApplicationRecordRequest, Concept, ConceptHistory, ExportData, Snapshot } from '../src/shared/types.js';
import type { LearningOverview, LearningOverviewItem } from '../src/shared/learning-overview.js';

interface ResponseData {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
  json: <T>() => T;
}

interface RunningApp {
  root: string;
  dataDir: string;
  port: number;
  request: (path: string, options?: {
    method?: string;
    body?: unknown;
    cookie?: string;
    headers?: Record<string, string>;
  }) => Promise<ResponseData>;
  stop: () => Promise<void>;
}

interface SessionData {
  writeToken: string;
  sourceId: string;
}

const NOW = '2026-03-01T00:00:00.000Z';

function conceptFile(title: string, summary: string, privateBody: string): string {
  return [
    '---',
    'type: concept',
    `title: ${title}`,
    'aliases: []',
    `summary: ${summary}`,
    '---',
    '',
    `# ${title}`,
    '',
    privateBody,
    '',
  ].join('\n');
}

function sourceFixture(): { root: string; dataDir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'living-memory-learning-overview-source-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'living-memory-learning-overview-data-'));
  mkdirSync(join(root, 'Math'), { recursive: true });
  writeFileSync(join(root, 'Math', 'Alpha.md'), conceptFile('Alpha', '数学概念摘要', 'ALPHA_PRIVATE_SOURCE_BODY')); 
  writeFileSync(join(root, 'Math', 'Beta.md'), conceptFile('Beta', '另一个概念摘要', 'BETA_PRIVATE_SOURCE_BODY'));
  writeFileSync(join(root, 'Model.md'), conceptFile('Model', '模型概念摘要', 'MODEL_PRIVATE_SOURCE_BODY'));
  return {
    root,
    dataDir,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function running(options: {
  root?: string;
  dataDir?: string;
  accountsEnabled?: boolean;
  limit?: number;
} = {}): Promise<RunningApp> {
  const fixture = options.root && options.dataDir
    ? { root: options.root, dataDir: options.dataDir, cleanup: () => undefined }
    : sourceFixture();
  // Bind the real listener before creating the app so the Host allow-list and
  // the HTTP client always use one identical port, including in full-suite
  // parallel execution.
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as { port: number }).port;
  const app = createApp({
    root: fixture.root,
    dataDir: fixture.dataDir,
    accountsEnabled: options.accountsEnabled,
    limit: options.limit,
    port,
    now: () => new Date(NOW),
    staticDir: join(fixture.dataDir, 'no-dist'),
  });
  server.on('request', app);
  let stopped = false;
  const request = (path: string, requestOptions: {
    method?: string;
    body?: unknown;
    cookie?: string;
    headers?: Record<string, string>;
  } = {}) => new Promise<ResponseData>((resolve, reject) => {
    const body = requestOptions.body === undefined ? undefined : JSON.stringify(requestOptions.body);
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path,
      method: requestOptions.method ?? 'GET',
      headers: {
        host: `127.0.0.1:${port}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(requestOptions.cookie ? { cookie: requestOptions.cookie } : {}),
        ...(requestOptions.headers ?? {}),
      },
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: text,
        json: <T>() => JSON.parse(text) as T,
      }));
    });
    req.once('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
  return {
    root: fixture.root,
    dataDir: fixture.dataDir,
    port,
    request,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      closeApp(app);
      fixture.cleanup();
    },
  };
}

function tokenHeaders(session: SessionData): Record<string, string> {
  return { 'x-lm-token': session.writeToken, 'x-lm-source-id': session.sourceId };
}

async function session(client: RunningApp, cookie?: string): Promise<SessionData> {
  const response = await client.request('/api/session', { cookie });
  assert.equal(response.status, 200);
  return response.json<SessionData>();
}

async function snapshot(client: RunningApp, cookie?: string): Promise<Snapshot> {
  const response = await client.request('/api/snapshot?scope=all', { cookie });
  assert.equal(response.status, 200);
  return response.json<Snapshot>();
}

function conceptAt(snapshotValue: Snapshot, path: string): Concept {
  const concept = snapshotValue.concepts.find((item) => item.source.path === path);
  assert.ok(concept, `fixture concept ${path} should be present`);
  return concept;
}

function errorCode(response: ResponseData): string {
  return response.json<{ error?: { code?: string } }>().error?.code ?? '';
}

function observation(
  concept: Concept,
  snapshotValue: Snapshot,
  eventId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    eventId,
    conceptId: concept.id,
    sourceRevision: concept.source.revision,
    observedAt: '2026-02-28T00:00:00Z',
    configRevision: snapshotValue.config.revision,
    anchorEventId: null,
    answer: 'PRIVATE_ANSWER_SHOULD_NOT_APPEAR',
    rating: 'clear',
    exposure: 'unexposed',
    observedExposure: false,
    ...overrides,
  };
}

function application(concept: Concept, eventId: string, overrides: Partial<ApplicationRecordRequest> = {}): ApplicationRecordRequest {
  return {
    eventId,
    conceptId: concept.id,
    sourceRevision: concept.source.revision,
    occurredAt: '2026-02-27T00:00:00Z',
    kind: 'application',
    context: 'PRIVATE_APPLICATION_CONTEXT',
    content: 'PRIVATE_APPLICATION_CONTENT',
    outcome: 'success',
    assistance: 'independent',
    result: 'PRIVATE_APPLICATION_RESULT',
    limitations: 'PRIVATE_APPLICATION_LIMITATIONS',
    insight: 'PRIVATE_APPLICATION_INSIGHT',
    correction: 'PRIVATE_APPLICATION_CORRECTION',
    references: 'PRIVATE_APPLICATION_REFERENCES',
    ...overrides,
  };
}

function itemByPath(items: LearningOverviewItem[], path: string, snapshotValue: Snapshot): LearningOverviewItem {
  const concept = conceptAt(snapshotValue, path);
  const item = items.find((candidate) => candidate.conceptId === concept.id);
  assert.ok(item, `overview item ${path} should be present`);
  return item;
}

function cookieFrom(response: ResponseData): string {
  const cookie = String(response.headers['set-cookie'] ?? '').split(';', 1)[0];
  assert.match(cookie, /^lm_session=/);
  return cookie;
}

test('learning overview aggregates current evidence across the full source and keeps private text out of the response', async () => {
  const client = await running({ limit: 1 });
  try {
    const currentSession = await session(client);
    const initial = await snapshot(client);
    assert.equal((await client.request('/api/snapshot')).json<Snapshot>().concepts.length, 1, 'graph view remains limited');
    assert.equal(initial.concepts.length, 3, 'fixture has three concepts in the full index');
    const alpha = conceptAt(initial, 'Math/Alpha.md');
    const beta = conceptAt(initial, 'Math/Beta.md');
    const headers = tokenHeaders(currentSession);

    const oldObservation = observation(alpha, initial, 'alpha-old-observation', {
      observedAt: '2026-02-01T00:00:00Z',
      answer: 'PRIVATE_OLD_ANSWER',
      learning: {
        task: 'concept',
        confidence: 40,
        confidenceAt: '2026-02-01T00:00:00Z',
        cue: 'lookup',
        outcome: 'partial',
        basis: 'application',
      },
    });
    assert.equal((await client.request('/api/observations', { method: 'POST', headers, body: oldObservation })).status, 201);
    assert.equal((await client.request('/api/applications', {
      method: 'POST', headers, body: application(alpha, 'alpha-old-application'),
    })).status, 201);
    assert.equal((await client.request('/api/applications', {
      method: 'POST', headers, body: application(beta, 'beta-deleted-application'),
    })).status, 201);

    // Refresh creates a new revision while keeping old records in the private
    // store. The deleted concept must not be projected into the overview.
    writeFileSync(join(client.root, 'Math', 'Alpha.md'), conceptFile('Alpha', '更新后的摘要', 'ALPHA_NEW_PRIVATE_SOURCE_BODY'));
    rmSync(join(client.root, 'Math', 'Beta.md'), { force: true });
    assert.equal((await client.request('/api/refresh', { method: 'POST', headers, body: {} })).status, 200);
    const refreshed = await snapshot(client);
    const currentAlpha = conceptAt(refreshed, 'Math/Alpha.md');
    assert.notEqual(currentAlpha.source.revision, alpha.source.revision);
    const currentModel = conceptAt(refreshed, 'Model.md');

    const review = {
      eventId: 'alpha-current-review',
      conceptId: currentAlpha.id,
      sourceRevision: currentAlpha.source.revision,
      kind: 'review',
      occurredAt: '2026-02-25T00:00:00Z',
    };
    assert.equal((await client.request('/api/reviews', { method: 'POST', headers, body: review })).status, 201);
    const currentConceptObservation = observation(currentAlpha, refreshed, 'alpha-current-concept-observation', {
      anchorEventId: review.eventId,
      rating: 'clear',
      answer: 'PRIVATE_CURRENT_CONCEPT_ANSWER',
      learning: {
        task: 'concept',
        confidence: 80,
        confidenceAt: '2026-02-28T00:00:00Z',
        cue: 'independent',
        outcome: 'success',
        basis: 'self-check',
      },
    });
    assert.equal((await client.request('/api/observations', { method: 'POST', headers, body: currentConceptObservation })).status, 201);
    const currentScenarioObservation = observation(currentAlpha, refreshed, 'alpha-current-scenario-observation', {
      anchorEventId: review.eventId,
      rating: 'partial',
      answer: 'PRIVATE_SCENARIO_ANSWER',
      learning: {
        task: 'scenario',
        scenario: 'PRIVATE_SCENARIO_TEXT',
        applicability: 'PRIVATE_APPLICABILITY_TEXT',
        confidence: 60,
        confidenceAt: '2026-02-28T00:00:00Z',
        cue: 'independent',
        outcome: 'success',
        basis: 'application',
      },
    });
    assert.equal((await client.request('/api/observations', { method: 'POST', headers, body: currentScenarioObservation })).status, 201);
    assert.equal((await client.request('/api/applications', {
      method: 'POST', headers, body: application(currentAlpha, 'alpha-current-application'),
    })).status, 201);
    assert.equal((await client.request('/api/applications', {
      method: 'POST', headers,
      body: application(currentAlpha, 'alpha-current-summary', { kind: 'summary', context: '', content: 'PRIVATE_SUMMARY_CONTENT' }),
    })).status, 201);

    const beforeExport = (await client.request('/api/export')).json<ExportData>();
    const overviewResponse = await client.request('/api/learning-overview', { headers: { 'x-lm-source-id': currentSession.sourceId } });
    assert.equal(overviewResponse.status, 200);
    assert.equal(overviewResponse.headers['cache-control'], 'no-store');
    const overview = overviewResponse.json<LearningOverview>();
    assert.equal(overview.sourceId, currentSession.sourceId);
    assert.equal(overview.asOf, NOW);
    assert.equal(overview.items.length, 2, 'overview uses all current source concepts except deleted Beta');
    assert.equal(overview.items.some((item) => item.conceptId === beta.id), false);
    assert.equal(overview.items.some((item) => item.conceptId === currentModel.id), true);

    const alphaItem = itemByPath(overview.items, 'Math/Alpha.md', refreshed);
    assert.equal(alphaItem.sourceRevision, currentAlpha.source.revision);
    assert.equal(alphaItem.domainId, 'Math');
    assert.equal(alphaItem.recall.total, 1);
    assert.equal(alphaItem.recall.clear, 1);
    assert.equal(alphaItem.recall.partial, 0);
    assert.equal(alphaItem.recall.blank, 0);
    assert.equal(alphaItem.scenario.total, 1);
    assert.equal(alphaItem.scenario.partial, 0);
    assert.equal(alphaItem.scenario.failure, 0);
    assert.equal(alphaItem.scenario.independentSuccess, 1);
    assert.equal(alphaItem.scenario.assisted, 0);
    assert.equal(alphaItem.calibration.concept.count, 1);
    assert.equal(alphaItem.calibration.concept.meanConfidence, 80);
    assert.equal(alphaItem.calibration.scenario.count, 1);
    assert.equal(alphaItem.calibration.scenario.meanConfidence, 60);
    assert.equal(alphaItem.applications.application, 1);
    assert.equal(alphaItem.applications.summary, 1);
    assert.equal(alphaItem.evidence.currentObservations, 2);
    assert.equal(alphaItem.evidence.previousObservations, 1);
    assert.equal(alphaItem.evidence.previousApplications, 1);
    assert.equal(alphaItem.applications.latestAt, '2026-02-27T00:00:00.000Z');
    assert.equal(alphaItem.evidence.latestAt, '2026-02-28T00:00:00.000Z');
    assert.equal(alphaItem.recall.latest?.eventId, 'alpha-current-concept-observation');
    assert.equal(alphaItem.scenario.latest?.eventId, 'alpha-current-scenario-observation');
    assert.equal(alphaItem.recall.latest?.cue, 'independent');
    assert.equal(alphaItem.recall.latest?.outcome, 'success');
    assert.equal(alphaItem.timeRecall?.buckets.length, 1);
    assert.equal(alphaItem.timeRecall?.buckets[0].anchorKind, 'review');
    assert.equal(alphaItem.timeRecall?.buckets[0].condition, 'unexposed');
    assert.equal(alphaItem.timeRecall?.buckets[0].latest.elapsedDays, 3);
    assert.deepEqual(alphaItem.timeRecall?.excluded, { scenario: 1, missingTime: 0, invalidTime: 0 });

    const modelItem = itemByPath(overview.items, 'Model.md', refreshed);
    assert.equal(modelItem.recall.total, 0);
    assert.equal(modelItem.evidence.currentObservations, 0);
    assert.equal(modelItem.evidence.previousObservations, 0);
    assert.equal(modelItem.evidence.previousApplications, 0);

    const serialized = JSON.stringify(overview);
    for (const privateText of [
      'ALPHA_PRIVATE_SOURCE_BODY', 'ALPHA_NEW_PRIVATE_SOURCE_BODY', 'BETA_PRIVATE_SOURCE_BODY', 'MODEL_PRIVATE_SOURCE_BODY',
      'PRIVATE_OLD_ANSWER', 'PRIVATE_CURRENT_CONCEPT_ANSWER', 'PRIVATE_SCENARIO_ANSWER', 'PRIVATE_SCENARIO_TEXT',
      'PRIVATE_APPLICABILITY_TEXT', 'PRIVATE_APPLICATION_CONTEXT', 'PRIVATE_APPLICATION_CONTENT', 'PRIVATE_APPLICATION_INSIGHT',
      'PRIVATE_SUMMARY_CONTENT', 'PRIVATE_APPLICATION_RESULT', 'PRIVATE_APPLICATION_LIMITATIONS', 'PRIVATE_APPLICATION_CORRECTION',
    ]) {
      assert.doesNotMatch(serialized, new RegExp(privateText));
    }
    assert.doesNotMatch(serialized, /"path"/);
    assert.doesNotMatch(serialized, /"body"/);

    const afterExport = (await client.request('/api/export')).json<ExportData>();
    assert.deepEqual(afterExport, beforeExport, 'overview is read-only and does not mutate learning records');
  } finally {
    await client.stop();
  }
});

test('learning overview enforces read source identity and account-private namespaces', async () => {
  const fixture = sourceFixture();
  let client: RunningApp | undefined;
  try {
    client = await running({ root: fixture.root, dataDir: fixture.dataDir, accountsEnabled: true });
    const unauthenticated = await client.request('/api/learning-overview');
    assert.equal(unauthenticated.status, 401);
    assert.equal(errorCode(unauthenticated), 'AUTH_REQUIRED');

    const setup = await client.request('/api/auth/setup', {
      method: 'POST', body: { username: 'owner', password: 'owner-password-2026' },
    });
    assert.equal(setup.status, 201);
    const ownerCookie = cookieFrom(setup);
    const owner = await session(client, ownerCookie);
    const ownerHeaders = tokenHeaders(owner);
    const ownerSnapshot = await snapshot(client, ownerCookie);
    const ownerConcept = conceptAt(ownerSnapshot, 'Math/Alpha.md');
    assert.equal((await client.request('/api/applications', {
      method: 'POST', cookie: ownerCookie, headers: ownerHeaders,
      body: application(ownerConcept, 'owner-overview-application', { content: 'OWNER_PRIVATE_RECORD' }),
    })).status, 201);
    assert.equal((await client.request('/api/reviews', {
      method: 'POST', cookie: ownerCookie, headers: ownerHeaders,
      body: { eventId: 'owner-time-anchor', conceptId: ownerConcept.id, sourceRevision: ownerConcept.source.revision,
        kind: 'review', occurredAt: '2026-02-01T00:00:00Z' },
    })).status, 201);
    assert.equal((await client.request('/api/observations', {
      method: 'POST', cookie: ownerCookie, headers: ownerHeaders,
      body: observation(ownerConcept, ownerSnapshot, 'owner-time-observation', { anchorEventId: 'owner-time-anchor' }),
    })).status, 201);

    const wrongSource = await client.request('/api/learning-overview', {
      cookie: ownerCookie,
      headers: { 'x-lm-source-id': 'wrong-private-source' },
    });
    assert.equal(wrongSource.status, 409);
    assert.equal(errorCode(wrongSource), 'SOURCE_MISMATCH');
    const ownerOverview = (await client.request('/api/learning-overview', {
      cookie: ownerCookie,
      headers: { 'x-lm-source-id': owner.sourceId },
    })).json<LearningOverview>();
    assert.equal(ownerOverview.items.length, 3);
    assert.equal(ownerOverview.items.find((item) => item.conceptId === ownerConcept.id)?.applications.application, 1);
    assert.equal(ownerOverview.items.find((item) => item.conceptId === ownerConcept.id)?.timeRecall?.buckets[0].count, 1);

    const created = await client.request('/api/admin/users', {
      method: 'POST', cookie: ownerCookie, headers: ownerHeaders,
      body: { username: 'member', password: 'member-password-2026' },
    });
    assert.equal(created.status, 201);
    const memberId = created.json<{ user: { id: string } }>().user.id;
    const memberRoot = join(fixture.dataDir, 'users', memberId, 'knowledge');
    mkdirSync(join(memberRoot, 'Math'), { recursive: true });
    writeFileSync(join(memberRoot, 'Math', 'Alpha.md'), conceptFile('Alpha', '成员摘要', 'MEMBER_PRIVATE_SOURCE_BODY'));
    const login = await client.request('/api/auth/login', {
      method: 'POST', body: { username: 'member', password: 'member-password-2026' },
    });
    assert.equal(login.status, 200);
    const memberCookie = cookieFrom(login);
    const member = await session(client, memberCookie);
    const memberHeaders = tokenHeaders(member);
    assert.notEqual(member.sourceId, owner.sourceId);
    assert.equal((await client.request('/api/refresh', {
      method: 'POST', cookie: memberCookie, headers: memberHeaders, body: {},
    })).status, 200);
    const memberSnapshot = await snapshot(client, memberCookie);
    const memberConcept = conceptAt(memberSnapshot, 'Math/Alpha.md');
    assert.equal((await client.request('/api/applications', {
      method: 'POST', cookie: memberCookie, headers: memberHeaders,
      body: application(memberConcept, 'member-overview-application', { content: 'MEMBER_PRIVATE_RECORD' }),
    })).status, 201);

    const memberOverviewResponse = await client.request('/api/learning-overview', {
      cookie: memberCookie,
      headers: { 'x-lm-source-id': member.sourceId },
    });
    assert.equal(memberOverviewResponse.status, 200);
    const memberOverview = memberOverviewResponse.json<LearningOverview>();
    assert.equal(memberOverview.sourceId, member.sourceId);
    assert.equal(memberOverview.items.length, 1);
    assert.equal(memberOverview.items[0].conceptId, memberConcept.id);
    assert.equal(memberOverview.items[0].applications.application, 1);
    assert.deepEqual(memberOverview.items[0].timeRecall?.buckets, []);
    assert.notEqual(memberOverview.items[0].conceptId, ownerConcept.id);

    const ownerResponse = JSON.stringify(ownerOverview);
    const memberResponse = JSON.stringify(memberOverview);
    assert.doesNotMatch(ownerResponse, /OWNER_PRIVATE_RECORD|MEMBER_PRIVATE_RECORD|MEMBER_PRIVATE_SOURCE_BODY/);
    assert.doesNotMatch(memberResponse, /MEMBER_PRIVATE_RECORD|OWNER_PRIVATE_RECORD|OWNER_PRIVATE_SOURCE_BODY|MEMBER_PRIVATE_SOURCE_BODY/);
    const ownerConceptFromMember = await client.request('/api/learning-overview', {
      cookie: memberCookie,
      headers: { 'x-lm-source-id': owner.sourceId },
    });
    assert.equal(ownerConceptFromMember.status, 409);
    assert.equal(errorCode(ownerConceptFromMember), 'SOURCE_MISMATCH');
  } finally {
    if (client) await client.stop();
    fixture.cleanup();
  }
});

test('time comparison keeps historical H and review dates across new reviews, config changes and source revisions', async () => {
  const client = await running();
  try {
    const credentials = await session(client);
    const headers = tokenHeaders(credentials);
    const initial = await snapshot(client);
    assert.equal(initial.config.halfLifeDays, 7);
    const targets = [conceptAt(initial, 'Math/Alpha.md'), conceptAt(initial, 'Math/Beta.md')];
    for (const [index, concept] of targets.entries()) {
      const anchor = { eventId: `time-anchor-${index}`, conceptId: concept.id, sourceRevision: concept.source.revision,
        kind: index ? 'estimated' : 'review', occurredAt: '2026-02-01T00:00:00Z' };
      assert.equal((await client.request('/api/reviews', { method: 'POST', headers, body: anchor })).status, 201);
      assert.equal((await client.request('/api/observations', { method: 'POST', headers,
        body: observation(concept, initial, `time-observation-${index}`, {
          observedAt: '2026-02-15T00:00:00Z', anchorEventId: anchor.eventId, rating: 'clear',
          learning: { task: 'concept', confidence: null, confidenceAt: null, cue: 'independent', outcome: 'success', basis: 'self-check' },
        }),
      })).status, 201);
      assert.equal((await client.request('/api/reviews', { method: 'POST', headers,
        body: { ...anchor, eventId: `latest-anchor-${index}`, kind: 'review', occurredAt: '2026-02-28T00:00:00Z' },
      })).status, 201);
    }
    assert.equal((await client.request('/api/config', { method: 'PUT', headers,
      body: { revision: initial.config.revision, halfLifeDays: 28 },
    })).status, 200);
    const current = await snapshot(client);
    assert.equal(current.states[targets[0].id].status, 'recent');
    const before = (await client.request('/api/export')).json<ExportData>();
    const read = await client.request('/api/learning-overview', { headers });
    assert.equal(read.status, 200);
    const overview = read.json<LearningOverview>();
    for (const [index, concept] of targets.entries()) {
      const item = overview.items.find(row => row.conceptId === concept.id)!;
      assert.equal(item.memory.status, 'recent');
      const bucket = item.timeRecall!.buckets[0];
      assert.equal(bucket.band, 'stale');
      assert.equal(bucket.anchorKind, index ? 'estimated' : 'review');
      assert.equal(bucket.latest.halfLifeDays, 7);
      assert.equal(bucket.latest.configRevision, initial.config.revision);
      assert.equal(bucket.latest.elapsedDays, 14);
      assert.equal(bucket.latest.decay, 0.25);
      assert.equal(bucket.latest.anchorOccurredAt, '2026-02-01T00:00:00.000Z');
      assert.equal(bucket.latestClear?.eventId, `time-observation-${index}`);
    }
    await client.request('/api/learning-overview', { headers });
    assert.deepEqual((await client.request('/api/export')).json<ExportData>(), before);
    writeFileSync(join(client.root, 'Math', 'Alpha.md'), conceptFile('Alpha', 'Changed version', 'NEW_PRIVATE_BODY'));
    assert.equal((await client.request('/api/refresh', { method: 'POST', headers, body: {} })).status, 200);
    const changed = (await client.request('/api/learning-overview', { headers })).json<LearningOverview>();
    const alpha = changed.items.find(row => row.conceptId === targets[0].id)!;
    assert.equal(alpha.evidence.previousObservations, 1);
    assert.deepEqual(alpha.timeRecall!.buckets, [], 'old version observations are not matched to current content');
  } finally { await client.stop(); }
});

test('focused application history returns one old record, keeps correction metadata, and remains read-only', async () => {
  const client = await running({ limit: 1 });
  try {
    const currentSession = await session(client);
    const initial = await snapshot(client);
    const alpha = conceptAt(initial, 'Math/Alpha.md');
    const headers = tokenHeaders(currentSession);
    const eventIds: string[] = [];
    for (let index = 0; index < 25; index += 1) {
      const eventId = `history-${String(index).padStart(2, '0')}`;
      eventIds.push(eventId);
      const response = await client.request('/api/applications', {
        method: 'POST', headers,
        body: application(alpha, eventId, { occurredAt: `2026-02-${String(index + 1).padStart(2, '0')}T00:00:00Z` }),
      });
      assert.equal(response.status, 201);
    }
    const before = (await client.request('/api/export', { headers })).json<ExportData>();
    const regular = await client.request(`/api/concepts/${encodeURIComponent(alpha.id)}/history?limit=20`, { headers });
    assert.equal(regular.status, 200);
    const regularHistory = regular.json<ConceptHistory>();
    assert.equal(regularHistory.entries.length, 20);
    assert.ok(regularHistory.nextCursor);

    const focused = await client.request(`/api/concepts/${encodeURIComponent(alpha.id)}/history?limit=1&applicationEventId=${eventIds[0]}`, { headers });
    assert.equal(focused.status, 200);
    const focusedHistory = focused.json<{
      entries: Array<{ type: string; event: { eventId: string } }>;
      total: number;
      nextCursor: string | null;
      focusedApplicationEventId?: string;
      corrections?: Record<string, unknown>;
    }>();
    assert.equal(focusedHistory.entries.length, 1);
    assert.equal(focusedHistory.entries[0]?.type, 'application');
    assert.equal(focusedHistory.entries[0]?.event.eventId, eventIds[0]);
    assert.equal(focusedHistory.total, 1);
    assert.equal(focusedHistory.nextCursor, null);
    assert.equal(focusedHistory.focusedApplicationEventId, eventIds[0]);
    assert.deepEqual(Object.keys(focusedHistory.corrections ?? {}), [eventIds[0]]);

    const withCursor = await client.request(`/api/concepts/${encodeURIComponent(alpha.id)}/history?cursor=${encodeURIComponent(regularHistory.nextCursor!)}&applicationEventId=${eventIds[0]}`, { headers });
    assert.equal(withCursor.status, 400);
    assert.equal(errorCode(withCursor), 'INVALID_HISTORY_CURSOR');
    const invalidId = await client.request(`/api/concepts/${encodeURIComponent(alpha.id)}/history?applicationEventId=bad%20id`, { headers });
    assert.equal(invalidId.status, 400);
    assert.equal(errorCode(invalidId), 'INVALID_EVENT_ID');
    const wrongConcept = conceptAt(initial, 'Math/Beta.md');
    const wrongConceptFocus = await client.request(`/api/concepts/${encodeURIComponent(wrongConcept.id)}/history?applicationEventId=${eventIds[0]}`, { headers });
    assert.equal(wrongConceptFocus.status, 404);
    assert.equal(errorCode(wrongConceptFocus), 'APPLICATION_NOT_FOUND');
    assert.deepEqual((await client.request('/api/export', { headers })).json<ExportData>(), before);
  } finally {
    await client.stop();
  }
});

test('learning overview corrections and focused history remain account-private', async () => {
  const fixture = sourceFixture();
  let client: RunningApp | undefined;
  try {
    client = await running({ root: fixture.root, dataDir: fixture.dataDir, accountsEnabled: true });
    const setup = await client.request('/api/auth/setup', {
      method: 'POST', body: { username: 'owner', password: 'owner-password-2026' },
    });
    assert.equal(setup.status, 201);
    const ownerCookie = cookieFrom(setup);
    const owner = await session(client, ownerCookie);
    const ownerHeaders = tokenHeaders(owner);
    const ownerSnapshot = await snapshot(client, ownerCookie);
    const ownerConcept = conceptAt(ownerSnapshot, 'Math/Alpha.md');
    const ownerApplication = application(ownerConcept, 'owner-correction-application');
    assert.equal((await client.request('/api/applications', {
      method: 'POST', cookie: ownerCookie, headers: ownerHeaders, body: ownerApplication,
    })).status, 201);
    const ownerOverview = (await client.request('/api/learning-overview', {
      cookie: ownerCookie, headers: { 'x-lm-source-id': owner.sourceId },
    })).json<LearningOverview>();
    assert.equal(ownerOverview.corrections?.items.length, 1);
    assert.equal(ownerOverview.corrections?.items[0]?.applicationEventId, ownerApplication.eventId);
    assert.doesNotMatch(JSON.stringify(ownerOverview.corrections), /PRIVATE_APPLICATION_CORRECTION|PRIVATE_APPLICATION_CONTENT/);

    const created = await client.request('/api/admin/users', {
      method: 'POST', cookie: ownerCookie, headers: ownerHeaders,
      body: { username: 'member', password: 'member-password-2026' },
    });
    assert.equal(created.status, 201);
    const memberId = created.json<{ user: { id: string } }>().user.id;
    const memberRoot = join(fixture.dataDir, 'users', memberId, 'knowledge');
    mkdirSync(join(memberRoot, 'Math'), { recursive: true });
    writeFileSync(join(memberRoot, 'Math', 'Alpha.md'), conceptFile('Alpha', '成员摘要', 'MEMBER_PRIVATE_SOURCE_BODY'));
    const login = await client.request('/api/auth/login', {
      method: 'POST', body: { username: 'member', password: 'member-password-2026' },
    });
    assert.equal(login.status, 200);
    const memberCookie = cookieFrom(login);
    const member = await session(client, memberCookie);
    const memberHeaders = tokenHeaders(member);
    assert.equal((await client.request('/api/refresh', {
      method: 'POST', cookie: memberCookie, headers: memberHeaders, body: {},
    })).status, 200);
    const memberSnapshot = await snapshot(client, memberCookie);
    const memberConcept = conceptAt(memberSnapshot, 'Math/Alpha.md');
    const foreignFocus = await client.request(`/api/concepts/${encodeURIComponent(memberConcept.id)}/history?applicationEventId=${ownerApplication.eventId}`, {
      cookie: memberCookie, headers: { 'x-lm-source-id': member.sourceId },
    });
    assert.equal(foreignFocus.status, 404);
    assert.equal(errorCode(foreignFocus), 'APPLICATION_NOT_FOUND');
    const memberOverview = (await client.request('/api/learning-overview', {
      cookie: memberCookie, headers: { 'x-lm-source-id': member.sourceId },
    })).json<LearningOverview>();
    assert.deepEqual(memberOverview.corrections?.items, []);
    assert.equal(memberOverview.corrections?.unavailableCount, 0);
  } finally {
    if (client) await client.stop();
    fixture.cleanup();
  }
});
