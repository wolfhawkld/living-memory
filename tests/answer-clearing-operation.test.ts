import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAnswerClearingMarker, type AnswerClearingMarker, type AnswerClearingReceipt, type AnswerClearingState } from '../src/shared/answer-clearing';
import { createAnswerClearingOperation } from '../src/web/answer-clearing-operation';
import type { AnswerPrivacyChannel } from '../src/web/answer-clearing-privacy';
const marker = { observationEventId: 'saved-observation', clearedAt: '2026-10-26T02:00:00.000Z' };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture(overrides: { clear?: () => Promise<AnswerClearingReceipt>; read?: () => Promise<AnswerClearingState>; complete?: boolean; timeoutMs?: number; beginFailure?: boolean } = {}) {
  let confirmed: AnswerClearingMarker | null = null, pending = false; let clears = 0, reads = 0, begins = 0, cleanups = 0;
  const channel: AnswerPrivacyChannel = {
    getMarker: () => confirmed, isBlocked: () => pending || !!confirmed, getSnapshot: () => [], subscribe: () => () => {},
    begin: async () => { begins++; if (overrides.beginFailure) throw new Error('denied'); pending = true; }, cancelUnsent: async () => { pending = false; },
    confirm: async value => { confirmed = parseAnswerClearingMarker(value); return { complete: overrides.complete ?? true, pendingRemoved: 0, checkpointCleared: false, errors: [] }; },
    retryCleanup: async () => { cleanups++; return { complete: !!confirmed, pendingRemoved: 0, checkpointCleared: false, errors: confirmed ? [] : ['unknown'] }; },
    reconcile: () => {}, dispose: () => {},
  };
  const operation = createAnswerClearingOperation({ channel, timeoutMs: overrides.timeoutMs,
    clear: async () => { clears++; return overrides.clear ? overrides.clear() : { ...marker, status: 'accepted' }; },
    read: async () => { reads++; return overrides.read ? overrides.read() : { ...marker, status: 'cleared' }; } });
  return { operation, counts: () => ({ clears, reads, begins, cleanups }), marker: () => confirmed };
}
test('opening and cancellation do not send; explicit confirmation uses the exact marker projection and succeeds once', async () => {
  const { operation, counts, marker: confirmed } = fixture();
  operation.open(marker.observationEventId); assert.equal(operation.getSnapshot()?.stage, 'confirm');
  operation.close(); assert.equal(operation.getSnapshot(), null); assert.equal(counts().clears, 0);
  operation.open(marker.observationEventId); await operation.submit(); assert.equal(operation.getSnapshot()?.stage, 'saved');
  assert.deepEqual(confirmed(), marker); assert.equal(counts().clears, 1);
  await operation.submit(); assert.equal(counts().clears, 1);
});
test('failed recovery-intent persistence prevents POST and remains confirmable', async () => {
  const { operation, counts } = fixture({ beginFailure: true }); operation.open(marker.observationEventId); await operation.submit();
  assert.equal(counts().clears, 0); assert.equal(operation.getSnapshot()?.stage, 'confirm'); assert.match(operation.getSnapshot()?.message ?? '', /尚未发送/);
});
test('a timed-out write stays unknown despite its late receipt, then read-only status confirms the original event', async () => {
  const pending = deferred<AnswerClearingReceipt>(); const { operation, counts, marker: confirmed } = fixture({ clear: () => pending.promise, timeoutMs: 5 });
  operation.open(marker.observationEventId); await operation.submit(); assert.equal(operation.getSnapshot()?.stage, 'unknown');
  await operation.submit(); assert.equal(counts().clears, 1, 'unknown must not automatically resubmit');
  pending.resolve({ ...marker, status: 'accepted' }); await Promise.resolve(); assert.equal(confirmed(), null); assert.equal(operation.getSnapshot()?.stage, 'unknown');
  await operation.check(); assert.equal(operation.getSnapshot()?.stage, 'saved'); assert.deepEqual(confirmed(), marker); assert.deepEqual(counts(), { clears: 1, reads: 1, begins: 1, cleanups: 0 });
});
test('GET saved permits only an explicit retry, while empty or foreign event results never claim success', async () => {
  let state: AnswerClearingState = { observationEventId: marker.observationEventId, status: 'saved' }; let fail = true;
  const { operation, counts } = fixture({ clear: async () => { if (fail) throw new Error('offline'); return { ...marker, status: 'duplicate' }; }, read: async () => state });
  operation.open(marker.observationEventId); await operation.submit(); await operation.check(); assert.equal(operation.getSnapshot()?.retryAllowed, true); assert.equal(counts().clears, 1);
  state = { observationEventId: marker.observationEventId, status: 'empty' }; await operation.check(); assert.equal(operation.getSnapshot()?.retryAllowed, false); assert.equal(operation.getSnapshot()?.stage, 'unknown');
  state = { ...marker, observationEventId: 'foreign', status: 'cleared' }; await operation.check(); assert.equal(operation.getSnapshot()?.stage, 'unknown');
  state = { observationEventId: marker.observationEventId, status: 'saved' }; await operation.check(); fail = false; await operation.submit();
  assert.equal(operation.getSnapshot()?.stage, 'saved'); assert.equal(counts().clears, 2);
});
test('server-confirmed local partial failure offers cleanup without another clear POST', async () => {
  const { operation, counts } = fixture({ complete: false }); operation.open(marker.observationEventId); await operation.submit();
  assert.equal(operation.getSnapshot()?.stage, 'saved'); assert.match(operation.getSnapshot()?.message ?? '', /未完成清理/);
  await operation.retryCleanup(); assert.equal(counts().clears, 1); assert.equal(counts().cleanups, 1); assert.match(operation.getSnapshot()?.message ?? '', /已清理/);
});
test('disposing the old account/instance operation makes late begin, POST receipts, and GET results inert', async () => {
  for (const mode of ['post', 'get'] as const) {
    const wait = deferred<AnswerClearingReceipt & { status: 'accepted' }>();
    const status = deferred<AnswerClearingState>(); const { operation, marker: confirmed } = fixture({ clear: () => wait.promise, read: () => status.promise });
    operation.open(marker.observationEventId);
    const action = mode === 'post' ? operation.submit() : operation.check();
    await Promise.resolve(); operation.dispose();
    wait.resolve({ ...marker, status: 'accepted' }); status.resolve({ ...marker, status: 'cleared' }); await action;
    assert.equal(operation.getSnapshot(), null); assert.equal(confirmed(), null);
  }
});
test('local cleanup cannot promote an unknown server outcome to cleared', async () => {
  const { operation, counts } = fixture({ clear: async () => { throw new Error('offline'); } });
  operation.open(marker.observationEventId); await operation.submit(); assert.equal(operation.getSnapshot()?.stage, 'unknown');
  await operation.retryCleanup(); assert.equal(operation.getSnapshot()?.stage, 'unknown'); assert.equal(counts().cleanups, 0); assert.equal(counts().clears, 1);
});
