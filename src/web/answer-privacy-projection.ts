import type { AnswerClearingMarker, PrivacyObservation } from '../shared/answer-clearing';
import type { ConceptHistory, ConceptHistoryEntry } from '../shared/types';
import { applyAnswerClearing } from '../core/answer-clearing';

/** A live, scoped view, consulted again after every asynchronous response. */
export interface AnswerPrivacyGuard {
  getMarker(eventId: string): AnswerClearingMarker | null;
  isBlocked(eventId: string): boolean;
  subscribe(listener: () => void): () => void;
}

export function projectPrivateObservation(observation: PrivacyObservation, guard?: AnswerPrivacyGuard): PrivacyObservation | null {
  if (!guard) return observation;
  const marker = guard.getMarker(observation.eventId);
  if (marker) return applyAnswerClearing(observation, marker);
  return guard.isBlocked(observation.eventId) ? null : observation;
}

/** Unknown outcomes hide the targeted observation, preserving independent entries. */
export function projectPrivateHistory(history: ConceptHistory<PrivacyObservation>, guard?: AnswerPrivacyGuard): ConceptHistory<PrivacyObservation> {
  if (!guard) return history;
  return { ...history, entries: history.entries.flatMap<ConceptHistoryEntry<PrivacyObservation>>(entry => {
    if (entry.type !== 'observation') return [entry];
    const event = projectPrivateObservation(entry.event, guard);
    return event ? [{ ...entry, event }] : [];
  }) };
}
