import type { CalibrationSummary, Exposure, LearningEvidence, LearningSummary, MemoryStatus, RecallRating } from './types.js';

/** Evidence metadata only. Answers, scenarios and private application text never leave the overview API. */
export interface OverviewObservation {
  eventId: string;
  observedAt: string;
  rating: RecallRating;
  exposure: Exposure;
  observedExposure: boolean;
  cue: LearningEvidence['cue'];
  outcome: LearningEvidence['outcome'];
  basis: LearningEvidence['basis'];
}

export interface LearningOverviewItem {
  conceptId: string;
  title: string;
  domainId: string;
  sourceRevision: string;
  memory: { status: MemoryStatus; elapsedDays: number | null; lastReviewedAt: string | null; estimated: boolean };
  recall: { total: number; clear: number; partial: number; blank: number; latest: OverviewObservation | null };
  scenario: LearningSummary['scenario'] & { latest: OverviewObservation | null };
  calibration: { concept: CalibrationSummary; scenario: CalibrationSummary };
  applications: { application: number; summary: number; latestAt: string | null };
  evidence: { currentObservations: number; previousObservations: number; previousApplications: number; latestAt: string | null };
  /** Optional for clients talking to an older service; unknown is not an empty result. */
  timeRecall?: import('./time-recall.js').TimeRecallSummary;
}

export interface LearningOverview {
  sourceId: string;
  asOf: string;
  items: LearningOverviewItem[];
}

export type LearningOverviewFilter = 'all' | 'recall' | 'scenario' | 'calibration' | 'unobserved';
