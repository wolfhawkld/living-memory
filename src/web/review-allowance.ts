import { reviewDayKey, type ReviewPlanResponse } from '../shared/review-plan';
import type { PendingWrite } from './api';

/** A soft workload budget, never a memory score or a server-side write quota. */
export function reviewAllowance(response: ReviewPlanResponse, pending: readonly PendingWrite[]) {
  const completed = new Set(response.completedConceptIds);
  const pendingIds = new Set<string>();
  for (const write of pending) {
    if (write.path !== '/observations' || !write.payload || typeof write.payload !== 'object') continue;
    const event = write.payload as Record<string, unknown>;
    const learning = event.learning as { task?: unknown } | undefined;
    if (learning?.task === 'scenario' || typeof event.conceptId !== 'string' || typeof event.observedAt !== 'string'
      || !Number.isFinite(Date.parse(event.observedAt))) continue;
    if (reviewDayKey(event.observedAt, response.timeZone) === response.dayKey && !completed.has(event.conceptId)) pendingIds.add(event.conceptId);
  }
  return {
    completed: completed.size,
    pending: pendingIds.size,
    remaining: Math.max(0, response.plan.dailyBudget - completed.size - pendingIds.size),
    excludedIds: new Set([...completed, ...pendingIds]),
  };
}
