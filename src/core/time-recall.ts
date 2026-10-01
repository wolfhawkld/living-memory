import type {
  AnchorEvent,
  Observation,
  RecallRating,
} from '../shared/types.js';
import type {
  LearningOverviewItem,
} from '../shared/learning-overview.js';
import type {
  RecallCounts,
  TimeRecallBand,
  TimeRecallBucket,
  TimeRecallCondition,
  TimeRecallEvidence,
  TimeRecallSelectionOptions,
  TimeRecallSummary,
} from '../shared/time-recall.js';
import { decayAt, isValidInstant } from './time-model.js';

const DAY_MS = 86_400_000;
const FROZEN_TOLERANCE = 1e-10;

const BAND_ORDER: readonly TimeRecallBand[] = ['recent', 'revisit', 'stale'];
const ANCHOR_KIND_ORDER: readonly AnchorEvent['kind'][] = ['review', 'estimated'];
const CONDITION_ORDER: readonly TimeRecallCondition[] = ['unexposed', 'assisted', 'unknown'];

interface ParsedObservationTime {
  observedAt: number;
  recordedAt: number;
}

interface ParsedAnchorTime {
  occurredAt: number;
  recordedAt: number;
}

function parseInstant(value: unknown): number | null {
  if (typeof value !== 'string' || !isValidInstant(value)) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function parseObservationTime(
  observation: Observation,
  asOfTimestamp: number,
): ParsedObservationTime | null {
  const observedAt = parseInstant(observation.observedAt);
  const recordedAt = parseInstant(observation.recordedAt);
  if (observedAt === null || recordedAt === null) return null;
  if (observedAt > asOfTimestamp || recordedAt > asOfTimestamp) return null;
  return { observedAt, recordedAt };
}

function parseAnchorTime(
  anchor: AnchorEvent,
  asOfTimestamp: number,
): ParsedAnchorTime | null {
  const occurredAt = parseInstant(anchor.occurredAt);
  const recordedAt = parseInstant(anchor.recordedAt);
  if (occurredAt === null || recordedAt === null) return null;
  if (occurredAt > asOfTimestamp || recordedAt > asOfTimestamp) return null;
  return { occurredAt, recordedAt };
}

function compareIds(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareEvidence(left: TimeRecallEvidence, right: TimeRecallEvidence): number {
  const observed = compareNumbers(Date.parse(left.observedAt), Date.parse(right.observedAt));
  if (observed !== 0) return observed;
  const recorded = compareNumbers(Date.parse(left.recordedAt), Date.parse(right.recordedAt));
  if (recorded !== 0) return recorded;
  return compareIds(left.eventId, right.eventId);
}

function compareNumbers(left: number, right: number): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function emptyCounts(): RecallCounts {
  return { clear: 0, partial: 0, blank: 0 };
}

function cloneCounts(counts: RecallCounts): RecallCounts {
  return { clear: counts.clear, partial: counts.partial, blank: counts.blank };
}

function bandForDecay(decay: number): TimeRecallBand {
  if (decay > 0.5) return 'recent';
  if (decay > 0.25) return 'revisit';
  return 'stale';
}

function conditionForObservation(observation: Observation): TimeRecallCondition {
  const learning = observation.learning;
  if (
    observation.exposure === 'exposed'
    || observation.observedExposure === true
    || learning?.cue === 'hinted'
    || learning?.cue === 'lookup'
  ) {
    return 'assisted';
  }
  if (observation.exposure === 'unexposed'
    && observation.observedExposure === false
    && learning?.cue === 'independent') {
    return 'unexposed';
  }
  return 'unknown';
}

function validRating(rating: unknown): rating is RecallRating {
  return rating === 'clear' || rating === 'partial' || rating === 'blank';
}

function validFrozenMetrics(observation: Observation): boolean {
  const { elapsedDays, decay, halfLifeDays, configRevision } = observation;
  return Number.isFinite(elapsedDays)
    && elapsedDays !== null
    && elapsedDays >= 0
    && Number.isFinite(decay)
    && decay !== null
    && decay >= 0
    && decay <= 1
    && Number.isFinite(halfLifeDays)
    && halfLifeDays > 0
    && Number.isSafeInteger(configRevision)
    && configRevision >= 1;
}

function frozenMetricsMissing(observation: Observation): boolean {
  return observation.elapsedDays == null
    || observation.decay == null
    || observation.halfLifeDays == null
    || observation.configRevision == null;
}

function metricsMatchAnchor(
  observation: Observation,
  observationTime: ParsedObservationTime,
  anchorTime: ParsedAnchorTime,
): boolean {
  const elapsedDays = observation.elapsedDays;
  const halfLifeDays = observation.halfLifeDays;
  const decay = observation.decay;
  if (
    typeof elapsedDays !== 'number'
    || typeof halfLifeDays !== 'number'
    || typeof decay !== 'number'
  ) return false;

  const expectedElapsed = (observationTime.observedAt - anchorTime.occurredAt) / DAY_MS;
  if (!Number.isFinite(expectedElapsed) || expectedElapsed < 0) return false;
  let expectedDecay: number;
  try {
    expectedDecay = decayAt(expectedElapsed, halfLifeDays);
  } catch {
    return false;
  }
  return Math.abs(elapsedDays - expectedElapsed) <= FROZEN_TOLERANCE
    && Math.abs(decay - expectedDecay) <= FROZEN_TOLERANCE;
}

function makeEvidence(
  observation: Observation,
  anchor: AnchorEvent,
): TimeRecallEvidence {
  return {
    eventId: observation.eventId,
    observedAt: observation.observedAt,
    recordedAt: observation.recordedAt,
    rating: observation.rating,
    elapsedDays: observation.elapsedDays as number,
    decay: observation.decay as number,
    halfLifeDays: observation.halfLifeDays,
    configRevision: observation.configRevision,
    anchorOccurredAt: anchor.occurredAt,
  };
}

interface BucketAccumulator {
  band: TimeRecallBand;
  anchorKind: AnchorEvent['kind'];
  condition: TimeRecallCondition;
  count: number;
  ratings: RecallCounts;
  latest: TimeRecallEvidence | null;
  latestClear: TimeRecallEvidence | null;
  latestDifficulty: TimeRecallEvidence | null;
}

function accumulatorFor(
  accumulators: Map<string, BucketAccumulator>,
  band: TimeRecallBand,
  anchorKind: AnchorEvent['kind'],
  condition: TimeRecallCondition,
): BucketAccumulator {
  const key = `${band}\u0000${anchorKind}\u0000${condition}`;
  const existing = accumulators.get(key);
  if (existing) return existing;
  const created: BucketAccumulator = {
    band,
    anchorKind,
    condition,
    count: 0,
    ratings: emptyCounts(),
    latest: null,
    latestClear: null,
    latestDifficulty: null,
  };
  accumulators.set(key, created);
  return created;
}

function addToAccumulator(
  accumulator: BucketAccumulator,
  evidence: TimeRecallEvidence,
): void {
  accumulator.count += 1;
  accumulator.ratings[evidence.rating] += 1;
  if (accumulator.latest === null || compareEvidence(evidence, accumulator.latest) > 0) {
    accumulator.latest = evidence;
  }
  if (evidence.rating === 'clear'
    && (accumulator.latestClear === null || compareEvidence(evidence, accumulator.latestClear) > 0)) {
    accumulator.latestClear = evidence;
  }
  if ((evidence.rating === 'partial' || evidence.rating === 'blank')
    && (accumulator.latestDifficulty === null || compareEvidence(evidence, accumulator.latestDifficulty) > 0)) {
    accumulator.latestDifficulty = evidence;
  }
}

function bucketSort(left: BucketAccumulator | TimeRecallBucket, right: BucketAccumulator | TimeRecallBucket): number {
  const band = BAND_ORDER.indexOf(left.band) - BAND_ORDER.indexOf(right.band);
  if (band !== 0) return band;
  const kind = ANCHOR_KIND_ORDER.indexOf(left.anchorKind) - ANCHOR_KIND_ORDER.indexOf(right.anchorKind);
  if (kind !== 0) return kind;
  return CONDITION_ORDER.indexOf(left.condition) - CONDITION_ORDER.indexOf(right.condition);
}

function cloneEvidence(evidence: TimeRecallEvidence): TimeRecallEvidence {
  return { ...evidence };
}

function toBucket(accumulator: BucketAccumulator): TimeRecallBucket {
  return {
    band: accumulator.band,
    anchorKind: accumulator.anchorKind,
    condition: accumulator.condition,
    count: accumulator.count,
    ratings: cloneCounts(accumulator.ratings),
    latest: cloneEvidence(accumulator.latest as TimeRecallEvidence),
    latestClear: accumulator.latestClear ? cloneEvidence(accumulator.latestClear) : null,
    latestDifficulty: accumulator.latestDifficulty ? cloneEvidence(accumulator.latestDifficulty) : null,
  };
}

/**
 * Build a bounded, privacy-preserving comparison of frozen recall observations.
 * The projection deliberately trusts neither the current config nor current memory state.
 */
export function buildTimeRecallSummary(
  observations: readonly Observation[],
  anchors: readonly AnchorEvent[],
  asOf: string,
): TimeRecallSummary {
  const excluded = { scenario: 0, missingTime: 0, invalidTime: 0 };
  const asOfTimestamp = parseInstant(asOf);
  if (asOfTimestamp === null) return { buckets: [], excluded };

  const anchorById = new Map<string, AnchorEvent>();
  for (const anchor of anchors) {
    if (!anchorById.has(anchor.eventId)) anchorById.set(anchor.eventId, anchor);
  }

  const accumulators = new Map<string, BucketAccumulator>();
  for (const observation of observations) {
    const observationTime = parseObservationTime(observation, asOfTimestamp);
    if (observationTime === null) continue;

    if (observation.learning?.task === 'scenario') {
      excluded.scenario += 1;
      continue;
    }

    if (observation.anchorEventId == null) {
      excluded.missingTime += 1;
      continue;
    }
    if (frozenMetricsMissing(observation)) {
      excluded.missingTime += 1;
      continue;
    }
    if (!validFrozenMetrics(observation) || !validRating(observation.rating)) {
      excluded.invalidTime += 1;
      continue;
    }

    const anchor = anchorById.get(observation.anchorEventId);
    if (!anchor) {
      excluded.invalidTime += 1;
      continue;
    }
    const anchorTime = parseAnchorTime(anchor, asOfTimestamp);
    if (anchorTime === null
      || anchor.conceptId !== observation.conceptId
      || anchor.sourceRevision !== observation.sourceRevision
      || anchor.kind !== 'review' && anchor.kind !== 'estimated'
      || anchorTime.occurredAt > observationTime.observedAt
      || anchorTime.recordedAt > observationTime.recordedAt
      || anchorTime.recordedAt < anchorTime.occurredAt) {
      excluded.invalidTime += 1;
      continue;
    }
    if (!metricsMatchAnchor(observation, observationTime, anchorTime)) {
      excluded.invalidTime += 1;
      continue;
    }

    const evidence = makeEvidence(observation, anchor);
    const frozenDecay = observation.decay as number;
    addToAccumulator(
      accumulatorFor(
        accumulators,
        bandForDecay(frozenDecay),
        anchor.kind,
        conditionForObservation(observation),
      ),
      evidence,
    );
  }

  return {
    buckets: [...accumulators.values()].sort(bucketSort).map(toBucket),
    excluded,
  };
}

interface SelectionRow {
  item: LearningOverviewItem;
  evidence: TimeRecallEvidence;
  band: TimeRecallBand;
  matchingCount: number;
}

function addCounts(target: RecallCounts, source: RecallCounts): void {
  target.clear += source.clear;
  target.partial += source.partial;
  target.blank += source.blank;
}

function evidenceForAll(buckets: readonly TimeRecallBucket[]): TimeRecallEvidence | null {
  let latest: TimeRecallEvidence | null = null;
  for (const bucket of buckets) {
    if (latest === null || compareEvidence(bucket.latest, latest) > 0) latest = bucket.latest;
  }
  return latest;
}

function matchingBuckets(
  item: LearningOverviewItem,
  options: TimeRecallSelectionOptions,
): TimeRecallBucket[] {
  return (item.timeRecall?.buckets ?? []).filter((bucket) =>
    bucket.anchorKind === options.anchorKind && bucket.condition === options.condition);
}

function compareRows(left: SelectionRow, right: SelectionRow): number {
  const evidenceComparison = compareEvidence(left.evidence, right.evidence);
  if (evidenceComparison !== 0) return -evidenceComparison;
  return compareIds(left.item.conceptId, right.item.conceptId);
}

/** Select an overview slice without recomputing or mixing recall conditions. */
export function selectTimeRecall(
  items: readonly LearningOverviewItem[],
  options: TimeRecallSelectionOptions,
): {
  bands: Array<{ band: TimeRecallBand; count: number; ratings: RecallCounts; conceptCount: number }>;
  rows: SelectionRow[];
  sampleCount: number;
  conceptCount: number;
  unavailableConcepts: number;
  excluded: TimeRecallSummary['excluded'];
} {
  const bands = BAND_ORDER.map((band) => ({
    band,
    count: 0,
    ratings: emptyCounts(),
    conceptIds: new Set<string>(),
  }));
  const rows: SelectionRow[] = [];
  let unavailableConcepts = 0;
  const excluded = { scenario: 0, missingTime: 0, invalidTime: 0 };
  const seenConceptIds = new Set<string>();
  const matchingConceptIds = new Set<string>();

  for (const item of items) {
    if (item.timeRecall === undefined) {
      unavailableConcepts += 1;
      continue;
    }
    excluded.scenario += item.timeRecall.excluded.scenario;
    excluded.missingTime += item.timeRecall.excluded.missingTime;
    excluded.invalidTime += item.timeRecall.excluded.invalidTime;

    const buckets = matchingBuckets(item, options);
    for (const bucket of buckets) {
      const target = bands[BAND_ORDER.indexOf(bucket.band)];
      target.count += bucket.count;
      addCounts(target.ratings, bucket.ratings);
      target.conceptIds.add(item.conceptId);
      matchingConceptIds.add(item.conceptId);
    }

    if (seenConceptIds.has(item.conceptId)) continue;
    let evidence: TimeRecallEvidence | null = null;
    let band: TimeRecallBand | null = null;
    let matchingCount = 0;
    if (options.focus === 'all') {
      evidence = evidenceForAll(buckets);
      if (evidence) {
        const matchingBucket = buckets.find((bucket) => bucket.latest.eventId === evidence!.eventId);
        band = matchingBucket?.band ?? null;
        matchingCount = buckets.reduce((sum, bucket) => sum + bucket.count, 0);
      }
    } else if (options.focus === 'recent-difficulty') {
      const recent = buckets.find((bucket) => bucket.band === 'recent');
      evidence = recent?.latestDifficulty ?? null;
      band = evidence ? 'recent' : null;
      matchingCount = recent ? recent.ratings.partial + recent.ratings.blank : 0;
    } else {
      const stale = buckets.find((bucket) => bucket.band === 'stale');
      evidence = stale?.latestClear ?? null;
      band = evidence ? 'stale' : null;
      matchingCount = stale?.ratings.clear ?? 0;
    }
    if (evidence && band && matchingCount > 0) {
      rows.push({ item, evidence, band, matchingCount });
      seenConceptIds.add(item.conceptId);
    }
  }

  rows.sort(compareRows);
  return {
    bands: bands.map(({ band, count, ratings, conceptIds: ids }) => ({
      band,
      count,
      ratings,
      conceptCount: ids.size,
    })),
    rows,
    sampleCount: bands.reduce((sum, band) => sum + band.count, 0),
    conceptCount: matchingConceptIds.size,
    unavailableConcepts,
    excluded,
  };
}
