import type {
  AnchorEvent,
  ApplicationRecord,
  CalibrationSummary,
  Concept,
  MemoryState,
  Observation,
} from '../shared/types.js';
import type {
  LearningOverview,
  LearningOverviewItem,
  LearningOverviewFilter,
  OverviewObservation,
} from '../shared/learning-overview.js';
import type { CorrectionEvent } from '../shared/corrections.js';
import { domainIdOf } from './domain-view.js';
import { summarizeLearning } from './learning-evidence.js';
import { isValidInstant } from './time-model.js';
import { buildTimeRecallSummary } from './time-recall.js';
import { buildCorrectionOverview } from './correction-overview.js';

/** Inputs used to build the privacy-preserving learning overview. */
export interface LearningOverviewInput {
  sourceId: string;
  asOf: string;
  concepts: readonly Concept[];
  states: Readonly<Record<string, MemoryState>>;
  observations: readonly Observation[];
  applications: readonly ApplicationRecord[];
  /** Optional for compatibility with clients/fixtures predating corrections. */
  corrections?: readonly CorrectionEvent[];
  anchors?: readonly AnchorEvent[];
}

export interface LearningOverviewSelectionOptions {
  domainId?: string;
  filter?: LearningOverviewFilter;
  query?: string;
}

interface TimedRecord {
  eventId: string;
  occurredAt: string;
  recordedAt: string;
}

interface PreparedTime {
  occurredAt: number;
  recordedAt: number;
}

const UNKNOWN_OBSERVATION: Pick<OverviewObservation, 'cue' | 'outcome' | 'basis'> = {
  cue: 'unknown',
  outcome: 'unverified',
  basis: 'unknown',
};

function parseTimestamp(value: string): number | null {
  if (!isValidInstant(value)) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

/**
 * Keep records that were both available and had happened at the supplied
 * projection time. Persisted records normally satisfy this already; checking
 * both timestamps keeps historical projections from seeing future writes.
 */
function prepareTime(
  occurredAt: string,
  recordedAt: string,
  asOfTimestamp: number,
): PreparedTime | null {
  const occurred = parseTimestamp(occurredAt);
  const recorded = parseTimestamp(recordedAt);
  if (occurred === null || recorded === null || !Number.isFinite(asOfTimestamp)) return null;
  if (occurred > asOfTimestamp || recorded > asOfTimestamp) return null;
  return { occurredAt: occurred, recordedAt: recorded };
}

function compareIds(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** Compare event chronology without relying on input array order. */
function compareTimedRecords(left: TimedRecord, right: TimedRecord): number {
  const leftOccurred = parseTimestamp(left.occurredAt) ?? Number.NEGATIVE_INFINITY;
  const rightOccurred = parseTimestamp(right.occurredAt) ?? Number.NEGATIVE_INFINITY;
  if (leftOccurred !== rightOccurred) return leftOccurred - rightOccurred;

  const leftRecorded = parseTimestamp(left.recordedAt) ?? Number.NEGATIVE_INFINITY;
  const rightRecorded = parseTimestamp(right.recordedAt) ?? Number.NEGATIVE_INFINITY;
  if (leftRecorded !== rightRecorded) return leftRecorded - rightRecorded;
  return compareIds(left.eventId, right.eventId);
}

function latestRecord<T extends TimedRecord>(records: readonly T[]): T | null {
  let latest: T | null = null;
  for (const record of records) {
    if (latest === null || compareTimedRecords(record, latest) > 0) latest = record;
  }
  return latest;
}

function overviewObservation(event: Observation): OverviewObservation {
  const evidence = event.learning;
  return {
    ...(event.evidenceMode ? { evidenceMode: event.evidenceMode } : {}),
    eventId: event.eventId,
    observedAt: event.observedAt,
    rating: event.rating,
    exposure: event.exposure,
    observedExposure: event.observedExposure,
    cue: evidence?.cue ?? UNKNOWN_OBSERVATION.cue,
    outcome: evidence?.outcome ?? UNKNOWN_OBSERVATION.outcome,
    basis: evidence?.basis ?? UNKNOWN_OBSERVATION.basis,
    ...(evidence?.task === 'scenario' && evidence.scenarioRevisit ? { scenarioRevisit: true as const } : {}),
  };
}

function projectMemory(state: MemoryState | undefined): LearningOverviewItem['memory'] {
  if (!state) {
    return { status: 'unknown', elapsedDays: null, lastReviewedAt: null, estimated: false };
  }
  return {
    status: state.status,
    elapsedDays: state.elapsedDays,
    lastReviewedAt: state.anchor?.occurredAt ?? null,
    estimated: state.anchor?.kind === 'estimated',
  };
}

function observationIsScenario(event: Observation): boolean {
  return event.learning?.task === 'scenario';
}

function observationOccurredAt(event: Observation): TimedRecord {
  return { eventId: event.eventId, occurredAt: event.observedAt, recordedAt: event.recordedAt };
}

function applicationOccurredAt(event: ApplicationRecord): TimedRecord {
  return { eventId: event.eventId, occurredAt: event.occurredAt, recordedAt: event.recordedAt };
}

function maxTimestamp(left: string | null, right: string | null): string | null {
  if (!left) return right;
  if (!right) return left;
  const leftRecord: TimedRecord = { eventId: 'left', occurredAt: left, recordedAt: left };
  const rightRecord: TimedRecord = { eventId: 'right', occurredAt: right, recordedAt: right };
  return compareTimedRecords(leftRecord, rightRecord) >= 0 ? left : right;
}

function calibrationSamples(item: LearningOverviewItem): number {
  return item.calibration.concept.count + item.calibration.scenario.count;
}

function calibrationGap(item: LearningOverviewItem): number {
  const gaps = [item.calibration.concept.gap, item.calibration.scenario.gap]
    .filter((gap): gap is number => typeof gap === 'number' && Number.isFinite(gap));
  return gaps.length ? Math.max(...gaps.map((gap) => Math.abs(gap))) : 0;
}

function hasCalibrationEvidence(summary: CalibrationSummary): boolean {
  return summary.count > 0;
}

function latestEvidenceTimestamp(item: LearningOverviewItem): number {
  return item.evidence.latestAt ? parseTimestamp(item.evidence.latestAt) ?? Number.NEGATIVE_INFINITY : Number.NEGATIVE_INFINITY;
}

/** Whether the latest concept recall signal is partial or blank. */
export function overviewHasRecallDifficulty(item: LearningOverviewItem): boolean {
  return item.recall.latest?.rating === 'partial' || item.recall.latest?.rating === 'blank';
}

/**
 * Whether the latest scenario signal still needs a human check or assistance.
 * This is a queueing hint, not a mastery or diagnostic judgement.
 */
export function overviewNeedsScenarioCheck(item: LearningOverviewItem): boolean {
  const latest = item.scenario.latest;
  if (!latest) return false;
  return latest.evidenceMode === 'mental'
    || latest.outcome !== 'success'
    || latest.basis === 'unknown'
    || latest.cue !== 'independent'
    || latest.exposure !== 'unexposed'
    || latest.observedExposure;
}

function overviewPriority(item: LearningOverviewItem): number {
  if (overviewHasRecallDifficulty(item) || overviewNeedsScenarioCheck(item)) return 3;
  if (item.evidence.currentObservations > 0) return 2;
  if (item.applications.application + item.applications.summary > 0) return 1;
  return 0;
}

function compareOverviewItems(left: LearningOverviewItem, right: LearningOverviewItem): number {
  const leftPriority = overviewPriority(left);
  const rightPriority = overviewPriority(right);
  if (leftPriority !== rightPriority) return rightPriority - leftPriority;

  const leftEvidence = latestEvidenceTimestamp(left);
  const rightEvidence = latestEvidenceTimestamp(right);
  if (leftEvidence !== rightEvidence) return rightEvidence - leftEvidence;
  return compareIds(left.conceptId, right.conceptId);
}

function compareCalibrationItems(left: LearningOverviewItem, right: LearningOverviewItem): number {
  const leftGap = calibrationGap(left);
  const rightGap = calibrationGap(right);
  if (leftGap !== rightGap) return rightGap - leftGap;

  const leftSamples = calibrationSamples(left);
  const rightSamples = calibrationSamples(right);
  if (leftSamples !== rightSamples) return rightSamples - leftSamples;

  const leftEvidence = latestEvidenceTimestamp(left);
  const rightEvidence = latestEvidenceTimestamp(right);
  if (leftEvidence !== rightEvidence) return rightEvidence - leftEvidence;
  return compareIds(left.conceptId, right.conceptId);
}

function matchesFilter(item: LearningOverviewItem, filter: LearningOverviewFilter): boolean {
  switch (filter) {
    case 'recall':
      return overviewHasRecallDifficulty(item);
    case 'scenario':
      return overviewNeedsScenarioCheck(item);
    case 'calibration':
      return hasCalibrationEvidence(item.calibration.concept)
        || hasCalibrationEvidence(item.calibration.scenario);
    case 'unobserved':
      return item.evidence.currentObservations === 0;
    case 'all':
    default:
      return true;
  }
}

/** Build an overview from metadata only; private answers and source content stay out. */
export function buildLearningOverview({
  sourceId,
  asOf,
  concepts,
  states,
  observations,
  applications,
  corrections,
  anchors = [],
}: LearningOverviewInput): LearningOverview {
  const asOfTimestamp = parseTimestamp(asOf) ?? Number.NaN;
  const observationsByConcept = new Map<string, Observation[]>();
  const anchorsByConcept = new Map<string, AnchorEvent[]>();
  for (const anchor of anchors) {
    const bucket = anchorsByConcept.get(anchor.conceptId);
    if (bucket) bucket.push(anchor);
    else anchorsByConcept.set(anchor.conceptId, [anchor]);
  }
  for (const observation of observations) {
    if (prepareTime(observation.observedAt, observation.recordedAt, asOfTimestamp) === null) continue;
    const bucket = observationsByConcept.get(observation.conceptId);
    if (bucket) bucket.push(observation);
    else observationsByConcept.set(observation.conceptId, [observation]);
  }
  const applicationsByConcept = new Map<string, ApplicationRecord[]>();
  for (const application of applications) {
    if (prepareTime(application.occurredAt, application.recordedAt, asOfTimestamp) === null) continue;
    const bucket = applicationsByConcept.get(application.conceptId);
    if (bucket) bucket.push(application);
    else applicationsByConcept.set(application.conceptId, [application]);
  }

  const items: LearningOverviewItem[] = [];
  const seenConcepts = new Set<string>();

  for (const concept of concepts) {
    const conceptKey = `${concept.id}\u0000${concept.source.revision}`;
    if (seenConcepts.has(conceptKey)) continue;
    seenConcepts.add(conceptKey);

    const conceptObservations = observationsByConcept.get(concept.id) ?? [];
    const currentObservations = conceptObservations.filter((event) => event.sourceRevision === concept.source.revision);
    const previousObservations = conceptObservations.filter((event) => event.sourceRevision !== concept.source.revision);
    const conceptApplications = applicationsByConcept.get(concept.id) ?? [];
    const currentApplications = conceptApplications.filter((event) => event.sourceRevision === concept.source.revision);
    const previousApplicationCount = conceptApplications.length - currentApplications.length;

    const recallObservations = currentObservations.filter((event) => !observationIsScenario(event));
    const scenarioObservations = currentObservations.filter(observationIsScenario);
    const learning = summarizeLearning(currentObservations);
    const latestRecall = latestRecord(recallObservations.map((event) => observationOccurredAt(event)));
    const latestScenario = latestRecord(scenarioObservations.map((event) => observationOccurredAt(event)));
    const latestObservation = latestRecord(currentObservations.map((event) => observationOccurredAt(event)));
    const latestApplication = latestRecord(currentApplications.map((event) => applicationOccurredAt(event)));

    const latestRecallEvent = latestRecall
      ? recallObservations.find((event) => event.eventId === latestRecall.eventId) ?? null
      : null;
    const latestScenarioEvent = latestScenario
      ? scenarioObservations.find((event) => event.eventId === latestScenario.eventId) ?? null
      : null;

    const applicationLatestAt = latestApplication?.occurredAt ?? null;
    const observationLatestAt = latestObservation?.occurredAt ?? null;
    const item: LearningOverviewItem = {
      conceptId: concept.id,
      title: concept.title,
      domainId: domainIdOf(concept),
      sourceRevision: concept.source.revision,
      memory: projectMemory(states[concept.id]),
      recall: {
        total: recallObservations.length,
        clear: recallObservations.filter((event) => event.rating === 'clear').length,
        partial: recallObservations.filter((event) => event.rating === 'partial').length,
        blank: recallObservations.filter((event) => event.rating === 'blank').length,
        latest: latestRecallEvent ? overviewObservation(latestRecallEvent) : null,
      },
      scenario: {
        ...learning.scenario,
        latest: latestScenarioEvent ? overviewObservation(latestScenarioEvent) : null,
      },
      calibration: learning.calibration,
      applications: {
        application: currentApplications.filter((event) => event.kind === 'application').length,
        summary: currentApplications.filter((event) => event.kind === 'summary').length,
        latestAt: applicationLatestAt,
      },
      evidence: {
        currentObservations: currentObservations.length,
        previousObservations: previousObservations.length,
        previousApplications: previousApplicationCount,
        latestAt: maxTimestamp(observationLatestAt, applicationLatestAt),
      },
      timeRecall: buildTimeRecallSummary(currentObservations, anchorsByConcept.get(concept.id) ?? [], asOf),
    };
    items.push(item);
  }

  return {
    sourceId,
    asOf,
    items,
    ...(corrections === undefined
      ? {}
      : { corrections: buildCorrectionOverview({ concepts, applications, corrections, asOf }) }),
  };
}

/** Filter and prioritize overview items for a focused review of learning evidence. */
export function selectLearningOverviewItems(
  items: readonly LearningOverviewItem[],
  { domainId, filter = 'all', query }: LearningOverviewSelectionOptions = {},
): LearningOverviewItem[] {
  const normalizedQuery = query?.trim().toLowerCase();
  const selected = items.filter((item) => {
    if (domainId !== undefined && item.domainId !== domainId) return false;
    if (!matchesFilter(item, filter)) return false;
    if (normalizedQuery && !item.title.toLowerCase().includes(normalizedQuery)
      && !item.conceptId.toLowerCase().includes(normalizedQuery)) return false;
    return true;
  });

  return [...selected].sort(filter === 'calibration' ? compareCalibrationItems : compareOverviewItems);
}
