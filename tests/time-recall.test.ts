import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTimeRecallSummary, selectTimeRecall } from '../src/core/time-recall.js';
import { decayAt } from '../src/core/time-model.js';
import type { LearningOverviewItem } from '../src/shared/learning-overview.js';
import type { AnchorEvent, LearningEvidence, Observation } from '../src/shared/types.js';
import type { TimeRecallSummary } from '../src/shared/time-recall.js';

const AS_OF = '2026-02-01T00:00:00.000Z';

function anchor(
  eventId: string,
  conceptId = 'alpha',
  occurredAt = '2026-01-01T00:00:00.000Z',
  kind: AnchorEvent['kind'] = 'review',
  overrides: Partial<AnchorEvent> = {},
): AnchorEvent {
  return {
    eventId,
    conceptId,
    sourceRevision: 'v1',
    occurredAt,
    recordedAt: '2026-01-01T00:00:01.000Z',
    kind,
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
  eventId: string,
  observedAt: string,
  anchorEventId: string | null,
  overrides: Partial<Observation> & { anchorOccurredAt?: string } = {},
): Observation {
  const halfLifeDays = overrides.halfLifeDays ?? 7;
  const anchorOccurredAt = overrides.anchorOccurredAt ?? '2026-01-01T00:00:00.000Z';
  const elapsedDays = Object.prototype.hasOwnProperty.call(overrides, 'elapsedDays')
    ? (overrides.elapsedDays ?? null)
    : (anchorEventId ? (Date.parse(observedAt) - Date.parse(anchorOccurredAt)) / 86_400_000 : null);
  const decay = Object.prototype.hasOwnProperty.call(overrides, 'decay')
    ? (overrides.decay ?? null)
    : (elapsedDays === null ? null : decayAt(elapsedDays, halfLifeDays));
  const recordedAt = overrides.recordedAt ?? new Date(Date.parse(observedAt) + 1000).toISOString();
  const { anchorOccurredAt: _ignored, ...rest } = overrides;
  return {
    eventId,
    conceptId: 'alpha',
    sourceRevision: 'v1',
    observedAt,
    recordedAt,
    configRevision: 1,
    halfLifeDays,
    anchorEventId,
    elapsedDays,
    decay,
    answer: 'PRIVATE ANSWER',
    rating: 'clear',
    exposure: 'unexposed',
    observedExposure: false,
    learning: evidence(),
    ...rest,
  };
}

function item(
  conceptId: string,
  timeRecall: TimeRecallSummary | undefined,
): LearningOverviewItem {
  return {
    conceptId,
    title: conceptId,
    domainId: 'fixture',
    sourceRevision: 'v1',
    memory: { status: 'recent', elapsedDays: 1, lastReviewedAt: null, estimated: false },
    recall: { total: 0, clear: 0, partial: 0, blank: 0, latest: null },
    scenario: { total: 0, independentSuccess: 0, assisted: 0, partial: 0, failure: 0, unverified: 0, latest: null },
    calibration: {
      concept: { count: 0, meanConfidence: null, successRate: null, gap: null, brier: null },
      scenario: { count: 0, meanConfidence: null, successRate: null, gap: null, brier: null },
    },
    applications: { application: 0, summary: 0, latestAt: null },
    evidence: { currentObservations: 0, previousObservations: 0, previousApplications: 0, latestAt: null },
    ...(timeRecall === undefined ? {} : { timeRecall }),
  };
}

test('uses frozen decay boundaries and preserves historical H after current changes', () => {
  const first = anchor('review-1');
  const observations = [
    observation('at-zero', '2026-01-01T00:00:00.000Z', first.eventId),
    observation('at-half', '2026-01-08T00:00:00.000Z', first.eventId),
    observation('at-quarter', '2026-01-15T00:00:00.000Z', first.eventId),
    observation('historical-h', '2026-01-08T00:00:00.000Z', first.eventId, {
      halfLifeDays: 7,
      rating: 'partial',
    }),
  ];
  const summary = buildTimeRecallSummary(observations, [first], AS_OF);

  assert.deepEqual(summary.buckets.map((bucket) => [bucket.band, bucket.count]), [
    ['recent', 1],
    ['revisit', 2],
    ['stale', 1],
  ]);
  assert.equal(summary.buckets.find((bucket) => bucket.band === 'revisit')?.latest.eventId, 'historical-h');
  assert.equal(summary.buckets.find((bucket) => bucket.band === 'stale')?.latest.decay, 0.25);
  assert.deepEqual(summary.excluded, { scenario: 0, missingTime: 0, invalidTime: 0 });
});

test('separates review and estimated anchors and classifies exposure conditions', () => {
  const review = anchor('review', 'alpha');
  const estimated = anchor('estimated', 'alpha', '2026-01-01T00:00:00.000Z', 'estimated');
  const observations = [
    observation('independent', '2026-01-02T00:00:00.000Z', review.eventId),
    observation('exposed', '2026-01-03T00:00:00.000Z', review.eventId, { exposure: 'exposed' }),
    observation('cue-hint', '2026-01-04T00:00:00.000Z', estimated.eventId, { learning: evidence({ cue: 'hinted' }) }),
    observation('legacy', '2026-01-05T00:00:00.000Z', estimated.eventId, { learning: undefined }),
    observation('observed-exposure', '2026-01-06T00:00:00.000Z', estimated.eventId, { observedExposure: true }),
    observation('scenario', '2026-01-07T00:00:00.000Z', review.eventId, {
      learning: evidence({ task: 'scenario', scenario: 'PRIVATE SCENARIO' }),
    }),
  ];
  const summary = buildTimeRecallSummary(observations, [review, estimated], AS_OF);

  assert.deepEqual(summary.buckets.map((bucket) => [bucket.anchorKind, bucket.condition, bucket.count]), [
    ['review', 'unexposed', 1],
    ['review', 'assisted', 1],
    ['estimated', 'assisted', 2],
    ['estimated', 'unknown', 1],
  ]);
  assert.equal(summary.excluded.scenario, 1);
  assert.equal(JSON.stringify(summary).includes('PRIVATE ANSWER'), false);
  assert.equal(JSON.stringify(summary).includes('PRIVATE SCENARIO'), false);
});

test('ignores invalid or future observation timestamps, and counts missing versus invalid time data', () => {
  const validAnchor = anchor('valid');
  const wrongConcept = anchor('wrong-concept', 'other');
  const observations = [
    observation('no-anchor', '2026-01-02T00:00:00.000Z', null),
    observation('missing-metric', '2026-01-03T00:00:00.000Z', validAnchor.eventId, { elapsedDays: null, decay: null }),
    observation('missing-anchor', '2026-01-03T00:00:00.000Z', 'does-not-exist'),
    observation('wrong-anchor', '2026-01-03T00:00:00.000Z', wrongConcept.eventId),
    observation('bad-frozen', '2026-01-03T00:00:00.000Z', validAnchor.eventId, { elapsedDays: 99 }),
    observation('anchor-after-observation', '2025-12-31T00:00:00Z', validAnchor.eventId, { elapsedDays: 0, decay: 1 }),
    observation('future', '2026-02-02T00:00:00Z', validAnchor.eventId),
    observation('bad-date', 'not-a-date', validAnchor.eventId, {
      elapsedDays: null, decay: null, recordedAt: '2026-01-03T00:00:00Z',
    }),
  ];
  const summary = buildTimeRecallSummary(observations, [validAnchor, wrongConcept], AS_OF);
  assert.deepEqual(summary.buckets, []);
  assert.deepEqual(summary.excluded, { scenario: 0, missingTime: 2, invalidTime: 4 });
});

test('validates anchor version and recorded chronology, uses stable latest ordering, and does not mutate inputs', () => {
  const first = anchor('a-anchor');
  const before = structuredClone({ first, observations: [
    observation('event-a', '2026-01-04T00:00:00Z', first.eventId, { rating: 'partial' }),
    observation('event-z', '2026-01-04T00:00:00Z', first.eventId, { rating: 'clear' }),
  ] });
  const observations = before.observations;
  const summary = buildTimeRecallSummary(observations, [first], AS_OF);
  const bucket = summary.buckets[0];
  assert.equal(bucket.latest.eventId, 'event-z');
  assert.equal(bucket.latestClear?.eventId, 'event-z');
  assert.equal(bucket.latestDifficulty?.eventId, 'event-a');
  assert.deepEqual({ first, observations }, before);

  const badRecorded = anchor('bad-recorded', 'alpha', '2026-01-01T00:00:00Z', 'review', {
    recordedAt: '2026-01-03T00:00:00Z',
  });
  const badObservation = observation('bad-recorded-observation', '2026-01-02T00:00:00Z', badRecorded.eventId);
  const mismatch = buildTimeRecallSummary([badObservation], [badRecorded], AS_OF);
  assert.deepEqual(mismatch.excluded, { scenario: 0, missingTime: 0, invalidTime: 1 });
});

test('selector keeps band totals independent of focus, filters condition, and distinguishes samples from concepts', () => {
  const anchorEvent = anchor('selector-anchor');
  const summaryAlpha = buildTimeRecallSummary([
    observation('alpha-recent-partial', '2026-01-02T00:00:00Z', anchorEvent.eventId, { rating: 'partial' }),
    observation('alpha-recent-blank', '2026-01-03T00:00:00Z', anchorEvent.eventId, { rating: 'blank' }),
    observation('alpha-recent-clear', '2026-01-04T00:00:00Z', anchorEvent.eventId, { rating: 'clear' }),
    observation('alpha-stale-clear', '2026-01-15T00:00:00Z', anchorEvent.eventId, { rating: 'clear' }),
  ], [anchorEvent], AS_OF);
  const betaAnchor = anchor('beta-anchor', 'beta');
  const summaryBeta = buildTimeRecallSummary([
    observation('beta-recent-partial', '2026-01-02T00:00:00Z', betaAnchor.eventId, { rating: 'partial' }),
  ].map((event) => ({ ...event, conceptId: 'beta' })), [betaAnchor], AS_OF);
  const alpha = item('alpha', summaryAlpha);
  const beta = item('beta', summaryBeta);
  const unavailable = item('unavailable', undefined);
  const all = selectTimeRecall([alpha, beta, unavailable], {
    anchorKind: 'review', condition: 'unexposed', focus: 'all',
  });
  assert.deepEqual(all.bands.map(({ band, count, conceptCount }) => ({ band, count, conceptCount })), [
    { band: 'recent', count: 4, conceptCount: 2 },
    { band: 'revisit', count: 0, conceptCount: 0 },
    { band: 'stale', count: 1, conceptCount: 1 },
  ]);
  assert.equal(all.sampleCount, 5);
  assert.equal(all.conceptCount, 2);
  assert.equal(all.unavailableConcepts, 1);
  assert.equal(all.rows[0].evidence.eventId, 'alpha-stale-clear');
  assert.equal(all.rows[0].matchingCount, 4);

  const difficulty = selectTimeRecall([alpha, beta], {
    anchorKind: 'review', condition: 'unexposed', focus: 'recent-difficulty',
  });
  assert.equal(difficulty.sampleCount, 5, 'top sample count remains independent of focus');
  assert.deepEqual(difficulty.rows.map((row) => [row.item.conceptId, row.evidence.eventId, row.matchingCount]), [
    ['alpha', 'alpha-recent-blank', 2],
    ['beta', 'beta-recent-partial', 1],
  ]);

  const clear = selectTimeRecall([alpha, beta], {
    anchorKind: 'review', condition: 'unexposed', focus: 'stale-clear',
  });
  assert.equal(clear.rows.length, 1);
  assert.deepEqual(clear.rows[0], {
    item: alpha,
    evidence: alpha.timeRecall!.buckets.find((bucket) => bucket.band === 'stale')!.latestClear,
    band: 'stale',
    matchingCount: 1,
  });
});

test('selector aggregates exclusions from every available item regardless of selected condition', () => {
  const summary: TimeRecallSummary = {
    buckets: [],
    excluded: { scenario: 2, missingTime: 3, invalidTime: 4 },
  };
  const selected = selectTimeRecall([item('alpha', summary), item('legacy-service', undefined)], {
    anchorKind: 'estimated', condition: 'assisted', focus: 'stale-clear',
  });
  assert.deepEqual(selected.excluded, { scenario: 2, missingTime: 3, invalidTime: 4 });
  assert.equal(selected.unavailableConcepts, 1);
});
