import type { AnchorEvent, RecallRating } from './types.js';

export type TimeRecallBand = 'recent' | 'revisit' | 'stale';
export type TimeRecallCondition = 'unexposed' | 'assisted' | 'unknown';
export type TimeRecallFocus = 'all' | 'recent-difficulty' | 'stale-clear';

/** Frozen observation metadata only; never include answers or scenario text. */
export interface TimeRecallEvidence {
  eventId: string;
  observedAt: string;
  recordedAt: string;
  rating: RecallRating;
  elapsedDays: number;
  decay: number;
  halfLifeDays: number;
  configRevision: number;
  anchorOccurredAt: string;
}

export interface RecallCounts { clear: number; partial: number; blank: number }

/** Bounded summary: at most 3 time bands × 2 anchor kinds × 3 conditions. */
export interface TimeRecallBucket {
  band: TimeRecallBand;
  anchorKind: AnchorEvent['kind'];
  condition: TimeRecallCondition;
  count: number;
  ratings: RecallCounts;
  latest: TimeRecallEvidence;
  latestClear: TimeRecallEvidence | null;
  latestDifficulty: TimeRecallEvidence | null;
}

export interface TimeRecallSummary {
  buckets: TimeRecallBucket[];
  excluded: { scenario: number; missingTime: number; invalidTime: number };
}

export interface TimeRecallSelectionOptions {
  anchorKind: AnchorEvent['kind'];
  condition: TimeRecallCondition;
  focus: TimeRecallFocus;
}
