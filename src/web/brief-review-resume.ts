import { domainIdOf } from '../core/domain-view';
import type { ReviewPlanResponse } from '../shared/review-plan';
import type { AnchorEvent, ReviewRequest, Snapshot } from '../shared/types';
import type { PendingWrite } from './api';
import type { BriefReviewCheckpoint } from './brief-review-checkpoint';
import { completeBriefReviewItem, resolveBriefReviewItem } from './brief-review-session';
import { reviewAllowance } from './review-allowance';

export function briefReviewConfirmationSuperseded(
  request: Pick<ReviewRequest, 'eventId' | 'occurredAt'> | null | undefined, anchor: AnchorEvent | null | undefined,
): boolean {
  return Boolean(request?.occurredAt && anchor && anchor.eventId !== request.eventId
    && Date.parse(anchor.occurredAt) > Date.parse(request.occurredAt));
}

/** Reconcile acknowledged local writes before deciding whether a draft can resume. */
export function prepareBriefReviewResume(
  checkpoint: BriefReviewCheckpoint, snapshot: Snapshot, response: ReviewPlanResponse, pending: readonly PendingWrite[],
) {
  let session = checkpoint.session;
  if (session.sourceId !== response.sourceId) throw new Error('未完成记录属于另一个知识空间。');
  const item = session.items[session.index];
  const concept = snapshot.concepts.find((entry) => entry.id === item.conceptId) ?? null;
  const pendingObservation = checkpoint.attempt?.eventId && pending.some((write) =>
    write.path === '/observations' && write.eventId === checkpoint.attempt!.eventId && write.conceptId === item.conceptId);
  if (pendingObservation) session = completeBriefReviewItem(session, session.id, item.conceptId, 'queued')!;
  const review = checkpoint.reviewRequest;
  if (review && snapshot.states[item.conceptId]?.anchor?.eventId === review.eventId) {
    session = { ...session, reviews: { ...session.reviews, [item.conceptId]: 'saved' } };
  } else if (review && pending.some((write) => write.path === '/reviews' && write.eventId === review.eventId && write.conceptId === item.conceptId)) {
    session = { ...session, reviews: { ...session.reviews, [item.conceptId]: 'queued' } };
  }
  if (session.results[item.conceptId]) return { session, concept, attempt: null, state: null };

  if (!concept || concept.source.revision !== item.sourceRevision || domainIdOf(concept) !== session.domainId) {
    throw new Error('当前题目的资料或领域已变化，原作答仍保留，可先复制，再放弃本轮重新安排。');
  }
  const excluded = new Set(pending.filter((write) => write.path !== '/applications').map((write) => write.conceptId).filter((id): id is string => Boolean(id)));
  const allowance = reviewAllowance(response, pending);
  // An already-started answer may finish after a budget change. A new question
  // must fit today's budget; fixed submitted payloads remain safe to retry.
  if (!checkpoint.attempt) {
    if (!allowance.remaining) throw new Error('今日预算已用完，可明天继续，或调整每日预算。');
    allowance.excludedIds.forEach((id) => excluded.add(id));
  }
  const ready = resolveBriefReviewItem(session, snapshot, excluded, { preferences: response.plan.concepts, asOf: response.asOf });
  if (!ready) throw new Error('当前题目已暂缓、重温、长期保持或有待同步记录，原作答仍保留，可先复制再重新安排。');
  if (checkpoint.attempt && checkpoint.attempt.anchorEventId !== (ready.state.anchor?.eventId ?? null)) {
    throw new Error('当前题目的重温起点已变化，原作答仍保留，可先复制再重新安排。');
  }
  return { session, concept, attempt: checkpoint.attempt, state: ready.state };
}
