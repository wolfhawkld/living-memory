import type { BriefReviewCandidate } from '../core/brief-review';
import { selectBriefReviewCandidates } from '../core/brief-review';
import type { Concept, MemoryState, Snapshot } from '../shared/types';

export type BriefReviewResult = 'saved' | 'queued' | 'skipped' | 'unavailable';
export type BriefReviewItem = BriefReviewCandidate & { title: string };
export interface BriefReviewSession {
  id: string;
  sourceId: string;
  domainId: string;
  items: BriefReviewItem[];
  index: number;
  results: Record<string, BriefReviewResult>;
  reviews: Record<string, 'saved' | 'queued'>;
}

/** Revalidate each frozen item against a fresh real snapshot before showing it. */
export function resolveBriefReviewItem(
  session: BriefReviewSession, snapshot: Snapshot, excludedIds: ReadonlySet<string>,
): { concept: Concept; state: MemoryState } | null {
  const item = session.items[session.index];
  const concept = snapshot.concepts.find((value) => value.id === item?.conceptId);
  if (!item || !concept || concept.source.revision !== item.sourceRevision) return null;
  const candidates = selectBriefReviewCandidates({ ...snapshot, concepts: [concept] }, session.domainId, { excludedIds });
  return candidates.length ? { concept, state: snapshot.states[concept.id] } : null;
}

/** Guard late callbacks and duplicate completion without creating learning events. */
export function completeBriefReviewItem(
  session: BriefReviewSession | null, sessionId: string, conceptId: string, result: BriefReviewResult,
): BriefReviewSession | null {
  if (!session || session.id !== sessionId || session.items[session.index]?.conceptId !== conceptId
    || session.results[conceptId]) return session;
  return { ...session, results: { ...session.results, [conceptId]: result } };
}

export function advanceBriefReview(session: BriefReviewSession): BriefReviewSession {
  const item = session.items[session.index];
  if (!item || !session.results[item.conceptId] || session.index >= session.items.length - 1) return session;
  return { ...session, index: session.index + 1 };
}

export function briefReviewCounts(session: BriefReviewSession): { saved: number; queued: number; skipped: number } {
  const results = Object.values(session.results);
  return {
    saved: results.filter((result) => result === 'saved').length,
    queued: results.filter((result) => result === 'queued').length,
    skipped: results.filter((result) => result === 'skipped' || result === 'unavailable').length,
  };
}
