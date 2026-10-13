import type { RelationReviewBasis, RelationReviewStatus } from './relation-reviews.js';
import type { RelationSuggestion, RelationSuggestionEndpoint } from './types.js';

/** Metadata only; relation text, application bodies and decision notes remain in history. */
export interface RelationOverviewItem {
  applicationEventId: string;
  conceptId: string;
  title: string;
  domainId: string;
  sourceRevision: string;
  applicationRevision: string;
  kind: 'application' | 'summary';
  occurredAt: string;
  recordedAt: string;
  operation: RelationSuggestion['operation'];
  source: RelationSuggestionEndpoint;
  target: RelationSuggestionEndpoint;
  status: RelationReviewStatus | null;
  latestEventId: string | null;
  latestOccurredAt: string | null;
  basis: RelationReviewBasis;
  basisChanged: boolean;
  needsRecheck: boolean;
  chainInvalid: boolean;
  structureMatches: boolean | null;
  sourceChanged: boolean;
}

export interface RelationOverview {
  items: RelationOverviewItem[];
  unavailableCount: number;
}

export type RelationOverviewFilter = 'actionable' | 'open' | 'recheck' | 'resolved' | 'dismissed' | 'all';

export function relationOverviewIsActionable(item: RelationOverviewItem): boolean {
  return item.status === 'open' || item.needsRecheck || item.chainInvalid;
}
