import type { Observation } from './types.js';
import type { ObservationAssessment, ObservationRevision } from './observation-revisions.js';

/** A single parent's current adopted judgment, independent of its raw answer. */
export interface ObservationRevisionHistoryState {
  status: 'active' | 'withdrawn';
  /** Withdrawal retains the last adopted judgment for a later reinstatement. */
  currentAssessment: ObservationAssessment;
  latestRevisionEventId: string | null;
  appliedRevisionCount: number;
}

/**
 * Internal ledger read contract; no HTTP route consumes it yet.
 * Events run from the current tail toward the root and are bounded per page.
 * The full original observation is private and must remain authorization-scoped.
 */
export interface ObservationRevisionHistory {
  observation: Observation;
  state: ObservationRevisionHistoryState;
  events: ObservationRevision[];
  /** All revisions of this parent, including decisions outside the page. */
  total: number;
  /** All persisted revisions in this namespace; separate from raw history totals. */
  observationRevisionCount: number;
  /** A navigation boundary, never an authorization credential. */
  nextCursor: string | null;
}
