import { strict as assert } from 'node:assert';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { RelationReviewRequest, RelationReviewResponse } from '../src/shared/relation-reviews.js';
import { closeApp, createApp, type LivingMemoryApp } from '../src/server/app.js';
import type { ApplicationRecordRequest, Concept, ConceptHistory, ExportData, Snapshot, RelationSuggestion, RelationSuggestionEndpoint } from '../src/shared/types.js';



interface ResponseData {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
  json: <T>() => T;
}

interface RunningApp {
  app: LivingMemoryApp;
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

const NOW = '2026-01-10T00:00:00.000Z';

function conceptFile(title: string, summary: string): string {
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
    summary,
    '',
  ].join('\n');
}

function sourceFixture(): { root: string; dataDir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'living-memory-application-source-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'living-memory-application-data-'));
  mkdirSync(join(root, 'Math'), { recursive: true });
  writeFileSync(join(root, 'Math', 'Alpha.md'), conceptFile('Alpha', '数学中的一个概念。') + '\n## 关系网络\n- 应用：[[Math/Beta.md]] — first\n- 相关：[[Math/Beta.md]] — second\n');
  writeFileSync(join(root, 'Math', 'Beta.md'), conceptFile('Beta', '另一个可用于测试的概念。') + '\n## 关系网络\n- 相关：[[Math/Alpha.md]] — reverse\n');
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
  accountsEnabled?: boolean;
  root?: string;
  dataDir?: string;
  now?: string;
  limit?: number;
} = {}): Promise<RunningApp> {
  const fixture = options.root && options.dataDir
    ? { root: options.root, dataDir: options.dataDir, cleanup: () => undefined }
    : sourceFixture();
  const now = options.now ?? NOW;
  // Bind the real HTTP server first, then construct the app with that exact
  // bound port. This avoids a released-probe-port race when the full test
  // suite starts several HTTP workers in parallel.
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
    now: () => new Date(now),
    staticDir: join(fixture.dataDir, 'no-dist'),
  });
  server.on('request', app);
  let stopped = false;
  const request = (path: string, options: {
    method?: string;
    body?: unknown;
    cookie?: string;
    headers?: Record<string, string>;
  } = {}) => new Promise<ResponseData>((resolve, reject) => {
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path,
      method: options.method ?? 'GET',
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
    app,
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

function conceptAt(snapshotValue: Snapshot, path = 'Math/Alpha.md'): Concept {
  const concept = snapshotValue.concepts.find((item) => item.source.path === path);
  assert.ok(concept, `fixture concept ${path} should be present`);
  return concept;
}

function baseApplication(concept: Concept, overrides: Partial<ApplicationRecordRequest> = {}): ApplicationRecordRequest {
  return {
    eventId: 'application-1',
    conceptId: concept.id,
    sourceRevision: concept.source.revision,
    occurredAt: '2026-01-09T00:00:00Z',
    kind: 'application',
    context: '为一个需要强校验的编排器设计概念模型。',
    content: '我把问题拆为输入范围、风险约束和决策路径。',
    outcome: 'partial',
    assistance: 'independent',
    result: '完成了初版模型和边界列表。',
    limitations: '仍需用真实业务数据验证覆盖范围。',
    insight: '先区分校验层和推理层，有助于减少概念混用。',
    correction: '将“记得名称”与“能在场景中调用”分开记录。',
    references: '内部设计笔记。',
    ...overrides,
  };
}

function errorCode(response: ResponseData): string {
  return response.json<{ error?: { code?: string } }>().error?.code ?? '';
}

function endpoint(concept: Concept): RelationSuggestionEndpoint {
  return { conceptId: concept.id, sourceRevision: concept.source.revision, title: concept.title, path: concept.source.path };
}
function proposal(initial: Snapshot, operation: 'add' | 'change' | 'remove', reverse = false): RelationSuggestion {
  const alpha = conceptAt(initial); const beta = conceptAt(initial, 'Math/Beta.md');
  const source = endpoint(reverse ? beta : alpha); const target = endpoint(reverse ? alpha : beta);
  const edge = initial.links.find(link => link.source === source.conceptId && link.target === target.conceptId)!;
  assert.ok(edge);
  const before = { type: edge.type, description: edge.description };
  const after = { type: 'proposed', description: '私人关系建议，不修改知识源。' };
  return operation === 'add' ? { operation, source, target, after }
    : operation === 'change' ? { operation, source, target, before, after }
      : { operation, source, target, before };
}
function record(initial: Snapshot, relationSuggestion: RelationSuggestion, eventId: string): ApplicationRecordRequest {
  return baseApplication(conceptAt(initial), { eventId, correction: '', relationSuggestion });
}
async function post(client: RunningApp, headers: Record<string, string>, body: ApplicationRecordRequest, cookie?: string) {
  return client.request('/api/applications', { method: 'POST', headers, body, cookie });
}

async function review(client: RunningApp, applicationEventId: string, cookie?: string): Promise<RelationReviewResponse> {
  const response = await client.request(`/api/applications/${applicationEventId}/relation-review`, { cookie });
  assert.equal(response.status, 200, response.body); assert.equal(response.headers['cache-control'], 'no-store');
  return response.json<RelationReviewResponse>();
}
function decision(current: RelationReviewResponse, overrides: Partial<RelationReviewRequest> = {}): RelationReviewRequest {
  return { eventId: 'decision', applicationEventId: current.applicationEventId, conceptId: current.conceptId, occurredAt: '2026-01-09T12:00:00.000Z', previousEventId: current.history.latest?.eventId ?? null, status: 'resolved', note: ' human inspected ', basis: current.basis, ...overrides };
}
async function submit(client: RunningApp, headers: Record<string, string>, body: RelationReviewRequest, cookie?: string) {
  return client.request('/api/relation-reviews', { method: 'POST', headers, body, cookie });
}
function betaRelations(client: RunningApp, lines: string) {
  writeFileSync(join(client.root, 'Math', 'Beta.md'), conceptFile('Beta', '另一个可用于测试的概念。') + '\n## 关系网络\n' + lines);
  client.app.livingMemory.refresh();
}

test('relation-review API compares directed exact tuples and allows graph adoption with unchanged primary revision', async () => {
  const client = await running();
  try {
    const headers = tokenHeaders(await session(client)); const initial = await snapshot(client);
    const primaryRevision = conceptAt(initial).source.revision;
    for (const operation of ['add', 'change', 'remove'] as const) {
      const relation = proposal(initial, operation, true);
      if ('after' in relation) relation.after = { type: initial.links.find((edge) => edge.description === 'first')!.type, description: 'new exact description' };
      const result = await post(client, headers, record(initial, relation, operation)); assert.equal(result.status, 201, result.body);
    }
    const before = await review(client, 'change'); assert.equal(before.basis.beforePresent, true); assert.equal(before.basis.afterPresent, false);
    const unmatched = await submit(client, headers, decision(before)); assert.equal(unmatched.status, 409); assert.equal(errorCode(unmatched), 'RELATION_REVIEW_NOT_MATCHED');
    // A different tuple, reverse direction and similar description never satisfy exact adoption.
    betaRelations(client, '- 应用：[[Math/Alpha.md]] — wrong description\n- 相关：[[Math/Alpha.md]] — reverse\n');
    assert.equal((await review(client, 'change')).basis.afterPresent, false);
    betaRelations(client, '- 应用：[[Math/Alpha.md]] — new exact description\n- 相关：[[Math/Alpha.md]] — reverse\n');
    const coexist = await review(client, 'change'); assert.equal(coexist.basis.beforePresent, true); assert.equal(coexist.basis.afterPresent, true);
    const oldStillPresent = await submit(client, headers, decision(coexist, { eventId: 'coexists' })); assert.equal(oldStillPresent.status, 409); assert.equal(errorCode(oldStillPresent), 'RELATION_REVIEW_NOT_MATCHED');
    betaRelations(client, '- 应用：[[Math/Alpha.md]] — new exact description\n- 其他：[[Math/Alpha.md]] — unrelated same pair\n');
    assert.equal(conceptAt(await snapshot(client)).source.revision, primaryRevision);
    for (const operation of ['add', 'change', 'remove']) {
      const current = await review(client, operation);
      assert.equal(current.basis.beforePresent, operation === 'add' ? null : false);
      assert.equal(current.basis.afterPresent, operation === 'remove' ? null : true);
      const saved = await submit(client, headers, decision(current, { eventId: `resolved-${operation}` })); assert.equal(saved.status, 201, saved.body);
    }
    const exported = (await client.request('/api/export')).json<ExportData>();
    assert.equal(exported.relationReviews?.length, 3); assert.deepEqual(exported.corrections, []);
  } finally { await client.stop(); }
});

test('relation-review API source CAS, chain CAS and accepted canonical retries remain independent', async () => {
  const client = await running();
  try {
    const headers = tokenHeaders(await session(client)); const initial = await snapshot(client);
    assert.equal((await post(client, headers, record(initial, proposal(initial, 'remove', true), 'remove'))).status, 201);
    const old = await review(client, 'remove');
    betaRelations(client, '');
    const stale = await submit(client, headers, decision(old, { eventId: 'stale-source' })); assert.equal(stale.status, 409); assert.equal(errorCode(stale), 'RELATION_REVIEW_SOURCE_CHANGED');
    const current = await review(client, 'remove');
    const forged = decision(current, { eventId: 'forged' }); forged.basis = structuredClone(forged.basis); forged.basis.target.current!.title += ' forged';
    const rejected = await submit(client, headers, forged); assert.equal(rejected.status, 409); assert.equal(errorCode(rejected), 'RELATION_REVIEW_SOURCE_CHANGED');
    const original = decision(current); assert.equal((await submit(client, headers, original)).status, 201);
    const next = decision(await review(client, 'remove'), { eventId: 'reopened', status: 'open' }); assert.equal((await submit(client, headers, next)).status, 201);
    const staleChain = await submit(client, headers, decision(current, { eventId: 'stale-chain', status: 'open' })); assert.equal(staleChain.status, 409); assert.equal(errorCode(staleChain), 'RELATION_REVIEW_CONFLICT');
    betaRelations(client, '- 相关：[[Math/Alpha.md]] — reverse\n');
    const duplicate = await submit(client, headers, original); assert.equal(duplicate.status, 200, duplicate.body); assert.equal(duplicate.json<{ status: string }>().status, 'duplicate');
    const conflict = await submit(client, headers, { ...original, note: 'different' }); assert.equal(conflict.status, 409); assert.equal(errorCode(conflict), 'EVENT_CONFLICT');
    assert.equal((await review(client, 'remove')).history.total, 2);
  } finally { await client.stop(); }
});

test('missing secondary endpoint retains identity and requires human open/dismissed instead of resolved removal', async () => {
  const client = await running();
  try {
    const headers = tokenHeaders(await session(client)); const initial = await snapshot(client);
    assert.equal((await post(client, headers, record(initial, proposal(initial, 'remove'), 'missing-target'))).status, 201);
    const beta = conceptAt(initial, 'Math/Beta.md'); unlinkSync(join(client.root, 'Math', 'Beta.md')); client.app.livingMemory.refresh();
    const current = await review(client, 'missing-target');
    assert.deepEqual(current.basis.target, { conceptId: beta.id, current: null }); assert.equal(current.basis.beforePresent, null); assert.equal(current.basis.afterPresent, null);
    const resolved = await submit(client, headers, decision(current)); assert.equal(resolved.status, 409); assert.equal(errorCode(resolved), 'RELATION_REVIEW_NOT_MATCHED');
    assert.equal((await submit(client, headers, decision(current, { eventId: 'dismissed', status: 'dismissed' }))).status, 201);
    assert.equal((await submit(client, headers, decision(await review(client, 'missing-target'), { eventId: 'open-again', status: 'open' }))).status, 201);
  } finally { await client.stop(); }
});

test('relation review reads and writes preserve nonempty memory/config/layout/plan and original files', async () => {
  const client = await running();
  try {
    const headers = tokenHeaders(await session(client)); const initial = await snapshot(client); const concept = conceptAt(initial);
    const common = { conceptId: concept.id, sourceRevision: concept.source.revision };
    assert.equal((await client.request('/api/reviews', { method: 'POST', headers, body: { ...common, eventId: 'anchor', kind: 'review', occurredAt: '2026-01-07T00:00:00Z' } })).status, 201);
    assert.equal((await client.request('/api/retentions', { method: 'POST', headers, body: { ...common, eventId: 'retained', active: true, previousEventId: null, occurredAt: '2026-01-08T00:00:00Z' } })).status, 201);
    assert.equal((await client.request('/api/config', { method: 'PUT', headers, body: { halfLifeDays: 9, revision: initial.config.revision } })).status, 200);
    const configured = await snapshot(client);
    assert.equal((await client.request('/api/observations', { method: 'POST', headers, body: { ...common, eventId: 'observation', observedAt: '2026-01-09T00:00:00Z', configRevision: configured.config.revision, anchorEventId: 'anchor', answer: 'synthetic', rating: 'partial', exposure: 'unexposed', observedExposure: false } })).status, 201);
    assert.equal((await client.request('/api/layout', { method: 'PUT', headers, body: { [concept.id]: { x: 1, y: 2, z: 3 } } })).status, 200);
    assert.equal((await client.request('/api/review-plan', { method: 'PUT', headers, body: { revision: 0, dailyBudget: 7 } })).status, 200);
    assert.equal((await client.request('/api/review-plan', { method: 'PUT', headers, body: { revision: 1, concept: { ...common, focus: true, deferUntil: null } } })).status, 200);
    const appResult = await post(client, headers, record(initial, proposal(initial, 'remove'), 'safe')); assert.equal(appResult.status, 201, appResult.body);
    const before = (await client.request('/api/export')).json<ExportData>(); const files = ['Alpha', 'Beta'].map(name => readFileSync(join(client.root, 'Math', `${name}.md`), 'utf8')); const states = (await snapshot(client)).states;
    for (let count = 0; count < 3; count++) assert.equal((await review(client, 'safe')).history.total, 0);
    const wrongRead = await client.request('/api/applications/safe/relation-review', { headers: { 'x-lm-source-id': 'wrong' } }); assert.equal(wrongRead.status, 409); assert.equal(errorCode(wrongRead), 'SOURCE_MISMATCH');
    const wrongSource = await submit(client, { ...headers, 'x-lm-source-id': 'wrong' }, decision(await review(client, 'safe'), { status: 'open' })); assert.equal(wrongSource.status, 409); assert.equal(errorCode(wrongSource), 'SOURCE_MISMATCH');
    const untouched = (await client.request('/api/export')).json<ExportData>(); assert.deepEqual(untouched, before);
    const current = await review(client, 'safe'); assert.equal((await submit(client, headers, decision(current, { status: 'open' }))).status, 201);
    const after = (await client.request('/api/export')).json<ExportData>();
    for (const key of ['anchors', 'observations', 'retentions', 'config', 'configHistory', 'layout', 'reviewPlan', 'applications', 'corrections'] as const) assert.deepEqual(after[key], before[key]);
    assert.deepEqual((await snapshot(client)).states, states); assert.deepEqual(['Alpha', 'Beta'].map(name => readFileSync(join(client.root, 'Math', `${name}.md`), 'utf8')), files);
    const primary = (await client.request(`/api/concepts/${encodeURIComponent(concept.id)}/history`)).json<ConceptHistory>(); assert.equal(primary.correctionCount, 0);
    const secondary = (await client.request(`/api/concepts/${encodeURIComponent(conceptAt(initial, 'Math/Beta.md').id)}/history`)).json<ConceptHistory>(); assert.equal(secondary.total, 0);
  } finally { await client.stop(); }
});

test('relation review uses full index beyond display cap and hides other account applications', async () => {
  const client = await running({ limit: 1 });
  try {
    const headers = tokenHeaders(await session(client)); const full = await snapshot(client);
    assert.equal((await client.request('/api/snapshot')).json<Snapshot>().concepts.length, 1);
    assert.equal((await post(client, headers, record(full, proposal(full, 'remove', true), 'outside'))).status, 201);
    assert.equal((await review(client, 'outside')).basis.source.current?.conceptId, conceptAt(full, 'Math/Beta.md').id);
    betaRelations(client, '');
    assert.equal((await submit(client, headers, decision(await review(client, 'outside')))).status, 201);
  } finally { await client.stop(); }
  const accounts = await running({ accountsEnabled: true });
  try {
    const setup = await accounts.request('/api/auth/setup', { method: 'POST', body: { username: 'owner', password: 'synthetic-owner-password' } }); assert.equal(setup.status, 201);
    const ownerCookie = String(setup.headers['set-cookie']).split(';', 1)[0]; const ownerHeaders = tokenHeaders(await session(accounts, ownerCookie)); const owner = await snapshot(accounts, ownerCookie);
    assert.equal((await post(accounts, ownerHeaders, record(owner, proposal(owner, 'remove'), 'private'), ownerCookie)).status, 201);
    const created = await accounts.request('/api/admin/users', { method: 'POST', cookie: ownerCookie, headers: ownerHeaders, body: { username: 'member', password: 'synthetic-member-password' } }); assert.equal(created.status, 201);
    const login = await accounts.request('/api/auth/login', { method: 'POST', body: { username: 'member', password: 'synthetic-member-password' } }); assert.equal(login.status, 200);
    const cookie = String(login.headers['set-cookie']).split(';', 1)[0]; const headers = tokenHeaders(await session(accounts, cookie));
    const hidden = await accounts.request('/api/applications/private/relation-review', { cookie }); assert.equal(hidden.status, 404); assert.equal(errorCode(hidden), 'APPLICATION_NOT_FOUND');
    const foreign = await submit(accounts, headers, decision(await review(accounts, 'private', ownerCookie)), cookie); assert.equal(foreign.status, 409); assert.equal(errorCode(foreign), 'APPLICATION_NOT_FOUND');
  } finally { await accounts.stop(); }
});
