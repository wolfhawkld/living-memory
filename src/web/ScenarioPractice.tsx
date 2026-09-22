import { useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type ReactElement } from 'react';
import type {
  Concept,
  Exposure,
  LearningEvidence,
  ObservationRequest,
  RecallRating,
  Snapshot,
} from '../shared/types';
import { MarkdownView } from './MarkdownView';

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
): ScenarioPracticeState {
  return {
    snapshot: freezeScenarioSnapshot(snapshot),
    sourceViewedBefore: Object.freeze({ ...sourceViewedBefore }),
    stage: 'setup',
    scenario: '',
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
  const anchorEventId = state.snapshot.states[concept.id]?.anchor?.eventId ?? null;
  const learning: LearningEvidence = {
    task: 'scenario',
    scenario: state.scenario.trim(),
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

function parseConfidence(value: string): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 100 ? parsed : null;
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
  'self-check': '自己的回忆核对',
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
}: ScenarioPracticeProps): ReactElement {
  const initialState = useRef<ScenarioPracticeState | null>(null);
  if (!initialState.current) {
    const frozenSnapshot = freezeScenarioSnapshot(snapshot);
    const sourceViewedBefore = captureScenarioSourceExposure(frozenSnapshot, wasSourceViewed);
    initialState.current = createScenarioPracticeState(frozenSnapshot, sourceViewedBefore);
  }
  const [state, setState] = useState<ScenarioPracticeState>(initialState.current);
  const [conceptQuery, setConceptQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const answerRef = useRef<HTMLTextAreaElement>(null);
  const scenarioRef = useRef<HTMLTextAreaElement>(null);
  const queryRef = useRef<HTMLInputElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const busyRef = useRef(busy);
  const onCloseRef = useRef(onClose);
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
  const isBusy = busy || saving;

  busyRef.current = isBusy;
  onCloseRef.current = onClose;

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
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || busyRef.current) return;
      event.preventDefault();
      onCloseRef.current();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    if (state.stage === 'setup') scenarioRef.current?.focus({ preventScroll: true });
    else if (state.stage === 'answer') answerRef.current?.focus({ preventScroll: true });
    else queryRef.current?.focus({ preventScroll: true });
  }, [state.stage]);

  const close = () => {
    if (!isBusy) onClose();
  };

  const changeScenario = (event: ChangeEvent<HTMLTextAreaElement>) => {
    if (state.stage !== 'setup') return;
    setState((current) => ({ ...current, scenario: event.target.value, validationError: null, saveError: null }));
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

  const save = async () => {
    if (isBusy) return;
    const error = state.submittedRequest ? null : validateScenarioPractice(state);
    if (error) {
      setState((current) => ({ ...current, validationError: error }));
      return;
    }
    const request = state.submittedRequest ?? buildScenarioObservationRequest(state);
    if (!state.submittedRequest) setState((current) => ({ ...current, submittedRequest: request, validationError: null, saveError: null }));
    setSaving(true);
    try {
      const saved = await onSave(request);
      if (saved) onClose();
      else setState((current) => ({ ...current, submittedRequest: request, saveError: '记录没有确认写入，请检查连接后重试。' }));
    } catch (error: unknown) {
      const message = error instanceof Error && error.message ? error.message : '记录没有确认写入，请检查连接后重试。';
      setState((current) => ({ ...current, submittedRequest: request, saveError: message }));
    } finally {
      setSaving(false);
    }
  };

  const backdropDown = useRef(false);
  return (
    <dialog
      ref={dialogRef}
      className="scenario-practice"
      aria-labelledby={titleId}
      aria-modal="true"
      onCancel={(event) => { event.preventDefault(); close(); }}
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
            <p className="scenario-practice-intro">写下一个你正在处理的业务、研究或工作场景。之后先只看场景作答，系统会在提交后让你检索可能适用的概念。</p>
            <label className="scenario-practice-field" htmlFor={scenarioId}>
              <span>场景描述</span>
              <textarea id={scenarioId} ref={scenarioRef} value={state.scenario} maxLength={SCENARIO_MAX_LENGTH} onChange={changeScenario} placeholder="例如：需要为一个多代理系统设计负责意图识别、规则校验和上下文记忆的 orchestrator……" />
              <small>{state.scenario.length} / {SCENARIO_MAX_LENGTH}</small>
            </label>
            <label className="scenario-practice-field scenario-confidence" htmlFor={confidenceId}>
              <span>开始前的信心</span>
              <select id={confidenceId} value={state.confidence === null ? '' : String(state.confidence)} onChange={(event) => setState((current) => updateDraft(current, { confidence: parseConfidence(event.target.value) }))}>
                {SCENARIO_CONFIDENCE_OPTIONS.map((option) => <option key={option.label} value={option.value === null ? '' : String(option.value)}>{option.label}</option>)}
              </select>
              <small>你认为自己能独立想起一个适用概念，并解释为什么适用的概率。</small>
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
              </aside>
            </div>
            <div className="scenario-practice-actions">
              <button type="button" className="scenario-button secondary" onClick={close} disabled={isBusy}>取消，不保存</button>
              <button type="button" className="scenario-button primary" onClick={() => void save()} disabled={isBusy || !concept}>{isBusy ? '保存中…' : state.submittedRequest ? '重试保存' : '保存这次场景观察'}</button>
            </div>
            <p className="scenario-practice-footnote">这条记录描述一次场景调用表现，不会把主观自评直接当作客观记忆强度。</p>
          </section>
        ) : null}
      </div>
    </dialog>
  );
}

export default ScenarioPractice;
