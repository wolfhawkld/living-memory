import { strict as assert } from 'node:assert';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
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

test('directed add/change/remove suggestions export their full context without warming memory or editing source', async () => {
  const client = await running();
  try {
    const headers = tokenHeaders(await session(client)); const baseline = await snapshot(client);
    const concept = conceptAt(baseline);
    const common = { conceptId: concept.id, sourceRevision: concept.source.revision };
    assert.equal((await client.request('/api/reviews', { method: 'POST', headers, body: {
      ...common, eventId: 'existing-anchor', kind: 'review', occurredAt: '2026-01-07T00:00:00Z',
    } })).status, 201);
    assert.equal((await client.request('/api/retentions', { method: 'POST', headers, body: {
      ...common, eventId: 'existing-retention', active: true, previousEventId: null, occurredAt: '2026-01-08T00:00:00Z',
    } })).status, 201);
    assert.equal((await client.request('/api/config', { method: 'PUT', headers, body: {
      halfLifeDays: baseline.config.halfLifeDays + 1, revision: baseline.config.revision,
    } })).status, 200);
    const configured = await snapshot(client);
    assert.equal((await client.request('/api/observations', { method: 'POST', headers, body: {
      ...common, eventId: 'existing-observation', observedAt: '2026-01-09T00:00:00Z',
      configRevision: configured.config.revision, anchorEventId: 'existing-anchor', answer: 'original recall',
      rating: 'partial', exposure: 'unexposed', observedExposure: false,
    } })).status, 201);
    assert.equal((await client.request('/api/layout', { method: 'PUT', headers,
      body: { [concept.id]: { x: 1, y: 2, z: 3 } } })).status, 200);
    const initial = await snapshot(client);
    const files = ['Alpha', 'Beta'].map(name => readFileSync(join(client.root, 'Math', `${name}.md`), 'utf8'));
    const before = (await client.request('/api/export')).json<ExportData>();
    const requests = (['add', 'change', 'remove'] as const).flatMap(operation => [false, true].map(reverse =>
      record(initial, proposal(initial, operation, reverse), `${operation}-${reverse}`)));
    for (const request of requests) { const result = await post(client, headers, request); assert.equal(result.status, 201, result.body); }
    const after = (await client.request('/api/export')).json<ExportData>();
    assert.deepEqual(after.applications?.map(item => item.relationSuggestion).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      requests.map(item => item.relationSuggestion).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
    for (const key of ['anchors', 'observations', 'config', 'configHistory', 'retentions', 'layout'] as const) assert.deepEqual(after[key], before[key]);
    assert.deepEqual((await snapshot(client)).links, initial.links);
    assert.deepEqual((await snapshot(client)).states, initial.states);
    assert.deepEqual(['Alpha', 'Beta'].map(name => readFileSync(join(client.root, 'Math', `${name}.md`), 'utf8')), files);
    const primary = (await client.request(`/api/concepts/${encodeURIComponent(conceptAt(initial).id)}/history`)).json<ConceptHistory>();
    const secondary = (await client.request(`/api/concepts/${encodeURIComponent(conceptAt(initial, 'Math/Beta.md').id)}/history`)).json<ConceptHistory>();
    assert.equal(primary.total, 9); assert.equal(secondary.total, 0);
    assert.equal(primary.correctionCount, 0);
    assert.deepEqual(after.corrections ?? [], before.corrections ?? []);
  } finally { await client.stop(); }
});

test('both endpoint metadata must match current source; nonexistent endpoints are rejected', async () => {
  const client = await running();
  try {
    const headers = tokenHeaders(await session(client)); const initial = await snapshot(client);
    const relation = proposal(initial, 'add'); let counter = 0;
    for (const side of ['source', 'target'] as const) {
      for (const field of ['sourceRevision', 'title', 'path'] as const) {
        const changed = structuredClone(relation); changed[side][field] += '-changed';
        const response = await post(client, headers, record(initial, changed, `mismatch-${counter++}`));
        assert.ok(response.status >= 400, response.body);
        // A parent endpoint revision mismatch is rejected by request schema before source lookup.
        if (!(side === 'source' && field === 'sourceRevision')) {
          assert.equal(response.status, 409, response.body); assert.equal(errorCode(response), 'SOURCE_REVISION_MISMATCH');
        }
      }
    }
    const missing = structuredClone(relation); missing.target.conceptId = 'nonexistent';
    const rejected = await post(client, headers, record(initial, missing, 'missing'));
    assert.equal(rejected.status, 404, rejected.body); assert.equal(errorCode(rejected), 'CONCEPT_NOT_FOUND');
    assert.equal((await client.request('/api/export')).json<ExportData>().applications?.length, 0);
  } finally { await client.stop(); }
});

test('before matches exact directed type and description; duplicate after is not a new relation', async () => {
  const client = await running();
  try {
    const headers = tokenHeaders(await session(client)); const initial = await snapshot(client);
    const a = conceptAt(initial); const b = conceptAt(initial, 'Math/Beta.md');
    const edges = initial.links.filter(edge => edge.source === a.id && edge.target === b.id);
    assert.equal(edges.length, 2); assert.notEqual(edges[0].type, edges[1].type);
    for (const operation of ['change', 'remove'] as const) {
      for (const field of ['type', 'description'] as const) {
        const relation = proposal(initial, operation);
        if (relation.operation === 'add') throw new Error('fixture');
        relation.before[field] += '-missing';
        const result = await post(client, headers, record(initial, relation, `${operation}-${field}`));
        assert.equal(result.status, 409, result.body); assert.equal(errorCode(result), 'RELATION_SOURCE_CHANGED');
      }
    }
    const add = proposal(initial, 'add');
    if (add.operation !== 'add') throw new Error('fixture');
    add.after = { type: edges[0].type, description: edges[0].description };
    const change = proposal(initial, 'change');
    if (change.operation !== 'change') throw new Error('fixture');
    change.after = { type: edges[1].type, description: edges[1].description };
    for (const [i, relation] of [add, change].entries()) {
      const result = await post(client, headers, record(initial, relation, `duplicate-edge-${i}`));
      assert.equal(result.status, 409, result.body); assert.equal(errorCode(result), 'RELATION_SOURCE_CHANGED');
    }
    const exactOther = { operation: 'remove' as const, source: endpoint(a), target: endpoint(b),
      before: { type: edges[1].type, description: edges[1].description } };
    const result = await post(client, headers, record(initial, exactOther, 'exact-second-type'));
    assert.equal(result.status, 201, result.body);
  } finally { await client.stop(); }
});

test('full index and links validate endpoints outside display cap', async () => {
  const fixture = sourceFixture(); const client = await running({ ...fixture, limit: 1 });
  try {
    const headers = tokenHeaders(await session(client));
    const limited = (await client.request('/api/snapshot')).json<Snapshot>(); assert.equal(limited.concepts.length, 1);
    assert.equal(limited.links.length, 0);
    const full = await snapshot(client); assert.equal(full.concepts.length, 2);
    const relation = proposal(full, 'remove');
    const result = await post(client, headers, record(full, relation, 'outside-cap'));
    assert.equal(result.status, 201, result.body);
  } finally { await client.stop(); fixture.cleanup(); }
});

test('accepted frozen suggestions remain duplicates after endpoint or edge changes; any changed payload conflicts', async () => {
  const client = await running();
  try {
    const headers = tokenHeaders(await session(client)); const initial = await snapshot(client);
    const body = record(initial, proposal(initial, 'change'), 'frozen-retry');
    assert.equal((await post(client, headers, body)).status, 201);
    writeFileSync(join(client.root, 'Math', 'Alpha.md'), conceptFile('Alpha', 'changed without edges'));
    writeFileSync(join(client.root, 'Math', 'Beta.md'), conceptFile('Beta renamed', 'changed endpoint'));
    await client.request('/api/refresh', { method: 'POST', headers, body: {} });
    const duplicate = await post(client, headers, body); assert.equal(duplicate.status, 200, duplicate.body);
    assert.equal(duplicate.json<{status: string}>().status, 'duplicate');
    const stale = await post(client, headers, { ...body, eventId: 'stale-new' });
    assert.equal(stale.status, 409); assert.equal(errorCode(stale), 'SOURCE_REVISION_MISMATCH');
    for (const mutate of [
      (r: RelationSuggestion) => { r.target.title += '-different'; },
      (r: RelationSuggestion) => { if (r.operation === 'change') r.before.description += '-different'; },
      (r: RelationSuggestion) => { if (r.operation === 'change') r.after.type += '-different'; },
    ]) {
      const changed = structuredClone(body); mutate(changed.relationSuggestion!);
      const conflict = await post(client, headers, changed);
      assert.equal(conflict.status, 409, conflict.body); assert.equal(errorCode(conflict), 'EVENT_CONFLICT');
    }
  } finally { await client.stop(); }
});

test('secondary endpoints cannot cross private account knowledge spaces', async () => {
  const fixture = sourceFixture(); const client = await running({ ...fixture, accountsEnabled: true });
  try {
    const setup = await client.request('/api/auth/setup', { method: 'POST', body: { username: 'owner', password: 'synthetic-owner-password' } });
    assert.equal(setup.status, 201);
    const ownerCookie = String(setup.headers['set-cookie']).split(';', 1)[0];
    const ownerHeaders = tokenHeaders(await session(client, ownerCookie)); const owner = await snapshot(client, ownerCookie);
    const user = await client.request('/api/admin/users', { method: 'POST', cookie: ownerCookie, headers: ownerHeaders,
      body: { username: 'member', password: 'synthetic-member-password' } });
    assert.equal(user.status, 201);
    const memberRoot = join(fixture.dataDir, 'users', user.json<{user: {id: string}}>().user.id, 'knowledge');
    mkdirSync(join(memberRoot, 'Math'), { recursive: true });
    writeFileSync(join(memberRoot, 'Math', 'Alpha.md'), conceptFile('Alpha', 'member only'));
    const login = await client.request('/api/auth/login', { method: 'POST', body: { username: 'member', password: 'synthetic-member-password' } });
    assert.equal(login.status, 200);
    const cookie = String(login.headers['set-cookie']).split(';', 1)[0]; const headers = tokenHeaders(await session(client, cookie));
    await client.request('/api/refresh', { method: 'POST', headers, cookie, body: {} });
    const member = await snapshot(client, cookie); const primary = conceptAt(member);
    const foreign: RelationSuggestion = { operation: 'add', source: endpoint(primary), target: endpoint(conceptAt(owner, 'Math/Beta.md')),
      after: { type: 'related', description: 'cross-account forbidden' } };
    const result = await post(client, headers, baseApplication(primary, { eventId: 'foreign-secondary', correction: '', relationSuggestion: foreign }), cookie);
    assert.equal(result.status, 404, result.body); assert.equal(errorCode(result), 'CONCEPT_NOT_FOUND');
    assert.equal((await client.request('/api/export', { cookie })).json<ExportData>().applications?.length, 0);
    assert.equal((await client.request('/api/export', { cookie: ownerCookie })).json<ExportData>().applications?.length, 0);
  } finally { await client.stop(); fixture.cleanup(); }
});
