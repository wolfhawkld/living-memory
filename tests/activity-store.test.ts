import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { ActivityError, ActivityStore, type ActivityAppendContext } from '../src/server/activity-store';
import { parseActivityAppendRequest, type ActivityAppendRequest, type ActivityReference } from '../src/shared/activity';

function database() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE anchors(id TEXT PRIMARY KEY,body TEXT); INSERT INTO anchors VALUES(\'existing\',\'learning stays intact\')');
  return { db, store: new ActivityStore({ db, namespace: 'alice', now: () => new Date('2026-10-16T00:00:00.000Z') }) };
}

test('activity defaults stay virtual, settings use CAS and disabling advances the write epoch', () => {
  const { db, store } = database();
  try {
    assert.deepEqual(store.getSettings(), { enabled: true, epoch: 0, revision: 0 });
    assert.equal(db.prepare('SELECT count(*) AS count FROM activity_settings').get()!.count, 0);
    assert.deepEqual(store.updateSettings({ enabled: false, expectedRevision: 0 }), { enabled: false, epoch: 1, revision: 1 });
    assert.throws(() => store.updateSettings({ enabled: true, expectedRevision: 0 }), { code: 'ACTIVITY_SETTINGS_CHANGED' });
    assert.deepEqual(store.updateSettings({ enabled: true, expectedRevision: 1 }), { enabled: true, epoch: 1, revision: 2 });
    assert.deepEqual(store.updateSettings({ enabled: true, expectedRevision: 2 }), { enabled: true, epoch: 1, revision: 2 });
    assert.equal(db.prepare('SELECT body FROM anchors').get()!.body, 'learning stays intact');
  } finally { db.close(); }
});

const context: ActivityAppendContext = {
  principalId: 'trusted-alice', sessionKind: 'accounts', deliveryChannel: 'web', allowedOriginChannels: ['web'],
  inspectReference: () => ({ status: 'current' }),
};
function request(overrides: Partial<ActivityAppendRequest['event']> = {}, epoch = 0, deliveryId = 'delivery-1'): ActivityAppendRequest {
  return { epoch, event: { schemaVersion: 1, eventId: 'event-1', operationId: 'operation-1', stepKey: 'query-submitted',
    occurredAt: '2026-10-16T08:00:00.000Z', actor: { kind: 'user' }, channel: 'web', kind: 'query.submitted', refs: [], payload: { resultCount: overrides.refs?.length ?? 0 }, ...overrides } as ActivityAppendRequest['event'],
  delivery: { deliveryId, channel: 'web' } };
}
const reference: ActivityReference = { conceptId: 'concept-1', sourceRevision: 'revision-old', path: 'Math/A.md', scope: 'result' };

test('semantic event deduplication preserves original reception and supports several steps per operation', () => {
  const { db } = database();
  let time = '2026-10-16T09:00:00.000Z';
  const store = new ActivityStore({ db, namespace: 'alice', now: () => new Date(time) });
  try {
    const first = store.append(context, request());
    time = '2026-10-17T09:00:00.000Z';
    assert.deepEqual(store.append(context, request()), { ...first, status: 'duplicate' });
    store.append(context, request({ eventId: 'event-2', stepKey: 'query-selected', kind: 'query.selected', refs: [reference], payload: {} }, 0, 'delivery-2'));
    assert.equal(store.list().items.length, 2);
    assert.equal(store.export().deliveries.length, 2);
    assert.throws(() => store.append(context, request({ payload: { resultCount: 1 } })), { code: 'ACTIVITY_CONFLICT' });
    assert.throws(() => store.append(context, request({ eventId: 'replacement-event' }, 0, 'new-delivery')), { code: 'ACTIVITY_CONFLICT' });
    assert.throws(() => store.append(context, request({ operationId: 'other-operation', stepKey: 'other-step' })), { code: 'ACTIVITY_CONFLICT' });
    assert.equal(store.list().items.length, 2);
  } finally { db.close(); }
});

test('another trusted delivery channel adds a receipt without rewriting event origin, actor or frozen inspection', () => {
  const { db, store } = database();
  let inspected = 0;
  const initial = { ...context, inspectReference: () => { inspected += 1; return { status: 'historical-or-unresolved' as const }; } };
  const event = request({ refs: [reference] });
  try {
    const first = store.append(initial, event);
    const replay = { ...event, delivery: { deliveryId: 'delivery-cli', channel: 'cli' as const } };
    assert.equal(store.append({ ...context, principalId: 'trusted-agent', sessionKind: 'cli', deliveryChannel: 'cli', allowedOriginChannels: ['cli'],
      inspectReference: () => { throw new Error('Accepted frozen event must not be inspected again'); } }, replay).status, 'duplicate');
    assert.equal(inspected, 1);
    const record = store.list().items[0];
    assert.equal(record.receivedAt, first.receivedAt);
    assert.equal(record.event.channel, 'web');
    assert.deepEqual(record.recordedBy, { principalId: 'trusted-alice', sessionKind: 'accounts' });
    assert.deepEqual(record.referenceInspections, [{ status: 'historical-or-unresolved' }]);
    assert.deepEqual(record.event.refs, [reference]);
    assert.equal(store.export().deliveries[1].recordedBy.principalId, 'trusted-agent');
    assert.throws(() => store.append(context, replay), { code: 'ACTIVITY_CHANNEL_FORBIDDEN' });
    assert.throws(() => store.append({ ...context, allowedOriginChannels: ['cli'] }, request({ eventId: 'new', operationId: 'new' }, 0, 'new')), { code: 'ACTIVITY_CHANNEL_FORBIDDEN' });
  } finally { db.close(); }
});

test('delivery conflicts and database failures roll back the entire event transaction', () => {
  const { db, store } = database();
  try {
    store.append(context, request());
    assert.throws(() => store.append(context, request({ eventId: 'event-2', operationId: 'operation-2' })), { code: 'ACTIVITY_CONFLICT' });
    assert.equal(store.list().items.length, 1);
    db.exec("CREATE TRIGGER fail_activity_delivery BEFORE INSERT ON activity_deliveries BEGIN SELECT RAISE(ABORT,'synthetic delivery failure'); END");
    assert.throws(() => store.append(context, request({ eventId: 'event-3', operationId: 'operation-3' }, 0, 'delivery-3')), /synthetic delivery failure/);
    assert.equal(store.list().items.length, 1);
    assert.equal(store.export().deliveries.length, 1);
    assert.equal(db.prepare('SELECT body FROM anchors').get()!.body, 'learning stays intact');
  } finally { db.close(); }
});

test('operation deletion removes saved query text and all deliveries and blocks late replays including initially empty operations', () => {
  const { db, store } = database();
  try {
    store.append(context, request({ payload: { resultCount: 0, queryText: 'private explicitly saved query', queryTextSavedByUser: true } }));
    assert.equal(store.clearOperation({ operationId: 'operation-1', expectedEpoch: 0 }).deletedEvents, 1);
    assert.equal(store.export().events.length, 0); assert.equal(store.export().deliveries.length, 0);
    assert.throws(() => store.append(context, request()), { code: 'ACTIVITY_DELETED' });
    assert.equal(store.clearOperation({ operationId: 'operation-1', expectedEpoch: 0 }).deletedEvents, 0);
    const unicodeId = '操作-' + '长'.repeat(150);
    store.clearOperation({ operationId: unicodeId, expectedEpoch: 0 });
    assert.throws(() => store.append(context, request({ operationId: unicodeId })), { code: 'ACTIVITY_DELETED' });
    assert.equal(db.prepare("SELECT event_json FROM activity_events WHERE event_json LIKE '%private%'").all().length, 0);
    assert.equal(db.prepare('SELECT body FROM anchors').get()!.body, 'learning stays intact');
  } finally { db.close(); }
});

test('clear-all and disable invalidate in-flight old epochs while preserving activity history when merely disabled', () => {
  const { db, store } = database();
  try {
    store.append(context, request());
    store.updateSettings({ enabled: false, expectedRevision: 0 });
    assert.equal(store.list().items.length, 1);
    assert.throws(() => store.append(context, request()), { code: 'ACTIVITY_EPOCH_CHANGED' });
    assert.throws(() => store.append(context, request({ eventId: 'disabled', operationId: 'disabled' }, 1, 'disabled')), { code: 'ACTIVITY_DISABLED' });
    store.updateSettings({ enabled: true, expectedRevision: 1 });
    store.append(context, request({ eventId: 'epoch-1', operationId: 'new-operation' }, 1, 'epoch-1'));
    assert.equal(store.list().items.length, 2);
    assert.equal(store.clearAll({ expectedEpoch: 1 }).deletedEvents, 2);
    assert.throws(() => store.append(context, request({ eventId: 'late', operationId: 'late' }, 1, 'late')), { code: 'ACTIVITY_EPOCH_CHANGED' });
    assert.equal(store.export().events.length, 0); assert.equal(store.export().deliveries.length, 0);
  } finally { db.close(); }
});

test('activity namespaces isolate settings, events, deliveries, tombstones and exports on one shared connection', () => {
  const { db, store } = database();
  const bob = new ActivityStore({ db, namespace: 'bob' });
  try {
    store.append(context, request()); bob.append(context, request());
    store.clearOperation({ operationId: 'operation-1', expectedEpoch: 0 });
    store.updateSettings({ enabled: false, expectedRevision: 0 });
    assert.equal(bob.getSettings().enabled, true); assert.equal(bob.list().items.length, 1);
    assert.equal(store.export().deliveries.length, 0); assert.equal(bob.export().deliveries.length, 1);
    bob.clearAll({ expectedEpoch: 0 });
    assert.equal(store.getSettings().enabled, false);
  } finally { db.close(); }
});

test('pagination sorts actual instants with offset timestamps and stable event IDs without changing recorded occurredAt', () => {
  const { db, store } = database();
  try {
    for (const [eventId, occurredAt] of [['a', '2026-10-16T10:00:00+08:00'], ['b', '2026-10-16T03:00:00Z'], ['c', '2026-10-16T03:00:00Z']]) {
      store.append(context, request({ eventId, operationId: eventId, occurredAt, refs: [reference] }, 0, eventId));
    }
    const first = store.list({ limit: 1, conceptId: reference.conceptId });
    assert.equal(first.items[0].event.eventId, 'c'); assert.ok(first.nextCursor);
    const second = store.list({ limit: 1, conceptId: reference.conceptId, cursor: first.nextCursor });
    assert.equal(second.items[0].event.eventId, 'b'); assert.ok(second.nextCursor);
    const last = store.list({ limit: 1, conceptId: reference.conceptId, cursor: second.nextCursor });
    assert.equal(last.items[0].event.eventId, 'a'); assert.equal(last.nextCursor, null);
    assert.equal(last.items[0].event.occurredAt, '2026-10-16T10:00:00+08:00');
    assert.equal(store.list({ from: '2026-10-16T10:30:00+08:00', to: '2026-10-16T03:00:00Z' }).items.length, 2);
    assert.equal(store.list({ operationId: 'a', kind: 'query.submitted', channel: 'web' }).items.length, 1);
    assert.throws(() => store.list({ cursor: first.nextCursor!, operationId: 'a' }), { code: 'INVALID_ACTIVITY' });
    assert.throws(() => store.list({ cursor: 'not-a-json-cursor' }), { code: 'INVALID_ACTIVITY' });
    assert.throws(() => store.list({ limit: 101 }), { code: 'INVALID_ACTIVITY' });
    assert.throws(() => store.list({ surprise: true } as never), { code: 'INVALID_ACTIVITY' });
  } finally { db.close(); }
});

test('strict browser-safe payload parsing refuses unconsented query text, body/answer/hash fields, malformed references and over-limit data', () => {
  for (const mutate of [
    (value: any) => { value.sourceId = 'another-owner'; },
    (value: any) => { value.event.payload.answer = 'never persist'; },
    (value: any) => { value.event.payload.queryHash = 'never persist'; },
    (value: any) => { value.event.actor.userId = 'spoofed'; },
    (value: any) => { value.delivery.body = 'never persist'; },
    (value: any) => { value.event.payload.queryText = 'implicit secret'; },
    (value: any) => { value.event.payload.queryTextSavedByUser = true; },
    (value: any) => { value.event.payload.resultCount = 1_000_001; },
    (value: any) => { value.event.refs = [reference]; value.event.payload.resultCount = 0; },
    (value: any) => { value.event.occurredAt = '2026-02-30T08:00:00Z'; },
    (value: any) => { value.event.refs = [{ ...reference, path: '../private.md' }]; },
    (value: any) => { value.event.refs = [{ ...reference, body: 'never persist' }]; },
    (value: any) => { value.event.payload = { resultCount: 0, queryText: 'x'.repeat(1001), queryTextSavedByUser: true }; },
    (value: any) => { value.event.refs = Array.from({ length: 51 }, () => reference); },
    (value: any) => { value.event.refs = Array.from({ length: 50 }, () => ({ ...reference, path: 'a'.repeat(2048), title: 'a'.repeat(500) })); },
  ]) {
    const value = request(); mutate(value);
    assert.throws(() => parseActivityAppendRequest(value));
  }
  const original = request({ refs: [reference] });
  const parsed = parseActivityAppendRequest(original);
  original.event.refs[0].path = 'changed.md';
  assert.equal(parsed.event.refs[0].path, 'Math/A.md');
  reference.path = 'Math/A.md';
});

test('visible content requires bounded block coordinates and failed current-reference inspection writes nothing', () => {
  const { db, store } = database();
  const block: ActivityReference = { ...reference, scope: 'block', blockId: 'block-1', contentPart: 'body', sectionId: '定义',
    bodyRange: { coordinateSpace: 'render-markdown-v1', startOffset: 0, endOffset: 10, startLine: 1, endLine: 1 } };
  const input = request({ kind: 'content.visible', payload: {}, refs: [block] });
  try {
    assert.throws(() => store.append({ ...context, inspectReference: () => { throw new ActivityError('INVALID_ACTIVITY_REFERENCE', 'synthetic forged range'); } }, input), { code: 'INVALID_ACTIVITY_REFERENCE' });
    assert.equal(store.list().items.length, 0);
    assert.equal(store.append(context, input).status, 'accepted');
    assert.throws(() => parseActivityAppendRequest(request({ kind: 'content.visible', payload: {}, refs: [{ ...block, contentPart: 'summary' }] })));
    assert.throws(() => parseActivityAppendRequest(request({ kind: 'content.visible', payload: {}, refs: [{ ...block, bodyRange: { ...block.bodyRange!, endOffset: 0 } }] })));
    assert.throws(() => parseActivityAppendRequest(request({ kind: 'query.selected', payload: {}, refs: [] })));
    assert.throws(() => parseActivityAppendRequest(request({ kind: 'reader.opened', payload: { section: 'summary' }, refs: [{ ...reference, scope: 'body' }] })));
    assert.throws(() => parseActivityAppendRequest(request({ kind: 'reader.opened', payload: { section: 'summary', requestedSectionId: 'chapter' }, refs: [{ ...reference, scope: 'summary' }] })));
    const output = store.export();
    assert.equal(output.format, 'living-memory-activity'); assert.equal(output.version, 1);
    assert.equal('schemaVersion' in output, false); assert.equal(output.sourceId, 'alice');
  } finally { db.close(); }
});

test('clearing an empty operation creates a tombstone and clearing all advances the namespace epoch', () => {
  const { db, store } = database();
  try {
    assert.equal(store.clearOperation({ operationId: 'late-operation', expectedEpoch: 0 }).deletedEvents, 0);
    assert.equal(db.prepare('SELECT operation_id FROM activity_deletions').get()!.operation_id, 'late-operation');
    assert.deepEqual(store.clearAll({ expectedEpoch: 0 }), {
      settings: { enabled: true, epoch: 1, revision: 1 }, deletedEvents: 0, deletedDeliveries: 0,
    });
    assert.throws(() => store.clearAll({ expectedEpoch: 0 }), { code: 'ACTIVITY_EPOCH_CHANGED' });
    assert.equal(db.prepare('SELECT count(*) AS count FROM activity_deletions').get()!.count, 0);
    assert.equal(db.prepare('SELECT body FROM anchors').get()!.body, 'learning stays intact');
  } finally { db.close(); }
});

test('activity writes nest safely in a caller transaction without committing its learning changes', () => {
  const { db, store } = database();
  try {
    db.exec('BEGIN; UPDATE anchors SET body=\'temporary\'');
    store.updateSettings({ enabled: false, expectedRevision: 0 });
    db.exec('ROLLBACK');
    assert.deepEqual(store.getSettings(), { enabled: true, epoch: 0, revision: 0 });
    assert.equal(db.prepare('SELECT body FROM anchors').get()!.body, 'learning stays intact');
  } finally { db.close(); }
});
