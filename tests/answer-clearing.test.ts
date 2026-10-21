import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { Observation } from '../src/shared/types.js';
import { AnswerClearingError, parseAnswerClearingMarker, parseAnswerClearingReceipt, parseAnswerClearingRequest,
  type AnswerClearingMarker, type PrivacyObservation } from '../src/shared/answer-clearing.js';
import { applyAnswerClearing, isAnswerCleared, isAnswerPrivacyEligible, planAnswerClearing } from '../src/core/answer-clearing.js';

const answer = 'SYNTHETIC_ORIGINAL_ANSWER_FOR_CLEARING';
const clearedAt = '2026-10-21T03:00:00.000Z';
const marker: AnswerClearingMarker = { observationEventId: 'observation-original', clearedAt };
function observation(): Observation {
  return { eventId: marker.observationEventId, conceptId: 'concept-original', sourceRevision: 'source-original',
    observedAt: '2026-10-20T00:00:00.000Z', recordedAt: '2026-10-20T00:00:01.000Z',
    configRevision: 3, halfLifeDays: 7, anchorEventId: 'anchor-original', elapsedDays: 2, decay: 0.82,
    answer, evidenceMode: 'written', rating: 'clear', exposure: 'unexposed', observedExposure: false,
    learning: { task: 'scenario', scenario: 'Synthetic scenario prompt', scenarioRevisit: true,
      applicability: 'Synthetic checked explanation', confidence: 80, confidenceAt: '2026-10-19T23:59:59.000Z',
      cue: 'independent', outcome: 'success', basis: 'self-check' } };
}
function errorCode(operation: () => unknown, code: string) {
  assert.throws(operation, (error: unknown) => error instanceof AnswerClearingError && error.code === code);
}
function unsafe(value: unknown): PrivacyObservation { return value as PrivacyObservation; }

test('answer clearing request, marker and receipt normalize only the target ID and explicit UTC instant', () => {
  assert.deepEqual(parseAnswerClearingRequest({ observationEventId: '  obs:A-1._  ' }), { observationEventId: 'obs:A-1._' });
  assert.deepEqual(parseAnswerClearingMarker({ observationEventId: '  observation-original  ', clearedAt: '2026-10-21T11:00:00+08:00' }), marker);
  for (const status of ['accepted', 'duplicate'] as const) {
    assert.deepEqual(parseAnswerClearingReceipt({ status, observationEventId: ' observation-original ', clearedAt: '2026-10-21T11:00:00+08:00' }),
      { status, ...marker });
  }
  assert.equal(parseAnswerClearingRequest({ observationEventId: 'a'.repeat(128) }).observationEventId.length, 128);
  assert.deepEqual(parseAnswerClearingRequest(Object.assign(Object.create(null), { observationEventId: 'null-prototype' })),
    { observationEventId: 'null-prototype' });
});

test('tombstone contracts reject original answers, hashes, unknown keys and invalid IDs without retaining their data', () => {
  const hash = createHash('sha256').update(answer).digest('hex');
  const parsers = [
    { parse: parseAnswerClearingRequest, value: { observationEventId: marker.observationEventId }, code: 'INVALID_REQUEST' },
    { parse: parseAnswerClearingMarker, value: marker, code: 'INVALID_MARKER' },
    { parse: parseAnswerClearingReceipt, value: { status: 'accepted', ...marker }, code: 'INVALID_RECEIPT' },
  ];
  for (const { parse, value, code } of parsers) {
    for (const extra of [{ answer }, { answerHash: hash }, { request_payload: answer }, { reason: 'unrequested retention' }, { extra: null }])
      errorCode(() => parse({ ...value, ...extra }), code);
    for (const observationEventId of ['', ' ', 'a'.repeat(129), '_invalid-first', '中文', 'with space', 'line\nbreak', 42, null])
      errorCode(() => parse({ ...value, observationEventId }), code);
    for (const invalid of [null, false, [], 'invalid', new Date(), new (class { observationEventId = marker.observationEventId; })()])
      errorCode(() => parse(invalid), code);
  }
  assert.deepEqual(Object.keys(parseAnswerClearingMarker(marker)).sort(), ['clearedAt', 'observationEventId']);
});

test('plain data parsing rejects accessor payloads without executing them and rejects unknown receipt states or invalid times', () => {
  let reads = 0;
  for (const { parse, code, value } of [
    { parse: parseAnswerClearingRequest, code: 'INVALID_REQUEST', value: { observationEventId: marker.observationEventId } },
    { parse: parseAnswerClearingMarker, code: 'INVALID_MARKER', value: { ...marker } },
    { parse: parseAnswerClearingReceipt, code: 'INVALID_RECEIPT', value: { ...marker, status: 'accepted' } },
  ]) {
    Object.defineProperty(value, 'observationEventId', { enumerable: true, get() { reads++; return marker.observationEventId; } });
    errorCode(() => parse(value), code);
  }
  assert.equal(reads, 0);
  for (const { parse, value, code } of [
    { parse: parseAnswerClearingRequest, value: { observationEventId: marker.observationEventId }, code: 'INVALID_REQUEST' },
    { parse: parseAnswerClearingMarker, value: marker, code: 'INVALID_MARKER' },
    { parse: parseAnswerClearingReceipt, value: { status: 'accepted', ...marker }, code: 'INVALID_RECEIPT' },
  ]) {
    const hidden = { ...value }; Object.defineProperty(hidden, 'hidden', { value: answer });
    errorCode(() => parse(hidden), code);
    errorCode(() => parse({ ...value, [Symbol('hidden')]: answer }), code);
  }
  for (const time of ['2026-10-21', '2026-10-21T03:00:00', '2026-02-30T00:00:00Z', 'invalid', null, 42,
    '9999-12-31T23:00:00-02:00', '0000-01-01T00:00:00+02:00']) {
    errorCode(() => parseAnswerClearingMarker({ ...marker, clearedAt: time }), 'INVALID_MARKER');
    errorCode(() => parseAnswerClearingReceipt({ status: 'accepted', ...marker, clearedAt: time }), 'INVALID_RECEIPT');
  }
  for (const status of ['', 'cleared', 'pending', null, false])
    errorCode(() => parseAnswerClearingReceipt({ status, ...marker }), 'INVALID_RECEIPT');
});

test('first clear returns a content-free marker and receipt while preserving all original assessment and frozen conditions', () => {
  const original = observation(), before = structuredClone(original);
  const result = planAnswerClearing(original, { observationEventId: original.eventId }, clearedAt);
  assert.deepEqual(result.receipt, { status: 'accepted', ...marker });
  assert.deepEqual(result.observation, { ...before, answer: null, answerClearing: marker });
  assert.deepEqual(original, before);
  assert.equal(isAnswerCleared(result.observation), true); assert.equal(isAnswerPrivacyEligible(result.observation), false);
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_ORIGINAL_ANSWER_FOR_CLEARING/);
  assert.deepEqual(Object.keys(result.receipt).sort(), ['clearedAt', 'observationEventId', 'status']);
});

test('privacy projection selects only known observation and learning fields and deep copies rather than leaking hidden payloads', () => {
  const original = observation();
  const hash = createHash('sha256').update(answer).digest('hex');
  const extended = { ...original, request_payload: answer, answerHash: hash, arbitrary: { original: answer },
    learning: { ...original.learning!, request_payload: answer, answerHash: hash, arbitrary: answer } };
  let unknownReads = 0;
  Object.defineProperty(extended, 'unknownGetter', { enumerable: true, get() { unknownReads++; throw new Error('unknown field must not be read'); } });
  Object.defineProperty(extended.learning, 'unknownGetter', { enumerable: true, get() { unknownReads++; throw new Error('unknown field must not be read'); } });
  const cleared = applyAnswerClearing(extended, marker);
  assert.deepEqual(cleared, { ...original, answer: null, answerClearing: marker });
  assert.equal(unknownReads, 0); assert.equal(extended.answer, answer);
  assert.notStrictEqual(cleared.learning, extended.learning); assert.notStrictEqual(cleared.answerClearing, marker);
  extended.learning.applicability = 'Changed source object'; marker.observationEventId = 'temporarily-mutated-marker';
  try { assert.equal(cleared.learning!.applicability, original.learning!.applicability); assert.equal(cleared.answerClearing.observationEventId, original.eventId); }
  finally { marker.observationEventId = original.eventId; }
  assert.equal(JSON.stringify(cleared).includes(hash), false); assert.equal(JSON.stringify(cleared).includes(answer), false);
});

test('already cleared planning is idempotent and keeps the first marker even with a later or earlier valid retry time', () => {
  const first = planAnswerClearing(observation(), { observationEventId: marker.observationEventId }, clearedAt);
  for (const retryAt of ['2026-10-22T00:00:00Z', '2026-10-19T00:00:00Z']) {
    const before = structuredClone(first.observation);
    const retry = planAnswerClearing(first.observation, { observationEventId: marker.observationEventId }, retryAt);
    assert.deepEqual(retry.receipt, { status: 'duplicate', ...marker }); assert.deepEqual(retry.observation, first.observation);
    assert.deepEqual(first.observation, before);
  }
  assert.deepEqual(applyAnswerClearing(first.observation, { ...marker }), first.observation);
  errorCode(() => planAnswerClearing(first.observation, { observationEventId: marker.observationEventId }, 'invalid'), 'INVALID_CLEARED_AT');
});

test('clearing is not an asOf assessment revision: old observation times do not recover the answer', () => {
  const original = observation(), cleared = applyAnswerClearing(original, marker);
  // There is deliberately no asOf argument or old-answer preimage in this contract.
  assert.equal(cleared.observedAt, original.observedAt); assert.equal(cleared.recordedAt, original.recordedAt);
  assert(Date.parse(cleared.recordedAt) < Date.parse(cleared.answerClearing.clearedAt)); assert.equal(cleared.answer, null);
  const roundTrip = JSON.parse(JSON.stringify(cleared)) as PrivacyObservation;
  assert.deepEqual(applyAnswerClearing(roundTrip, marker), cleared); assert.equal(isAnswerPrivacyEligible(roundTrip), false);
});

test('target and clearing time checks fail closed without changing the original observation', () => {
  const original = observation(), before = structuredClone(original);
  errorCode(() => applyAnswerClearing(original, { ...marker, observationEventId: 'another-observation' }), 'TARGET_MISMATCH');
  errorCode(() => planAnswerClearing(original, { observationEventId: 'another-observation' }, clearedAt), 'TARGET_MISMATCH');
  for (const time of ['2026-10-19T00:00:00Z', 'invalid', '2026-10-21T03:00:00',
    '9999-12-31T23:00:00-02:00', '0000-01-01T00:00:00+02:00'])
    errorCode(() => planAnswerClearing(original, { observationEventId: original.eventId }, time), 'INVALID_CLEARED_AT');
  assert.deepEqual(planAnswerClearing(original, { observationEventId: original.eventId }, original.recordedAt).receipt,
    { status: 'accepted', observationEventId: original.eventId, clearedAt: original.recordedAt });
  assert.deepEqual(original, before);
});

test('inconsistent tombstones cannot restore an old retry payload or be replaced by a new clearing marker', () => {
  const original = observation(), cleared = applyAnswerClearing(original, marker);
  for (const invalid of [{ ...original, answerClearing: marker }, { ...original, answer: null },
    { ...cleared, answer }, { ...cleared, answerClearing: { ...marker, observationEventId: 'another-observation' } }]) {
    errorCode(() => applyAnswerClearing(unsafe(invalid), marker), 'INCONSISTENT_CLEARING');
  }
  errorCode(() => applyAnswerClearing(cleared, { ...marker, clearedAt: '2026-10-22T00:00:00Z' }), 'INCONSISTENT_CLEARING');
  assert.equal(cleared.answer, null);
});

test('no saved text is distinct from mental evidence, and clearing never relabels written history as mental', () => {
  for (const original of [{ ...observation(), answer: '' }, { ...observation(), answer: '', evidenceMode: 'mental' as const }]) {
    assert.equal(isAnswerCleared(original), false); assert.equal(isAnswerPrivacyEligible(original), true);
    errorCode(() => planAnswerClearing(original, { observationEventId: original.eventId }, clearedAt), 'NO_SAVED_ANSWER');
  }
  const legacy = observation(); delete legacy.evidenceMode;
  const cleared = applyAnswerClearing(legacy, marker); assert.equal(Object.hasOwn(cleared, 'evidenceMode'), false);
  assert.equal(applyAnswerClearing(observation(), marker).evidenceMode, 'written');
  assert.equal(applyAnswerClearing({ ...observation(), answer: '   ' }, marker).answer, null);
  errorCode(() => applyAnswerClearing({ ...observation(), evidenceMode: 'mental' }, marker), 'INVALID_OBSERVATION');
});

test('answer privacy eligibility only excludes cleared records and does not replace assessment qualification or rewrite conditions', () => {
  const original = observation(); assert.equal(isAnswerCleared(original), false); assert.equal(isAnswerPrivacyEligible(original), true);
  const assisted = { ...observation(), rating: 'blank' as const, exposure: 'exposed' as const, observedExposure: true,
    learning: { ...observation().learning!, cue: 'lookup' as const, outcome: 'failure' as const, basis: 'application' as const } };
  // The existing learning-evidence filters remain responsible for these conditions.
  assert.equal(isAnswerPrivacyEligible(assisted), true);
  const cleared = applyAnswerClearing(assisted, marker); assert.equal(isAnswerPrivacyEligible(cleared), false);
  assert.deepEqual(cleared.learning, assisted.learning); assert.equal(cleared.rating, assisted.rating);
  assert.equal(cleared.exposure, assisted.exposure); assert.equal(cleared.observedExposure, assisted.observedExposure);
  assert.equal(cleared.anchorEventId, assisted.anchorEventId); assert.equal(cleared.halfLifeDays, assisted.halfLifeDays);
});
