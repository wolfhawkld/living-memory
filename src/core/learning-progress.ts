import { DAY_MS, type LearningEvidence, type Observation } from '../shared/types.js';
import type {
  LearningProgress,
  LearningProgressPair,
  LearningProgressPoint,
} from '../shared/learning-progress.js';
import { isValidInstant } from './time-model.js';

export interface LearningProgressInput {
  conceptId: string;
  sourceRevision: string;
  observations: readonly Observation[];
  asOf: string;
}

type Task = 'concept' | 'scenario';

interface TimedObservation {
  observation: Observation;
  observedTimestamp: number;
  recordedTimestamp: number;
}

function timestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !isValidInstant(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function compareIds(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** Compare observations from oldest to newest by their persisted chronology. */
function compareTimedObservations(left: TimedObservation, right: TimedObservation): number {
  if (left.observedTimestamp !== right.observedTimestamp) {
    return left.observedTimestamp - right.observedTimestamp;
  }
  if (left.recordedTimestamp !== right.recordedTimestamp) {
    return left.recordedTimestamp - right.recordedTimestamp;
  }
  return compareIds(left.observation.eventId, right.observation.eventId);
}

function validCue(value: LearningEvidence['cue'] | undefined): LearningEvidence['cue'] {
  return value === 'independent' || value === 'hinted' || value === 'lookup' || value === 'unknown'
    ? value
    : 'unknown';
}

function validOutcome(value: LearningEvidence['outcome'] | undefined): LearningEvidence['outcome'] {
  return value === 'success' || value === 'partial' || value === 'failure' || value === 'unverified'
    ? value
    : 'unverified';
}

function validBasis(value: LearningEvidence['basis'] | undefined): LearningEvidence['basis'] {
  return value === 'self-check' || value === 'application' || value === 'unknown'
    ? value
    : 'unknown';
}

function validExposure(value: Observation['exposure']): Observation['exposure'] {
  return value === 'unexposed' || value === 'exposed' || value === 'unknown' ? value : 'unknown';
}

function confidenceOf(observation: Observation, observedTimestamp: number): number | null {
  const evidence = observation.learning;
  const confidence = evidence?.confidence;
  if (
    !evidence
    || typeof confidence !== 'number'
    || !Number.isInteger(confidence)
    || confidence < 0
    || confidence > 100
  ) {
    return null;
  }

  const confidenceTimestamp = timestamp(evidence.confidenceAt);
  if (confidenceTimestamp === null || confidenceTimestamp > observedTimestamp) return null;
  return confidence;
}

function pointOf({ observation, observedTimestamp }: TimedObservation): LearningProgressPoint {
  const evidence = observation.learning;
  return {
    ...(observation.evidenceMode ? { evidenceMode: observation.evidenceMode } : {}),
    eventId: observation.eventId,
    observedAt: observation.observedAt,
    recordedAt: observation.recordedAt,
    rating: observation.rating,
    cue: validCue(evidence?.cue),
    exposure: validExposure(observation.exposure),
    observedExposure: observation.observedExposure,
    confidence: confidenceOf(observation, observedTimestamp),
    outcome: validOutcome(evidence?.outcome),
    basis: validBasis(evidence?.basis),
    ...(evidence?.task === 'scenario' && evidence.scenarioRevisit ? { scenarioRevisit: true as const } : {}),
    elapsedDays: observation.elapsedDays,
    halfLifeDays: observation.halfLifeDays,
    configRevision: observation.configRevision,
  };
}

function effectiveExposure(point: LearningProgressPoint): LearningProgressPoint['exposure'] {
  return point.observedExposure ? 'exposed' : point.exposure;
}

function conditionsOf(task: Task, latest: LearningProgressPoint | null, previous: LearningProgressPoint | null): LearningProgressPair['conditions'] {
  if (latest === null || previous === null) return 'insufficient';

  if (latest.evidenceMode !== previous.evidenceMode) {
    return latest.evidenceMode && previous.evidenceMode ? 'different' : 'unknown';
  }

  const latestExposure = effectiveExposure(latest);
  const previousExposure = effectiveExposure(previous);
  if (
    latest.cue === 'unknown'
    || previous.cue === 'unknown'
    || latestExposure === 'unknown'
    || previousExposure === 'unknown'
    || (task === 'scenario' && (latest.basis === 'unknown' || previous.basis === 'unknown'))
  ) {
    return 'unknown';
  }

  const sameCue = latest.cue === previous.cue;
  const sameExposure = latestExposure === previousExposure;
  const sameBasis = task !== 'scenario' || latest.basis === previous.basis;
  const sameRevisit = task !== 'scenario' || latest.scenarioRevisit === previous.scenarioRevisit;
  return sameCue && sameExposure && sameBasis && sameRevisit ? 'same' : 'different';
}

function pairOf(task: Task, records: readonly TimedObservation[]): LearningProgressPair {
  const ordered = [...records].sort((left, right) => compareTimedObservations(right, left));
  const latestRecord = ordered[0] ?? null;
  const previousRecord = ordered[1] ?? null;
  const latest = latestRecord ? pointOf(latestRecord) : null;
  const previous = previousRecord ? pointOf(previousRecord) : null;

  return {
    total: records.length,
    previous,
    latest,
    intervalDays: latestRecord && previousRecord
      ? (latestRecord.observedTimestamp - previousRecord.observedTimestamp) / DAY_MS
      : null,
    conditions: conditionsOf(task, latest, previous),
  };
}

/** Build a metadata-only, read-only progress projection for one concept revision. */
export function buildLearningProgress({
  conceptId,
  sourceRevision,
  observations,
  asOf,
}: LearningProgressInput): LearningProgress {
  const asOfTimestamp = timestamp(asOf);
  const current: { concept: TimedObservation[]; scenario: TimedObservation[] } = {
    concept: [],
    scenario: [],
  };
  let invalidTime = 0;
  let previousRevision = 0;

  for (const observation of observations) {
    if (observation.conceptId !== conceptId) continue;

    const observedTimestamp = timestamp(observation.observedAt);
    const recordedTimestamp = timestamp(observation.recordedAt);
    if (
      asOfTimestamp === null
      || observedTimestamp === null
      || recordedTimestamp === null
      || recordedTimestamp < observedTimestamp
      || observedTimestamp > asOfTimestamp
      || recordedTimestamp > asOfTimestamp
    ) {
      invalidTime += 1;
      continue;
    }

    if (observation.sourceRevision !== sourceRevision) {
      previousRevision += 1;
      continue;
    }

    const task: Task = observation.learning?.task === 'scenario' ? 'scenario' : 'concept';
    current[task].push({ observation, observedTimestamp, recordedTimestamp });
  }

  return {
    conceptId,
    sourceRevision,
    asOf,
    tasks: {
      concept: pairOf('concept', current.concept),
      scenario: pairOf('scenario', current.scenario),
    },
    excluded: { previousRevision, invalidTime },
  };
}
