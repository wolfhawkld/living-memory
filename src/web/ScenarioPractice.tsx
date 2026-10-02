import { useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type ReactElement } from 'react';
import type {
  Concept,
  Exposure,
  LearningEvidence,
  ObservationRequest,
  RecallRating,
  Snapshot,
} from '../shared/types';
import type { ScenarioPrompts } from '../shared/scenario-prompts';
import { MarkdownView } from './MarkdownView';
import { saveScenarioRequest } from './scenario-save';

/** Values are stored as integer percentages so the persisted evidence is explicit and portable. */
export const SCENARIO_CONFIDENCE_OPTIONS = [
  { value: null, label: '不填（暂不校准）' },
  { value: 0, label: '0%' },
  { value: 25, label: '25%' },
  { value: 50, label: '50%' },
  { value: 75, label: '75%' },
  { value: 100, label: '100%' },
] as const;

const SCENARIO_MAX_LENGTH = 4000;
const ANSWER_MAX_LENGTH = 4000;
const APPLICABILITY_MAX_LENGTH = 4000;

export type ScenarioPracticeStage = 'setup' | 'answer' | 'feedback';
export type ScenarioCue = LearningEvidence['cue'];
export type ScenarioOutcome = LearningEvidence['outcome'];
export type ScenarioBasis = LearningEvidence['basis'];

export interface ScenarioPracticeState {
  /** A private, cloned snapshot. It must not change when the parent receives a newer graph. */
  readonly snapshot: Snapshot;
  readonly sourceViewedBefore: Readonly<Record<string, boolean>>;
  stage: ScenarioPracticeStage;
  scenario: string;
  /** Whether the prompt came from a previously saved scenario observation. */
  scenarioRevisit: boolean;
  confidence: number | null;
  confidenceAt: string | null;
  answer: string;
  observedAt: string | null;
  eventId: string | null;
  conceptId: string | null;
  applicability: string;
  cue: ScenarioCue;
  outcome: ScenarioOutcome;
  basis: ScenarioBasis;
  exposure: Exposure;
  /** Set before the first save attempt and reused for every retry. */
  submittedRequest: ObservationRequest | null;
  /** The parent confirmed this frozen request was retained (server or local queue). */
  observationSaved: boolean;
  validationError: string | null;
  saveError: string | null;
}

export interface ScenarioPracticeProps {
  snapshot: Snapshot;
  sourceId: string;
  busy: boolean;
  onClose: () => void;
  onSave: (request: ObservationRequest) => Promise<boolean>;
  onReadSource: (concept: Concept) => void;
  wasSourceViewed: (concept: Concept) => boolean;
  /** Notify the parent after the feedback summary exposes a concept for future attempts. */
  onSourceExposed?: (concept: Concept) => void;
  /** Load saved scenario prompt text without exposing concept, answer, or result. */
  onLoadPrompts?: (options: { limit?: number; cursor?: string; signal?: AbortSignal }) => Promise<ScenarioPrompts>;
  /** Optional prompt supplied by history navigation; it remains a blind setup. */
  initialScenario?: string;
  /** After a successful observation save, open an editable application / summary draft. */
  onContinueApplication?: (request: ObservationRequest) => void | Promise<void>;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/** Clone and freeze the graph so a source refresh cannot alter a live exercise. */
export function freezeScenarioSnapshot(snapshot: Snapshot): Snapshot {
  const clone = typeof structuredClone === 'function'
    ? structuredClone(snapshot)
    : JSON.parse(JSON.stringify(snapshot)) as Snapshot;
  return deepFreeze(clone);
}

export function captureScenarioSourceExposure(
  snapshot: Snapshot,
  wasSourceViewed: (concept: Concept) => boolean,
): Readonly<Record<string, boolean>> {
  return Object.freeze(Object.fromEntries(snapshot.concepts.map((concept) => [concept.id, Boolean(wasSourceViewed(concept))])));
}

function fallbackEventId(): string {
  return `lm-scenario-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function newScenarioEventId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : fallbackEventId();
}

export function createScenarioPracticeState(
  snapshot: Snapshot,
  sourceViewedBefore: Readonly<Record<string, boolean>> = {},
  initialScenario = '',
  scenarioRevisit = Boolean(initialScenario.trim()),
): ScenarioPracticeState {
  return {
    snapshot: freezeScenarioSnapshot(snapshot),
    sourceViewedBefore: Object.freeze({ ...sourceViewedBefore }),
    stage: 'setup',
    scenario: initialScenario,
    scenarioRevisit,
    confidence: null,
    confidenceAt: null,
    answer: '',
    observedAt: null,
    eventId: null,
    conceptId: null,
    applicability: '',
    cue: 'unknown',
    outcome: 'unverified',
    basis: 'unknown',
    exposure: 'unknown',
    submittedRequest: null,
    observationSaved: false,
    validationError: null,
    saveError: null,
  };
}

function validIsoDate(value: string | null): boolean {
  return Boolean(value && Number.isFinite(new Date(value).getTime()));
}

function findConcept(state: ScenarioPracticeState): Concept | null {
  if (!state.conceptId) return null;
  return state.snapshot.concepts.find((concept) => concept.id === state.conceptId) ?? null;
}

export function startScenarioPractice(state: ScenarioPracticeState, confidenceAt: string): ScenarioPracticeState {
  if (state.stage !== 'setup' || !state.scenario.trim() || state.scenario.length > SCENARIO_MAX_LENGTH) return state;
  return {
    ...state,
    stage: 'answer',
    confidenceAt: state.confidence === null ? null : confidenceAt,
    validationError: null,
    saveError: null,
  };
}

/** Submitting may intentionally contain an empty answer: blank recall is useful evidence. */
export function submitScenarioAnswer(
  state: ScenarioPracticeState,
  observedAt: string,
  eventId: string,
): ScenarioPracticeState {
  if (state.stage !== 'answer' || !validIsoDate(observedAt) || !eventId.trim()) return state;
  return {
    ...state,
    stage: 'feedback',
    observedAt,
    eventId,
    validationError: null,
    saveError: null,
  };
}

function knownOutcome(outcome: ScenarioOutcome): boolean {
  return outcome !== 'unverified';
}

export function validateScenarioPractice(state: ScenarioPracticeState): string | null {
  if (state.stage !== 'feedback') return '请先提交场景回答。';
  if (!state.scenario.trim()) return '请先填写场景。';
  if (state.scenario.length > SCENARIO_MAX_LENGTH) return `场景不能超过 ${SCENARIO_MAX_LENGTH} 个字符。`;
  if (state.answer.length > ANSWER_MAX_LENGTH) return `回答不能超过 ${ANSWER_MAX_LENGTH} 个字符。`;
  if (state.confidence !== null && (!Number.isInteger(state.confidence) || state.confidence < 0 || state.confidence > 100)) return '信心概率必须是 0% 到 100% 之间的整数。';
  if (state.confidence !== null && !validIsoDate(state.confidenceAt)) return '开始练习时没有冻结有效的信心时间。';
  if (!validIsoDate(state.observedAt)) return '没有冻结有效的回答时间。';
  if (!state.eventId?.trim()) return '没有冻结这次练习的事件编号。';
  const concept = findConcept(state);
  if (!concept) return '请选择一个与场景相关的概念。';
  if (state.applicability.length > APPLICABILITY_MAX_LENGTH) return `适用性说明不能超过 ${APPLICABILITY_MAX_LENGTH} 个字符。`;
  if ((state.outcome === 'success' || state.outcome === 'partial') && !state.applicability.trim()) return '请用自己的话说明这个概念为什么适用于场景。';
  if (knownOutcome(state.outcome) && state.basis === 'unknown') return '已判断结果时，请选择这次判断的依据。';
  return null;
}

function ratingForOutcome(outcome: ScenarioOutcome): RecallRating {
  if (outcome === 'success') return 'clear';
  if (outcome === 'partial') return 'partial';
  return 'blank';
}

/** Build the immutable write payload from the snapshot captured at answer time. */
export function buildScenarioObservationRequest(state: ScenarioPracticeState): ObservationRequest {
  const error = validateScenarioPractice(state);
  if (error) throw new Error(error);
  const concept = findConcept(state);
  if (!concept || !state.eventId || !state.observedAt) throw new Error('场景练习资料不完整。');

  const observedExposure = state.sourceViewedBefore[concept.id] === true;
  const exposure: Exposure = observedExposure ? 'exposed' : state.exposure;
  const anchor = state.snapshot.states[concept.id]?.anchor ?? null;
  const anchorEventId = anchor && anchor.sourceRevision === concept.source.revision ? anchor.eventId : null;
  const learning: LearningEvidence = {
    task: 'scenario',
    scenario: state.scenario.trim(),
    ...(state.scenarioRevisit ? { scenarioRevisit: true } : {}),
    ...(state.applicability.trim() ? { applicability: state.applicability.trim() } : {}),
    confidence: state.confidence,
    confidenceAt: state.confidenceAt,
    cue: state.cue,
    outcome: state.outcome,
    basis: state.basis,
  };

  return Object.freeze({
    eventId: state.eventId,
    conceptId: concept.id,
    sourceRevision: concept.source.revision,
    observedAt: state.observedAt,
    configRevision: state.snapshot.config.revision,
    anchorEventId,
    answer: state.answer,
    rating: ratingForOutcome(state.outcome),
    exposure,
    observedExposure,
    learning,
  });
}

function updateDraft(state: ScenarioPracticeState, update: Partial<ScenarioPracticeState>): ScenarioPracticeState {
  if (state.submittedRequest) return state;
  return { ...state, ...update, validationError: null, saveError: null };
}

/** A failed write still owns a draft and frozen request that must be confirmed before discard. */
export function hasUnsavedScenarioDraft(state: ScenarioPracticeState): boolean {
  return !state.observationSaved && (
    Boolean(state.scenario.trim())
    || Boolean(state.answer.trim())
    || state.confidence !== null
    || Boolean(state.conceptId)
    || Boolean(state.applicability.trim())
  );
}

function parseConfidence(value: string): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 100 ? parsed : null;
}

function formatPromptDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(date);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

const CUE_LABELS: Record<ScenarioCue, string> = {
  independent: '独立想到',
  hinted: '得到提示后想到',
  lookup: '查阅资料后想到',
  unknown: '不确定',
};

const OUTCOME_LABELS: Record<ScenarioOutcome, string> = {
  success: '能准确调用并解释',
  partial: '部分调用或解释',
  failure: '没有准确调用',
  unverified: '暂不判断',
};

const BASIS_LABELS: Record<ScenarioBasis, string> = {
  'self-check': '自己对照资料核对',
  application: '实际应用结果',
  unknown: '不确定',
};

const EXPOSURE_LABELS: Record<Exposure, string> = {
  unknown: '不确定',
  unexposed: '提交前没有看资料',
  exposed: '提交前看过资料',
};

function selectedConcept(state: ScenarioPracticeState): Concept | null {
  return findConcept(state);
}

export function ScenarioPractice({
  snapshot,
  sourceId,
  busy,
  onClose,
  onSave,
  onReadSource,
  wasSourceViewed,
  onSourceExposed,
  onLoadPrompts,
  initialScenario = '',
  onContinueApplication,
}: ScenarioPracticeProps): ReactElement {
  const initialState = useRef<ScenarioPracticeState | null>(null);
  if (!initialState.current) {
    const frozenSnapshot = freezeScenarioSnapshot(snapshot);
    const sourceViewedBefore = captureScenarioSourceExposure(frozenSnapshot, wasSourceViewed);
    initialState.current = createScenarioPracticeState(frozenSnapshot, sourceViewedBefore, initialScenario, Boolean(initialScenario.trim()));
  }
  const [state, setState] = useState<ScenarioPracticeState>(initialState.current);
  const [conceptQuery, setConceptQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const [continueError, setContinueError] = useState<string | null>(null);
  const [promptsOpen, setPromptsOpen] = useState(false);
  const [prompts, setPrompts] = useState<ScenarioPrompts | null>(null);
  const [promptsLoading, setPromptsLoading] = useState(false);
  const [promptsLoadingMore, setPromptsLoadingMore] = useState(false);
  const [promptsError, setPromptsError] = useState<string | null>(null);
  const savingRef = useRef(false);
  const continuingRef = useRef(false);
  const promptsRequestRef = useRef(0);
  const promptsAbortRef = useRef<AbortController | null>(null);
  const promptsSourceIdRef = useRef(sourceId);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const answerRef = useRef<HTMLTextAreaElement>(null);
  const scenarioRef = useRef<HTMLTextAreaElement>(null);
  const queryRef = useRef<HTMLInputElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onSourceExposedRef = useRef(onSourceExposed);
  const exposedConceptRef = useRef<string | null>(null);
  const titleId = useId();
  const scenarioId = useId();
  const confidenceId = useId();
  const answerId = useId();
  const queryId = useId();
  const applicabilityId = useId();
  const cueId = useId();
  const outcomeId = useId();
  const basisId = useId();
  const exposureId = useId();
  const isBusy = busy || saving || continuing;

  onSourceExposedRef.current = onSourceExposed;
  promptsSourceIdRef.current = sourceId;

  const concept = selectedConcept(state);
  const concepts = state.snapshot.concepts;
  const filteredConcepts = useMemo(() => {
    const query = conceptQuery.trim().toLocaleLowerCase();
    const matches = query
      ? concepts.filter((candidate) => [candidate.title, candidate.domain, ...candidate.aliases]
        .some((value) => value.toLocaleLowerCase().includes(query)))
      : concepts;
    return matches.slice(0, 12);
  }, [conceptQuery, concepts]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    if (!dialog.open) dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
      document.body.style.overflow = previousOverflow;
      const previous = previousFocusRef.current;
      if (previous?.isConnected && !previous.closest('[inert]')) previous.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    if (state.stage !== 'feedback' || !concept) {
      if (!concept) exposedConceptRef.current = null;
      return;
    }
    const notify = onSourceExposedRef.current;
    if (!notify || exposedConceptRef.current === concept.id) return;
    exposedConceptRef.current = concept.id;
    notify(concept);
  }, [concept, state.stage]);

  useEffect(() => {
    if (state.stage === 'setup') scenarioRef.current?.focus({ preventScroll: true });
    else if (state.stage === 'answer') answerRef.current?.focus({ preventScroll: true });
    else queryRef.current?.focus({ preventScroll: true });
  }, [state.stage]);

  useEffect(() => () => {
    promptsRequestRef.current += 1;
    promptsAbortRef.current?.abort();
    promptsAbortRef.current = null;
  }, []);

  useEffect(() => {
    promptsRequestRef.current += 1;
    promptsAbortRef.current?.abort();
    promptsAbortRef.current = null;
    setPrompts(null);
    setPromptsLoading(false);
    setPromptsLoadingMore(false);
    setPromptsError(null);
    setPromptsOpen(false);
  }, [sourceId]);

  useEffect(() => {
    if (state.stage === 'setup') return;
    promptsRequestRef.current += 1;
    promptsAbortRef.current?.abort();
    promptsAbortRef.current = null;
    setPromptsLoading(false);
    setPromptsLoadingMore(false);
    setPromptsError(null);
    setPromptsOpen(false);
  }, [state.stage]);

  const loadPrompts = async (mode: 'initial' | 'more' = 'initial') => {
    if (!onLoadPrompts || promptsLoading || promptsLoadingMore) return;
    const cursor = mode === 'more' ? prompts?.nextCursor ?? undefined : undefined;
    if (mode === 'more' && !cursor) return;

    promptsAbortRef.current?.abort();
    const controller = new AbortController();
    const requestId = promptsRequestRef.current + 1;
    const requestSourceId = sourceId;
    promptsRequestRef.current = requestId;
    promptsAbortRef.current = controller;
    if (mode === 'initial') {
      setPromptsOpen(true);
      setPrompts(null);
      setPromptsLoading(true);
    } else setPromptsLoadingMore(true);
    setPromptsError(null);
    try {
      const response = await onLoadPrompts({ limit: 8, ...(cursor ? { cursor } : {}), signal: controller.signal });
      if (requestId !== promptsRequestRef.current || promptsSourceIdRef.current !== requestSourceId || controller.signal.aborted) return;
      if (!response || response.sourceId !== requestSourceId) throw new Error('已保存场景来自另一知识空间，请刷新后重试。');
      if (mode === 'initial') {
        setPrompts(response);
      } else {
        setPrompts((current) => {
          if (!current) return response;
          const seen = new Set(current.items.map((item) => item.eventId));
          return {
            ...response,
            items: [...current.items, ...response.items.filter((item) => !seen.has(item.eventId))],
          };
        });
      }
    } catch (error: unknown) {
      if (requestId !== promptsRequestRef.current || controller.signal.aborted || isAbortError(error)) return;
      setPromptsError(error instanceof Error && error.message ? error.message : '已保存场景加载失败，请重试。');
    } finally {
      if (requestId !== promptsRequestRef.current) return;
      if (mode === 'initial') setPromptsLoading(false);
      else setPromptsLoadingMore(false);
      if (promptsAbortRef.current === controller) promptsAbortRef.current = null;
    }
  };

  const hasUnsavedDraft = hasUnsavedScenarioDraft(state);

  const close = () => {
    if (isBusy) return;
    if (hasUnsavedDraft && typeof window !== 'undefined'
      && !window.confirm('当前场景或回答尚未保存，关闭会丢失输入。确定关闭吗？')) return;
    onClose();
  };

  const changeScenario = (event: ChangeEvent<HTMLTextAreaElement>) => {
    if (state.stage !== 'setup') return;
    setState((current) => ({ ...current, scenario: event.target.value, validationError: null, saveError: null }));
  };

  const selectPrompt = (item: ScenarioPrompts['items'][number]) => {
    setState((current) => updateDraft(current, {
      scenario: item.scenario,
      scenarioRevisit: true,
      confidence: null,
      confidenceAt: null,
      conceptId: null,
      answer: '',
      applicability: '',
      cue: 'unknown',
      outcome: 'unverified',
      basis: 'unknown',
      exposure: 'unknown',
    }));
    setConceptQuery('');
    setPromptsOpen(false);
    setPromptsError(null);
  };

  const startNewScenario = () => {
    if (state.stage !== 'setup') return;
    setState((current) => updateDraft(current, { scenario: '', scenarioRevisit: false, confidence: null, confidenceAt: null }));
    setPromptsOpen(false);
    setPromptsError(null);
  };

  const start = () => {
    if (!state.scenario.trim()) {
      setState((current) => ({ ...current, validationError: '请先写下一个具体的业务、研究或工作场景。' }));
      return;
    }
    setState((current) => startScenarioPractice(current, new Date().toISOString()));
  };

  const submit = () => {
    setState((current) => submitScenarioAnswer(current, new Date().toISOString(), newScenarioEventId()));
  };

  const chooseConcept = (next: Concept) => {
    setState((current) => updateDraft(current, {
      conceptId: next.id,
      exposure: current.sourceViewedBefore[next.id] ? 'exposed' : 'unknown',
    }));
    setConceptQuery(next.title);
  };

  const save = async (continueToApplication = false) => {
    if (isBusy || savingRef.current || continuingRef.current) return;
    if (!continueToApplication && state.observationSaved) return;
    if (continueToApplication && !onContinueApplication) return;
    const error = state.submittedRequest ? null : validateScenarioPractice(state);
    if (error) {
      setState((current) => ({ ...current, validationError: error }));
      return;
    }
    const request = state.submittedRequest ?? buildScenarioObservationRequest(state);
    if (!state.submittedRequest) setState((current) => ({ ...current, submittedRequest: request, validationError: null, saveError: null }));
    savingRef.current = true;
    continuingRef.current = continueToApplication;
    setSaving(true);
    setContinuing(continueToApplication);
    setContinueError(null);
    try {
      const result = await saveScenarioRequest(request, { onSave, onContinueApplication }, {
        observationSaved: state.observationSaved,
        continueToApplication,
      });
      if (result.saved) {
        setState((current) => ({ ...current, submittedRequest: request, observationSaved: true, saveError: null }));
        if (result.continuationError) setContinueError(result.continuationError);
        else if (!continueToApplication || result.continued) onClose();
      } else {
        setState((current) => ({ ...current, submittedRequest: request, observationSaved: false, saveError: result.saveError ?? '记录尚未确认写入，请检查连接后重试。' }));
      }
    } finally {
      savingRef.current = false;
      continuingRef.current = false;
      setSaving(false);
      setContinuing(false);
    }
  };

  const backdropDown = useRef(false);
  return (
    <dialog
      ref={dialogRef}
      className="scenario-practice"
      aria-labelledby={titleId}
      aria-modal="true"
      onCancel={(event) => {
        // Escape is handled by the top-most native dialog. A nested ConceptReader
        // must consume its own cancel event without closing this exercise.
        if (event.currentTarget !== dialogRef.current) return;
        event.preventDefault();
        close();
      }}
      onPointerDown={(event) => { backdropDown.current = event.target === event.currentTarget; }}
      onClick={(event) => {
        if (backdropDown.current && event.target === event.currentTarget && !isBusy) close();
        backdropDown.current = false;
      }}
    >
      <div className="scenario-practice-shell">
        <header className="scenario-practice-header">
          <div>
            <span className="scenario-practice-kicker">场景调用 · {state.stage === 'setup' ? '设置' : state.stage === 'answer' ? '先回忆' : '核对'}</span>
            <h2 id={titleId}>从场景中想起适用的概念</h2>
          </div>
          <button type="button" className="scenario-practice-close" onClick={close} disabled={isBusy} aria-label="关闭场景练习">×</button>
        </header>

        {state.stage === 'setup' ? (
          <section className="scenario-practice-body" aria-labelledby={titleId}>
            <p className="scenario-practice-intro">写下一个你正在处理的业务、研究或工作场景，也可以回访已保存的场景。之后先只看场景作答，系统会在提交后让你检索可能适用的概念。</p>
            {onLoadPrompts || state.scenarioRevisit ? <div className="scenario-prompt-toolbar">
              {onLoadPrompts ? <button type="button" className="scenario-button secondary" onClick={() => {
                const nextOpen = !promptsOpen;
                setPromptsOpen(nextOpen);
                if (nextOpen && !prompts && !promptsLoading) void loadPrompts('initial');
              }} disabled={isBusy || promptsLoading}>{promptsOpen ? '收起已保存场景' : '回访已保存场景'}</button> : null}
              {state.scenarioRevisit ? <button type="button" className="scenario-button quiet" onClick={startNewScenario} disabled={isBusy}>新场景</button> : null}
            </div> : null}
            {promptsOpen && onLoadPrompts ? <div className="scenario-prompts" aria-label="已保存场景">
              {promptsLoading ? <p className="scenario-prompts-status" role="status">正在加载已保存场景…</p> : null}
              {!promptsLoading && promptsError ? <div className="scenario-prompts-error" role="alert"><span>{promptsError}</span><button type="button" className="scenario-button quiet" onClick={() => void loadPrompts('initial')}>重试</button></div> : null}
              {!promptsLoading && !promptsError && prompts && prompts.items.length === 0 ? <p className="scenario-prompts-status">还没有可回访的已保存场景。</p> : null}
              {!promptsLoading && !promptsError && prompts?.items.length ? <>
                <p className="scenario-prompts-note">列表仅提供场景文字和时间，不显示旧概念、回答或核对结果。题面本身可能含已有线索。</p>
                <div className="scenario-prompts-list" role="listbox" aria-label="选择一个已保存场景">
                  {prompts.items.map((item) => <button type="button" role="option" className="scenario-prompt-option" key={item.eventId} onClick={() => selectPrompt(item)}>
                    <span>{item.scenario}</span><small>{formatPromptDate(item.observedAt)}</small>
                  </button>)}
                </div>
                {prompts.nextCursor ? <button type="button" className="scenario-button quiet scenario-prompts-more" onClick={() => void loadPrompts('more')} disabled={isBusy || promptsLoadingMore}>{promptsLoadingMore ? '加载中…' : '加载更多场景'}</button> : null}
              </> : null}
            </div> : null}
            <label className="scenario-practice-field" htmlFor={scenarioId}>
              <span>{state.scenarioRevisit ? '场景描述 · 同场景回访' : '场景描述'}</span>
              <textarea id={scenarioId} ref={scenarioRef} value={state.scenario} maxLength={SCENARIO_MAX_LENGTH} onChange={changeScenario} placeholder="例如：需要为一个多代理系统设计负责意图识别、规则校验和上下文记忆的 orchestrator……" />
              <small>{state.scenario.length} / {SCENARIO_MAX_LENGTH}{state.scenarioRevisit ? ' · 可编辑为同一场景的改写；不代表新场景迁移能力' : ''}</small>
            </label>
            <label className="scenario-practice-field scenario-confidence" htmlFor={confidenceId}>
              <span>开始前的信心</span>
              <select id={confidenceId} value={state.confidence === null ? '' : String(state.confidence)} onChange={(event) => setState((current) => updateDraft(current, { confidence: parseConfidence(event.target.value) }))}>
                {SCENARIO_CONFIDENCE_OPTIONS.map((option) => <option key={option.label} value={option.value === null ? '' : String(option.value)}>{option.label}</option>)}
              </select>
              <small>你认为自己能独立想起至少一个适用概念，并解释为什么适用的概率。一次记录只选一个概念；若原始回答没有明确想起当前概念，请谨慎选择结果。</small>
            </label>
            {state.validationError ? <p className="scenario-practice-error" role="alert">{state.validationError}</p> : null}
            <div className="scenario-practice-actions">
              <button type="button" className="scenario-button secondary" onClick={close} disabled={isBusy}>取消</button>
              <button type="button" className="scenario-button primary" onClick={start} disabled={isBusy || !state.scenario.trim()}>开始先回忆</button>
            </div>
          </section>
        ) : null}

        {state.stage === 'answer' ? (
          <section className="scenario-practice-body scenario-answer" aria-labelledby={titleId}>
            <div className="scenario-card-label">只给你场景</div>
            <p className="scenario-prompt">{state.scenario}</p>
            <label className="scenario-practice-field" htmlFor={answerId}>
              <span>先写下你会怎样分析或解决</span>
              <textarea id={answerId} ref={answerRef} value={state.answer} maxLength={ANSWER_MAX_LENGTH} onChange={(event) => setState((current) => ({ ...current, answer: event.target.value }))} placeholder="可以写概念名称、模型或算法，也可以写你会如何判断……（允许留白）" />
              <small>{state.answer.length} / {ANSWER_MAX_LENGTH} · 这一阶段不会显示候选概念。</small>
            </label>
            {state.validationError ? <p className="scenario-practice-error" role="alert">{state.validationError}</p> : null}
            <div className="scenario-practice-actions">
              <button type="button" className="scenario-button secondary" onClick={close} disabled={isBusy}>取消</button>
              <button type="button" className="scenario-button primary" onClick={submit} disabled={isBusy}>提交回答，进入核对</button>
            </div>
          </section>
        ) : null}

        {state.stage === 'feedback' ? (
          <section className="scenario-practice-body scenario-feedback" aria-labelledby={titleId}>
            <div className="scenario-feedback-columns">
              <div className="scenario-feedback-main">
                <p className="scenario-feedback-notice">请核对原始回答是否已想起该概念并说明适用理由；核对后新发现的概念不算这次独立想起。</p>
                {state.scenarioRevisit ? <p className="scenario-revisit-note" role="status">同场景回访：这次结果用于和此前同一场景对照，不代表新场景迁移能力。</p> : null}
                <div className="scenario-answer-echo"><span>场景</span><p>{state.scenario}</p></div>
                <div className="scenario-answer-echo"><span>你的回答</span><p>{state.answer || '（空白回答）'}</p></div>

                <label className="scenario-practice-field" htmlFor={queryId}>
                  <span>你认为哪个概念适用于这个场景？</span>
                  <input id={queryId} ref={queryRef} type="search" role="combobox" aria-autocomplete="list" aria-expanded={filteredConcepts.length > 0 && !state.submittedRequest} value={conceptQuery} disabled={Boolean(state.submittedRequest) || isBusy} onChange={(event) => {
                    const value = event.target.value;
                    setConceptQuery(value);
                    if (state.conceptId) setState((current) => updateDraft(current, { conceptId: null, exposure: 'unknown' }));
                  }} placeholder="搜索概念、别名或领域" />
                </label>
                {!state.submittedRequest && filteredConcepts.length > 0 ? (
                  <div className="scenario-concept-results" role="listbox" aria-label="匹配的概念">
                    {filteredConcepts.map((candidate) => <button type="button" role="option" aria-selected={candidate.id === state.conceptId} className={candidate.id === state.conceptId ? 'is-selected' : ''} key={candidate.id} onClick={() => chooseConcept(candidate)}>{candidate.title}<small>{candidate.domain}</small></button>)}
                  </div>
                ) : null}
                {concept ? <div className="scenario-selected-concept">
                  <div className="scenario-selected-heading"><div><span className="scenario-card-label">当前概念</span><strong>{concept.title}</strong><small>{concept.domain}</small></div><button type="button" className="scenario-read-source" onClick={() => onReadSource(concept)} disabled={isBusy}>阅读完整资料 ↗</button></div>
                  <div className="scenario-summary"><MarkdownView content={concept.summary || '此概念暂无摘要。'} compact source={{ sourceId, conceptId: concept.id, sourceRevision: concept.source.revision }} /></div>
                </div> : null}
                <label className="scenario-practice-field" htmlFor={applicabilityId}>
              <span>为什么适用或不适用（可在核对后补充）</span>
                  <textarea id={applicabilityId} value={state.applicability} maxLength={APPLICABILITY_MAX_LENGTH} disabled={Boolean(state.submittedRequest) || isBusy} onChange={(event) => setState((current) => updateDraft(current, { applicability: event.target.value }))} placeholder="它对应场景中的哪一部分？哪些条件使它适用或不适用？" />
                  <small>{state.applicability.length} / {APPLICABILITY_MAX_LENGTH}</small>
                </label>
              </div>

              <aside className="scenario-feedback-side" aria-label="回忆结果记录">
                <label className="scenario-practice-field" htmlFor={cueId}><span>获得概念的线索</span><select id={cueId} value={state.cue} disabled={Boolean(state.submittedRequest) || isBusy} onChange={(event) => setState((current) => updateDraft(current, { cue: event.target.value as ScenarioCue }))}>{(Object.keys(CUE_LABELS) as ScenarioCue[]).map((key) => <option key={key} value={key}>{CUE_LABELS[key]}</option>)}</select></label>
                <label className="scenario-practice-field" htmlFor={outcomeId}><span>这次调用结果</span><select id={outcomeId} value={state.outcome} disabled={Boolean(state.submittedRequest) || isBusy} onChange={(event) => setState((current) => updateDraft(current, { outcome: event.target.value as ScenarioOutcome }))}>{(Object.keys(OUTCOME_LABELS) as ScenarioOutcome[]).map((key) => <option key={key} value={key}>{OUTCOME_LABELS[key]}</option>)}</select></label>
                <label className="scenario-practice-field" htmlFor={basisId}><span>判断依据</span><select id={basisId} value={state.basis} disabled={Boolean(state.submittedRequest) || isBusy} onChange={(event) => setState((current) => updateDraft(current, { basis: event.target.value as ScenarioBasis }))}>{(Object.keys(BASIS_LABELS) as ScenarioBasis[]).map((key) => <option key={key} value={key}>{BASIS_LABELS[key]}</option>)}</select><small>成功、部分或失败需要注明依据；“暂不判断”可以保留为不确定。</small></label>
                <label className="scenario-practice-field" htmlFor={exposureId}><span>提交前是否看过资料</span><select id={exposureId} value={state.exposure} disabled={Boolean(state.submittedRequest) || isBusy} onChange={(event) => setState((current) => updateDraft(current, { exposure: event.target.value as Exposure }))}>{(Object.keys(EXPOSURE_LABELS) as Exposure[]).map((key) => <option key={key} value={key}>{EXPOSURE_LABELS[key]}</option>)}</select>{concept && state.sourceViewedBefore[concept.id] ? <small>该概念在练习开始前已被查看，保存时会按“看过”记录。</small> : null}</label>
                {state.validationError ? <p className="scenario-practice-error" role="alert">{state.validationError}</p> : null}
                {state.saveError ? <p className="scenario-practice-error" role="alert">{state.saveError}</p> : null}
                {continueError ? <p className="scenario-practice-error" role="alert">{continueError}</p> : null}
              </aside>
            </div>
            <div className="scenario-practice-actions">
              <button type="button" className="scenario-button secondary" onClick={close} disabled={isBusy}>{state.observationSaved ? '关闭（观察已保留）' : '取消，不保存'}</button>
              {onContinueApplication ? <button type="button" className="scenario-button secondary" onClick={() => void save(true)} disabled={isBusy || !concept}>
                {continuing ? '打开应用 / 总结中…' : state.observationSaved ? '继续写应用 / 总结' : '保存观察并写应用 / 总结'}
              </button> : null}
              <button type="button" className="scenario-button primary" onClick={() => void save()} disabled={isBusy || !concept || state.observationSaved}>{isBusy ? '保存中…' : state.observationSaved ? '观察已保留' : state.submittedRequest ? '重试保存' : '保存这次场景观察'}</button>
            </div>
            <p className="scenario-practice-footnote">这条记录描述一次场景调用表现，不会把主观自评直接当作客观记忆强度。应用 / 总结入口只会预填学习总结，实际应用请另行选择并确认。</p>
          </section>
        ) : null}
      </div>
    </dialog>
  );
}

export default ScenarioPractice;
