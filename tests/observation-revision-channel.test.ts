import assert from 'node:assert/strict';
import test from 'node:test';
import { createObservationRevisionChannel, type ObservationRevisionChannelContext } from '../src/web/observation-revision-channel';
import type { ObservationRevisionRequest } from '../src/shared/observation-revisions';
import type { ObservationRevisionHistory, ObservationRevisionReceipt } from '../src/shared/observation-revision-history';
import { observationRevisionPendingStorageKey } from '../src/web/observation-revision-pending';

const context: ObservationRevisionChannelContext = { accountId: 'synthetic-owner', sourceId: 'source', instanceId: 'instance', writeToken: 'memory-only-token', mode: 'real', locked: false };
const request: ObservationRevisionRequest = { eventId: 'revision-one', observationEventId: 'parent-one', previousEventId: null,
  occurredAt: '2026-10-20T00:00:00.000Z', action: 'withdraw', reason: 'other', note: '  exact\nnote  ' };
const receipt: ObservationRevisionReceipt = { status: 'accepted', eventId: request.eventId, recordedAt: '2026-10-20T00:01:00.000Z' };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function setup(extra: { append?: (r: ObservationRevisionRequest, token: string) => Promise<ObservationRevisionReceipt>; readHistory?: () => Promise<ObservationRevisionHistory> } = {}) {
  const values = new Map<string, string>(); let failWrites = false, calls = 0;
  const channel = createObservationRevisionChannel({
    storage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => { if (failWrites) throw new Error('storage unavailable'); values.set(key, value); } },
    withStorageLock: async (_scope, action) => action(), withSyncLock: async (_scope, action) => action(),
    append: async (r, token) => { calls++; return extra.append ? extra.append(r, token) : { ...receipt, eventId: r.eventId }; },
    readHistory: extra.readHistory ?? (async () => ({ observation: { eventId: 'parent-one' } }) as ObservationRevisionHistory),
  });
  channel.setContext(context);
  return { channel, values, failWrites: (fail: boolean) => { failWrites = fail; }, calls: () => calls };
}
test('channel writes exact durable request before POST and notifies once only after confirmed receipt', async () => {
  const pending = deferred<ObservationRevisionReceipt>();
  const env = setup({ append: async r => {
    const envelope = JSON.parse(env.values.get(observationRevisionPendingStorageKey(context))!);
    assert.deepEqual(envelope.rows[0].request, request); assert.deepEqual(r, request);
    assert.equal(env.channel.getSnapshot().confirmedVersion, 0); return pending.promise;
  } });
  await env.channel.refresh(); const submitted = env.channel.submit(request);
  await new Promise<void>(r => setImmediate(r));
  assert.equal(env.calls(), 1); assert.equal(env.channel.getSnapshot().busy, true);
  pending.resolve(receipt); assert.equal((await submitted).status, 'confirmed');
  assert.equal(env.channel.getSnapshot().confirmedVersion, 1); assert.equal(env.channel.getSnapshot().rows.length, 0);
  assert.equal(env.channel.getSnapshot().busy, false);
  assert.ok(![...env.values.values()].join('').includes(context.writeToken));
});
test('storage failure sends nothing, retains caller request and reports not-saved', async () => {
  const env = setup(); env.failWrites(true);
  const result = await env.channel.submit(request);
  assert.equal(result.status, 'not-saved'); assert.equal(env.calls(), 0); assert.equal(env.values.size, 0);
  env.failWrites(false); assert.equal((await env.channel.submit(request)).status, 'confirmed');
});
test('unknown result has no background dispatch and manual retry reuses every frozen field', async () => {
  const sent: ObservationRevisionRequest[] = []; let fail = true;
  const env = setup({ append: async r => { sent.push(r); if (fail) throw new Error('network'); return { ...receipt, status: 'duplicate' }; } });
  assert.equal((await env.channel.submit(request)).status, 'queued');
  assert.equal(env.channel.getSnapshot().rows[0].state, 'pending');
  await env.channel.refresh(); await new Promise<void>(r => setImmediate(r)); assert.equal(env.calls(), 1);
  fail = false; const retried = await env.channel.retry(request.eventId);
  assert.equal(retried.status, 'confirmed'); assert.deepEqual(sent, [request, request]);
});
test('rejected request is never resent and can only be archived by exact local row CAS', async () => {
  const env = setup({ append: async () => { throw Object.assign(new Error('rejected'), { code: 'OBSERVATION_REVISION_PREVIOUS_EVENT_CONFLICT', status: 409 }); } });
  assert.equal((await env.channel.submit(request)).status, 'rejected'); const row = env.channel.getSnapshot().rows[0];
  assert.equal((await env.channel.submit(request)).status, 'rejected');
  assert.equal((await env.channel.retry(request.eventId)).status, 'rejected'); await env.channel.retryAll(); assert.equal(env.calls(), 1);
  await assert.rejects(env.channel.assertMaintenanceReady());
  assert.equal(await env.channel.archiveRejected({ ...row, queuedAt: '2026-10-20T01:00:00.000Z' }), false);
  assert.equal(await env.channel.archiveRejected(row), true); await env.channel.assertMaintenanceReady();
  assert.equal(env.channel.getSnapshot().rows[0].state, 'archived');
  assert.equal(await env.channel.clearArchived(), true); assert.equal(env.channel.getSnapshot().rows.length, 0);
});
test('confirmed receipt with failed local cleanup still invalidates summaries exactly once', async () => {
  const env = setup({ append: async () => { env.failWrites(true); return receipt; } });
  const first = await env.channel.submit(request);
  assert.equal(first.status, 'confirmed'); if (first.status === 'confirmed') assert.equal(first.cleanupPending, true);
  assert.equal(env.channel.getSnapshot().confirmedVersion, 1); assert.equal(env.channel.getSnapshot().rows.length, 1);
  env.failWrites(false);
  // The retry is accepted/duplicate, but another cleanup failure must not create another summary event.
  assert.equal((await env.channel.retry(request.eventId)).status, 'confirmed');
  assert.equal(env.channel.getSnapshot().confirmedVersion, 1);
});
test('token ABA, source switches and task/mode changes invalidate late POST and GET continuations', async () => {
  for (const next of [{ ...context, writeToken: 'other-token' }, { ...context, sourceId: 'other-source' }, { ...context, locked: true }, { ...context, mode: 'example' as const }]) {
    const pending = deferred<ObservationRevisionReceipt>(), reading = deferred<ObservationRevisionHistory>();
    const env = setup({ append: () => pending.promise, readHistory: () => reading.promise });
    const submitted = env.channel.submit(request); const read = env.channel.readHistory('parent-one');
    const rejected = assert.rejects(read, /已变化/); await new Promise<void>(r => setImmediate(r));
    env.channel.setContext(next); env.channel.setContext(context);
    pending.resolve(receipt); reading.resolve({} as ObservationRevisionHistory);
    assert.equal((await submitted).status, 'context-changed'); await rejected;
    assert.equal(env.channel.getSnapshot().confirmedVersion, 0);
    await env.channel.refresh(); assert.equal(env.channel.getSnapshot().rows[0].request.eventId, request.eventId);
  }
});
test('maintenance fails closed for unreadable and unresolved queue, including while tasks lock writes', async () => {
  const env = setup({ append: async () => { throw new Error('offline'); } });
  env.values.set(observationRevisionPendingStorageKey(context), 'corrupt byte sequence');
  await env.channel.refresh(); assert.equal(env.channel.getSnapshot().status, 'unavailable');
  await assert.rejects(env.channel.assertMaintenanceReady()); assert.equal(env.calls(), 0);
  env.values.delete(observationRevisionPendingStorageKey(context)); await env.channel.submit(request);
  env.channel.setContext({ ...context, locked: true }); await assert.rejects(env.channel.assertMaintenanceReady());
});
test('retry cannot claim a durable copy after another tab removes it or storage becomes unreadable', async () => {
  for (const replacement of [null, 'bad unknown storage']) {
    const env = setup({ append: async () => { throw new Error('unknown result'); } });
    await env.channel.submit(request); assert.equal(env.calls(), 1);
    const key = observationRevisionPendingStorageKey(context);
    if (replacement === null) env.values.delete(key); else env.values.set(key, replacement);
    const result = await env.channel.retry(request.eventId);
    assert.equal(result.status, 'not-saved');
    if (result.status === 'not-saved') { assert.equal(result.persisted, false); assert.equal(result.outcomeUnknown, true); assert.match(result.message, /本机副本未能核实，服务结果未确认/); }
    assert.equal(env.calls(), 1);
  }
});
test('busy and changed-payload retries cannot adopt an unverified request', async () => {
  const pending = deferred<ObservationRevisionReceipt>(); const env = setup({ append: () => pending.promise });
  const first = env.channel.submit(request); await new Promise<void>(r => setImmediate(r));
  assert.equal((await env.channel.retry('never-queued')).status, 'not-saved');
  pending.resolve(receipt); await first;
  const unknown = setup({ append: async () => { throw new Error('unknown'); } });
  await unknown.channel.submit(request);
  const result = await unknown.channel.retry(request.eventId, { ...request, note: 'different request' });
  assert.equal(result.status, 'not-saved'); assert.equal(unknown.calls(), 1);
});
test('callbacks owned by an old window cannot start operations in a new account or an ABA session', async () => {
  const env = setup({ append: async () => { throw Object.assign(new Error('rejected'), { code: 'OBSERVATION_REVISION_PREVIOUS_EVENT_CONFLICT', status: 409 }); } });
  await env.channel.submit(request); const row = env.channel.getSnapshot().rows[0], key = env.channel.getSnapshot().contextKey;
  env.channel.setContext({ ...context, writeToken: 'new-token' }); env.channel.setContext(context);
  assert.equal((await env.channel.submit(request, key)).status, 'context-changed');
  assert.equal((await env.channel.retry(request.eventId, request, key)).status, 'context-changed');
  await assert.rejects(env.channel.readHistory(request.observationEventId, {}, key), /已变化/);
  assert.equal(await env.channel.archiveRejected(row, key), false); assert.equal(env.calls(), 1);
  await env.channel.refresh(); assert.equal(env.channel.getSnapshot().rows[0].state, 'rejected');
});
