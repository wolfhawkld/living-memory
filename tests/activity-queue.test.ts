import assert from 'node:assert/strict';
import test from 'node:test';
import { parseActivityAppendRequest, type ActivityAppendRequest, type ActivityAppendResult, type ActivitySettings } from '../src/shared/activity.ts';
import { PendingCoordinationError } from '../src/web/pending-coordination.ts';
import { ACTIVITY_QUEUE_MAX_BYTES, ACTIVITY_QUEUE_MAX_ITEMS, activityQueueStorageKey, createActivityQueue,
  type ActivityQueueContext, type ActivityQueueOptions, type ActivityQueueScope } from '../src/web/activity-queue.ts';

const settings: ActivitySettings = { enabled: true, epoch: 0, revision: 0 };
const context: ActivityQueueContext = { accountId: 'owner-a', sourceId: 'source-a', authenticated: true, mode: 'real', settings };
function request(index = 1, operationId = `operation-${index}`): ActivityAppendRequest {
  return { epoch: 0, event: {
    schemaVersion: 1, eventId: `event-${index}`, operationId, stepKey: `query-${index}`,
    occurredAt: '2026-10-16T08:00:00.000Z', actor: { kind: 'user' }, channel: 'web', kind: 'query.submitted',
    refs: [], payload: { resultCount: 0 },
  }, delivery: { deliveryId: `delivery-${index}`, channel: 'web' } };
}
function memoryStorage() {
  const values = new Map<string, string>();
  return { values, getItem(key: string) { return values.get(key) ?? null; }, setItem(key: string, value: string) { values.set(key, value); } };
}
function locks() {
  const storage = new Map<string, Promise<unknown>>();
  const syncing = new Set<string>();
  return {
    async withStorageLock<T>(scope: string, action: () => T): Promise<T> {
      const previous = storage.get(scope) ?? Promise.resolve();
      const current = previous.catch(() => undefined).then(action);
      storage.set(scope, current);
      try { return await current; } finally { if (storage.get(scope) === current) storage.delete(scope); }
    },
    async withSyncLock<T>(scope: string, action: () => Promise<T>, busy: () => T): Promise<T> {
      if (syncing.has(scope)) return busy();
      syncing.add(scope);
      try { return await action(); } finally { syncing.delete(scope); }
    },
  };
}
function receipt(input: ActivityAppendRequest, status: ActivityAppendResult['status'] = 'accepted'): ActivityAppendResult {
  return { status, epoch: input.epoch, eventId: input.event.eventId, receivedAt: '2026-10-16T00:00:00.000Z' };
}
function harness(overrides: Partial<ActivityQueueOptions> = {}) {
  const storage = memoryStorage();
  const sent: { request: ActivityAppendRequest; scope: ActivityQueueScope }[] = [];
  const coordination = locks();
  let time = 1000;
  const options: ActivityQueueOptions = {
    storage, ...coordination, now: () => time,
    transport: { async append(input, scope) { sent.push({ request: structuredClone(input), scope }); return receipt(input); } },
    ...overrides,
  };
  const queue = createActivityQueue(options);
  queue.setContext(context);
  return { queue, storage, sent, options, advance() { time += 100_000; } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test('activity collection requires real authenticated scope and server-obtained settings before any storage or send', async () => {
  const h = harness();
  const input = {} as ActivityAppendRequest;
  for (const mode of ['example', 'forecast'] as const) {
    h.queue.setContext({ ...context, mode });
    assert.deepEqual(await h.queue.enqueue(input), { status: 'not-saved', reason: 'inactive' });
    assert.equal((await h.queue.flush()).status, 'inactive');
  }
  h.queue.setContext({ ...context, locked: true });
  assert.deepEqual(await h.queue.enqueue(input), { status: 'not-saved', reason: 'inactive' });
  h.queue.setContext({ ...context, authenticated: false });
  assert.equal((await h.queue.enqueue(input)).status, 'not-saved');
  h.queue.setContext({ ...context, settings: undefined });
  assert.deepEqual(await h.queue.enqueue(input), { status: 'not-saved', reason: 'settings-unavailable' });
  h.queue.setContext({ ...context, settings: { ...settings, enabled: false } });
  assert.deepEqual(await h.queue.enqueue(input), { status: 'not-saved', reason: 'disabled' });
  assert.equal(h.storage.values.size, 0);
  assert.equal(h.sent.length, 0);
});

test('queued events preserve original IDs, step and occurredAt across retry and never send during enqueue', async () => {
  const sent: ActivityAppendRequest[] = [];
  const h = harness({ transport: { async append(input) {
    sent.push(structuredClone(input));
    if (sent.length === 1) throw Object.assign(new Error(), { code: 'OFFLINE' });
    return receipt(input, 'duplicate');
  } } });
  const original = request();
  const frozen = structuredClone(original);
  assert.equal((await h.queue.enqueue(original)).status, 'queued');
  original.event.occurredAt = '2030-01-01T00:00:00.000Z';
  assert.equal(sent.length, 0);
  assert.equal((await h.queue.flush()).items[0]?.status, 'retryable');
  assert.equal((await h.queue.flush()).items.length, 0);
  h.advance();
  assert.equal((await h.queue.flush()).items[0]?.status, 'duplicate');
  assert.deepEqual(sent, [frozen, frozen]);
  assert.equal((await h.queue.snapshot()).rows.length, 0);
});

test('same event is idempotent locally while changed content or same operation step with new ID conflicts', async () => {
  const h = harness();
  const original = request();
  assert.equal((await h.queue.enqueue(original)).status, 'queued');
  assert.equal((await h.queue.enqueue(structuredClone(original))).status, 'already-queued');
  const changed = structuredClone(original);
  changed.event.occurredAt = '2026-10-15T00:00:00.000Z';
  assert.deepEqual(await h.queue.enqueue(changed), { status: 'not-saved', reason: 'conflict' });
  changed.event.eventId = 'another-event';
  assert.deepEqual(await h.queue.enqueue(changed), { status: 'not-saved', reason: 'conflict' });
  assert.equal((await h.queue.snapshot()).rows.length, 1);
});

test('scope keys separate account and source without delimiter collisions or learning queue changes', async () => {
  const h = harness();
  const learningKey = 'living-memory.pending.existing-learning-key';
  h.storage.values.set(learningKey, 'untouched-learning-record');
  await h.queue.enqueue(request(1));
  h.queue.setContext({ ...context, accountId: 'owner-b' });
  assert.equal((await h.queue.snapshot()).rows.length, 0);
  await h.queue.enqueue(request(2));
  h.queue.setContext({ ...context, sourceId: 'source-b' });
  await h.queue.enqueue(request(3));
  h.queue.setContext(context);
  assert.equal((await h.queue.snapshot()).rows[0]?.request.event.eventId, request(1).event.eventId);
  assert.equal(h.storage.values.get(learningKey), 'untouched-learning-record');
  assert.notEqual(activityQueueStorageKey({ accountId: 'a:b', sourceId: 'c' }), activityQueueStorageKey({ accountId: 'a', sourceId: 'b:c' }));
});

test('queue rejects the 101st row explicitly and flushes at most ten requests per trigger', async () => {
  const h = harness();
  for (let index = 0; index < ACTIVITY_QUEUE_MAX_ITEMS; index += 1) assert.equal((await h.queue.enqueue(request(index))).status, 'queued');
  assert.deepEqual(await h.queue.enqueue(request(101)), { status: 'not-saved', reason: 'full' });
  assert.equal((await h.queue.snapshot()).rows.length, 100);
  assert.equal((await h.queue.flush()).items.length, 10);
  assert.equal(h.sent.length, 10);
  assert.equal((await h.queue.snapshot()).rows.length, 90);
});

test('storage denial, quota exhaustion, malformed records and missing coordination never silently save', async () => {
  const denied = harness({ storage: { getItem() { throw new Error('denied'); }, setItem() {} } });
  assert.deepEqual(await denied.queue.enqueue(request()), { status: 'not-saved', reason: 'storage-unavailable' });
  const quota = harness({ storage: { getItem() { return null; }, setItem() { throw Object.assign(new Error(), { name: 'QuotaExceededError' }); } } });
  assert.deepEqual(await quota.queue.enqueue(request()), { status: 'not-saved', reason: 'full' });
  const malformed = harness();
  malformed.storage.values.set(activityQueueStorageKey(context), '{broken');
  assert.deepEqual(await malformed.queue.enqueue(request()), { status: 'not-saved', reason: 'storage-corrupt' });
  assert.equal(malformed.storage.values.get(activityQueueStorageKey(context)), '{broken');
  const coordination = harness({ async withStorageLock() { throw new PendingCoordinationError(); } });
  assert.deepEqual(await coordination.queue.enqueue(request()), { status: 'not-saved', reason: 'coordination-unavailable' });
});

test('oversized persisted records are refused without replacing their bytes', async () => {
  const h = harness();
  const raw = 'x'.repeat(ACTIVITY_QUEUE_MAX_BYTES + 1);
  h.storage.values.set(activityQueueStorageKey(context), raw);
  assert.deepEqual(await h.queue.enqueue(request()), { status: 'not-saved', reason: 'storage-corrupt' });
  assert.equal(h.storage.values.get(activityQueueStorageKey(context)), raw);
});

test('three failed attempts exhaust an event without blocking reads or scheduling additional work', async () => {
  let attempts = 0;
  const h = harness({ transport: { async append() { attempts += 1; throw Object.assign(new Error(), { code: 'OFFLINE' }); } } });
  await h.queue.enqueue(request());
  for (let index = 0; index < 3; index += 1) {
    const result = await h.queue.flush();
    assert.equal(result.items[0]?.status, index === 2 ? 'exhausted' : 'retryable');
    h.advance();
  }
  assert.equal((await h.queue.snapshot()).status, 'available');
  assert.equal((await h.queue.snapshot()).rows[0]?.state, 'exhausted');
  assert.equal((await h.queue.flush()).items.length, 0);
  assert.equal(attempts, 3);
});

test('disable and full-clear epochs discard this scope while old confirmed settings cannot resurrect pending events', async () => {
  const h = harness();
  await h.queue.enqueue(request());
  assert.deepEqual(await h.queue.applySettings({ enabled: false, epoch: 1, revision: 1 }), { applied: true });
  assert.equal((await h.queue.snapshot()).rows.length, 0);
  assert.deepEqual(await h.queue.enqueue(request()), { status: 'not-saved', reason: 'disabled' });
  assert.equal((await h.queue.applySettings(settings)).applied, false);
  assert.deepEqual(await h.queue.applySettings({ enabled: true, epoch: 1, revision: 2 }), { applied: true });
  const current = request(2); current.epoch = 1;
  await h.queue.enqueue(current);
  assert.deepEqual(await h.queue.applySettings({ enabled: true, epoch: 2, revision: 3 }), { applied: true });
  assert.equal((await h.queue.snapshot()).rows.length, 0);
  assert.deepEqual(await h.queue.enqueue(current), { status: 'not-saved', reason: 'epoch-changed' });
});

test('a server-confirmed disable gates collection even when local clearing cannot persist', async () => {
  let writesDenied = false;
  const storage = memoryStorage();
  const h = harness({ storage: { getItem: storage.getItem, setItem(key, raw) { if (writesDenied) throw new Error('denied'); storage.setItem(key, raw); } } });
  await h.queue.enqueue(request());
  writesDenied = true;
  assert.deepEqual(await h.queue.applySettings({ enabled: false, epoch: 1, revision: 1 }), { applied: false, reason: 'storage-unavailable' });
  assert.deepEqual(await h.queue.enqueue(request(2)), { status: 'not-saved', reason: 'disabled' });
  assert.equal((await h.queue.flush()).status, 'inactive');
});

test('confirmed operation deletion clears only the selected operation in this scope', async () => {
  const h = harness();
  await h.queue.enqueue(request(1, 'remove-operation'));
  await h.queue.enqueue(request(2, 'keep-operation'));
  h.queue.setContext({ ...context, sourceId: 'another-source' });
  await h.queue.enqueue(request(3, 'remove-operation'));
  h.queue.setContext(context);
  assert.deepEqual(await h.queue.clearOperation('remove-operation'), { cleared: true });
  assert.deepEqual((await h.queue.snapshot()).rows.map((row) => row.request.event.operationId), ['keep-operation']);
  h.queue.setContext({ ...context, sourceId: 'another-source' });
  assert.equal((await h.queue.snapshot()).rows.length, 1);
});

test('server-disabled and epoch-changed results terminate stale batches and require fresh settings', async () => {
  for (const code of ['ACTIVITY_DISABLED', 'ACTIVITY_EPOCH_CHANGED']) {
    let sent = 0;
    const h = harness({ transport: { async append() { sent += 1; throw Object.assign(new Error(), { code }); } } });
    await h.queue.enqueue(request(1)); await h.queue.enqueue(request(2));
    const result = await h.queue.flush();
    assert.equal(result.items[0]?.status, code === 'ACTIVITY_DISABLED' ? 'disabled' : 'epoch-changed');
    assert.equal(sent, 1);
    assert.deepEqual(await h.queue.enqueue(request(3)), { status: 'not-saved', reason: 'settings-unavailable' });
    await h.queue.applySettings({ ...settings, epoch: 1, revision: 1 });
    assert.equal((await h.queue.snapshot()).rows.length, 0);
  }
});

test('operation tombstones terminate only deleted operations while conflicts remain visible and are not retried', async () => {
  const sent: string[] = [];
  const h = harness({ transport: { async append(input) {
    sent.push(input.event.eventId);
    if (input.event.operationId === 'deleted') throw Object.assign(new Error(), { code: 'ACTIVITY_DELETED' });
    if (input.event.operationId === 'conflict') throw Object.assign(new Error(), { code: 'ACTIVITY_CONFLICT' });
    return receipt(input);
  } } });
  await h.queue.enqueue(request(1, 'deleted'));
  await h.queue.enqueue(request(2, 'deleted'));
  await h.queue.enqueue(request(3, 'conflict'));
  await h.queue.enqueue(request(4, 'normal'));
  const statuses = (await h.queue.flush()).items.map((item) => item.status);
  assert.deepEqual(statuses, ['deleted', 'conflict', 'accepted']);
  assert.deepEqual((await h.queue.snapshot()).rows.map((row) => row.state), ['conflict']);
  assert.equal((await h.queue.flush()).items.length, 0);
  assert.equal(sent.length, 3);
});

test('unrelated success receipts never remove the queued event', async () => {
  const h = harness({ transport: { async append(input) { return { ...receipt(input), eventId: 'wrong-event' }; } } });
  await h.queue.enqueue(request());
  assert.equal((await h.queue.flush()).items[0]?.status, 'conflict');
  assert.equal((await h.queue.snapshot()).rows[0]?.state, 'conflict');
});

test('switching account, source, mode or auth during a request prevents later sends and ignores stale responses', async () => {
  for (const next of [{ ...context, accountId: 'other' }, { ...context, sourceId: 'other' },
    { ...context, mode: 'example' as const }, { ...context, authenticated: false }]) {
    const entered = deferred<void>();
    const response = deferred<ActivityAppendResult>();
    let sends = 0;
    const h = harness({ transport: { async append() { sends += 1; entered.resolve(); return response.promise; } } });
    const first = request(1);
    await h.queue.enqueue(first); await h.queue.enqueue(request(2));
    const flush = h.queue.flush();
    await entered.promise;
    h.queue.setContext(next);
    response.resolve(receipt(first));
    assert.equal((await flush).status, 'context-changed');
    assert.equal(sends, 1);
    h.queue.setContext(context);
    assert.equal((await h.queue.snapshot()).rows.length, 2);
  }
});

test('two tabs serialize storage, share a sync lock and retain events added during a slow request', async () => {
  const storage = memoryStorage();
  const coordination = locks();
  const entered = deferred<void>();
  const response = deferred<ActivityAppendResult>();
  let sends = 0;
  const options: ActivityQueueOptions = { storage, ...coordination, transport: { async append(input) {
    sends += 1;
    if (sends === 1) { entered.resolve(); return response.promise; }
    return receipt(input);
  } } };
  const first = createActivityQueue(options), second = createActivityQueue(options);
  first.setContext(context); second.setContext(context);
  await Promise.all([first.enqueue(request(1)), second.enqueue(request(2))]);
  assert.equal((await first.snapshot()).rows.length, 2);
  const flushing = first.flush();
  await entered.promise;
  assert.equal((await second.flush()).status, 'busy');
  assert.equal((await second.enqueue(request(3))).status, 'queued');
  response.resolve(receipt(request(1)));
  assert.equal((await flushing).items.length, 3);
  assert.equal((await second.snapshot()).rows.length, 0);
});

test('stale tabs cannot enqueue after another tab persists a newer consent epoch', async () => {
  const storage = memoryStorage();
  const coordination = locks();
  const options: ActivityQueueOptions = { storage, ...coordination, transport: { async append(input) { return receipt(input); } } };
  const stale = createActivityQueue(options), current = createActivityQueue(options);
  stale.setContext(context); current.setContext(context);
  await stale.enqueue(request());
  await current.applySettings({ enabled: false, epoch: 1, revision: 1 });
  assert.deepEqual(await stale.enqueue(request(2)), { status: 'not-saved', reason: 'epoch-changed' });
  assert.equal((await stale.flush()).status, 'unavailable');
});

test('the 512 KiB cap measures serialized UTF-8 bytes and preserves earlier valid rows', async () => {
  const h = harness();
  const inputs = Array.from({ length: 10 }, (_, index) => request(index));
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
  for (const input of inputs) {
    input.event.refs = Array.from({ length: 15 }, (_, index) => ({
      conceptId: `concept-${index}`, sourceRevision: 'revision-1', path: `${'notes/'.repeat(330)}concept.md`,
      title: '图'.repeat(500), scope: 'result' as const,
    }));
    assert.equal(input.event.kind, 'query.submitted');
    if (input.event.kind === 'query.submitted') input.event.payload.resultCount = 15;
    assert.doesNotThrow(() => parseActivityAppendRequest(input));
    assert.ok(bytes(input.event) <= 65_536);
  }
  assert.ok(JSON.stringify(inputs).length < ACTIVITY_QUEUE_MAX_BYTES);
  for (const input of inputs.slice(0, 9)) assert.equal((await h.queue.enqueue(input)).status, 'queued');
  const before = h.storage.values.get(activityQueueStorageKey(context))!;
  assert.ok(new TextEncoder().encode(before).length <= ACTIVITY_QUEUE_MAX_BYTES);
  const candidate = JSON.parse(before) as { rows: unknown[] };
  candidate.rows.push({ request: inputs[9], attempts: 0, nextAttemptAt: 0, state: 'pending' });
  assert.ok(bytes(candidate) > ACTIVITY_QUEUE_MAX_BYTES);
  assert.deepEqual(await h.queue.enqueue(inputs[9]!), { status: 'not-saved', reason: 'full' });
  assert.equal(h.storage.values.get(activityQueueStorageKey(context)), before);
  assert.equal((await h.queue.snapshot()).rows.length, 9);
  assert.equal(h.sent.length, 0);
});

test('unknown event fields and raw answers are refused before any local persistence', async () => {
  const h = harness();
  const input = request();
  (input.event as unknown as Record<string, unknown>).answer = 'private original answer';
  assert.deepEqual(await h.queue.enqueue(input), { status: 'not-saved', reason: 'invalid-request' });
  assert.equal(h.storage.values.size, 0);
});

test('invalid and forbidden-channel events stop retrying while authentication failures pause without deleting pending records', async () => {
  for (const code of ['ACTIVITY_CONFLICT', 'INVALID_ACTIVITY', 'INVALID_ACTIVITY_REFERENCE', 'ACTIVITY_CHANNEL_FORBIDDEN']) {
    let sends = 0;
    const h = harness({ transport: { async append() { sends += 1; throw Object.assign(new Error(), { code, status: 403 }); } } });
    await h.queue.enqueue(request());
    assert.equal((await h.queue.flush()).items[0]?.status, 'conflict');
    assert.equal((await h.queue.snapshot()).rows[0]?.state, 'conflict');
    assert.equal((await h.queue.flush()).items.length, 0);
    assert.equal(sends, 1);
  }
  for (const status of [401, 403]) {
    const h = harness({ transport: { async append() { throw Object.assign(new Error(), { status }); } } });
    await h.queue.enqueue(request());
    assert.equal((await h.queue.flush()).items[0]?.status, 'auth-required');
    assert.equal((await h.queue.flush()).status, 'inactive');
    assert.equal((await h.queue.enqueue(request(2))).status, 'not-saved');
    await h.queue.applySettings(settings);
    assert.equal((await h.queue.snapshot()).rows.length, 1);
  }
});

test('clear confirmation during an in-flight append wins over its late success response', async () => {
  const entered = deferred<void>();
  const response = deferred<ActivityAppendResult>();
  const h = harness({ transport: { async append() { entered.resolve(); return response.promise; } } });
  const original = request();
  await h.queue.enqueue(original);
  const flushing = h.queue.flush();
  await entered.promise;
  assert.equal((await h.queue.applySettings({ enabled: true, epoch: 1, revision: 1 })).applied, true);
  response.resolve(receipt(original));
  assert.equal((await flushing).status, 'context-changed');
  assert.equal((await h.queue.snapshot()).rows.length, 0);
  assert.deepEqual(await h.queue.enqueue(original), { status: 'not-saved', reason: 'epoch-changed' });
});

test('a storage failure after acceptance preserves the same request for a later duplicate receipt', async () => {
  const storage = memoryStorage();
  let denyWrites = false;
  const sent: ActivityAppendRequest[] = [];
  const h = harness({
    storage: { getItem: storage.getItem, setItem(key, raw) { if (denyWrites) throw new Error('denied'); storage.setItem(key, raw); } },
    transport: { async append(input) {
      sent.push(structuredClone(input));
      if (sent.length === 1) denyWrites = true;
      return receipt(input, sent.length === 1 ? 'accepted' : 'duplicate');
    } },
  });
  await h.queue.enqueue(request());
  assert.equal((await h.queue.flush()).status, 'unavailable');
  denyWrites = false;
  assert.equal((await h.queue.snapshot()).rows.length, 1);
  assert.equal((await h.queue.flush()).items[0]?.status, 'duplicate');
  assert.deepEqual(sent[0], sent[1]);
  assert.equal((await h.queue.snapshot()).rows.length, 0);
});

test('explicit retry restores exhausted transient events unchanged and leaves conflicts isolated', async () => {
  const sent: ActivityAppendRequest[] = [];
  const h = harness({ transport: { async append(input) {
    sent.push(structuredClone(input));
    throw Object.assign(new Error(), { code: input.event.operationId === 'conflicting' ? 'ACTIVITY_CONFLICT' : 'OFFLINE' });
  } } });
  const original = request(1, 'transient');
  await h.queue.enqueue(original); await h.queue.enqueue(request(2, 'conflicting'));
  for (let attempt = 0; attempt < 3; attempt += 1) { await h.queue.flush(); h.advance(); }
  assert.deepEqual((await h.queue.snapshot()).rows.map((row) => row.state), ['exhausted', 'conflict']);
  const attempts = sent.length;
  assert.deepEqual(await h.queue.retryPending(), { reset: 1 });
  assert.equal(sent.length, attempts);
  const snapshot = await h.queue.snapshot();
  assert.deepEqual(snapshot.rows.map((row) => row.state), ['pending', 'conflict']);
  assert.deepEqual(snapshot.rows[0]?.request, original);
  await h.queue.flush();
  assert.equal(sent.length, attempts + 1);
  assert.deepEqual(sent.at(-1), original);
});

test('instance keys preserve legacy bytes and separate same-account/source restored epochs', async () => {
  const h = harness();
  const legacyKey = `living-memory.activity.queue.v1.${encodeURIComponent(JSON.stringify(['owner-a', 'source-a']))}`;
  assert.equal(activityQueueStorageKey(context), legacyKey);
  assert.equal(activityQueueStorageKey({ ...context, instanceId: 'legacy' }), legacyKey);
  const oldSettings = { enabled: true, epoch: 12, revision: 40 };
  h.queue.setContext({ ...context, settings: oldSettings });
  const old = { ...request(), epoch: 12 };
  assert.equal((await h.queue.enqueue(old)).status, 'queued');
  const original = h.storage.values.get(legacyKey);
  const restored = { ...context, instanceId: 'new-instance/中文', settings };
  h.queue.setContext(restored);
  assert.equal((await h.queue.snapshot()).rows.length, 0);
  assert.equal((await h.queue.flush()).items.length, 0);
  assert.equal(h.sent.length, 0);
  assert.deepEqual(await h.queue.applySettings(settings), { applied: true });
  assert.equal((await h.queue.enqueue(request(2))).status, 'queued');
  assert.equal((await h.queue.flush()).items[0]?.status, 'accepted');
  assert.equal(h.sent[0].scope.instanceId, restored.instanceId);
  assert.equal(h.sent[0].request.epoch, 0);
  assert.equal(h.storage.values.get(legacyKey), original);
  assert.equal(activityQueueStorageKey(restored), `${legacyKey}:instance:${encodeURIComponent(restored.instanceId)}`);
});

test('cross-instance in-flight acceptance never deletes old rows or sends newly selected instance', async () => {
  const entered = deferred<void>();
  const response = deferred<ActivityAppendResult>();
  const sent: ActivityQueueScope[] = [];
  const h = harness({ transport: { async append(input, scope) {
    sent.push(scope); entered.resolve(); return response.promise;
  } } });
  await h.queue.enqueue(request(1));
  await h.queue.enqueue(request(2));
  const oldKey = activityQueueStorageKey(context);
  const original = h.storage.values.get(oldKey);
  const flushing = h.queue.flush();
  await entered.promise;
  const restored = { ...context, instanceId: 'restored' };
  h.queue.setContext(restored);
  await h.queue.enqueue(request(3));
  const newKey = activityQueueStorageKey(restored), newBytes = h.storage.values.get(newKey);
  response.resolve(receipt(request(1)));
  assert.equal((await flushing).status, 'context-changed');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], { accountId: context.accountId, sourceId: context.sourceId });
  assert.equal(h.storage.values.get(oldKey), original);
  assert.equal(h.storage.values.get(newKey), newBytes);
  assert.equal((await h.queue.snapshot()).rows[0].request.event.eventId, 'event-3');
});

test('INSTANCE_MISMATCH pauses activity scope without retries or dropping frozen events', async () => {
  let attempts = 0;
  const h = harness({ transport: { async append() {
    attempts++; throw Object.assign(new Error('restored instance'), { code: 'INSTANCE_MISMATCH', status: 409 });
  } } });
  await h.queue.enqueue(request());
  const key = activityQueueStorageKey(context);
  const original = h.storage.values.get(key);
  assert.equal((await h.queue.flush()).items[0]?.status, 'source-changed');
  h.advance();
  assert.equal((await h.queue.flush()).status, 'inactive');
  assert.equal(attempts, 1);
  assert.equal(h.storage.values.get(key), original);
  assert.deepEqual(await h.queue.enqueue(request(2)), { status: 'not-saved', reason: 'settings-unavailable' });
});
