/** A person's follow-up of an application record's knowledge correction. */
export type CorrectionStatus = 'resolved' | 'dismissed' | 'open';

export interface CorrectionRequest {
  eventId: string;
  applicationEventId: string;
  conceptId: string;
  /** Content revision explicitly reviewed when making this decision. */
  sourceRevision: string;
  occurredAt: string;
  previousEventId: string | null;
  status: CorrectionStatus;
  note: string;
}

export interface CorrectionEvent extends CorrectionRequest { recordedAt: string }

/** Latest first, bounded per application; older decisions remain in exports. */
export interface CorrectionHistory {
  latest: CorrectionEvent | null;
  events: CorrectionEvent[];
  total: number;
}
