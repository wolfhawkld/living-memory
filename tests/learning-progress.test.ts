import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildLearningProgress } from '../src/core/learning-progress.js';
import type { LearningEvidence, Observation } from '../src/shared/types.js';

const AS_OF = '2026-09-30T00:00:00Z';

function observation(overrides: Partial<Observation> = {}, learning: Partial<LearningEvidence> | undefined = {}): Observation {
  const observedAt = overrides.observedAt ?? '2026-09-20T00:00:00Z';
  return {
    eventId: 'event',
    conceptId: 'concept-a',
    sourceRevision: 'rev-2',
    observedAt,
    recordedAt: overrides.recordedAt ?? observedAt,
    configRevision: 7,
    halfLifeDays: 12,
    anchorEventId: null,
    elapsedDays: 3.5,
    decay: 0.8,
    answer: 'private answer',
    rating: 'clear',
    exposure: 'unexposed',
    observedExposure: false,
    learning: {
      task: 'concept',
      scenario: 'private scenario text',
      applicability: 'private applicability text',
      confidence: 80,
      confidenceAt: '2026-09-19T23:59:00Z',
      cue: 'independent',
      outcome: 'success',
      basis: 'self-check',
      ...learning,
    },
    ...overrides,
  };
}

test('filters by concept and revision, classifies bad times before old revisions, and keeps all current records in totals', () => {
  const result = buildLearningProgress({
    conceptId: 'concept-a',
    sourceRevision: 'rev-2',
    asOf: AS_OF,
    observations: [
      observation({ eventId: 'current' }),
      observation({ eventId: 'other-concept', conceptId: 'concept-b' }),
      observation({ eventId: 'old', sourceRevision: 'rev-1' }),
      observation({ eventId: 'old-future', sourceRevision: 'rev-1', observedAt: '2026-10-01T00:00:00Z' }),
      observation({ eventId: 'invalid-order', recordedAt: '2026-09-19T23:59:59Z' }),
      observation({ eventId: 'invalid-date', observedAt: 'not-an-instant' }),
    ],
  });

  assert.equal(result.excluded.previousRevision, 1);
  assert.equal(result.excluded.invalidTime, 3);
  assert.equal(result.tasks.concept.total, 1);
  assert.equal(result.tasks.concept.latest?.eventId, 'current');
  assert.equal(result.tasks.scenario.total, 0);
});

test('separates legacy concept and scenario tasks and orders ties by observed, recorded, then event ID', () => {
  const sameObserved = '2026-09-21T00:00:00Z';
  const result = buildLearningProgress({
    conceptId: 'concept-a',
    sourceRevision: 'rev-2',
    asOf: AS_OF,
    observations: [
      observation({ eventId: 'a', observedAt: sameObserved, recordedAt: '2026-09-21T00:00:01Z' }),
      observation({ eventId: 'z', observedAt: sameObserved, recordedAt: '2026-09-21T00:00:01Z' }),
      observation({ eventId: 'late-record', observedAt: sameObserved, recordedAt: '2026-09-21T00:00:02Z' }),
      observation({ eventId: 'scenario', observedAt: '2026-09-22T00:00:00Z', recordedAt: '2026-09-22T00:00:01Z' }, { task: 'scenario', basis: 'application' }),
      observation({ eventId: 'legacy', learning: undefined, observedAt: '2026-09-19T00:00:00Z' }),
    ],
  });

  assert.equal(result.tasks.concept.total, 4);
  assert.equal(result.tasks.concept.latest?.eventId, 'late-record');
  assert.equal(result.tasks.concept.previous?.eventId, 'z');
  assert.equal(result.tasks.scenario.total, 1);
  assert.equal(result.tasks.scenario.latest?.eventId, 'scenario');
  assert.equal(result.tasks.concept.intervalDays, 0);
});

test('keeps the two newest records, computes actual interval, and preserves historical model values', () => {
  const result = buildLearningProgress({
    conceptId: 'concept-a',
    sourceRevision: 'rev-2',
    asOf: AS_OF,
    observations: [
      observation({ eventId: 'earliest', observedAt: '2026-09-01T00:00:00Z', elapsedDays: 99, halfLifeDays: 4, configRevision: 1 }),
      observation({ eventId: 'previous', observedAt: '2026-09-10T00:00:00Z', elapsedDays: 20, halfLifeDays: 8, configRevision: 2 }),
      observation({ eventId: 'latest', observedAt: '2026-09-20T12:00:00Z', elapsedDays: 1, halfLifeDays: 99, configRevision: 3 }),
    ],
  });

  assert.equal(result.tasks.concept.previous?.eventId, 'previous');
  assert.equal(result.tasks.concept.latest?.eventId, 'latest');
  assert.equal(result.tasks.concept.intervalDays, 10.5);
  assert.equal(result.tasks.concept.latest?.elapsedDays, 1);
  assert.equal(result.tasks.concept.latest?.halfLifeDays, 99);
  assert.equal(result.tasks.concept.latest?.configRevision, 3);
});

test('validates confidence independently and maps missing learning to privacy-safe unknown fields', () => {
  const result = buildLearningProgress({
    conceptId: 'concept-a',
    sourceRevision: 'rev-2',
    asOf: AS_OF,
    observations: [
      observation({ eventId: 'missing-learning', learning: undefined }),
      observation({ eventId: 'bad-confidence', observedAt: '2026-09-21T00:00:00Z' }, { confidence: 80, confidenceAt: '2026-09-21T00:00:01Z' }),
    ],
  });

  const previous = result.tasks.concept.previous;
  const latest = result.tasks.concept.latest;
  assert.equal(previous?.eventId, 'missing-learning');
  assert.equal(previous?.cue, 'unknown');
  assert.equal(previous?.outcome, 'unverified');
  assert.equal(previous?.basis, 'unknown');
  assert.equal(previous?.confidence, null);
  assert.equal(latest?.confidence, null);
  assert.equal('answer' in (latest ?? {}), false);
  assert.equal('scenario' in (latest ?? {}), false);
});

test('conditions account for effective exposure and task-specific basis without inferring outcomes', () => {
  const make = (eventId: string, observedAt: string, learning: Partial<LearningEvidence>, fields: Partial<Observation> = {}) => observation({ eventId, observedAt, ...fields }, learning);
  const sameConcept = buildLearningProgress({
    conceptId: 'concept-a',
    sourceRevision: 'rev-2',
    asOf: AS_OF,
    observations: [
      make('old-concept', '2026-09-10T00:00:00Z', { cue: 'independent' }),
      make('new-concept', '2026-09-20T00:00:00Z', { cue: 'independent', outcome: 'failure' }),
    ],
  });
  assert.equal(sameConcept.tasks.concept.conditions, 'same');
  assert.equal(sameConcept.tasks.concept.latest?.outcome, 'failure');

  const differentScenario = buildLearningProgress({
    conceptId: 'concept-a',
    sourceRevision: 'rev-2',
    asOf: AS_OF,
    observations: [
      make('old-scenario', '2026-09-10T00:00:00Z', { task: 'scenario', basis: 'self-check' }),
      make('new-scenario', '2026-09-20T00:00:00Z', { task: 'scenario', basis: 'application' }, { observedExposure: true }),
    ],
  });
  assert.equal(differentScenario.tasks.scenario.conditions, 'different');

  const unknownScenario = buildLearningProgress({
    conceptId: 'concept-a',
    sourceRevision: 'rev-2',
    asOf: AS_OF,
    observations: [
      make('old-unknown', '2026-09-10T00:00:00Z', { task: 'scenario', basis: 'unknown' }),
      make('new-unknown', '2026-09-20T00:00:00Z', { task: 'scenario', basis: 'application' }, { exposure: 'unknown' }),
    ],
  });
  assert.equal(unknownScenario.tasks.scenario.conditions, 'unknown');
});

test('single and empty groups are insufficient, and projection does not mutate input observations', () => {
  const input = [observation({ eventId: 'only' })];
  const before = structuredClone(input);
  const result = buildLearningProgress({ conceptId: 'concept-a', sourceRevision: 'rev-2', observations: input, asOf: AS_OF });
  assert.equal(result.tasks.concept.conditions, 'insufficient');
  assert.equal(result.tasks.scenario.conditions, 'insufficient');
  assert.deepEqual(input, before);

  const empty = buildLearningProgress({ conceptId: 'concept-a', sourceRevision: 'rev-2', observations: [], asOf: AS_OF });
  assert.deepEqual(empty.tasks.concept, { total: 0, previous: null, latest: null, intervalDays: null, conditions: 'insufficient' });
  assert.deepEqual(empty.tasks.scenario, { total: 0, previous: null, latest: null, intervalDays: null, conditions: 'insufficient' });
});

test('a marked scenario revisit is retained as metadata and changes the reported comparison condition', () => {
  const events = [
    observation({ eventId: 'first', observedAt: '2026-09-10T00:00:00Z' }, { task: 'scenario' }),
    observation({ eventId: 'revisit', observedAt: '2026-09-20T00:00:00Z' }, { task: 'scenario', scenarioRevisit: true }),
  ];
  const result = buildLearningProgress({ conceptId: 'concept-a', sourceRevision: 'rev-2', observations: events, asOf: AS_OF });
  assert.equal(result.tasks.scenario.conditions, 'different');
  assert.equal(result.tasks.scenario.latest?.scenarioRevisit, true);
  assert.equal(result.tasks.scenario.previous?.scenarioRevisit, undefined);
  assert.doesNotMatch(JSON.stringify(result), /private answer|private scenario text|private applicability text/);
});
