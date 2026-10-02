import type { Concept } from '../shared/types.js';
import type { PracticeCardEvent, PracticeCardView, PracticeData } from '../shared/practice.js';

const byTime = (left: { recordedAt: string; eventId: string }, right: { recordedAt: string; eventId: string }) =>
  right.recordedAt.localeCompare(left.recordedAt) || right.eventId.localeCompare(left.eventId);

/** Follow the append-only chain rather than timestamp ties to find its current tail. */
export function latestPracticeCards(cards: PracticeCardEvent[]): PracticeCardEvent[] {
  const referenced = new Set(cards.flatMap((card) => card.previousEventId ? [card.previousEventId] : []));
  return cards.filter((card) => !referenced.has(card.eventId)).sort(byTime);
}

/** Read-only projection; never converts a question result to concept mastery or a time anchor. */
export function buildPracticeCards(data: PracticeData, concepts: Concept[]): PracticeCardView[] {
  const byId = new Map(concepts.map((concept) => [concept.id, concept]));
  const attemptsByCard = new Map<string, PracticeData['attempts']>();
  for (const attempt of data.attempts) {
    const attempts = attemptsByCard.get(attempt.cardId) ?? [];
    attempts.push(attempt);
    attemptsByCard.set(attempt.cardId, attempts);
  }
  return latestPracticeCards(data.cards).map((card) => {
    const currentSources = card.sources.map((source) => {
      const concept = byId.get(source.conceptId);
      return concept ? { conceptId: concept.id, title: concept.title, sourceRevision: concept.source.revision } : null;
    });
    const sourceMissing = currentSources.some((source) => source === null);
    const sourceChanged = currentSources.some((source, index) => source?.sourceRevision !== card.sources[index].sourceRevision);
    const applicable = !sourceMissing && !sourceChanged;
    const attempts = (attemptsByCard.get(card.cardId) ?? []).sort((a, b) =>
      b.answeredAt.localeCompare(a.answeredAt) || byTime(a, b));
    const current = applicable ? attempts.filter((attempt) => attempt.cardEventId === card.eventId) : [];
    return {
      card,
      status: sourceMissing ? 'source-missing' : sourceChanged ? 'source-changed' : card.paused ? 'paused' : 'ready',
      currentSources,
      currentAttempts: current.length,
      totalAttempts: attempts.length,
      latest: current[0] ?? null,
    };
  });
}
