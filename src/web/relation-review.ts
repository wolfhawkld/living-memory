import type { ApplicationRecord } from '../shared/types';
import { parseRelationReviewRequest, type RelationReviewBasis, type RelationReviewRequest, type RelationReviewResponse } from '../shared/relation-reviews';
export { relationReviewBasisEqual } from '../shared/relation-reviews';

export function relationReviewCanRebase(errorCode: string | undefined): boolean {
  return errorCode === 'RELATION_REVIEW_SOURCE_CHANGED' || errorCode === 'RELATION_REVIEW_CONFLICT';
}

/** Retrying an uncertain write never depends on newer read-side evidence. */
export function relationReviewSubmissionMode(input: {
  locked: boolean; available: boolean; frozenInScope: boolean; hasFrozen: boolean;
  currentAvailable: boolean; stale: boolean; decision: RelationReviewRequest['status']; matching: boolean; confirmed: boolean;
}): 'blocked' | 'retry' | 'new' {
  if (input.locked || !input.available) return 'blocked';
  if (input.hasFrozen) return input.frozenInScope ? 'retry' : 'blocked';
  if (!input.currentAvailable || input.stale || (input.decision === 'resolved' && (!input.matching || !input.confirmed))) return 'blocked';
  return 'new';
}

export function relationReviewResponseMatches(response: RelationReviewResponse, application: Pick<ApplicationRecord, 'eventId' | 'conceptId'>, sourceId: string): boolean {
  return response.sourceId === sourceId && response.applicationEventId === application.eventId && response.conceptId === application.conceptId;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

/** One event/time and a detached basis are retained unchanged for retries. */
export function buildRelationReviewRequest(
  application: Pick<ApplicationRecord, 'eventId' | 'conceptId'>,
  basis: RelationReviewBasis,
  previousEventId: string | null,
  status: RelationReviewRequest['status'],
  note: string,
  eventId: string = crypto.randomUUID(),
  occurredAt = new Date().toISOString(),
): RelationReviewRequest {
  return deepFreeze(parseRelationReviewRequest({
    eventId, applicationEventId: application.eventId, conceptId: application.conceptId,
    occurredAt, previousEventId, status, note: note.trim(), basis: structuredClone(basis),
  }));
}
