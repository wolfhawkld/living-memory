import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  buildLearningOverview,
  overviewHasRecallDifficulty,
  overviewNeedsScenarioCheck,
  selectLearningOverviewItems,
} from '../src/core/learning-overview.js';
import type {
  ApplicationRecord,
  ApplicationRecordRequest,
  Concept,
  LearningEvidence,
  MemoryState,
  Observation,
} from '../src/shared/types.js';

const AS_OF = '2026-01-10T00:00:00.000Z';

test('scenario revisit metadata survives the overview without revealing the scenario or answers', () => {
  const result = buildLearningOverview({
    sourceId: 'synthetic', asOf: AS_OF, concepts: [concept('rule')], states: {},
    observations: [observation('rule', 'revisit', '2026-01-09T00:00:00.000Z', {}, evidence({
      task: 'scenario', scenario: 'PRIVATE_SCENARIO', applicability: 'PRIVATE_CHECK', scenarioRevisit: true,
    }))], applications: [], corrections: [], anchors: [],
  });
  assert.equal(result.items[0].scenario.latest?.scenarioRevisit, true);
  assert.equal(result.items[0].scenario.revisited, 1);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SCENARIO|PRIVATE_CHECK|private answer/);
});

function concept(
  id: string,
  revision = 'v1',
  path = `Math/${id}.md`,
  title = id,
): Concept {
  return {
    id,
    title,
    aliases: [],
    domain: 'fixture',
    summary: 'private source summary',
    body: 'private source body',
    source: { path, revision },
  };
}

function memoryState(conceptId: string, overrides: Partial<MemoryState> = {}): MemoryState {
  return {
    conceptId,
    status: 'recent',
    decay: 0.8,
    elapsedDays: 2,
    anchor: {
      eventId: `${conceptId}-anchor`,
      conceptId,
      sourceRevision: 'v1',
      occurredAt: '2026-01-08T00:00:00Z',
      recordedAt: '2026-01-08T00:00:01Z',
      kind: 'review',
    },
    reason: null,
    asOf: AS_OF,
    ...overrides,
  };
}

function evidence(overrides: Partial<LearningEvidence> = {}): LearningEvidence {
  return {
    task: 'concept',
    confidence: null,
    confidenceAt: null,
    cue: 'independent',
    outcome: 'success',
    basis: 'self-check',
    ...overrides,
  };
}

function observation(
  conceptId: string,
  eventId: string,
  observedAt: string,
  overrides: Partial<Observation> = {},
  learning?: LearningEvidence,
): Observation {
  const resolvedLearning = Object.prototype.hasOwnProperty.call(overrides, 'learning')
    ? overrides.learning
    : arguments.length >= 5
      ? learning
      : evidence();
  return {
    eventId,
    conceptId,
    sourceRevision: 'v1',
    observedAt,
    recordedAt: observedAt,
    configRevision: 1,
    halfLifeDays: 7,
    anchorEventId: null,
    elapsedDays: null,
    decay: null,
    answer: 'private answer that must never enter the overview',
    rating: 'clear',
    exposure: 'unexposed',
    observedExposure: false,
    ...(resolvedLearning === undefined ? {} : { learning: resolvedLearning }),
    ...overrides,
  };
}

function application(
  conceptId: string,
  eventId: string,
  occurredAt: string,
  overrides: Partial<ApplicationRecordRequest> = {},
): ApplicationRecord {
  return {
    eventId,
    conceptId,
    sourceRevision: 'v1',
    occurredAt,
    kind: 'application',
    context: 'private work context',
    content: 'private application content',
    outcome: 'success',
    assistance: 'independent',
    result: 'private result',
    limitations: 'private limitation',
    insight: 'private insight',
    correction: 'private correction',
    references: 'private references',
    recordedAt: occurredAt,
    ...overrides,
  };
}

test('aggregates current versions, preserves previous counts, filters as-of records, and exposes metadata only', () => {
  const alpha = concept('alpha', 'v2', 'Cognition/Math/alpha.md', 'Alpha');
  const beta = concept('beta', 'v1', 'Cognition/AI/beta.md', 'Beta');
  const concepts = [alpha, beta];
  const states: Record<string, MemoryState> = {
    alpha: memoryState('alpha', {
      status: 'retained',
      elapsedDays: null,
      anchor: {
        eventId: 'retained-alpha', conceptId: 'alpha', sourceRevision: 'v2',
        occurredAt: '2026-01-03T00:00:00Z', recordedAt: '2026-01-03T00:00:01Z', kind: 'estimated',
      },
    }),
  };
  const observations: Observation[] = [
    observation('alpha', 'old-observation', '2026-01-01T00:00:00Z', { sourceRevision: 'v1', rating: 'blank' }),
    observation('alpha', 'legacy-recall', '2026-01-04T00:00:00Z', { sourceRevision: 'v2', learning: undefined }),
    observation('alpha', 'current-recall', '2026-01-03T00:00:00Z', { sourceRevision: 'v2', rating: 'partial' }),
    observation('alpha', 'current-scenario', '2026-01-04T00:00:00Z', {
      sourceRevision: 'v2',
      rating: 'clear',
    }, evidence({ task: 'scenario', scenario: 'private scenario', confidence: 80, confidenceAt: '2026-01-03T23:00:00Z' })),
    observation('alpha', 'future-observation', '2026-01-11T00:00:00Z', { sourceRevision: 'v2', rating: 'blank' }),
    observation('alpha', 'future-recorded', '2026-01-03T00:00:00Z', { sourceRevision: 'v2', recordedAt: '2026-01-11T00:00:00Z' }),
    observation('alpha', 'invalid-observation', 'not-a-time', { sourceRevision: 'v2' }),
    observation('beta', 'beta-observation', '2026-01-05T00:00:00Z'),
    observation('removed', 'removed-observation', '2026-01-05T00:00:00Z'),
  ];
  const applications: ApplicationRecord[] = [
    application('alpha', 'old-application', '2026-01-01T00:00:00Z', { sourceRevision: 'v1' }),
    application('alpha', 'current-application', '2026-01-05T00:00:00Z', { sourceRevision: 'v2' }),
    application('alpha', 'current-summary', '2026-01-06T00:00:00Z', { sourceRevision: 'v2', kind: 'summary' }),
    application('alpha', 'future-application', '2026-01-11T00:00:00Z', { sourceRevision: 'v2' }),
    application('beta', 'beta-application', '2026-01-05T00:00:00Z'),
    application('removed', 'removed-application', '2026-01-05T00:00:00Z'),
  ];
  const before = JSON.stringify({ concepts, states, observations, applications });

  const overview = buildLearningOverview({ sourceId: 'source-a', asOf: AS_OF, concepts, states, observations, applications });
  assert.deepEqual(overview.items.map((item) => item.conceptId), ['alpha', 'beta']);
  const alphaItem = overview.items[0];
  assert.equal(alphaItem.domainId, 'Cognition/Math');
  assert.equal(alphaItem.sourceRevision, 'v2');
  assert.deepEqual(alphaItem.recall, {
    total: 2,
    clear: 1,
    partial: 1,
    blank: 0,
    latest: {
      eventId: 'legacy-recall', observedAt: '2026-01-04T00:00:00Z', rating: 'clear',
      exposure: 'unexposed', observedExposure: false, cue: 'unknown', outcome: 'unverified', basis: 'unknown',
    },
  });
  assert.equal(alphaItem.scenario.total, 1);
  assert.equal(alphaItem.scenario.independentSuccess, 1);
  assert.equal(alphaItem.scenario.latest?.eventId, 'current-scenario');
  assert.equal(alphaItem.calibration.scenario.count, 1);
  assert.deepEqual(alphaItem.applications, { application: 1, summary: 1, latestAt: '2026-01-06T00:00:00Z' });
  assert.deepEqual(alphaItem.evidence, {
    currentObservations: 3,
    previousObservations: 1,
    previousApplications: 1,
    latestAt: '2026-01-06T00:00:00Z',
  });
  assert.deepEqual(alphaItem.memory, {
    status: 'retained', elapsedDays: null, lastReviewedAt: '2026-01-03T00:00:00Z', estimated: true,
  });
  assert.deepEqual(overview.items[1].memory, {
    status: 'unknown', elapsedDays: null, lastReviewedAt: null, estimated: false,
  });

  const serialized = JSON.stringify(alphaItem);
  assert.doesNotMatch(serialized, /private answer|private source body|private scenario|private application content|private work context/);
  assert.equal(JSON.stringify({ concepts, states, observations, applications }), before);
});

test('latest evidence is chronological and input-order independent; a later success supersedes an older scenario failure hint', () => {
  const current = concept('latest', 'v1', 'Math/latest.md');
  const scenarioSuccess = observation('latest', 'z-success', '2026-01-04T00:00:00Z', {}, evidence({ task: 'scenario' }));
  const sameTimeLowerId = observation('latest', 'a-failure', '2026-01-04T00:00:00Z', {}, evidence({ task: 'scenario', outcome: 'failure' }));
  const olderFailure = observation('latest', 'older-failure', '2026-01-03T00:00:00Z', {}, evidence({ task: 'scenario', outcome: 'failure' }));
  const laterRecorded = observation('latest', 'later-recorded', '2026-01-02T00:00:00Z', { recordedAt: '2026-01-05T00:00:00Z' }, evidence({ task: 'scenario', outcome: 'failure' }));
  const item = buildLearningOverview({
    sourceId: 'source-a', asOf: AS_OF, concepts: [current], states: {},
    observations: [scenarioSuccess, olderFailure, laterRecorded, sameTimeLowerId], applications: [],
  }).items[0];

  assert.equal(item.scenario.latest?.eventId, 'z-success', 'occurrence time wins over a later recorded time');
  assert.equal(item.scenario.failure, 3);
  assert.equal(overviewNeedsScenarioCheck(item), false, 'old failure is retained in counts but does not mask latest success');
  assert.equal(overviewHasRecallDifficulty(item), false);

  const tied = buildLearningOverview({
    sourceId: 'source-a', asOf: AS_OF, concepts: [current], states: {},
    observations: [sameTimeLowerId, scenarioSuccess], applications: [],
  }).items[0];
  assert.equal(tied.scenario.latest?.eventId, 'z-success', 'event ID is the deterministic final tie-breaker');
});

test('difficulty hints, filters, privacy-safe unobserved state, and deterministic selection order', () => {
  const difficultRecall = concept('difficult-recall', 'v1', 'Math/difficult.md', 'Difficult Recall');
  const scenarioCheck = concept('scenario-check', 'v1', 'Math/scenario.md', 'Scenario Check');
  const clearPractice = concept('clear-practice', 'v1', 'Math/clear.md', 'Clear Practice');
  const assistedScenario = concept('assisted-scenario', 'v1', 'AI/assisted.md', 'Assisted Scenario');
  const applicationOnly = concept('application-only', 'v1', 'Math/application.md', 'Application Only');
  const noEvidence = concept('no-evidence', 'v1', 'AI/empty.md', 'No Evidence');
  const calibrationGap = concept('calibration-gap', 'v1', 'Math/calibration-gap.md', 'Calibration Gap');
  const calibrationZero = concept('calibration-zero', 'v1', 'Math/calibration-zero.md', 'Calibration Zero');
  const concepts = [difficultRecall, scenarioCheck, clearPractice, assistedScenario, applicationOnly, noEvidence, calibrationGap, calibrationZero];
  const observations = [
    observation('difficult-recall', 'difficult-recall-event', '2026-01-08T00:00:00Z', { rating: 'partial' }),
    observation('scenario-check', 'scenario-check-event', '2026-01-07T00:00:00Z', {}, evidence({ task: 'scenario', outcome: 'failure' })),
    observation('clear-practice', 'clear-practice-event', '2026-01-09T00:00:00Z'),
    observation('assisted-scenario', 'assisted-scenario-event', '2026-01-06T00:00:00Z', {}, evidence({ task: 'scenario', cue: 'hinted' })),
    observation('calibration-gap', 'calibration-gap-event', '2026-01-06T00:00:00Z', {}, evidence({ confidence: 100, confidenceAt: '2026-01-05T00:00:00Z', outcome: 'failure' })),
    observation('calibration-zero', 'calibration-zero-event', '2026-01-05T00:00:00Z', {}, evidence({ confidence: 100, confidenceAt: '2026-01-04T00:00:00Z', outcome: 'success' })),
  ];
  const applications = [application('application-only', 'application-only-event', '2026-01-04T00:00:00Z')];
  const overview = buildLearningOverview({
    sourceId: 'source-a',
    asOf: AS_OF,
    concepts,
    states: { 'difficult-recall': memoryState('difficult-recall', { status: 'retained' }) },
    observations,
    applications,
  });
  const byId = new Map(overview.items.map((item) => [item.conceptId, item]));

  assert.equal(overviewHasRecallDifficulty(byId.get('difficult-recall')!), true);
  assert.equal(overviewNeedsScenarioCheck(byId.get('scenario-check')!), true);
  assert.equal(overviewNeedsScenarioCheck(byId.get('assisted-scenario')!), true);
  assert.equal(overviewNeedsScenarioCheck(byId.get('clear-practice')!), false);

  assert.deepEqual(selectLearningOverviewItems(overview.items).map((item) => item.conceptId), [
    'difficult-recall', 'scenario-check', 'assisted-scenario', 'clear-practice',
    'calibration-gap', 'calibration-zero', 'application-only', 'no-evidence',
  ]);
  assert.deepEqual(selectLearningOverviewItems(overview.items, { filter: 'recall' }).map((item) => item.conceptId), [
    'difficult-recall',
  ]);
  assert.deepEqual(selectLearningOverviewItems(overview.items, { filter: 'scenario' }).map((item) => item.conceptId), [
    'scenario-check', 'assisted-scenario',
  ]);
  assert.deepEqual(selectLearningOverviewItems(overview.items, { filter: 'unobserved' }).map((item) => item.conceptId), [
    'application-only', 'no-evidence',
  ]);
  assert.deepEqual(selectLearningOverviewItems(overview.items, { domainId: 'AI' }).map((item) => item.conceptId), [
    'assisted-scenario', 'no-evidence',
  ]);
  assert.deepEqual(selectLearningOverviewItems(overview.items, { query: 'DIFFICULT' }).map((item) => item.conceptId), ['difficult-recall']);

  const calibrationItems = selectLearningOverviewItems(overview.items, { filter: 'calibration' });
  assert.deepEqual(calibrationItems.map((item) => item.conceptId), ['calibration-gap', 'calibration-zero']);
  assert.equal(byId.get('calibration-zero')?.calibration.concept.count, 1, 'a zero-gap sample remains calibration evidence');
  assert.equal(byId.get('application-only')?.evidence.currentObservations, 0, 'applications do not become practice observations');
  assert.equal(byId.get('application-only')?.recall.total, 0);
  assert.equal(byId.get('application-only')?.scenario.total, 0);
  assert.equal(byId.get('application-only')?.memory.status, 'unknown');
  assert.equal(byId.get('no-evidence')?.memory.status, 'unknown', 'no evidence is not projected as zero or mastered');
});
