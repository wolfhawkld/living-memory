import type { Concept, Exposure } from '../shared/types.js';
import type {
  PracticeAttemptRequest,
  PracticeCardEvent,
  PracticeCardRequest,
  PracticeCardView,
  PracticeKind,
  PracticeSource,
} from '../shared/practice.js';

/** The blind and feedback phases are deliberately separate to keep source material out of recall markup. */
export type PracticeSessionStage = 'predict' | 'answer' | 'feedback';
export type PracticeOutcome = PracticeAttemptRequest['outcome'];
export type PracticeCue = PracticeAttemptRequest['cue'];

export const PRACTICE_PROMPT_MAX_LENGTH = 4_000;
export const PRACTICE_ANSWER_MAX_LENGTH = 12_000;
export const PRACTICE_NOTES_MAX_LENGTH = 4_000;
export const PRACTICE_TITLE_MAX_LENGTH = 160;
export const PRACTICE_REFERENCE_MAX_LENGTH = 12_000;

export interface PracticeSessionCore {
  readonly eventId: string;
  readonly answeredAt: string;
  readonly answer: string;
  readonly confidence: number | null;
  readonly confidenceAt: string | null;
  readonly exposure: Exposure;
  readonly observedExposure: boolean;
}

export interface PracticeSessionState {
  /** The card event is cloned so a later list refresh cannot replace the question being answered. */
  readonly card: Readonly<PracticeCardEvent>;
  readonly sourceViewedBefore: Readonly<Record<string, boolean>>;
  stage: PracticeSessionStage;
  confidence: number | null;
  confidenceAt: string | null;
  answer: string;
  answeredAt: string | null;
  eventId: string | null;
  /** Set once the answer is submitted, before reference material is rendered. */
  submittedCore: PracticeSessionCore | null;
  cue: PracticeCue;
  outcome: PracticeOutcome;
  exposure: Exposure;
  checkNotes: string;
  /** The exact request remains unchanged for every retry after the first save attempt. */
  submittedRequest: PracticeAttemptRequest | null;
  /** True means the service or a local queue retained the request. */
  attemptSaved: boolean;
  validationError: string | null;
  saveError: string | null;
}

export interface PracticeCardDraft {
  cardId: string;
  previousEventId: string | null;
  kind: PracticeKind;
  title: string;
  prompt: string;
  referenceAnswer: string;
  referenceNotes: string;
  sources: PracticeSource[];
  sourceChecked: boolean;
  paused: boolean;
  /** Namespace in which this draft was opened. It is UI-only and never enters the shared request. */
  originSourceId?: string;
  submittedRequest?: PracticeCardRequest | null;
  saved?: boolean;
  validationError?: string | null;
  saveError?: string | null;
}

export interface PracticeSaveResult {
  request: PracticeAttemptRequest | PracticeCardRequest;
  saved: boolean;
  error: string | null;
}

export interface PracticeSaveCoordinator<T extends PracticeAttemptRequest | PracticeCardRequest> {
  save: (request: T) => Promise<PracticeSaveResult>;
  readonly retainedRequest: T | null;
}

function clone<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function validIsoDate(value: string | null | undefined): boolean {
  return Boolean(value && Number.isFinite(new Date(value).getTime()));
}

function fallbackEventId(prefix: string): string {
  return `lm-practice-${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function newPracticeEventId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : fallbackEventId('event');
}

export function newPracticeCardId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? `card-${crypto.randomUUID()}`
    : fallbackEventId('card');
}

function cardEventOf(card: PracticeCardEvent | PracticeCardView): PracticeCardEvent {
  return 'card' in card ? card.card : card;
}

function isPracticeSourceList(value: PracticeCardEvent | PracticeCardView | readonly PracticeSource[]): value is readonly PracticeSource[] {
  return Array.isArray(value);
}

/** Capture only the source identities used by a card; unrelated concepts do not affect an attempt. */
export function capturePracticeSourceExposure(
  cardOrSources: PracticeCardEvent | PracticeCardView | readonly PracticeSource[],
  concepts: readonly Concept[],
  wasSourceViewed: (concept: Concept) => boolean,
): Readonly<Record<string, boolean>> {
  const sources = isPracticeSourceList(cardOrSources) ? cardOrSources : cardEventOf(cardOrSources).sources;
  const byId = new Map(concepts.map((concept) => [concept.id, concept]));
  const result: Record<string, boolean> = {};
  for (const source of sources) {
    const concept = byId.get(source.conceptId);
    result[source.conceptId] = Boolean(concept && wasSourceViewed(concept));
  }
  return Object.freeze(result);
}

/** Convenience form used by callers that need a complete source-view index. */
export function capturePracticeExposure(
  concepts: readonly Concept[],
  wasSourceViewed: (concept: Concept) => boolean,
): Readonly<Record<string, boolean>> {
  return Object.freeze(Object.fromEntries(concepts.map((concept) => [concept.id, Boolean(wasSourceViewed(concept))])));
}

export function createPracticeSessionState(
  cardOrView: PracticeCardEvent | PracticeCardView,
  sourceViewedBefore: Readonly<Record<string, boolean>> = {},
): PracticeSessionState {
  const card = deepFreeze(clone(cardEventOf(cardOrView)));
  return {
    card,
    sourceViewedBefore: Object.freeze({ ...sourceViewedBefore }),
    stage: 'predict',
    confidence: null,
    confidenceAt: null,
    answer: '',
    answeredAt: null,
    eventId: null,
    submittedCore: null,
    cue: 'unknown',
    outcome: 'unverified',
    exposure: 'unknown',
    checkNotes: '',
    submittedRequest: null,
    attemptSaved: false,
    validationError: null,
    saveError: null,
  };
}

export function setPracticeConfidence(
  state: PracticeSessionState,
  confidence: number | null,
): PracticeSessionState {
  if (state.stage !== 'predict' || state.submittedCore || state.submittedRequest) return state;
  if (confidence !== null && (!Number.isInteger(confidence) || confidence < 0 || confidence > 100)) return state;
  return { ...state, confidence, validationError: null, saveError: null };
}

function validConfidence(value: number | null): boolean {
  return value === null || (Number.isInteger(value) && value >= 0 && value <= 100);
}

/** Start the blind answer phase. A missing confidence is an explicit skip. */
export function startPracticeSession(state: PracticeSessionState, confidenceAt: string | null): PracticeSessionState {
  if (state.stage !== 'predict' || state.submittedCore || state.submittedRequest) return state;
  if (state.confidence !== null && !validIsoDate(confidenceAt)) return state;
  return {
    ...state,
    stage: 'answer',
    confidenceAt: state.confidence === null ? null : confidenceAt,
    validationError: null,
    saveError: null,
  };
}

/** Alias for UI copy and tests that describe the optional prediction as a skip. */
export function skipPracticePrediction(state: PracticeSessionState): PracticeSessionState {
  const withoutPrediction = state.confidence === null ? state : { ...state, confidence: null, confidenceAt: null };
  return startPracticeSession(withoutPrediction, null);
}

/** Freeze event ID, answer, timestamp, prospective confidence, and pre-answer exposure before feedback. */
export function submitPracticeAnswer(
  state: PracticeSessionState,
  answeredAt: string,
  eventId: string,
): PracticeSessionState {
  if (state.stage !== 'answer' || state.submittedCore || state.submittedRequest) return state;
  if (!validIsoDate(answeredAt) || !eventId.trim() || !validConfidence(state.confidence)) return state;
  const observedExposure = state.card.sources.some((source) => state.sourceViewedBefore[source.conceptId] === true);
  const core = deepFreeze({
    eventId,
    answeredAt,
    answer: state.answer,
    confidence: state.confidence,
    confidenceAt: state.confidenceAt,
    exposure: observedExposure ? 'exposed' : state.exposure,
    observedExposure,
  } satisfies PracticeSessionCore);
  return {
    ...state,
    stage: 'feedback',
    answeredAt,
    eventId,
    submittedCore: core,
    validationError: null,
    saveError: null,
  };
}

export function validatePracticeSession(state: PracticeSessionState): string | null {
  if (state.stage !== 'feedback' || !state.submittedCore) return '请先提交自己的回答。';
  if (!state.card.cardId || !state.card.eventId) return '练习卡版本信息不完整，请刷新后重试。';
  if (!state.submittedCore.eventId.trim() || !validIsoDate(state.submittedCore.answeredAt)) return '没有冻结有效的回答事件。';
  if (!validConfidence(state.submittedCore.confidence)) return '开始练习时的信心概率无效。';
  if (state.submittedCore.confidence !== null && !validIsoDate(state.submittedCore.confidenceAt)) return '开始练习时没有冻结信心时间。';
  if (state.submittedCore.confidenceAt && Date.parse(state.submittedCore.confidenceAt) > Date.parse(state.submittedCore.answeredAt)) return '开始预测时间不能晚于提交回答时间。';
  if (state.submittedCore.answer.length > PRACTICE_ANSWER_MAX_LENGTH) return `回答不能超过 ${PRACTICE_ANSWER_MAX_LENGTH} 个字符。`;
  if (!['independent', 'hinted', 'lookup', 'unknown'].includes(state.cue)) return '请选择这次回忆所需的提示程度。';
  if (!['success', 'partial', 'failure', 'unverified'].includes(state.outcome)) return '请选择这次练习的自评结果。';
  if (!['unexposed', 'exposed', 'unknown'].includes(state.exposure)) return '请选择提交前是否看过资料。';
  if (state.checkNotes.length > PRACTICE_NOTES_MAX_LENGTH) return `核对笔记不能超过 ${PRACTICE_NOTES_MAX_LENGTH} 个字符。`;
  return null;
}

/** Build the only attempt payload used by the service; calling it after feedback never changes the frozen core. */
export function buildPracticeAttemptRequest(state: PracticeSessionState): PracticeAttemptRequest {
  if (state.submittedRequest) return state.submittedRequest;
  const error = validatePracticeSession(state);
  if (error) throw new Error(error);
  const core = state.submittedCore;
  if (!core) throw new Error('请先提交自己的回答。');
  const observedExposure = state.card.sources.some((source) => state.sourceViewedBefore[source.conceptId] === true);
  const request = {
    eventId: core.eventId,
    cardId: state.card.cardId,
    cardEventId: state.card.eventId,
    answeredAt: core.answeredAt,
    answer: core.answer,
    confidence: core.confidence,
    confidenceAt: core.confidenceAt,
    exposure: observedExposure ? 'exposed' : state.exposure,
    observedExposure,
    cue: state.cue,
    outcome: state.outcome,
    checkNotes: state.checkNotes.trim(),
  } satisfies PracticeAttemptRequest;
  return deepFreeze(request);
}

/** A failed save still owns the exercise draft; a retained request is safe to close without warning. */
export function hasUnsavedPracticeDraft(state: PracticeSessionState): boolean {
  if (state.attemptSaved) return false;
  return Boolean(
    state.confidence !== null
      || state.answer
      || state.submittedCore
      || state.submittedRequest
      || state.checkNotes
      || state.outcome !== 'unverified'
      || state.cue !== 'unknown'
      || state.exposure !== 'unknown',
  );
}

function sourceIsValid(source: PracticeSource, concepts: readonly Concept[]): boolean {
  const concept = concepts.find((candidate) => candidate.id === source.conceptId);
  return Boolean(concept && source.sourceRevision.trim() && concept.source.revision === source.sourceRevision);
}

export function validatePracticeCardDraft(
  draft: PracticeCardDraft,
  concepts: readonly Concept[],
): string | null {
  if (!draft.cardId.trim()) return '缺少练习卡编号。';
  if (!draft.title.trim()) return '请填写卡片标题。';
  if (draft.title.length > PRACTICE_TITLE_MAX_LENGTH) return `卡片标题不能超过 ${PRACTICE_TITLE_MAX_LENGTH} 个字符。`;
  if (!draft.prompt.trim()) return '请填写练习题干。';
  if (draft.prompt.length > PRACTICE_PROMPT_MAX_LENGTH) return `练习题干不能超过 ${PRACTICE_PROMPT_MAX_LENGTH} 个字符。`;
  if (!draft.referenceAnswer.trim()) return '请填写核对答案。';
  if (draft.referenceAnswer.length > PRACTICE_REFERENCE_MAX_LENGTH) return `核对答案不能超过 ${PRACTICE_REFERENCE_MAX_LENGTH} 个字符。`;
  if (!draft.referenceNotes.trim()) return '请填写出处或理由。';
  if (draft.referenceNotes.length > PRACTICE_NOTES_MAX_LENGTH) return `出处或理由不能超过 ${PRACTICE_NOTES_MAX_LENGTH} 个字符。`;
  if (draft.kind === 'detail' && draft.sources.length !== 1) return '关键细节卡必须引用 1 个来源。';
  if (draft.kind === 'comparison' && (draft.sources.length < 2 || draft.sources.length > 4)) return '概念比较卡必须引用 2 到 4 个不同来源。';
  if (new Set(draft.sources.map((source) => source.conceptId)).size !== draft.sources.length) return '每个来源必须是不同概念。';
  if (draft.sources.some((source) => !sourceIsValid(source, concepts))) return '来源已删除或版本已变化，请重新选择并核对当前资料。';
  if (draft.sourceChecked !== true) return '请明确勾选已核对当前资料。';
  return null;
}

export function createPracticeCardDraft(
  kind: PracticeKind = 'detail',
  options: Partial<Pick<PracticeCardDraft, 'cardId' | 'previousEventId' | 'sources' | 'originSourceId'>> = {},
): PracticeCardDraft {
  return {
    cardId: options.cardId ?? newPracticeCardId(),
    previousEventId: options.previousEventId ?? null,
    kind,
    title: '',
    prompt: '',
    referenceAnswer: '',
    referenceNotes: '',
    sources: [...(options.sources ?? [])],
    sourceChecked: false,
    paused: false,
    originSourceId: options.originSourceId,
    submittedRequest: null,
    saved: false,
    validationError: null,
    saveError: null,
  };
}

export function createPracticeCardDraftFromEvent(
  event: PracticeCardEvent,
  concepts: readonly Concept[] = [],
  originSourceId?: string,
): PracticeCardDraft {
  const currentById = new Map(concepts.map((concept) => [concept.id, concept]));
  return {
    cardId: event.cardId,
    previousEventId: event.eventId,
    kind: event.kind,
    title: event.title,
    prompt: event.prompt,
    referenceAnswer: event.referenceAnswer,
    referenceNotes: event.referenceNotes,
    // Existing concepts are presented at their current revision in the editable draft. The
    // explicit confirmation remains false, so opening an editor never writes this replacement;
    // a deleted concept keeps its old identity until the user chooses a new one.
    sources: event.sources.map((source) => {
      const concept = currentById.get(source.conceptId);
      return concept ? { conceptId: concept.id, sourceRevision: concept.source.revision } : { ...source };
    }),
    sourceChecked: false,
    paused: event.paused,
    originSourceId,
    submittedRequest: null,
    saved: false,
    validationError: null,
    saveError: null,
  };
}

export function buildPracticeCardRequest(
  draft: PracticeCardDraft,
  occurredAt: string,
  eventId: string,
  concepts?: readonly Concept[],
): PracticeCardRequest {
  if (!validIsoDate(occurredAt)) throw new Error('练习卡缺少有效的发生时间。');
  if (!eventId.trim()) throw new Error('练习卡缺少事件编号。');
  if (draft.sourceChecked !== true) throw new Error('请明确勾选已核对当前资料。');
  if (draft.kind === 'detail' && draft.sources.length !== 1) throw new Error('关键细节卡必须引用 1 个来源。');
  if (draft.kind === 'comparison' && (draft.sources.length < 2 || draft.sources.length > 4)) throw new Error('概念比较卡必须引用 2 到 4 个不同来源。');
  if (new Set(draft.sources.map((source) => source.conceptId)).size !== draft.sources.length) throw new Error('每个来源必须是不同概念。');
  if (concepts) {
    const error = validatePracticeCardDraft(draft, concepts);
    if (error) throw new Error(error);
  }
  return deepFreeze({
    eventId,
    cardId: draft.cardId,
    previousEventId: draft.previousEventId,
    occurredAt,
    kind: draft.kind,
    title: draft.title.trim(),
    prompt: draft.prompt.trim(),
    referenceAnswer: draft.referenceAnswer.trim(),
    referenceNotes: draft.referenceNotes.trim(),
    sources: draft.sources.map((source) => ({ ...source })),
    sourceChecked: true,
    paused: draft.paused,
  } satisfies PracticeCardRequest);
}

/** Pause/resume is itself a card revision and carries the exact old source references. */
export function buildPracticeCardRevisionRequest(
  card: PracticeCardEvent,
  paused: boolean,
  occurredAt: string,
  eventId: string,
): PracticeCardRequest {
  return buildPracticeCardRequest({
    cardId: card.cardId,
    previousEventId: card.eventId,
    kind: card.kind,
    title: card.title,
    prompt: card.prompt,
    referenceAnswer: card.referenceAnswer,
    referenceNotes: card.referenceNotes,
    sources: card.sources.map((source) => ({ ...source })),
    sourceChecked: true,
    paused,
  }, occurredAt, eventId);
}

export function hasUnsavedPracticeCardDraft(draft: PracticeCardDraft): boolean {
  if (draft.saved) return false;
  return Boolean(
    draft.submittedRequest
      || draft.title
      || draft.prompt
      || draft.referenceAnswer
      || draft.referenceNotes
      || draft.sources.length
      || draft.sourceChecked,
  );
}

/**
 * A small save coordinator for retryable writes. It deduplicates concurrent double clicks and
 * retains a successful request for the lifetime of the dialog. Failed requests may be retried
 * with the same object by the caller.
 */
export function createPracticeSaveCoordinator<T extends PracticeAttemptRequest | PracticeCardRequest>(
  onSave: (request: T) => Promise<boolean>,
): PracticeSaveCoordinator<T> {
  let retainedRequest: T | null = null;
  let inFlight: Promise<PracticeSaveResult> | null = null;
  return {
    get retainedRequest() { return retainedRequest; },
    save(request: T): Promise<PracticeSaveResult> {
      if (retainedRequest) return Promise.resolve({ request: retainedRequest, saved: true, error: null });
      if (inFlight) return inFlight;
      inFlight = (async () => {
        try {
          const saved = await onSave(request);
          if (saved) retainedRequest = request;
          return { request, saved, error: saved ? null : '记录尚未确认写入，请检查连接后重试。' };
        } catch (error: unknown) {
          return { request, saved: false, error: error instanceof Error && error.message ? error.message : '记录保存失败，请检查连接后重试。' };
        } finally {
          inFlight = null;
        }
      })();
      return inFlight;
    },
  };
}

export const createPracticeAttemptSaver = createPracticeSaveCoordinator;
export const createPracticeCardSaver = createPracticeSaveCoordinator;

const attemptCoordinators = new WeakMap<Function, Map<string, PracticeSaveCoordinator<PracticeAttemptRequest>>>();
const cardCoordinators = new WeakMap<Function, Map<string, PracticeSaveCoordinator<PracticeCardRequest>>>();

function coordinatorFor<T extends PracticeAttemptRequest | PracticeCardRequest>(
  registry: WeakMap<Function, Map<string, PracticeSaveCoordinator<T>>>,
  onSave: (request: T) => Promise<boolean>,
  eventId: string,
): PracticeSaveCoordinator<T> {
  let byEvent = registry.get(onSave);
  if (!byEvent) {
    byEvent = new Map();
    registry.set(onSave, byEvent);
  }
  let coordinator = byEvent.get(eventId);
  if (!coordinator) {
    coordinator = createPracticeSaveCoordinator(onSave);
    byEvent.set(eventId, coordinator);
  }
  return coordinator;
}

export async function savePracticeAttempt(
  request: PracticeAttemptRequest,
  onSave: (request: PracticeAttemptRequest) => Promise<boolean>,
): Promise<PracticeSaveResult> {
  return coordinatorFor(attemptCoordinators, onSave, request.eventId).save(request);
}

export async function savePracticeCard(
  request: PracticeCardRequest,
  onSave: (request: PracticeCardRequest) => Promise<boolean>,
): Promise<PracticeSaveResult> {
  return coordinatorFor(cardCoordinators, onSave, request.eventId).save(request);
}
