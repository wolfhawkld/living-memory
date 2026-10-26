import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { createAnswerPrivacyChannel, getAnswerPrivacyChannel, answerPrivacyStorageKey, answerPrivacyLockKey, type AnswerPrivacyScope } from '../src/web/answer-clearing-privacy';
import { briefReviewCheckpointKey, serializeBriefReviewCheckpoint, readBriefReviewCheckpoint, type BriefReviewCheckpoint } from '../src/web/brief-review-checkpoint';
import { instanceStorage, instanceStorageKey } from '../src/web/instance-storage';
import { writePrivateBriefReviewCheckpoint, readPrivateBriefReviewCheckpoint, clearPrivateBriefReviewCheckpoint } from '../src/web/answer-clearing-checkpoint';
import { api, queuePendingWrite, getPendingWrites } from '../src/web/api';
import { MemoryLockManager } from './helpers/memory-lock-manager';
import { clearedExport, sourceId as fixtureSourceId } from './helpers/answer-clearing-json-fixture';
class StorageMemory {
  values = new Map<string, string>(); failKey: string | null = null;
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { if (this.failKey === key) throw new Error('denied'); this.values.set(key, value); }
  removeItem(key: string) { if (this.failKey === key) throw new Error('denied'); this.values.delete(key); }
}
const marker = { observationEventId: 'observed-a', clearedAt: '2026-10-26T01:00:00.000Z' };
const pendingKey = (scope: AnswerPrivacyScope) => instanceStorageKey(`living-memory.pending-writes.v1.${encodeURIComponent(scope.sourceId)}`, scope.instanceId);
const cpKey = (scope: AnswerPrivacyScope) => instanceStorageKey(briefReviewCheckpointKey(scope.sourceId), scope.instanceId);
function checkpoint(scope: AnswerPrivacyScope): BriefReviewCheckpoint {
  const learning = { task: 'concept' as const, confidence: 75, confidenceAt: '2026-09-27T09:59:00.000Z', cue: 'independent' as const, outcome: 'partial' as const, basis: 'self-check' as const };
  const payload = { eventId: marker.observationEventId, conceptId: 'concept-a', sourceRevision: 'rev-a', observedAt: '2026-09-27T10:00:00.000Z', configRevision: 3, anchorEventId: 'anchor-a', answer: 'PRIVATE_ANSWER', rating: 'partial' as const, exposure: 'unexposed' as const, observedExposure: false, learning };
  return { version: 1, savedAt: '2026-09-27T10:01:00.000Z', session: { id: 'session-a', sourceId: scope.sourceId, domainId: 'Cognition/Math', items: [{ conceptId: 'concept-a', title: 'Concept A', sourceRevision: 'rev-a', status: 'stale', elapsedDays: 14, estimated: false }, { conceptId: 'concept-b', title: 'Concept B', sourceRevision: 'rev-b', status: 'revisit', elapsedDays: 7, estimated: true }], index: 0, results: {}, reviews: {} }, attempt: { conceptId: 'concept-a', eventId: payload.eventId, answer: payload.answer, startedAt: '2026-09-27T09:58:00.000Z', observedAt: payload.observedAt, configRevision: 3, anchorEventId: 'anchor-a', sourceRevision: 'rev-a', sourceViewedBefore: false, stage: 'feedback', rating: 'partial', exposure: 'unexposed', learning, submittedPayload: payload } };
}
function setup(scope: AnswerPrivacyScope) {
  const storage = new StorageMemory();
  const channel = createAnswerPrivacyChannel(scope, { storage, host: null, lock: action => Promise.resolve().then(action) });
  return { storage, channel };
}
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalFetch = globalThis.fetch;
afterEach(() => { if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else Reflect.deleteProperty(globalThis, 'window'); globalThis.fetch = originalFetch; api.configureSessionScope(null); });
function browser(storage = new StorageMemory()) {
  const host = new EventTarget(); const locks = new MemoryLockManager();
  Object.defineProperties(host, { localStorage: { value: storage }, navigator: { value: { locks } } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: host });
  return { storage, host, locks };
}

test('confirmation removes only matching original observation and checkpoint, retaining independent records and progress', async () => {
  const scope = { sourceId: 'cleanup-scope', instanceId: 'instance-a' }; const { storage, channel } = setup(scope);
  const original = checkpoint(scope); storage.setItem(cpKey(scope), serializeBriefReviewCheckpoint(scope.sourceId, original));
  const target = { id: 'pending-a', method: 'POST', path: '/observations', eventId: marker.observationEventId, payload: original.attempt!.submittedPayload };
  const independent = [{ id: 'revision', path: '/observations/observed-a/revisions', payload: { note: 'PRIVATE_ANSWER' } }, { id: 'application', path: '/applications', payload: { content: 'PRIVATE_ANSWER' } }, { id: 'other-observation', method: 'POST', path: '/observations', eventId: 'another', payload: { eventId: 'another', answer: 'OTHER_ANSWER' } }];
  storage.setItem(pendingKey(scope), JSON.stringify([target, ...independent]));
  const result = await channel.confirm(marker);
  assert.equal(result.complete, true); assert.equal(result.pendingRemoved, 1); assert.equal(result.checkpointCleared, true);
  assert.deepEqual(JSON.parse(storage.getItem(pendingKey(scope))!), independent);
  const restored = readBriefReviewCheckpoint(scope.sourceId, instanceStorage(storage, scope.instanceId))!;
  assert.equal(restored.attempt, null); assert.equal(restored.session.results['concept-a'], 'saved'); assert.deepEqual(restored.session.items, original.session.items);
  assert.equal(storage.getItem(cpKey(scope))!.includes('PRIVATE_ANSWER'), false);
  assert.deepEqual(JSON.parse(storage.getItem(answerPrivacyStorageKey(scope))!), [{ ...marker, status: 'cleared', cleanup: 'complete' }]);
});

test('durable tombstone survives cleanup write failure and retry does not need another server clear', async () => {
  const scope = { sourceId: 'partial', instanceId: 'instance-a' }; const { storage, channel } = setup(scope);
  storage.setItem(cpKey(scope), serializeBriefReviewCheckpoint(scope.sourceId, checkpoint(scope))); storage.failKey = cpKey(scope);
  const result = await channel.confirm(marker); assert.equal(result.complete, false); assert.equal(channel.getMarker(marker.observationEventId)?.clearedAt, marker.clearedAt);
  assert.equal(JSON.parse(storage.getItem(answerPrivacyStorageKey(scope))!)[0].cleanup, 'pending');
  storage.failKey = null;
  assert.equal((await channel.retryCleanup(marker.observationEventId)).complete, true);
  assert.equal(readBriefReviewCheckpoint(scope.sourceId, instanceStorage(storage, scope.instanceId))!.attempt, null);
});

test('malformed queues and conflicting event metadata remain intact and report incomplete cleanup', async () => {
  for (const raw of ['{broken', JSON.stringify([{ method: 'POST', path: '/observations', eventId: marker.observationEventId, payload: { eventId: 'different', answer: 'PRIVATE_ANSWER' } }])]) {
    const scope = { sourceId: `malformed-${raw.length}`, instanceId: 'one' }; const { storage, channel } = setup(scope);
    storage.setItem(pendingKey(scope), raw);
    const result = await channel.confirm(marker); assert.equal(result.complete, false); assert.equal(storage.getItem(pendingKey(scope)), raw);
    assert.equal(channel.isBlocked(marker.observationEventId), true);
  }
});

test('cross-tab reconciliation is monotonic, scoped, and invalid storage fails closed with a new snapshot', async () => {
  const scope = { sourceId: 'shared', instanceId: 'one' }; const { storage, channel: first } = setup(scope);
  const second = createAnswerPrivacyChannel(scope, { storage, host: null, lock: action => Promise.resolve().then(action) });
  const foreign = createAnswerPrivacyChannel({ ...scope, instanceId: 'two' }, { storage, host: null });
  await first.begin(marker.observationEventId); second.reconcile(); assert.equal(second.isBlocked(marker.observationEventId), true); assert.equal(foreign.isBlocked(marker.observationEventId), false);
  await first.confirm(marker); second.reconcile(); const before = second.getSnapshot();
  storage.setItem(answerPrivacyStorageKey(scope), 'broken'); second.reconcile(); assert.notEqual(second.getSnapshot(), before); assert.equal(second.isBlocked('any-event'), true);
  const failed = second.getSnapshot(); second.reconcile(); assert.equal(second.getSnapshot(), failed, 'stable failure must not trigger render loops');
  storage.removeItem(answerPrivacyStorageKey(scope)); second.reconcile(); assert.equal(second.getMarker(marker.observationEventId)?.clearedAt, marker.clearedAt);
  await assert.rejects(second.confirm({ ...marker, clearedAt: '2026-10-27T01:00:00.000Z' }), /冲突/);
});

test('unknown intent blocks checkpoint recovery without deleting drafts; confirmed stale autosave is scrubbed', async () => {
  const { storage } = browser(); const scope = { sourceId: 'checkpoint-browser', instanceId: 'one' }; const original = checkpoint(scope);
  storage.setItem(cpKey(scope), serializeBriefReviewCheckpoint(scope.sourceId, original)); const channel = getAnswerPrivacyChannel(scope);
  await channel.begin(marker.observationEventId);
  assert.throws(() => readPrivateBriefReviewCheckpoint(scope), { code: 'ANSWER_CLEARING_UNKNOWN' });
  await assert.rejects(writePrivateBriefReviewCheckpoint(scope, original), { code: 'ANSWER_CLEARING_UNKNOWN' });
  assert.equal(storage.getItem(cpKey(scope))!.includes('PRIVATE_ANSWER'), true);
  await channel.confirm(marker);
  const saved = await writePrivateBriefReviewCheckpoint(scope, original);
  assert.equal(saved.attempt, null); assert.equal(storage.getItem(cpKey(scope))!.includes('PRIVATE_ANSWER'), false);
  assert.equal(readPrivateBriefReviewCheckpoint(scope)!.session.results['concept-a'], 'saved');
});

test('ending a session prevents an autosave already waiting for the same lock from recreating it', async () => {
  const { storage, locks } = browser(); const scope = { sourceId: 'end-session', instanceId: 'one' };
  let release!: () => void; const blocker = new Promise<void>(resolve => { release = resolve; });
  const lockName = `living-memory.pending.storage.v1.${encodeURIComponent(answerPrivacyLockKey(scope))}`;
  const held = locks.request(lockName, () => blocker);
  const writing = writePrivateBriefReviewCheckpoint(scope, checkpoint(scope));
  const rejected = assert.rejects(writing, /本轮复习已结束/);
  const clearing = clearPrivateBriefReviewCheckpoint(scope);
  release(); await held; await rejected; await clearing;
  assert.equal(storage.getItem(cpKey(scope)), null);
});

test('v3 API uses bodyless clear and instance-bound status; tombstones block enqueue/send but keep independent writes', async () => {
  browser(); const scope = { sourceId: 'api-browser', instanceId: 'runtime-one' };
  const session = { ...scope, writeToken: 'api-browser-token', learningProtocolVersion: 3 as const };
  const requests: Array<{ path: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    const path = String(input); requests.push({ path, init });
    if (path === '/api/session') return Response.json(session);
    if (init?.method === 'POST' && path.endsWith('/answer-clearing')) return Response.json({ ...marker, status: 'accepted' });
    if (path.endsWith('/answer-clearing')) return Response.json({ ...marker, status: 'cleared' });
    return Response.json({ status: 'accepted' });
  };
  api.configureSessionScope(session);
  const receipt = await api.clearObservationAnswer(marker.observationEventId, session.writeToken, scope.sourceId);
  assert.equal(receipt.status, 'accepted');
  const sent = requests.find(request => request.init?.method === 'POST')!;
  assert.equal(sent.init?.body, undefined); assert.equal(new Headers(sent.init?.headers).get('x-lm-instance-id'), scope.instanceId);
  assert.equal((await api.getObservationAnswerClearingState(marker.observationEventId, scope.sourceId)).status, 'cleared');
  const stateRequest = requests.at(-1)!; assert.equal(new Headers(stateRequest.init?.headers).get('x-lm-instance-id'), scope.instanceId);
  await getAnswerPrivacyChannel(scope).confirm(marker);
  const payload = checkpoint(scope).attempt!.submittedPayload!;
  assert.equal(await queuePendingWrite(scope.sourceId, { method: 'POST', path: '/observations', payload, eventId: payload.eventId, conceptId: payload.conceptId, label: 'answer' }), null);
  const prior = requests.length;
  await assert.rejects(api.postObservation(payload, session.writeToken, scope.sourceId), { code: 'ANSWER_CLEARED' });
  assert.equal(requests.length, prior, 'no original answer is sent after tombstone');
  assert.ok(await queuePendingWrite(scope.sourceId, { method: 'POST', path: '/applications', payload: { content: 'PRIVATE_ANSWER' }, eventId: 'independent', conceptId: payload.conceptId, label: 'summary' }));
  assert.equal(getPendingWrites(scope.sourceId).length, 1);
  assert.equal(await queuePendingWrite(scope.sourceId, { method: 'POST', path: `/observations/${payload.eventId}/answer-clearing`, payload: {}, eventId: payload.eventId, conceptId: payload.conceptId, label: 'clear' }), null);
});

test('a server ANSWER_CLEARED rejection verifies current status and clears local copies without treating it as accepted', async () => {
  const { storage } = browser(); const scope = { sourceId: 'remote-cleared-browser', instanceId: 'runtime-one' };
  const session = { ...scope, writeToken: 'remote-cleared-token', learningProtocolVersion: 3 as const };
  const original = checkpoint(scope); storage.setItem(cpKey(scope), serializeBriefReviewCheckpoint(scope.sourceId, original));
  const paths: string[] = [];
  globalThis.fetch = async (input) => {
    const path = String(input); paths.push(path);
    if (path === '/api/session') return Response.json(session);
    if (path.endsWith('/answer-clearing')) return Response.json({ ...marker, status: 'cleared' });
    return Response.json({ error: { code: 'ANSWER_CLEARED', message: '原答已清除。' } }, { status: 409 });
  };
  api.configureSessionScope(session);
  await assert.rejects(api.postObservation(original.attempt!.submittedPayload!, session.writeToken, scope.sourceId), { code: 'ANSWER_CLEARED' });
  assert.ok(paths.some(path => path.endsWith('/answer-clearing')));
  assert.equal(getAnswerPrivacyChannel(scope).getMarker(marker.observationEventId)?.clearedAt, marker.clearedAt);
  assert.equal(storage.getItem(cpKey(scope))!.includes('PRIVATE_ANSWER'), false);
});

test('an unverified server clearing rejection keeps a metadata-only recovery intent and never guesses a marker', async () => {
  browser(); const scope = { sourceId: 'remote-unknown-browser', instanceId: 'runtime-one' };
  const session = { ...scope, writeToken: 'remote-unknown-token', learningProtocolVersion: 3 as const };
  globalThis.fetch = async input => {
    if (String(input) === '/api/session') return Response.json(session);
    if (String(input).endsWith('/answer-clearing')) throw new TypeError('offline');
    return Response.json({ error: { code: 'ANSWER_CLEARED', message: '原答已清除。' } }, { status: 409 });
  };
  api.configureSessionScope(session);
  await assert.rejects(api.postObservation(checkpoint(scope).attempt!.submittedPayload!, session.writeToken, scope.sourceId), { code: 'ANSWER_CLEARED' });
  const channel = getAnswerPrivacyChannel(scope);
  assert.equal(channel.getMarker(marker.observationEventId), null);
  assert.deepEqual(channel.getSnapshot(), [{ observationEventId: marker.observationEventId, status: 'pending', cleanup: 'pending' }]);
});

test('pending display never reintroduces a blocked answer when disk cleanup is incomplete, and malformed storage remains visible', async () => {
  const { storage } = browser(); const scope = { sourceId: 'pending-display-private', instanceId: 'runtime-one' };
  api.configureSessionScope({ ...scope, writeToken: 'pending-display-token', learningProtocolVersion: 3 });
  const payload = checkpoint(scope).attempt!.submittedPayload!;
  assert.ok(await queuePendingWrite(scope.sourceId, { method: 'POST', path: '/observations', eventId: payload.eventId, conceptId: payload.conceptId, payload, label: 'original' }));
  storage.failKey = pendingKey(scope);
  assert.equal((await getAnswerPrivacyChannel(scope).confirm(marker)).complete, false);
  assert.equal(storage.getItem(pendingKey(scope))!.includes('PRIVATE_ANSWER'), true, 'disk failure remains explicitly pending');
  const shown = getPendingWrites(scope.sourceId);
  assert.equal(shown.length, 1); assert.equal(shown[0].lastError?.code, 'ANSWER_CLEARED');
  assert.equal(JSON.stringify(shown).includes('PRIVATE_ANSWER'), false, 'React pending state receives metadata only');
  storage.failKey = null; storage.setItem(pendingKey(scope), '{broken');
  assert.equal(getPendingWrites(scope.sourceId)[0].lastError?.code, 'PENDING_STORAGE_UNAVAILABLE');
  assert.equal(storage.getItem(pendingKey(scope)), '{broken');
});

test('confirmed in-memory invalidation precedes a denied marker write and remains recoverable', async () => {
  const scope = { sourceId: 'marker-write-denied', instanceId: 'one' }, storage = new StorageMemory();
  storage.failKey = answerPrivacyStorageKey(scope);
  const channel = createAnswerPrivacyChannel(scope, { storage, host: null, lock: action => Promise.resolve().then(action) });
  const confirming = channel.confirm(marker);
  assert.equal(channel.getMarker(marker.observationEventId)?.clearedAt, marker.clearedAt, 'synchronous invalidation happens before lock/storage');
  assert.equal((await confirming).complete, false); assert.equal(storage.getItem(answerPrivacyStorageKey(scope)), null);
  assert.match(channel.getSnapshot()[0].error ?? '', /本机副本清理尚未完成/);
  storage.failKey = null; assert.equal((await channel.retryCleanup(marker.observationEventId)).complete, true);
  assert.equal(JSON.parse(storage.getItem(answerPrivacyStorageKey(scope))!)[0].clearedAt, marker.clearedAt);
});

test('trusted history read remembers its first marker globally and API returns safe projections to new consumers', async () => {
  browser(); const scope = { sourceId: fixtureSourceId, instanceId: 'history-read-runtime' };
  const session = { ...scope, writeToken: 'history-read-token', learningProtocolVersion: 3 as const };
  const cleared = clearedExport().observations[0]; assert.equal(cleared.answer, null);
  const { answerClearing: first, ...base } = cleared as typeof cleared & { answerClearing: { observationEventId: string; clearedAt: string } };
  const intact = { ...base, answer: 'PRIVATE_HISTORY_ANSWER' };
  let parent: typeof cleared | typeof intact = cleared; let revisionParent = intact;
  globalThis.fetch = async input => {
    const path = String(input); if (path === '/api/session') return Response.json(session);
    if (path.includes('/revisions')) return Response.json({ observation: revisionParent });
    return Response.json({ sourceId: scope.sourceId, conceptId: cleared.conceptId, entries: [{ type: 'observation', event: parent }], observationAssessmentVersion: 'a'.repeat(64), observationPrivacy: { cleared: 1, excludedFromPerformance: 1 } });
  };
  api.configureSessionScope(session);
  await api.getConceptHistory(cleared.conceptId, scope.sourceId);
  assert.deepEqual(getAnswerPrivacyChannel(scope).getMarker(cleared.eventId), first);
  parent = intact;
  const oldPage = await api.getConceptHistory(cleared.conceptId, scope.sourceId);
  assert.equal(JSON.stringify(oldPage).includes(intact.answer), false);
  const oldRevision = await api.getObservationRevisions(cleared.eventId, scope.sourceId);
  assert.equal(oldRevision.observation.answer, null); assert.equal(JSON.stringify(oldRevision).includes(intact.answer), false);
  revisionParent = { ...intact, eventId: 'unknown-clear-parent' };
  await getAnswerPrivacyChannel(scope).begin(revisionParent.eventId);
  await assert.rejects(api.getObservationRevisions(revisionParent.eventId, scope.sourceId), { code: 'ANSWER_CLEARING_UNKNOWN' });
});

test('Express-equivalent clearing path variants cannot be enqueued or sent by the generic queue', async () => {
  browser(); const scope = { sourceId: 'clear-path-variants', instanceId: 'runtime-one' };
  const session = { ...scope, writeToken: 'clear-path-token', learningProtocolVersion: 3 as const };
  api.configureSessionScope(session);
  let requests = 0; globalThis.fetch = async () => { requests++; return Response.json({ status: 'accepted' }); };
  for (const path of ['/observations/saved-id/answer-clearing', '/observations/saved-id/answer-clearing/', '/OBSERVATIONS/saved-id/ANSWER-CLEARING', '/observations/saved-id/answer-clearing?verify=1', '/observations/saved-id/answer-clearing/#fragment']) {
    const write = { id: `queued-${requests}`, method: 'POST' as const, path, eventId: 'saved-id', conceptId: 'concept-a', payload: undefined, label: 'clear', createdAt: new Date().toISOString() };
    assert.equal(await queuePendingWrite(scope.sourceId, write), null, path);
    await assert.rejects(api.sendPending(write, session.writeToken, scope.sourceId), { code: 'ANSWER_CLEARING_NOT_QUEUEABLE' }, path);
  }
  assert.equal(requests, 0); assert.deepEqual(getPendingWrites(scope.sourceId), []);
});
