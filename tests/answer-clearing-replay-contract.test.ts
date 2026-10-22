import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildAnswerClearingImportPlan } from '../src/server/answer-clearing-import.js';
import { buildSafeImportReplayDescriptor, encodeSafeImportReceiptEnvelope, parseSafeImportReceiptEnvelope,
  safeImportReplayEqual, SAFE_IMPORT_CREDENTIAL } from '../src/server/answer-clearing-replay-contract.js';
import type { ImportReceipt } from '../src/shared/import-data.js';
import { clone, fullExport, importInput, now, sourceId } from './helpers/answer-clearing-json-fixture.js';

const options = { restoreLayout: true, restoreReviewPlan: true };
const code = 'ANSWER_CLEARING_REPLAY_DATA_INVALID';
function fixture() {
  const prepared = buildAnswerClearingImportPlan(importInput());
  const replay = buildSafeImportReplayDescriptor(prepared, options);
  const receipt: ImportReceipt = { status: 'accepted', importId: 'import-1', sourceId, importedAt: now, counts: prepared.preview.counts, backupId: 'backup-1' };
  const envelope = { version: 1 as const, receipt, replay };
  return { prepared, replay, receipt, envelope };
}
const expected = { namespace: sourceId, importId: 'import-1' };

test('safe replay uses every incoming identity and no event bodies, preview token, audit bindings or diagnostics', () => {
  const { prepared, replay } = fixture();
  assert.equal(prepared.preview.canImport, true);
  assert.equal(replay.events.length, 9);
  assert.equal(new Set(replay.events.map(event => event.kind)).size, 9);
  for (const event of replay.events) assert.deepEqual(Object.keys(event).sort(), ['eventId', 'kind', 'recordedAt']);
  const serialized = JSON.stringify(replay);
  for (const privateValue of ['private-answer-sentinel', 'separate practice answer', 'Reference', 'Question', 'independent audit note', 'separate correction', 'separate relation', prepared.preview.token, 'binding-alpha']) {
    assert.equal(serialized.includes(privateValue), false, privateValue);
  }
  assert.equal(/^[a-f0-9]{64}$/.test(SAFE_IMPORT_CREDENTIAL), false);
  const changed = clone(prepared);
  changed.preview.token = 'TOKEN_MUST_NOT_PERSIST';
  changed.normalized.source.diagnostics = ['DIAGNOSTICS_MUST_NOT_PERSIST'];
  changed.normalized.observations[0].answer = 'CHANGED_ANSWER_MUST_NOT_PERSIST';
  changed.normalized.practice!.cards[0].referenceAnswer = 'CHANGED_REFERENCE_MUST_NOT_PERSIST';
  changed.normalized.practice!.attempts[0].answer = 'CHANGED_PRACTICE_MUST_NOT_PERSIST';
  changed.newAnchors = []; changed.newObservations = []; changed.newObservationRevisions = [];
  changed.newRetentions = []; changed.newApplications = []; changed.newCorrections = [];
  changed.newRelationReviews = []; changed.newPracticeCards = []; changed.newPracticeAttempts = [];
  assert.equal(safeImportReplayEqual(replay, buildSafeImportReplayDescriptor(changed, options)), true);
  let bodyReads = 0;
  Object.defineProperty(changed.normalized.observations[0], 'answer', { enumerable: true, get() { bodyReads++; throw new Error('must not inspect body'); } });
  Object.defineProperty(changed.normalized.practice!.attempts[0], 'answer', { enumerable: true, get() { bodyReads++; throw new Error('must not inspect practice body'); } });
  assert.equal(safeImportReplayEqual(replay, buildSafeImportReplayDescriptor(changed, options)), true);
  assert.equal(bodyReads, 0);
  // Body equality is deliberately the coordinator's fresh pure-plan check, not this descriptor's job.
});

test('descriptor canonicalizes unordered collections and retains input metadata rather than merged preferences', () => {
  const { prepared, replay } = fixture();
  const changed = clone(prepared);
  changed.normalized.concepts.reverse();
  changed.normalized.anchors.reverse();
  changed.mergedLayout = { injected: { x: 99, y: 99, z: 99 } };
  changed.mergedReviewPlan = { revision: 99, dailyBudget: 40, concepts: {} };
  assert.equal(safeImportReplayEqual(replay, buildSafeImportReplayDescriptor(changed, options)), true);
  const reversed = clone(replay); reversed.events.reverse(); reversed.concepts.reverse(); reversed.restoreMetadata.anchorRequests.reverse();
  assert.equal(safeImportReplayEqual(replay, reversed), true);
  assert.deepEqual(clone(replay.layout), clone(prepared.normalized.layout));
  assert.deepEqual(clone(replay.reviewPlan), clone(prepared.normalized.reviewPlan));
});

test('manifest changes for every incoming recordedAt, identity and membership including previously duplicate events', () => {
  const { prepared, replay } = fixture();
  for (const event of replay.events) {
    const changed = clone(replay);
    changed.events.find(item => item.eventId === event.eventId)!.recordedAt = '2026-01-08T04:00:00.000Z';
    assert.equal(safeImportReplayEqual(replay, changed), false, event.kind);
  }
  for (const mutate of [
    (value: typeof replay) => { value.events.pop(); },
    (value: typeof replay) => { value.events[0].eventId = 'different-id'; },
    (value: typeof replay) => { value.options.restoreLayout = false; },
    (value: typeof replay) => { value.exportedAt = now; },
    (value: typeof replay) => { value.concepts[0].source.path = 'New.md'; },
    (value: typeof replay) => { value.restoreMetadata.configRecordedAt['1'] = now; },
    (value: typeof replay) => { value.layout[Object.keys(value.layout)[0]].x++; },
    (value: typeof replay) => { value.reviewPlan!.dailyBudget++; },
  ]) {
    const changed = clone(replay); mutate(changed); assert.equal(safeImportReplayEqual(replay, changed), false);
  }
  const duplicatePlan = buildAnswerClearingImportPlan(importInput(fullExport(), fullExport()));
  assert.equal(duplicatePlan.newObservations.length, 0);
  assert.equal(buildSafeImportReplayDescriptor(duplicatePlan, options).events.length, prepared.normalized.observationRevisions.length + 8);
});

test('safe receipt round trips strictly against namespace and importId with no aliases', () => {
  const { replay, receipt } = fixture();
  const serialized = encodeSafeImportReceiptEnvelope(receipt, replay);
  const parsed = parseSafeImportReceiptEnvelope(JSON.parse(serialized), expected);
  assert.equal(parsed.version, 1);
  assert.deepEqual(parsed.receipt, receipt);
  assert.equal(safeImportReplayEqual(parsed.replay, replay), true);
  assert.throws(() => parseSafeImportReceiptEnvelope(JSON.parse(serialized), { ...expected, namespace: 'other' }), { code });
  assert.throws(() => parseSafeImportReceiptEnvelope(JSON.parse(serialized), { ...expected, importId: 'other' }), { code });
  assert.throws(() => parseSafeImportReceiptEnvelope(serialized, expected), { code });
  replay.events.pop();
  assert.equal(parsed.replay.events.length, 9);
});

test('stored envelope rejects unknown fields at every boundary, corrupt values and private mechanical extensions', () => {
  const { envelope } = fixture();
  const paths = [[], ['receipt'], ['receipt', 'counts'], ['receipt', 'counts', 'added'], ['replay'], ['replay', 'options'],
    ['replay', 'config'], ['replay', 'configHistory', 0], ['replay', 'concepts', 0], ['replay', 'concepts', 0, 'source'],
    ['replay', 'events', 0], ['replay', 'restoreMetadata'], ['replay', 'restoreMetadata', 'anchorRequests', 0], ['replay', 'reviewPlan'],
    ['replay', 'reviewPlan', 'concepts', 'live-alpha'], ['replay', 'layout', 'live-alpha']] as const;
  for (const path of paths) {
    const changed = clone(envelope);
    let target: unknown = changed;
    for (const key of path) target = (target as Record<string | number, unknown>)[key];
    (target as Record<string, unknown>).answer = 'MECHANICAL_PRIVATE_COPY';
    assert.throws(() => parseSafeImportReceiptEnvelope(changed, expected), { code }, JSON.stringify(path));
  }
  for (const mutate of [
    (value: typeof envelope) => { value.replay.events.push({ ...value.replay.events[0] }); },
    (value: typeof envelope) => { value.replay.events[0].recordedAt = 'invalid'; },
    (value: typeof envelope) => { value.replay.namespace = 'other'; },
    (value: typeof envelope) => { value.receipt.status = 'duplicate'; },
    (value: typeof envelope) => { value.receipt.counts.duplicates = -1; },
  ]) {
    const changed = clone(envelope); mutate(changed); assert.throws(() => parseSafeImportReceiptEnvelope(changed, expected), { code });
  }
});

test('stored parser never calls getters or toJSON and rejects cycles, exotic objects, sparse arrays and excessive depth', () => {
  const { envelope } = fixture();
  let invoked = 0;
  const getter = clone(envelope);
  Object.defineProperty(getter.replay, 'answer', { enumerable: true, get() { invoked++; return 'private'; } });
  const serializer = clone(envelope);
  Object.defineProperty(serializer.replay, 'toJSON', { value() { invoked++; return {}; }, enumerable: true });
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  let deep: unknown = 1; for (let i = 0; i < 102; i++) deep = { child: deep };
  const sparse = clone(envelope); sparse.replay.events = new Array(2);
  for (const value of [getter, serializer, cycle, deep, sparse, new Date(), { ...envelope, extra: Symbol('private') }, { ...envelope, extra: 'x'.repeat(20 * 1024 * 1024) }]) {
    assert.throws(() => parseSafeImportReceiptEnvelope(value, expected), { code });
  }
  assert.equal(invoked, 0);
  assert.throws(() => encodeSafeImportReceiptEnvelope(envelope.receipt, getter.replay), { code });
  assert.equal(invoked, 0);
});
