import type { Concept, Exposure, WriteReceipt } from './types.js';

export type PracticeKind = 'detail' | 'comparison';
export interface PracticeSource { conceptId: string; sourceRevision: string }

/** An append-only, manually authored and source-checked question revision. */
export interface PracticeCardRequest {
  eventId: string;
  cardId: string;
  previousEventId: string | null;
  occurredAt: string;
  kind: PracticeKind;
  title: string;
  prompt: string;
  referenceAnswer: string;
  referenceNotes: string;
  sources: PracticeSource[];
  sourceChecked: true;
  paused: boolean;
}
export interface PracticeCardEvent extends PracticeCardRequest { recordedAt: string }

/** These answers never enter concept/scenario recall aggregates or memory anchors. */
export interface PracticeAttemptRequest {
  eventId: string;
  cardId: string;
  cardEventId: string;
  answeredAt: string;
  answer: string;
  confidence: number | null;
  confidenceAt: string | null;
  exposure: Exposure;
  observedExposure: boolean;
  cue: 'independent' | 'hinted' | 'lookup' | 'unknown';
  outcome: 'success' | 'partial' | 'failure' | 'unverified';
  checkNotes: string;
}
export interface PracticeAttempt extends PracticeAttemptRequest { recordedAt: string }
export interface PracticeData { cards: PracticeCardEvent[]; attempts: PracticeAttempt[] }

export interface PracticeCardView {
  card: PracticeCardEvent;
  status: 'ready' | 'paused' | 'source-changed' | 'source-missing';
  currentSources: Array<{ conceptId: string; title: string; sourceRevision: string } | null>;
  /** Only attempts of this exact card revision and still-current source versions. */
  currentAttempts: number;
  totalAttempts: number;
  latest: PracticeAttempt | null;
}
export interface PracticeCardsResponse {
  sourceId: string;
  asOf: string;
  items: PracticeCardView[];
}
export interface PracticeHistoryResponse {
  sourceId: string;
  cardId: string;
  cards: PracticeCardEvent[];
  attempts: PracticeAttempt[];
}
export interface PracticeHandlers {
  loadCards: (signal?: AbortSignal) => Promise<PracticeCardsResponse>;
  loadHistory: (cardId: string, signal?: AbortSignal) => Promise<PracticeHistoryResponse>;
  saveCard: (request: PracticeCardRequest) => Promise<boolean>;
  saveAttempt: (request: PracticeAttemptRequest) => Promise<boolean>;
  readConcept: (conceptId: string) => Promise<Concept>;
}
export type PracticeReceipt = WriteReceipt;
