import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync, statSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { recordCliActivity, retryCliActivity, clearLocalCliActivity, type CliActivityOptions } from '../src/cli/activity';
import { runCli } from '../src/cli/index';
import type { ActivityAppendRequest, ActivityAppendResult, ActivitySettings } from '../src/shared/activity';
import type { Concept, Snapshot } from '../src/shared/types';

const concept: Concept = { id: 'concept-1', title: 'Alpha', aliases: ['first'], domain: 'Math', summary: 'private summary', body: 'private original body', source: { path: 'Math/Alpha.md', revision: 'revision-1' } };
const ack = (request: ActivityAppendRequest): ActivityAppendResult => ({ status: 'accepted', epoch: request.epoch, eventId: request.event.eventId, receivedAt: '2026-10-16T08:01:00Z' });
function fixture() {
  const stateDir = mkdtempSync(join(tmpdir(), 'lm-cli-activity-'));
  let current: ActivitySettings = { enabled: true, epoch: 0, revision: 0 };
  const requests: ActivityAppendRequest[] = [];
  const options: CliActivityOptions = { stateDir, now: () => new Date('2026-10-16T08:00:00Z'), transport: {
    scope: { baseUrl: 'http://127.0.0.1:4317', principalId: 'alice', sourceId: 'source-alice', instanceId: 'legacy' },
    getSettings: async () => current,
    append: async (request) => { requests.push(structuredClone(request)); return ack(request); },
  } };
  return { stateDir, options, requests, settings: (value: ActivitySettings) => { current = value; },
    files: () => { try { return readdirSync(join(stateDir, 'activity')).filter(name => name.endsWith('.json')); } catch { return []; } },
    read: (name: string) => readFileSync(join(stateDir, 'activity', name), 'utf8'), close: () => rmSync(stateDir, { recursive: true, force: true }) };
}
const fail = (code: string) => { throw Object.assign(new Error('secret diagnostic that must never be returned'), { code }); };

test('disabled or unavailable settings collect no local payload, while default pending receipts omit query, summary and body', async () => {
  const f = fixture();
  try {
    f.settings({ enabled: false, epoch: 1, revision: 1 });
    assert.equal((await recordCliActivity(f.options, { kind: 'query', concepts: [concept], resultCount: 1 })).status, 'disabled');
    assert.deepEqual(readdirSync(f.stateDir), []);
    f.settings({ enabled: true, epoch: 1, revision: 2 });
    f.options.transport.append = async () => fail('NETWORK_ERROR');
    const result = await recordCliActivity(f.options, { kind: 'query', concepts: [concept], resultCount: 1 });
    assert.equal(result.status, 'pending');
    const text = f.read(f.files()[0]);
    assert.doesNotMatch(text, /queryText|private summary|private original body|secret diagnostic/);
    assert.equal(statSync(join(f.stateDir, 'activity')).mode & 0o777, 0o700);
    assert.equal(statSync(join(f.stateDir, 'activity', f.files()[0])).mode & 0o777, 0o600);
    const unavailable = { ...f.options, transport: { ...f.options.transport, getSettings: async () => fail('AUTH_REQUIRED') } };
    assert.deepEqual(await recordCliActivity(unavailable, { kind: 'show', concept }), { status: 'unavailable', code: 'AUTH_REQUIRED' });
    assert.equal(f.files().length, 1);
  } finally { f.close(); }
});

test('explicit query opt-in is frozen once and retries replay only unacknowledged original envelopes', async () => {
  const f = fixture();
  try {
    const seen: ActivityAppendRequest[] = [];
    f.options.transport.append = async request => { seen.push(structuredClone(request)); if (seen.length === 2) return fail('TIMEOUT'); return ack(request); };
    const first = await recordCliActivity(f.options, { kind: 'query', concepts: [concept], resultCount: 1, queryText: '主动保存的查询' });
    assert.equal(first.status, 'pending'); assert.equal(first.pending, 1);
    assert.match(f.read(f.files()[0]), /主动保存的查询/);
    f.options.now = () => new Date('2026-12-01T00:00:00Z');
    const retried = await retryCliActivity(f.options, first.operationId!);
    assert.equal(retried.status, 'recorded'); assert.deepEqual(seen[2], seen[1]);
    assert.equal(seen.length, 3); assert.equal(f.files().length, 0);
    assert.equal(seen[0].event.kind, 'query.submitted'); assert.equal(seen[1].event.kind, 'content.delivery');
    if (seen[1].event.kind === 'content.delivery') assert.deepEqual(seen[1].event.payload, { medium: 'cli-result', outcome: 'prepared', coverage: 'results' });
  } finally { f.close(); }
});

test('hook markers keep original event time and prevent duplicate or cross-epoch re-creation', async () => {
  const f = fixture();
  try {
    const input = { kind: 'after', operationId: 'ingest-operation', workflow: 'ingest' } as const;
    const first = await recordCliActivity(f.options, input);
    f.options.now = () => new Date('2026-12-01T00:00:00Z');
    assert.equal((await recordCliActivity(f.options, input)).status, 'recorded');
    assert.equal(f.requests.length, 1); assert.equal(first.operationId, 'hook:ingest-operation');
    const marker = f.read(f.files()[0]); assert.match(marker, /2026-10-16/); assert.doesNotMatch(marker, /requests|queryText|refs/);
    assert.equal((await recordCliActivity(f.options, { ...input, workflow: 'query' })).code, 'ACTIVITY_CONFLICT');
    f.settings({ enabled: true, epoch: 1, revision: 1 });
    assert.equal((await recordCliActivity(f.options, input)).status, 'discarded');
    assert.equal((await recordCliActivity(f.options, input)).status, 'discarded');
    assert.equal(f.requests.length, 1);
  } finally { f.close(); }
});

test('terminal deletion/epoch/disable remove sensitive pending data, conflicts quarantine and authentication failures stay pending', async () => {
  for (const code of ['ACTIVITY_DELETED', 'ACTIVITY_EPOCH_CHANGED', 'ACTIVITY_DISABLED', 'ACTIVITY_CONFLICT', 'INVALID_ACTIVITY', 'AUTH_REQUIRED', 'ACTIVITY_CHANNEL_FORBIDDEN']) {
    const f = fixture();
    try {
      f.options.transport.append = async () => fail(code);
      const result = await recordCliActivity(f.options, { kind: 'query', concepts: [], resultCount: 0, queryText: 'sensitive' });
      if (['ACTIVITY_DELETED', 'ACTIVITY_EPOCH_CHANGED', 'ACTIVITY_DISABLED'].includes(code)) {
        assert.equal(result.status, 'discarded'); assert.equal(f.files().length, 0);
      } else if (['ACTIVITY_CONFLICT', 'INVALID_ACTIVITY', 'ACTIVITY_CHANNEL_FORBIDDEN'].includes(code)) {
        assert.equal(result.status, 'quarantined');
        let posted = 0; f.options.transport.append = async request => { posted += 1; return ack(request); };
        assert.equal((await retryCliActivity(f.options, result.operationId!)).status, 'quarantined'); assert.equal(posted, 0);
      } else assert.equal(result.status, 'pending');
    } finally { f.close(); }
  }
});

test('receipt lookup and local clearing isolate principal, source, server and restored instance without touching learning receipts', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.stateDir, 'learning-receipt.json'), 'learning unchanged');
    f.options.transport.append = async () => fail('TIMEOUT');
    const saved = await recordCliActivity(f.options, { kind: 'show', concept });
    for (const part of [{ principalId: 'bob' }, { sourceId: 'source-bob' }, { baseUrl: 'http://127.0.0.1:9999' }, { instanceId: 'restored-instance' }]) {
      const other = { ...f.options, transport: { ...f.options.transport, scope: { ...f.options.transport.scope, ...part } } };
      assert.equal((await retryCliActivity(other, saved.operationId!)).code, 'ACTIVITY_RECEIPT_NOT_FOUND');
      assert.equal((await clearLocalCliActivity(other)).cleared, 0);
      assert.equal(f.files().length, 1);
    }
    assert.equal((await clearLocalCliActivity(f.options)).cleared, 1);
    assert.equal(readFileSync(join(f.stateDir, 'learning-receipt.json'), 'utf8'), 'learning unchanged');
  } finally { f.close(); }
});

test('independent SQLite lease rejects simultaneous writers immediately and releases after the holder closes', async () => {
  const f = fixture();
  const dir = join(f.stateDir, 'activity'); mkdirSync(dir, { mode: 0o700 });
  const leasePath = join(dir, '.lease.sqlite'); const blocker = new DatabaseSync(leasePath); chmodSync(leasePath, 0o600);
  try {
    blocker.exec('BEGIN IMMEDIATE');
    assert.equal((await recordCliActivity(f.options, { kind: 'show', concept })).code, 'ACTIVITY_LOCAL_BUSY');
    assert.equal(f.requests.length, 0); blocker.close();
    assert.equal((await recordCliActivity(f.options, { kind: 'show', concept })).status, 'recorded');
    assert.equal(f.requests.length, 2);
  } finally { try { blocker.close(); } catch { /* already closed */ } f.close(); }
});

test('UTF8 byte capacity is enforced before reaching the count cap without dropping older pending receipts', async () => {
  const f = fixture();
  try {
    f.options.transport.append = async () => fail('TIMEOUT');
    const concepts = Array.from({ length: 15 }, (_, index) => ({ ...concept, id: `concept-${index}`, title: '知'.repeat(250), source: { revision: 'rev', path: `${'文'.repeat(650)}-${index}.md` } }));
    let result;
    for (let index = 0; index < 20; index += 1) {
      result = await recordCliActivity(f.options, { kind: 'query', concepts, resultCount: 15 });
      if (result.status === 'unavailable') break;
    }
    assert.equal(result!.code, 'ACTIVITY_LOCAL_CAPACITY');
    assert.ok(f.files().length > 0 && f.files().length < 100);
    assert.ok(f.files().reduce((sum, name) => sum + Buffer.byteLength(f.read(name), 'utf8'), 0) <= 512 * 1024);
  } finally { f.close(); }
});

test('pending count, completed hook markers and whole-directory limits reject admission without deleting earlier records', async () => {
  const f = fixture();
  try {
    f.options.transport.append = async () => fail('TIMEOUT');
    for (let index = 0; index < 100; index += 1) assert.equal((await recordCliActivity(f.options, { kind: 'show', concept })).status, 'pending');
    assert.equal((await recordCliActivity(f.options, { kind: 'show', concept })).code, 'ACTIVITY_LOCAL_CAPACITY');
    assert.equal(f.files().length, 100);
  } finally { f.close(); }
  const markers = fixture();
  try {
    await recordCliActivity(markers.options, { kind: 'after', operationId: 'first', workflow: 'ingest' });
    const first = JSON.parse(markers.read(markers.files()[0]));
    for (let index = 1; index < 1000; index += 1) {
      const operationId = `hook:marker-${index}`;
      const name = createHash('sha256').update(JSON.stringify([first.scope.baseUrl, first.scope.principalId, first.scope.sourceId, first.scope.instanceId, operationId])).digest('hex');
      writeFileSync(join(markers.stateDir, 'activity', `${name}.json`), JSON.stringify({ ...first, operationId, eventId: `marker-event-${index}` }), { mode: 0o600 });
    }
    assert.equal((await recordCliActivity(markers.options, { kind: 'after', operationId: 'overflow', workflow: 'ingest' })).code, 'ACTIVITY_LOCAL_CAPACITY');
    assert.equal(markers.files().length, 1000); assert.equal(markers.requests.length, 1);
  } finally { markers.close(); }
  const bytes = fixture();
  try {
    mkdirSync(join(bytes.stateDir, 'activity'), { mode: 0o700 });
    writeFileSync(join(bytes.stateDir, 'activity', 'orphan.tmp'), Buffer.alloc(2 * 1024 * 1024), { mode: 0o600 });
    assert.equal((await recordCliActivity(bytes.options, { kind: 'show', concept })).code, 'ACTIVITY_LOCAL_CAPACITY');
    assert.equal(bytes.requests.length, 0); assert.equal(bytes.files().length, 0);
  } finally { bytes.close(); }
});

test('large query result metadata stays bounded to the actual first fifty results and unexpected diagnostic text is suppressed', async () => {
  const f = fixture();
  try {
    const concepts = Array.from({ length: 60 }, (_, index) => ({ ...concept, id: `concept-${index}` }));
    assert.equal((await recordCliActivity(f.options, { kind: 'query', concepts, resultCount: 60 })).status, 'recorded');
    assert.equal(f.requests[0].event.refs.length, 50);
    if (f.requests[0].event.kind === 'query.submitted') assert.equal(f.requests[0].event.payload.resultCount, 60);
    f.options.transport.getSettings = async () => fail('PRIVATE_PASSWORD_VALUE');
    assert.deepEqual(await recordCliActivity(f.options, { kind: 'show', concept }), { status: 'unavailable', code: 'ACTIVITY_UNAVAILABLE' });
  } finally { f.close(); }
});

function mockCli(stateDir: string, sessionExtra: object = {}) {
  const calls: { path: string; method: string; body?: any; headers: Headers }[] = [];
  const snapshot = { concepts: [concept], links: [], states: { [concept.id]: { status: 'unknown' } }, asOf: '2026-10-16T08:00:00Z', observationsCount: 0,
    source: { name: 'synthetic', mode: 'local', conceptCount: 1, limit: 20, diagnostics: [] }, config: { modelVersion: 'time-only-v0', halfLifeDays: 7, revision: 1 } } as unknown as Snapshot;
  const fetchImpl: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname; const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, method, body, headers: new Headers(init?.headers) });
    let data: unknown;
    if (path === '/api/session') data = { writeToken: 'synthetic-write-token', sourceId: 'stable-source', user: { id: 'alice' }, ...sessionExtra };
    else if (path === '/api/refresh') data = { status: 'refreshed' };
    else if (path === '/api/snapshot') data = snapshot;
    else if (path === '/api/activity/settings') data = { sourceId: 'stable-source', settings: { enabled: true, epoch: 0, revision: 0 } };
    else if (path === '/api/activity/cli') data = ack(body);
    else throw new Error('Unexpected synthetic request');
    return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, snapshot, runner: { stateDir, fetchImpl, env: {}, now: () => new Date('2026-10-16T08:00:00Z') } };
}

test('CLI query/show retain original results, record only prepared delivery and never write learning endpoints', async () => {
  const f = fixture(); const mock = mockCli(f.stateDir, { instanceId: 'instance-new' });
  const before = JSON.stringify(mock.snapshot);
  try {
    const query = await runCli(['query', 'Alpha'], mock.runner) as any;
    assert.equal(query.hits[0].id, concept.id); assert.equal(query.query, 'Alpha');
    const show = await runCli(['show', concept.id], mock.runner) as any;
    assert.deepEqual(show.concept, concept);
    const writes = mock.calls.filter(call => call.method === 'POST');
    assert.ok(writes.every(call => ['/api/refresh', '/api/activity/cli'].includes(call.path)));
    assert.ok(writes.every(call => call.headers.get('x-lm-instance-id') === 'instance-new'));
    const activities = writes.filter(call => call.path === '/api/activity/cli').map(call => call.body);
    assert.deepEqual(activities.map(item => item.event.kind), ['query.submitted', 'content.delivery', 'query.selected', 'content.delivery']);
    assert.ok(activities.every(item => item.event.actor.kind === 'unknown'));
    assert.doesNotMatch(JSON.stringify(activities), /queryText|private original body|private summary/);
    assert.equal(JSON.stringify(mock.snapshot), before);
    const optin = await runCli(['query', 'Alpha', '--save-query'], mock.runner) as any;
    assert.equal(optin.activity.status, 'recorded');
    const saved = mock.calls.filter(call => call.path === '/api/activity/cli').at(-2)!.body;
    assert.equal(saved.event.payload.queryText, 'Alpha'); assert.equal(saved.event.payload.queryTextSavedByUser, true);
    await assert.rejects(runCli(['show', 'Alpha', '--save-query'], mock.runner), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(runCli(['query', 'x'.repeat(1001), '--save-query'], mock.runner), { code: 'INVALID_ARGUMENT' });
  } finally { f.close(); }
});

test('CLI root validation accepts additive physical fingerprints with stable source IDs and preserves legacy namespace checks', async () => {
  const f = fixture();
  const fingerprint = createHash('sha256').update(realpathSync(f.stateDir)).digest('hex');
  try {
    const current = mockCli(f.stateDir, { sourceRootFingerprint: fingerprint, instanceId: 'restored' });
    assert.equal((await runCli(['show', 'Alpha', '--source-root', f.stateDir], current.runner) as any).concept.id, concept.id);
    const wrong = mockCli(f.stateDir, { sourceRootFingerprint: '0'.repeat(64) });
    await assert.rejects(runCli(['show', 'Alpha', '--source-root', f.stateDir], wrong.runner), { code: 'SOURCE_MISMATCH' });
    const legacy = mockCli(f.stateDir, { sourceId: `kg_${fingerprint.slice(0, 48)}` });
    // Status has no activity calls, so this verifies the original protocol alone.
    assert.equal((await runCli(['status', '--source-root', f.stateDir], legacy.runner) as any).sourceId, `kg_${fingerprint.slice(0, 48)}`);
    const malformed = mockCli(f.stateDir, { sourceRootFingerprint: 'bad' });
    await assert.rejects(runCli(['status'], malformed.runner), { code: 'SESSION_INVALID' });
  } finally { f.close(); }
});

test('CLI activity retry only replays frozen activity and local clear requires explicit confirmation', async () => {
  const f = fixture(); const mock = mockCli(f.stateDir); const base = mock.runner.fetchImpl;
  let failing = true;
  mock.runner.fetchImpl = async (input, init) => {
    if (failing && new URL(String(input)).pathname === '/api/activity/cli') throw new Error('synthetic offline');
    return base(input, init);
  };
  try {
    const first = await runCli(['query', 'Alpha', '--save-query'], mock.runner) as any;
    assert.equal(first.activity.status, 'pending');
    const beforeRetry = mock.calls.length; failing = false;
    const retry = await runCli(['activity-retry', first.activity.operationId], mock.runner) as any;
    assert.equal(retry.activity.status, 'recorded');
    assert.ok(mock.calls.slice(beforeRetry).every(call => ['/api/session', '/api/activity/settings', '/api/activity/cli'].includes(call.path)));
    await assert.rejects(runCli(['activity-clear-local'], mock.runner), { code: 'CONFIRM_REQUIRED' });
    const clear = await runCli(['activity-clear-local', '--confirm'], mock.runner) as any;
    assert.equal(clear.activity.status, 'cleared');
  } finally { f.close(); }
});

test('primary CLI reads stay successful when tracking is offline and tracing uses one shared one-second timeout budget', async () => {
  const f = fixture(); const mock = mockCli(f.stateDir);
  const base = mock.runner.fetchImpl;
  mock.runner.fetchImpl = async (input, init) => {
    if (new URL(String(input)).pathname === '/api/activity/settings') return new Promise<Response>(() => undefined);
    return base(input, init);
  };
  const began = Date.now();
  try {
    const result = await runCli(['show', 'Alpha'], mock.runner) as any;
    assert.equal(result.concept.id, concept.id); assert.equal(result.activity.status, 'unavailable');
    assert.ok(Date.now() - began < 1800);
    assert.equal(f.files().length, 0);
  } finally { f.close(); }
});

test('legacy learning receipts cannot replay into a restored instance through retry or same-event review', async () => {
  const f = fixture(); const mock = mockCli(f.stateDir, { instanceId: 'restored-instance' });
  const eventId = 'legacy-review'; const sourceId = 'stable-source';
  const path = join(f.stateDir, `${createHash('sha256').update(sourceId + eventId).digest('hex')}.json`);
  const receipt = { version: 1, sourceId, eventId, request: { eventId, conceptId: concept.id, sourceRevision: concept.source.revision,
    kind: 'review', occurredAt: '2026-10-16T08:00:00Z' }, status: 'pending', createdAt: '2026-10-16T08:00:00Z', updatedAt: '2026-10-16T08:00:00Z' };
  const bytes = JSON.stringify(receipt); writeFileSync(path, bytes, { mode: 0o600 });
  try {
    await assert.rejects(runCli(['retry', eventId], mock.runner), { code: 'INSTANCE_MISMATCH' });
    await assert.rejects(runCli(['review', 'Alpha', '--confirm', '--event-id', eventId], mock.runner), { code: 'INSTANCE_MISMATCH' });
    assert.equal(readFileSync(path, 'utf8'), bytes);
    assert.equal(mock.calls.filter(call => call.path === '/api/reviews').length, 0);
    writeFileSync(path, JSON.stringify({ ...receipt, instanceId: null }), { mode: 0o600 });
    await assert.rejects(runCli(['retry', eventId], mock.runner), { code: 'RECEIPT_INVALID' });
  } finally { f.close(); }
});

test('same-instance learning retry retains the original request and new receipts freeze the instance', async () => {
  const f = fixture(); const mock = mockCli(f.stateDir, { instanceId: 'same-instance' }); const base = mock.runner.fetchImpl;
  const posts: { request: any; instance: string | null }[] = []; let failing = true;
  mock.runner.fetchImpl = async (input, init) => {
    if (new URL(String(input)).pathname === '/api/reviews') {
      posts.push({ request: JSON.parse(String(init?.body)), instance: new Headers(init?.headers).get('x-lm-instance-id') });
      if (failing) throw new Error('synthetic offline');
      return new Response(JSON.stringify({ status: 'accepted' }), { status: 200 });
    }
    return base(input, init);
  };
  const eventId = 'same-instance-review'; const path = join(f.stateDir, `${createHash('sha256').update('stable-source' + eventId).digest('hex')}.json`);
  try {
    await assert.rejects(runCli(['review', 'Alpha', '--confirm', '--event-id', eventId], mock.runner), { code: 'NETWORK_ERROR' });
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).instanceId, 'same-instance');
    failing = false; mock.runner.now = () => new Date('2026-12-01T00:00:00Z');
    const result = await runCli(['retry', eventId], mock.runner) as any;
    assert.equal(result.response.status, 'accepted');
    assert.deepEqual(posts[1], posts[0]); assert.equal(posts[0].instance, 'same-instance');
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).status, 'succeeded');
  } finally { f.close(); }
});
