export interface ConceptReviewPreference {
  focus: boolean;
  deferUntil: string | null;
}

/** Scheduling preferences are separate from learning evidence and memory state. */
export interface ReviewPlan {
  revision: number;
  dailyBudget: number;
  concepts: Record<string, ConceptReviewPreference>;
}

export type ReviewPlanUpdate = { revision: number } & (
  | { dailyBudget: number; concept?: never }
  | { concept: ConceptReviewPreference & { conceptId: string; sourceRevision: string }; dailyBudget?: never }
);

export interface ReviewPlanResponse {
  sourceId: string;
  asOf: string;
  timeZone: string;
  dayKey: string;
  plan: ReviewPlan;
  /** Unique concepts with accepted concept-recall observations on this local day. */
  completedConceptIds: string[];
}

export const DEFAULT_DAILY_REVIEW_BUDGET = 5;
export const MAX_DAILY_REVIEW_BUDGET = 50;

/** Use a calendar day in an explicit zone, including DST boundaries. */
export function reviewDayKey(instant: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(instant));
  const part = (type: string) => parts.find((item) => item.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
