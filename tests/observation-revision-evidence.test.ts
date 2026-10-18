import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeLearning } from '../src/core/learning-evidence.js';
import { buildLearningProgress } from '../src/core/learning-progress.js';
import { buildTimeRecallSummary } from '../src/core/time-recall.js';
import { projectObservationAssessments } from '../src/core/observation-revisions.js';
import type { ObservationRevision } from '../src/shared/observation-revisions.js';
import type { AnchorEvent, Observation } from '../src/shared/types.js';

const AS_OF = '2026-10-20T00:00:00Z';
const anchor: AnchorEvent = { eventId: 'anchor', conceptId: 'concept', sourceRevision: 'v1', kind: 'review',
  occurredAt: '2026-09-24T00:00:00Z', recordedAt: '2026-09-24T00:00:01Z' };
function observation(eventId: string, fields: Partial<Observation> = {}): Observation {
  return { eventId, conceptId: 'concept', sourceRevision: 'v1', observedAt: '2026-10-01T00:00:00Z',
    recordedAt: '2026-10-01T00:00:01Z', configRevision: 1, halfLifeDays: 7, anchorEventId: anchor.eventId,
    elapsedDays: 7, decay: .5, answer: 'frozen original reasoning', rating: 'clear', evidenceMode: 'written',
    exposure: 'unexposed', observedExposure: false, learning: { task: 'concept', confidence: 80,
      confidenceAt: '2026-09-30T23:59:00Z', cue: 'independent', outcome: 'success', basis: 'self-check' }, ...fields };
}
function correction(id: string, parent: Observation): ObservationRevision {
  return { eventId: id, observationEventId: parent.eventId, previousEventId: null,
    conceptId: parent.conceptId, sourceRevision: parent.sourceRevision, occurredAt: '2026-10-15T00:00:00Z',
    recordedAt: '2026-10-15T00:00:01Z', action: 'revise', reason: 'rechecked-original',
    assessment: { rating: 'blank', learning: parent.learning ? { outcome: 'failure', basis: 'self-check' } : null } };
}
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) frozen(child); Object.freeze(value); }
  return value;
}

test('derived judgments change calibration and time comparisons while keeping original chronology and bytes', () => {
  const old = observation('older');
  const recent = observation('newer', { observedAt: '2026-10-08T00:00:00Z', recordedAt: '2026-10-08T00:00:01Z', elapsedDays: 14, decay: .25 });
  const raw = frozen([old, recent]), revisions = frozen([correction('rechecked-old-answer', old)]);
  const beforeBytes = JSON.stringify([raw, revisions, anchor]);
  const original = summarizeLearning(raw);
  const result = projectObservationAssessments(raw, revisions, AS_OF);
  const effective = result.effective.map(item => item.observation);
  const corrected = summarizeLearning(effective);
  assert.equal(original.calibration.concept.count, 2);
  assert.equal(original.calibration.concept.successRate, 100);
  assert.equal(corrected.calibration.concept.count, 2);
  assert.equal(corrected.calibration.concept.meanConfidence, 80);
  assert.equal(corrected.calibration.concept.successRate, 50);
  assert.ok(Math.abs(corrected.calibration.concept.brier! - .34) < 1e-12);
  const progress = buildLearningProgress({ conceptId: 'concept', sourceRevision: 'v1', observations: effective, asOf: AS_OF });
  assert.equal(progress.tasks.concept.previous?.eventId, old.eventId);
  assert.equal(progress.tasks.concept.previous?.rating, 'blank');
  assert.equal(progress.tasks.concept.latest?.eventId, recent.eventId);
  assert.equal(progress.tasks.concept.intervalDays, 7);
  const beforeTime = buildTimeRecallSummary(raw, [anchor], AS_OF);
  const afterTime = buildTimeRecallSummary(effective, [anchor], AS_OF);
  assert.equal(beforeTime.buckets.find(bucket => bucket.latest.eventId === old.eventId)?.ratings.clear, 1);
  const bucket = afterTime.buckets.find(item => item.latest.eventId === old.eventId)!;
  assert.equal(bucket.ratings.blank, 1);
  assert.equal(bucket.latest.halfLifeDays, 7);
  assert.equal(bucket.latest.configRevision, 1);
  assert.equal(bucket.latest.decay, .5);
  assert.equal(bucket.latest.observedAt, old.observedAt);
  assert.equal(JSON.stringify([raw, revisions, anchor]), beforeBytes);
});

test('withdraw and reinstate remove and restore one old sample without upgrading mental, exposed or legacy evidence', () => {
  const good = observation('eligible');
  const mental = observation('mental', { evidenceMode: 'mental', answer: '', learning: {
    task: 'concept', confidence: 80, confidenceAt: '2026-09-30T23:59:00Z', cue: 'independent', outcome: 'failure', basis: 'self-check' } });
  const exposed = observation('exposed', { exposure: 'exposed', observedExposure: true, learning: { ...mental.learning! } });
  const legacy = observation('legacy', { learning: undefined });
  const raw = frozen([good, mental, exposed, legacy]);
  const improve = (parent: Observation): ObservationRevision => ({ ...correction(`recheck-${parent.eventId}`, parent),
    action: 'revise', assessment: { rating: 'partial', learning: { outcome: 'success', basis: 'self-check' } } });
  const changes = [improve(mental), improve(exposed), correction('legacy-rating-only', legacy)];
  const withdraw: ObservationRevision = { eventId: 'withdraw-good', observationEventId: good.eventId,
    conceptId: good.conceptId, sourceRevision: good.sourceRevision, previousEventId: null,
    occurredAt: '2026-10-16T00:00:00Z', recordedAt: '2026-10-16T00:00:01Z', action: 'withdraw', reason: 'unreliable-evidence' };
  const restore: ObservationRevision = { ...withdraw, eventId: 'restore-good', previousEventId: withdraw.eventId,
    occurredAt: '2026-10-17T00:00:00Z', recordedAt: '2026-10-17T00:00:01Z', action: 'reinstate' };
  const active = projectObservationAssessments(raw, changes, AS_OF);
  assert.equal(summarizeLearning(active.effective.map(item => item.observation)).calibration.concept.count, 1);
  const withdrawn = projectObservationAssessments(raw, [...changes, withdraw], AS_OF);
  assert.equal(summarizeLearning(withdrawn.effective.map(item => item.observation)).calibration.concept.count, 0);
  const reinstated = projectObservationAssessments(raw, [...changes, withdraw, restore], AS_OF);
  assert.equal(summarizeLearning(reinstated.effective.map(item => item.observation)).calibration.concept.count, 1);
  assert.equal(reinstated.effective.find(item => item.observationEventId === good.eventId)?.observation.observedAt, good.observedAt);
  assert.equal(reinstated.effective.find(item => item.observationEventId === mental.eventId)?.observation.evidenceMode, 'mental');
  assert.equal(reinstated.effective.find(item => item.observationEventId === exposed.eventId)?.observation.observedExposure, true);
  assert.equal(reinstated.effective.find(item => item.observationEventId === legacy.eventId)?.observation.learning, undefined);
  assert.equal(raw.length, 4); // Raw submission facts remain available for OR-03 budget/receipt consumers.
  assert.equal(raw[0].rating, 'clear');
});

test('historical source reassessment stays with its original version and before-receipt projections use the old judgment', () => {
  const parent = frozen(observation('historical-source'));
  const revision = frozen(correction('later-recheck', parent));
  const before = projectObservationAssessments([parent], [revision], '2026-10-14T00:00:00Z');
  assert.equal(summarizeLearning(before.effective.map(item => item.observation)).calibration.concept.successRate, 100);
  const after = projectObservationAssessments([parent], [revision], AS_OF);
  assert.equal(after.effective[0].observation.sourceRevision, 'v1');
  const current = buildLearningProgress({ conceptId: parent.conceptId, sourceRevision: 'v2',
    observations: after.effective.map(item => item.observation), asOf: AS_OF });
  assert.equal(current.tasks.concept.total, 0);
  assert.equal(current.excluded.previousRevision, 1);
  assert.equal(parent.rating, 'clear');
  assert.equal(parent.sourceRevision, 'v1');
});

test('scenario reassessment changes results while preserving the task, prompt, applicability and prospective conditions', () => {
  for (const assisted of [false, true]) {
    const parent = frozen(observation('scenario-original', {
      exposure: assisted ? 'exposed' : 'unexposed', observedExposure: assisted,
      learning: { task: 'scenario', scenario: 'Synthetic case: choose a rule representation.',
        scenarioRevisit: true, applicability: 'Deterministic rules with explicit precedence.',
        confidence: 80, confidenceAt: '2026-09-30T23:59:00Z',
        cue: assisted ? 'hinted' : 'independent', outcome: 'success', basis: 'application' },
    }));
    const revision = frozen(correction('scenario-recheck', parent));
    const originalBytes = JSON.stringify([parent, revision]);
    const before = summarizeLearning([parent]);
    const result = projectObservationAssessments([parent], [revision], AS_OF);
    assert.equal(result.issues.length, 0);
    const effective = result.effective[0].observation;
    assert.deepEqual(effective, { ...parent, rating: 'blank', learning: {
      ...parent.learning!, outcome: 'failure', basis: 'self-check',
    } });
    const after = summarizeLearning([effective]);
    assert.equal(before.scenario.total, 1);
    assert.equal(before.scenario.failure, 0);
    assert.equal(before.scenario.independentSuccess, assisted ? 0 : 1);
    assert.equal(after.scenario.total, 1);
    assert.equal(after.scenario.failure, 1);
    assert.equal(after.scenario.independentSuccess, 0);
    assert.equal(after.scenario.assisted, assisted ? 1 : 0);
    assert.equal(after.scenario.revisited, 1);
    assert.equal(after.calibration.scenario.count, assisted ? 0 : 1);
    assert.equal(after.calibration.scenario.successRate, assisted ? null : 0);
    assert.equal(after.calibration.scenario.meanConfidence, assisted ? null : 80);
    const progress = buildLearningProgress({ conceptId: parent.conceptId, sourceRevision: parent.sourceRevision,
      observations: [effective], asOf: AS_OF });
    assert.equal(progress.tasks.concept.total, 0);
    assert.equal(progress.tasks.scenario.latest?.eventId, parent.eventId);
    assert.equal(progress.tasks.scenario.latest?.observedAt, parent.observedAt);
    assert.equal(progress.tasks.scenario.latest?.scenarioRevisit, true);
    assert.equal(JSON.stringify([parent, revision]), originalBytes);
  }
});
