import assert from 'node:assert/strict';
import test from 'node:test';
import { assessmentFromObservation, observationAssessmentsEqual, observationRevisionRequestEqual,
  ObservationRevisionError, parseObservationRevision, parseObservationRevisionRequest,
  type ObservationRevisionRequest } from '../src/shared/observation-revisions.js';
import type { Observation } from '../src/shared/types.js';

const request = () => ({ eventId: ' rev-1 ', observationEventId: ' obs-1 ', previousEventId: null,
  occurredAt: '2026-10-18T08:00:00+08:00', action: 'revise', reason: 'input-error',
  assessment: { rating: 'clear', learning: { outcome: 'failure', basis: 'self-check' } } });
const revision = () => ({ ...request(), conceptId: ' 概念 ', sourceRevision: ' source-revision ', recordedAt: '2026-10-18T00:01:00Z' });
const parent = () => ({ eventId: 'obs-1', conceptId: 'concept', sourceRevision: 'source-revision',
  observedAt: '2026-10-17T00:00:00Z', recordedAt: '2026-10-17T00:00:01Z', rating: 'clear',
  answer: '', evidenceMode: 'mental', exposure: 'exposed', observedExposure: true,
  learning: { outcome: 'unverified', basis: 'unknown', confidence: null, confidenceAt: null, cue: 'lookup', task: 'concept' },
} as Observation);
function rejects(value: unknown, stored = false) {
  assert.throws(() => stored ? parseObservationRevision(value) : parseObservationRevisionRequest(value), error => {
    assert.ok(error instanceof ObservationRevisionError);
    assert.equal(error.code, stored ? 'INVALID_REVISION' : 'INVALID_REQUEST');
    assert.equal(error.message, error.code);
    assert.doesNotMatch(error.message, /private|PASSWORD/);
    return true;
  });
}

test('revision requests normalize identities and instants, detach all levels and freeze without changing input', () => {
  const input = request(), original = structuredClone(input);
  const parsed = parseObservationRevisionRequest(input);
  assert.equal(parsed.eventId, 'rev-1'); assert.equal(parsed.observationEventId, 'obs-1');
  assert.equal(parsed.occurredAt, '2026-10-18T00:00:00.000Z'); assert.deepEqual(input, original);
  assert.ok(Object.isFrozen(parsed)); assert.notEqual(parsed, input);
  assert.equal(parsed.action, 'revise');
  if (parsed.action !== 'revise') assert.fail('expected revise');
  assert.notEqual(parsed.assessment, input.assessment); assert.notEqual(parsed.assessment.learning, input.assessment.learning);
  assert.ok(Object.isFrozen(parsed.assessment)); assert.ok(Object.isFrozen(parsed.assessment.learning));
  input.assessment.rating = 'blank'; input.assessment.learning.outcome = 'success';
  assert.deepEqual(parsed.assessment, { rating: 'clear', learning: { outcome: 'failure', basis: 'self-check' } });
});

test('action discriminators require full assessments only for revise and prohibit them on withdrawal or reinstatement', () => {
  const { assessment, ...base } = request();
  rejects(base);
  for (const action of ['withdraw', 'reinstate']) {
    const parsed = parseObservationRevisionRequest({ ...base, action });
    assert.equal(parsed.action, action); assert.equal(Object.hasOwn(parsed, 'assessment'), false);
    for (const extra of [assessment, undefined, null]) rejects({ ...base, action, assessment: extra });
  }
  for (const value of [{ rating: 'clear' }, { learning: null }, { rating: 'clear', learning: undefined },
    { rating: 'clear', learning: { outcome: 'success' } }, { rating: 'clear', learning: { basis: 'self-check' } }]) {
    rejects({ ...base, assessment: value });
  }
});

test('strict plain object fields reject attribution, inherited data, symbols, class instances and nested extras', () => {
  for (const value of [null, [], new (class { constructor() { Object.assign(this, request()); } })(),
    { ...request(), conceptId: 'private' }, { ...request(), sourceRevision: 'private' }, { ...request(), recordedAt: 'private' },
    { ...request(), answer: 'PASSWORD=private' }, { ...request(), [Symbol('private')]: true },
    { ...request(), assessment: { ...request().assessment, confidence: 100 } },
    { ...request(), assessment: { rating: 'clear', learning: { outcome: 'success', basis: 'self-check', task: 'scenario' } } },
  ]) rejects(value);
  const inherited = Object.create({ eventId: 'rev-1' }); Object.assign(inherited, request()); delete inherited.eventId;
  rejects(inherited);
  const withGetter = { ...request() }; Object.defineProperty(withGetter, 'note', { enumerable: true, get() { throw new Error('PASSWORD=private'); } });
  rejects(withGetter);
  const plain = Object.assign(Object.create(null), request());
  plain.assessment = Object.assign(Object.create(null), request().assessment);
  plain.assessment.learning = Object.assign(Object.create(null), request().assessment.learning);
  assert.equal(parseObservationRevisionRequest(plain).eventId, 'rev-1');
});

test('IDs, enums, provenance and instant validity enforce bounded normalized values with redacted errors', () => {
  for (const key of ['eventId', 'observationEventId', 'previousEventId']) {
    for (const value of ['', ' ', '-bad', '中文', 'a'.repeat(129), undefined]) rejects({ ...request(), [key]: value });
  }
  assert.equal(parseObservationRevisionRequest({ ...request(), eventId: ' '+ 'a'.repeat(128)+' ', previousEventId: ' prior:1 ' }).previousEventId, 'prior:1');
  for (const occurredAt of ['2026-10-18', '2026-10-18T00:00:00', '2026-02-30T00:00:00Z', 'private', undefined]) rejects({ ...request(), occurredAt });
  for (const [key, value] of [['action', 'remove'], ['reason', 'private'], ['reason', undefined]] as const) rejects({ ...request(), [key]: value });
  for (const value of [{ rating: 'good', learning: null }, { rating: 'clear', learning: { outcome: 'learned', basis: 'self-check' } },
    { rating: 'clear', learning: { outcome: 'failure', basis: 'unknown' } }, { rating: 'clear', learning: { outcome: 'success', basis: 'other' } }]) {
    rejects({ ...request(), assessment: value });
  }
});

test('optional notes preserve exact text and distinguish omission from empty while rejecting undefined or oversized text', () => {
  const empty = parseObservationRevisionRequest({ ...request(), note: '' });
  assert.equal(empty.note, ''); assert.equal(Object.hasOwn(parseObservationRevisionRequest(request()), 'note'), false);
  const spaces = ' \n explanation \n ';
  assert.equal(parseObservationRevisionRequest({ ...request(), note: spaces }).note, spaces);
  assert.equal(parseObservationRevisionRequest({ ...request(), note: '字'.repeat(1000) }).note!.length, 1000);
  for (const note of [undefined, null, 1, '字'.repeat(1001)]) rejects({ ...request(), note });
  assert.equal(observationRevisionRequestEqual(empty, parseObservationRevisionRequest(request())), false);
});

test('stored revisions require their own attribution and reception not preceding occurrence', () => {
  const parsed = parseObservationRevision(revision());
  assert.equal(parsed.conceptId, '概念'); assert.equal(parsed.sourceRevision, 'source-revision');
  assert.equal(parsed.recordedAt, '2026-10-18T00:01:00.000Z'); assert.ok(Object.isFrozen(parsed));
  for (const field of ['conceptId', 'sourceRevision', 'recordedAt']) {
    const missing = revision(); delete (missing as Record<string, unknown>)[field]; rejects(missing, true);
  }
  for (const value of [{ ...revision(), recordedAt: '2026-10-17T23:59:59Z' }, { ...revision(), conceptId: ' ' },
    { ...revision(), sourceRevision: 'x'.repeat(513) }, { ...revision(), accountId: 'other' }, { ...revision(), recordedAt: undefined }]) rejects(value, true);
  assert.equal(parseObservationRevision({ ...revision(), recordedAt: request().occurredAt }).recordedAt, '2026-10-18T00:00:00.000Z');
});

test('canonical comparison ignores key order and equivalent ID/time spelling but preserves meaningful decisions', () => {
  const canonical = parseObservationRevisionRequest(request());
  const reordered = { assessment: { learning: { basis: 'self-check', outcome: 'failure' }, rating: 'clear' }, reason: 'input-error', action: 'revise',
    occurredAt: '2026-10-18T00:00:00.000Z', previousEventId: null, observationEventId: 'obs-1', eventId: 'rev-1' } as ObservationRevisionRequest;
  assert.equal(observationRevisionRequestEqual(canonical, reordered), true);
  assert.equal(observationRevisionRequestEqual(canonical, { ...reordered, reason: 'other' }), false);
  assert.equal(observationAssessmentsEqual({ rating: 'clear', learning: { outcome: 'failure', basis: 'self-check' } },
    { learning: { basis: 'self-check', outcome: 'failure' }, rating: 'clear' }), true);
  assert.equal(observationAssessmentsEqual({ rating: 'clear', learning: null }, { rating: 'blank', learning: null }), false);
});

test('parent assessment projection preserves independent rating/outcome and mental conditions without inventing legacy evidence', () => {
  const input = parent(), before = structuredClone(input);
  const assessed = assessmentFromObservation(input);
  assert.deepEqual(assessed, { rating: 'clear', learning: { outcome: 'unverified', basis: 'unknown' } });
  assert.ok(Object.isFrozen(assessed)); assert.ok(Object.isFrozen(assessed.learning));
  assert.notEqual(assessed.learning, input.learning); assert.deepEqual(input, before);
  const legacy = { ...input }; delete legacy.learning;
  assert.deepEqual(assessmentFromObservation(legacy), { rating: 'clear', learning: null });
  assert.deepEqual(assessmentFromObservation({ ...input, learning: undefined }), { rating: 'clear', learning: null });
  // Parent identities, timestamps and non-assessment conditions belong to core validation.
  assert.deepEqual(assessmentFromObservation({ rating: 'blank' } as Observation), { rating: 'blank', learning: null });
  for (const rating of ['clear', 'partial', 'blank'] as const) {
    const parsed = parseObservationRevisionRequest({ ...request(), assessment: { rating, learning: { outcome: 'failure', basis: 'application' } } });
    assert.equal(parsed.action === 'revise' && parsed.assessment.rating, rating);
  }
  for (const bad of [{ ...input, rating: 'wrong' }, { ...input, learning: null }, { ...input, learning: 'private' },
    { ...input, learning: { outcome: 'success', basis: 'unknown' } }]) {
    assert.throws(() => assessmentFromObservation(bad as Observation), { code: 'INVALID_PARENT', message: 'INVALID_PARENT' });
  }
});
