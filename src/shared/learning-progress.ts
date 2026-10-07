import type { Exposure, LearningEvidence, RecallRating } from './types.js';

/** Metadata only; answers and scenario text must never be included. */
export interface LearningProgressPoint {
  /** Explicit answer medium; omitted for legacy records. */
  evidenceMode?: import('./types.js').ObservationEvidenceMode;
  eventId: string;
  observedAt: string;
  recordedAt: string;
  rating: RecallRating;
  cue: LearningEvidence['cue'];
  exposure: Exposure;
  observedExposure: boolean;
  confidence: number | null;
  outcome: LearningEvidence['outcome'];
  basis: LearningEvidence['basis'];
  /** Absent on older/newly written prompts; absence does not establish novelty. */
  scenarioRevisit?: true;
  elapsedDays: number | null;
  halfLifeDays: number;
  configRevision: number;
}

export interface LearningProgressPair {
  total: number;
  previous: LearningProgressPoint | null;
  latest: LearningProgressPoint | null;
  /** Actual time between observations, not time without intervening learning. */
  intervalDays: number | null;
  conditions: 'same' | 'different' | 'unknown' | 'insufficient';
}

export interface LearningProgress {
  conceptId: string;
  sourceRevision: string;
  asOf: string;
  tasks: { concept: LearningProgressPair; scenario: LearningProgressPair };
  excluded: { previousRevision: number; invalidTime: number };
}
