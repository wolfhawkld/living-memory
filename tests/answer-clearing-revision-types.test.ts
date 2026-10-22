import assert from 'node:assert/strict';
import test from 'node:test';
import { applyAnswerClearing, isAnswerPrivacyEligible } from '../src/core/answer-clearing.js';
import { projectObservationAssessments, type DerivedObservationAssessment,
  type ObservationAssessmentProjection } from '../src/core/observation-revisions.js';
import type { ClearedObservation, PrivacyObservation } from '../src/shared/answer-clearing.js';
import { assessmentFromObservation, type ObservationRevision } from '../src/shared/observation-revisions.js';
import type { Observation } from '../src/shared/types.js';
import { planObservationRevisionImport, type ObservationRevisionImportInput } from '../src/server/observation-revision-import.js';

const NOW = '2026-10-22T00:00:00Z';
function original(): Observation {
  return { eventId: 'parent', conceptId: 'concept', sourceRevision: 'revision',
    observedAt: '2026-10-01T00:00:00Z', recordedAt: '2026-10-01T00:00:01Z', configRevision: 1,
    halfLifeDays: 7, anchorEventId: null, elapsedDays: null, decay: null,
    answer: 'SYNTHETIC_PRIVATE_ORIGINAL', evidenceMode: 'written', rating: 'clear',
    exposure: 'unexposed', observedExposure: false, learning: { task: 'concept', confidence: 80,
      confidenceAt: '2026-09-30T23:59:00Z', cue: 'independent', outcome: 'success', basis: 'self-check' } };
}
function cleared(): ClearedObservation {
  return applyAnswerClearing(original(), { observationEventId: 'parent', clearedAt: '2026-10-20T00:00:00Z' });
}
function chain(): ObservationRevision[] {
  const base = { observationEventId: 'parent', conceptId: 'concept', sourceRevision: 'revision',
    occurredAt: '2026-10-02T00:00:00Z', recordedAt: '2026-10-02T00:00:01Z', reason: 'rechecked-original' as const };
  return [
    { ...base, eventId: 'revise', previousEventId: null, action: 'revise',
      assessment: { rating: 'partial', learning: { outcome: 'partial', basis: 'self-check' } } },
    { ...base, eventId: 'withdraw', previousEventId: 'revise', action: 'withdraw' },
    { ...base, eventId: 'reinstate', previousEventId: 'withdraw', action: 'reinstate' },
  ];
}
// Compile-time compatibility assertions: existing callers keep their string-answer types.
function typeCompatibility(parent: Observation, removed: ClearedObservation) {
  const legacy: ObservationAssessmentProjection = projectObservationAssessments([parent], chain(), NOW);
  const row: DerivedObservationAssessment = legacy.effective[0];
  const oldParent: Observation = row.observation;
  const oldInput: ObservationRevisionImportInput = { currentObservations: [parent], observations: [parent],
    currentRevisions: [], incomingRevisions: [], occupiedEventIds: new Set(), exportedAt: NOW };
  const privacy = projectObservationAssessments([removed], chain(), NOW);
  const nullAnswer: null = privacy.effective[0].observation.answer;
  const marker = privacy.effective[0].observation.answerClearing;
  // @ts-expect-error Cleared parents must not enter old string-answer evidence consumers.
  const unsafeOriginal: Observation = privacy.effective[0].observation;
  return { oldParent, oldInput, nullAnswer, marker, unsafeOriginal };
}
void typeCompatibility;

test('cleared answers and markers survive revise, withdraw and reinstate without qualifying as answer evidence', () => {
  const parent = cleared(), before = structuredClone(parent), events = chain();
  for (const count of [0, 1, 2, 3]) {
    const result = projectObservationAssessments([parent], events.slice(0, count), NOW);
    assert.deepEqual(result.issues, []);
    assert.equal(result.states[0].status, count === 2 ? 'withdrawn' : 'active');
    assert.equal(result.states[0].appliedRevisionCount, count);
    if (count === 2) { assert.deepEqual(result.effective, []); continue; }
    const projected = result.effective[0].observation;
    assert.equal(projected.answer, null);
    assert.deepEqual(projected.answerClearing, parent.answerClearing);
    assert.equal(isAnswerPrivacyEligible(projected), false);
    assert.equal(projected.rating, count ? 'partial' : 'clear');
    assert.equal(projected.learning?.confidence, 80);
    assert.equal(projected.halfLifeDays, parent.halfLifeDays);
    assert.equal(projected.anchorEventId, parent.anchorEventId);
    assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE_ORIGINAL/);
  }
  assert.deepEqual(parent, before);
  assert.deepEqual(assessmentFromObservation(parent), assessmentFromObservation(original()));
});

test('historical projection cannot revive a cleared answer before its clearing timestamp or adopt future revisions', () => {
  const parent = cleared(), events = chain();
  for (const asOf of ['2026-10-01T00:00:01Z', '2026-10-02T00:00:01Z', NOW]) {
    const result = projectObservationAssessments([parent], events, asOf);
    assert.equal(result.effective[0].observation.answer, null);
    assert.deepEqual(result.effective[0].observation.answerClearing, parent.answerClearing);
    assert.equal(result.states[0].appliedRevisionCount, asOf === '2026-10-01T00:00:01Z' ? 0 : 3);
  }
  const future = { eventId: 'bad-future', recordedAt: '2026-10-23T00:00:00Z', observationEventId: null };
  assert.deepEqual(projectObservationAssessments([parent], [...events, future], NOW),
    projectObservationAssessments([parent], events, NOW));
});

test('revision import validates and orders cleared-parent history without altering or reconstructing its answer', () => {
  const parent = cleared(), before = structuredClone(parent), events = chain();
  const input: ObservationRevisionImportInput<PrivacyObservation> = { currentObservations: [parent], observations: [parent],
    currentRevisions: [events[0]], incomingRevisions: [events[2], events[1], events[0]],
    occupiedEventIds: new Set(['parent']), exportedAt: NOW };
  const result = planObservationRevisionImport(input);
  assert.deepEqual(result.newRevisions.map(event => event.eventId), ['withdraw', 'reinstate']);
  assert.deepEqual(result.duplicateEventIds, ['revise']);
  assert.deepEqual(result.mergedRevisions.map(event => event.eventId), ['revise', 'withdraw', 'reinstate']);
  const projected = projectObservationAssessments(input.observations, result.mergedRevisions, NOW);
  assert.equal(projected.effective[0].observation.answer, null);
  assert.equal(isAnswerPrivacyEligible(projected.effective[0].observation), false);
  assert.deepEqual(parent, before);
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE_ORIGINAL/);
});

test('cleared parents retain identity, temporal, fork and predecessor validation', () => {
  const parent = cleared(), [revise, withdraw] = chain();
  for (const [events, code] of [
    [[{ ...revise, conceptId: 'foreign' }], 'PARENT_MISMATCH'],
    [[{ ...revise, sourceRevision: 'foreign' }], 'PARENT_MISMATCH'],
    [[{ ...revise, recordedAt: '2026-10-01T00:00:00Z', occurredAt: '2026-10-01T00:00:00Z' }], 'INVALID_REVISION_TIME'],
    [[{ ...withdraw, previousEventId: 'missing' }], 'MISSING_PREDECESSOR'],
    [[revise, { ...revise, eventId: 'other-root' }], 'FORK'],
  ] as const) {
    const result = projectObservationAssessments([parent], events, NOW);
    assert.equal(result.effective.length, 0);
    assert.ok(result.issues.some(issue => issue.code === code));
    assert.throws(() => planObservationRevisionImport({ currentObservations: [parent], observations: [parent],
      currentRevisions: [], incomingRevisions: events, occupiedEventIds: new Set(), exportedAt: NOW }),
    { code: 'OBSERVATION_REVISION_IMPORT_INVALID_CHAIN' });
  }
  assert.throws(() => planObservationRevisionImport({ currentObservations: [parent], observations: [parent],
    currentRevisions: [], incomingRevisions: [revise], occupiedEventIds: new Set(),
    exportedAt: '2026-10-01T00:00:01Z' }), { code: 'OBSERVATION_REVISION_IMPORT_INVALID_TIME' });
});
