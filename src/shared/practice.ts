import type { Concept, Exposure, WriteReceipt } from './types.js';

export type PracticeKind = 'detail' | 'comparison' | 'scenario';
export interface PracticeSource { conceptId: string; sourceRevision: string }

export type PracticeOutcome = 'success' | 'partial' | 'failure' | 'unverified';
export type ScenarioHintStage = 'independent' | 'structure' | 'name';
/** Authored hints are only shown after freezing the preceding answer. */
export interface PracticeScenarioCard {
  caseFamily: string;
  structureHint: string;
  nameHint: string;
}
export interface PracticeScenarioStage {
  stage: ScenarioHintStage;
  answer: string;
  answeredAt: string;
  /** null for the original blind answer. */
  hintShownAt: string | null;
  recallOutcome: PracticeOutcome;
  applicabilityOutcome: PracticeOutcome;
}
export interface PracticeScenarioAttempt {
  stages: PracticeScenarioStage[];
  caseExposure: 'seen' | 'unseen' | 'unknown';
  /** Frozen UI knowledge of earlier attempts of this card/family, never an assertion of novelty. */
  observedCaseExposure: boolean;
}

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
  /** Required only for kind=scenario; absent for older cards. */
  scenario?: PracticeScenarioCard;
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
  outcome: PracticeOutcome;
  checkNotes: string;
  /** Scenario ratings are per stage; top-level outcome stays unverified. */
  scenario?: PracticeScenarioAttempt;
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
  /** All prior versions/cards sharing the exact manually chosen family label. */
  scenarioHistory?: { sameCardAttempts: number; sameFamilyAttempts: number };
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
