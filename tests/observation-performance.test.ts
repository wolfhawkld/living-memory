import assert from 'node:assert/strict';
import test from 'node:test';
import { applyAnswerClearing } from '../src/core/answer-clearing.js';
import { projectObservationPerformance, selectObservationPerformanceForConcept } from '../src/core/observation-performance.js';
import type { PrivacyObservation } from '../src/shared/answer-clearing.js';
import type { ObservationRevision } from '../src/shared/observation-revisions.js';
import type { Observation } from '../src/shared/types.js';

const AS_OF = '2026-10-30T00:00:00.000Z';
const CLEAR_AT = '2026-10-25T00:00:00.000Z';
function observation(eventId: string, fields: Partial<Observation> = {}): Observation {
  return { eventId, conceptId: 'concept-a', sourceRevision: 'revision-a',
    observedAt: '2026-10-20T00:00:00.000Z', recordedAt: '2026-10-20T00:00:01.000Z',
    configRevision: 1, halfLifeDays: 7, anchorEventId: 'anchor-a', elapsedDays: 7, decay: .5,
    answer: `SYNTHETIC_ANSWER_${eventId}`, rating: 'clear', exposure: 'unexposed', observedExposure: false,
    evidenceMode: 'written', learning: { task: 'concept', confidence: 80, confidenceAt: '2026-10-19T23:59:59.000Z',
      cue: 'independent', outcome: 'success', basis: 'self-check' }, ...fields };
}
function cleared(parent: Observation): PrivacyObservation {
  return applyAnswerClearing(parent, { observationEventId: parent.eventId, clearedAt: CLEAR_AT });
}
function action(eventId: string, parent: PrivacyObservation, kind: 'withdraw' | 'reinstate', previousEventId: string | null,
  fields: Partial<ObservationRevision> = {}): ObservationRevision {
  return { eventId, observationEventId: parent.eventId, previousEventId, conceptId: parent.conceptId,
    sourceRevision: parent.sourceRevision, action: kind, reason: 'other',
    occurredAt: '2026-10-21T00:00:00.000Z', recordedAt: '2026-10-21T00:00:01.000Z', ...fields } as ObservationRevision;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

test('performance excludes current cleared answers while preserving adopted judgments and frozen conditions', () => {
  const intact = observation('intact');
  const removed = cleared(observation('removed'));
  const result = projectObservationPerformance([intact, removed], [], AS_OF);
  assert.deepEqual(result.observations.map(item => item.eventId), ['intact']);
  assert.deepEqual(result.privacy, { cleared: 1, excludedFromPerformance: 1 });
  assert.equal(result.assessments.effective.length, 2);
  const preserved = result.assessments.effective.find(item => item.observationEventId === removed.eventId)!.observation;
  assert.equal(preserved.answer, null);
  assert.deepEqual(preserved, removed);
  assert.deepEqual(result.assessments.states.map(item => item.status), ['active', 'active']);
  assert.equal(result.observations[0].learning?.confidence, 80);
  assert.equal(result.observations[0].decay, .5);
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_ANSWER_removed/);
  assert.deepEqual(Object.keys(result.privacy).sort(), ['cleared', 'excludedFromPerformance']);
});

test('withdrawal and reinstatement do not clear or restore privacy eligibility', () => {
  const parent = cleared(observation('parent'));
  const withdrawn = action('withdrawn', parent, 'withdraw', null);
  const reinstated = action('reinstated', parent, 'reinstate', withdrawn.eventId);
  const duringWithdrawal = projectObservationPerformance([parent], [withdrawn], AS_OF);
  assert.equal(duringWithdrawal.assessments.states[0].status, 'withdrawn');
  assert.deepEqual(duringWithdrawal.privacy, { cleared: 1, excludedFromPerformance: 0 });
  assert.deepEqual(duringWithdrawal.observations, []);
  const afterReinstatement = projectObservationPerformance([parent], [withdrawn, reinstated], AS_OF);
  assert.equal(afterReinstatement.assessments.states[0].status, 'active');
  assert.deepEqual(afterReinstatement.privacy, { cleared: 1, excludedFromPerformance: 1 });
  assert.deepEqual(afterReinstatement.observations, []);
  assert.equal(afterReinstatement.assessments.states[0].appliedRevisionCount, 2);
});

test('past queries never resurrect a currently cleared answer and future parents are not counted yet', () => {
  const parent = cleared(observation('parent'));
  const beforeClearing = projectObservationPerformance([parent], [], '2026-10-21T00:00:00.000Z');
  assert.deepEqual(beforeClearing.privacy, { cleared: 1, excludedFromPerformance: 1 });
  assert.deepEqual(beforeClearing.observations, []);
  assert.equal(beforeClearing.assessments.effective[0].observation.answer, null);
  const beforeReceipt = projectObservationPerformance([parent], [], parent.observedAt);
  assert.deepEqual(beforeReceipt.privacy, { cleared: 0, excludedFromPerformance: 0 });
  assert.deepEqual(beforeReceipt.observations, []);
  assert.equal(beforeReceipt.assessments.states[0].status, 'not-yet-recorded');
  const future = cleared(observation('future', { observedAt: '2026-10-24T00:00:00.000Z',
    recordedAt: '2026-10-24T00:00:01.000Z' }));
  assert.deepEqual(projectObservationPerformance([future], [], '2026-10-23T00:00:00.000Z').privacy,
    { cleared: 0, excludedFromPerformance: 0 });
});

test('concept selection uses immutable parents across versions and preserves bad-chain diagnostics', () => {
  const old = cleared(observation('old', { sourceRevision: 'old-version' }));
  const current = observation('current');
  const other = cleared(observation('other', { conceptId: 'concept-b' }));
  // A damaged revision claims B, but its immutable parent belongs to A. A
  // partial re-projection that filters revisions by claimed concept would revive A.
  const corrupt = action('wrong-owner', old, 'withdraw', null, { conceptId: 'concept-b' });
  const raw = [old, current, other];
  const full = projectObservationPerformance(raw, [corrupt], AS_OF);
  assert.deepEqual(full.privacy, { cleared: 2, excludedFromPerformance: 1 });
  const selectedA = selectObservationPerformanceForConcept(full, raw, 'concept-a');
  assert.deepEqual(selectedA.privacy, { cleared: 1, excludedFromPerformance: 0 });
  assert.deepEqual(selectedA.observations.map(item => item.eventId), ['current']);
  assert.equal(selectedA.assessments.states.find(item => item.observationEventId === 'old')?.status, 'unresolved');
  assert.deepEqual(selectedA.assessments.issues.map(item => item.code), ['PARENT_MISMATCH']);
  const selectedB = selectObservationPerformanceForConcept(full, raw, 'concept-b');
  assert.deepEqual(selectedB.privacy, { cleared: 1, excludedFromPerformance: 1 });
  assert.deepEqual(selectedB.assessments.issues, []);
  assert.deepEqual(selectedB.assessments.states.map(item => item.observationEventId), ['other']);
  const absent = selectObservationPerformanceForConcept(full, raw, 'missing');
  assert.deepEqual(absent.privacy, { cleared: 0, excludedFromPerformance: 0 });
  assert.deepEqual(absent.assessments.effective, []);
  assert.deepEqual(absent.assessments.states, []);
  assert.deepEqual(absent.assessments.issues, []);
});

test('projection and concept selection leave frozen raw records, revisions and complete projection unchanged', () => {
  const parent = observation('parent');
  const removed = cleared(observation('removed', { conceptId: 'concept-b' }));
  const revision: ObservationRevision = { eventId: 'revise', observationEventId: parent.eventId, previousEventId: null,
    conceptId: parent.conceptId, sourceRevision: parent.sourceRevision, occurredAt: '2026-10-21T00:00:00.000Z',
    recordedAt: '2026-10-21T00:00:01.000Z', action: 'revise', reason: 'input-error',
    assessment: { rating: 'partial', learning: { outcome: 'failure', basis: 'self-check' } } };
  const raw = freeze([parent, removed]), revisions = freeze([revision]);
  const before = JSON.stringify([raw, revisions]);
  const full = freeze(projectObservationPerformance(raw, revisions, AS_OF));
  const fullBefore = JSON.stringify(full);
  const selected = selectObservationPerformanceForConcept(full, raw, parent.conceptId);
  assert.equal(selected.observations[0].rating, 'partial');
  assert.equal(selected.observations[0].learning?.outcome, 'failure');
  assert.equal(selected.observations[0].learning?.confidence, parent.learning?.confidence);
  assert.equal(JSON.stringify([raw, revisions]), before);
  assert.equal(JSON.stringify(full), fullBefore);
  assert.equal(raw[0].rating, 'clear');
});

test('invalid current privacy states fail closed even for withdrawn and not-yet-recorded parents', () => {
  const parent = observation('parent');
  const missingMarker = { ...parent, answer: null } as PrivacyObservation;
  const contradictory = { ...parent, answerClearing: { observationEventId: parent.eventId, clearedAt: CLEAR_AT } } as PrivacyObservation;
  const wrongParent = { ...cleared(parent), answerClearing: { observationEventId: 'foreign', clearedAt: CLEAR_AT } } as PrivacyObservation;
  for (const invalid of [missingMarker, contradictory, wrongParent]) {
    for (const revisions of [[], [action('withdraw', invalid, 'withdraw', null)]]) {
      for (const asOf of [AS_OF, '2026-10-19T00:00:00.000Z']) {
        assert.throws(() => projectObservationPerformance([invalid], revisions, asOf),
          error => error instanceof Error && 'code' in error
            && ['INCONSISTENT_CLEARING', 'INVALID_MARKER'].includes(String(error.code)));
      }
    }
  }
});

test('the privacy gate leaves other performance and calibration conditions to existing algorithms', () => {
  const mental = observation('mental', { answer: '', evidenceMode: 'mental' });
  const unverified = observation('unverified', { answer: '', learning: { task: 'concept', confidence: null,
    confidenceAt: null, cue: 'lookup', outcome: 'unverified', basis: 'unknown' }, exposure: 'exposed' });
  const result = projectObservationPerformance([mental, unverified], [], AS_OF);
  assert.deepEqual(result.observations.map(item => item.eventId), ['mental', 'unverified']);
  assert.deepEqual(result.privacy, { cleared: 0, excludedFromPerformance: 0 });
  assert.equal(result.observations[0].evidenceMode, 'mental');
  assert.equal(result.observations[1].learning?.outcome, 'unverified');
});
