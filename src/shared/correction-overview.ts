import type { CorrectionStatus } from './corrections.js';

/** Metadata only: the suggestion, application body, and decision notes stay in history. */
export interface CorrectionOverviewItem {
  applicationEventId: string;
  conceptId: string;
  title: string;
  domainId: string;
  sourceRevision: string;
  applicationRevision: string;
  kind: 'application' | 'summary';
  occurredAt: string;
  recordedAt: string;
  status: CorrectionStatus;
  latestEventId: string | null;
  latestOccurredAt: string | null;
  reviewedRevision: string | null;
  sourceChanged: boolean;
  /** A resolved decision still refers to older content; it is not automatically reopened. */
  needsRecheck: boolean;
}

export interface CorrectionOverview {
  items: CorrectionOverviewItem[];
  /** Suggestions whose concepts are absent from the current knowledge index. */
  unavailableCount: number;
}

export type CorrectionOverviewFilter = 'actionable' | 'open' | 'recheck' | 'resolved' | 'dismissed' | 'all';
