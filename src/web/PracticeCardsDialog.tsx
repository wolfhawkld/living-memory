import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactElement,
} from 'react';
import type { Concept } from '../shared/types.js';
import type {
  PracticeAttemptRequest,
  PracticeCardEvent,
  PracticeCardRequest,
  PracticeCardView,
  PracticeCardsResponse,
  PracticeHandlers,
  PracticeHistoryResponse,
  PracticeKind,
} from '../shared/practice.js';
import { MarkdownView } from './MarkdownView';
import {
  buildPracticeAttemptRequest,
  buildPracticeCardRequest,
  buildPracticeCardRevisionRequest,
  capturePracticeSourceExposure,
  createPracticeCardDraft,
  createPracticeCardDraftFromEvent,
  createPracticeSessionState,
  hasUnsavedPracticeCardDraft,
  hasUnsavedPracticeDraft,
  newPracticeEventId,
  PRACTICE_ANSWER_MAX_LENGTH,
  PRACTICE_NOTES_MAX_LENGTH,
  PRACTICE_PROMPT_MAX_LENGTH,
  PRACTICE_REFERENCE_MAX_LENGTH,
  PRACTICE_TITLE_MAX_LENGTH,
  setPracticeConfidence,
  startPracticeSession,
  submitPracticeAnswer,
  validatePracticeCardDraft,
  type PracticeCardDraft,
  type PracticeSessionState,
} from './practice-session';

// Vite loads this stylesheet in the browser. Keeping the import conditional lets the pure
// server-rendered safety tests import this component through Node without a CSS loader.
if (typeof window !== 'undefined') void import('./practice-cards.css');

export interface PracticeCardsDialogProps {
  sourceId: string;
  /** The complete current concept index, including concepts outside the selected source. */
  concepts: Concept[];
  initialConceptId?: string;
  lockedReason: string | null;
  handlers: PracticeHandlers;
  wasSourceViewed: (concept: Concept) => boolean;
  onSourceExposed?: (concept: Concept) => void;
  onClose: () => void;
}

type CardFilter = 'all' | 'detail' | 'comparison' | 'paused' | 'source-review';
type EditorMode = 'create' | 'revise';

interface EditorState {
  mode: EditorMode;
  draft: PracticeCardDraft;
  /** Request namespace at the moment this editor opened. */
  originSourceId: string;
}

interface PendingCardWrite {
  request: PracticeCardRequest;
  cardId: string;
  error: string | null;
}

interface HistoryState {
  cardId: string;
  loading: boolean;
  error: string | null;
  data: PracticeHistoryResponse | null;
}

const FILTER_LABELS: Record<CardFilter, string> = {
  all: '全部',
  detail: '关键细节',
  comparison: '概念比较',
  paused: '已暂停',
  'source-review': '来源待复核',
};

const KIND_LABELS: Record<PracticeKind, string> = {
  detail: '关键细节',
  comparison: '概念比较',
};

const STATUS_LABELS: Record<PracticeCardView['status'], string> = {
  ready: '可以练习',
  paused: '已暂停',
  'source-changed': '来源已变化，待复核',
  'source-missing': '来源已删除，待重新选择',
};

const OUTCOME_LABELS: Record<PracticeAttemptRequest['outcome'], string> = {
  success: '准确',
  partial: '部分准确',
  failure: '未成功',
  unverified: '暂不判断',
};

const CUE_LABELS: Record<PracticeAttemptRequest['cue'], string> = {
  independent: '独立作答',
  hinted: '得到提示后想到',
  lookup: '查阅资料后想到',
  unknown: '不确定',
};

const EXPOSURE_LABELS: Record<PracticeAttemptRequest['exposure'], string> = {
  unexposed: '提交前没有看资料',
  exposed: '提交前看过资料',
  unknown: '不确定',
};

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(date);
}

function sourceRevisionLabel(value: string): string {
  return value.length > 16 ? `${value.slice(0, 16)}…` : value;
}

function sourceIsCurrent(source: { conceptId: string; sourceRevision: string }, concepts: readonly Concept[]): boolean {
  const concept = concepts.find((candidate) => candidate.id === source.conceptId);
  return Boolean(concept && concept.source.revision === source.sourceRevision);
}

function notifySources(
  sources: readonly { conceptId: string }[],
  concepts: readonly Concept[],
  notify: ((concept: Concept) => void) | undefined,
) {
  if (!notify) return;
  const byId = new Map(concepts.map((concept) => [concept.id, concept]));
  const notified = new Set<string>();
  for (const source of sources) {
    const concept = byId.get(source.conceptId);
    if (concept && !notified.has(concept.id)) {
      notified.add(concept.id);
      notify(concept);
    }
  }
}

function currentSourceList(draft: PracticeCardDraft, concepts: readonly Concept[]) {
  return draft.sources.map((source) => {
    const concept = concepts.find((candidate) => candidate.id === source.conceptId);
    return { source, concept, current: Boolean(concept && concept.source.revision === source.sourceRevision) };
  });
}

function cardHasSourceReview(view: PracticeCardView): boolean {
  return view.status === 'source-changed' || view.status === 'source-missing';
}

function cardSearchText(view: PracticeCardView, concepts: readonly Concept[]): string {
  const titles = view.card.sources.map((source) => concepts.find((concept) => concept.id === source.conceptId)?.title ?? source.conceptId);
  return [view.card.title, view.card.prompt, view.card.referenceNotes, ...titles].join(' ').toLocaleLowerCase();
}

/** A deliberately small export used by SSR tests: only the blind prompt and the learner's own answer exist here. */
export function PracticeBlindAnswer({
  prompt,
  answer,
  disabled = false,
  onAnswer,
  onSubmit,
}: {
  prompt: string;
  answer: string;
  disabled?: boolean;
  onAnswer: (value: string) => void;
  onSubmit: () => void;
}): ReactElement {
  return <section className="practice-cards-blind" aria-label="练习回答">
    <div className="practice-cards-prompt" aria-label="题干">{prompt}</div>
    <label className="practice-cards-field" htmlFor="practice-blind-answer">
      <span>你的回答</span>
      <textarea id="practice-blind-answer" maxLength={PRACTICE_ANSWER_MAX_LENGTH} value={answer} disabled={disabled} onChange={(event) => onAnswer(event.target.value)} placeholder="先用自己的话回答，再提交核对。" />
    </label>
    <button type="button" className="practice-cards-button primary" disabled={disabled} onClick={onSubmit}>提交回答</button>
  </section>;
}

function PracticeConfidence({
  value,
  disabled,
  onChange,
}: {
  value: number | null;
  disabled?: boolean;
  onChange: (value: number | null) => void;
}): ReactElement {
  return <fieldset className="practice-cards-confidence" disabled={disabled}>
    <legend>开始前的信心（可跳过）</legend>
    <div className="practice-cards-choice-row">
      {[null, 0, 25, 50, 75, 100].map((confidence) => <label key={confidence === null ? 'skip' : confidence}>
        <input type="radio" name="practice-confidence" checked={value === confidence} onChange={() => onChange(confidence)} />
        <span>{confidence === null ? '跳过' : `${confidence}%`}</span>
      </label>)}
    </div>
  </fieldset>;
}

function CardStatus({ view }: { view: PracticeCardView }): ReactElement {
  return <span className={`practice-cards-badge practice-cards-status-${view.status}`}>{STATUS_LABELS[view.status]}</span>;
}

function PracticeCardHistory({
  data,
  currentEventId,
  concepts,
  readConcept,
}: {
  data: PracticeHistoryResponse;
  currentEventId: string;
  concepts: readonly Concept[];
  readConcept: (conceptId: string) => void;
}): ReactElement {
  const attemptsByEvent = new Map<string, PracticeAttemptRequest[]>();
  for (const attempt of data.attempts) {
    const list = attemptsByEvent.get(attempt.cardEventId) ?? [];
    list.push(attempt);
    attemptsByEvent.set(attempt.cardEventId, list);
  }
  return <div className="practice-cards-history" aria-label="练习卡历史">
    <div className="practice-cards-subheading">卡片历史</div>
    {data.cards.length === 0 ? <p className="practice-cards-muted">暂无版本历史。</p> : data.cards.map((card) => {
      const current = card.eventId === currentEventId;
      const attempts = attemptsByEvent.get(card.eventId) ?? [];
      return <article key={card.eventId} className={`practice-cards-history-item${current ? ' is-current' : ' is-old'}`}>
        <div className="practice-cards-history-heading">
          <strong>{current ? '当前版本' : '旧版本'}</strong>
          <time dateTime={card.occurredAt}>{formatDate(card.occurredAt)}</time>
          {card.paused ? <span className="practice-cards-badge">已暂停</span> : null}
        </div>
        <p className="practice-cards-history-prompt">{card.prompt}</p>
        <div className="practice-cards-history-reference">
          <span>核对答案</span>
          <MarkdownView content={card.referenceAnswer} compact />
          <small>{card.referenceNotes}</small>
        </div>
        <div className="practice-cards-history-sources">
          {card.sources.map((source) => {
            const concept = concepts.find((candidate) => candidate.id === source.conceptId);
            return <button type="button" key={`${source.conceptId}:${source.sourceRevision}`} onClick={() => readConcept(source.conceptId)} disabled={!concept}>
              {concept?.title ?? `已删除来源：${source.conceptId}`} · {sourceRevisionLabel(source.sourceRevision)}
            </button>;
          })}
        </div>
        {attempts.length ? <div className="practice-cards-history-attempts">
          {attempts.map((attempt) => <div className="practice-cards-history-attempt" key={attempt.eventId}>
            <div className="practice-cards-history-meta"><span>自评：{OUTCOME_LABELS[attempt.outcome]}</span><span>提示：{CUE_LABELS[attempt.cue]}</span><time dateTime={attempt.answeredAt}>{formatDate(attempt.answeredAt)}</time></div>
            <div className="practice-cards-history-meta"><span>事前信心：{attempt.confidence === null ? '未填写' : `${attempt.confidence}%`}</span>
              <span>答题前查阅：{EXPOSURE_LABELS[attempt.exposure]}{attempt.observedExposure ? '（系统已知曝光）' : ''}</span></div>
            <p><strong>自己的回答</strong><br />{attempt.answer || '（空白回答）'}</p>
            {attempt.checkNotes ? <small>核对笔记：{attempt.checkNotes}</small> : null}
          </div>)}
        </div> : <p className="practice-cards-muted">这个版本还没有练习记录。</p>}
      </article>;
    })}
  </div>;
}

function CardEditor({
  editor,
  concepts,
  readConcepts,
  readingConceptId,
  readError,
  locked,
  canWrite,
  saving,
  onChange,
  onKindChange,
  onSourceChange,
  onAddSource,
  onRemoveSource,
  onReadSource,
  onSave,
  onCancel,
}: {
  editor: EditorState;
  concepts: readonly Concept[];
  readConcepts: Readonly<Record<string, Concept>>;
  readingConceptId: string | null;
  readError: { conceptId: string; message: string } | null;
  locked: boolean;
  canWrite: boolean;
  saving: boolean;
  onChange: <K extends keyof PracticeCardDraft>(key: K, value: PracticeCardDraft[K]) => void;
  onKindChange: (kind: PracticeKind) => void;
  onSourceChange: (index: number, conceptId: string) => void;
  onAddSource: () => void;
  onRemoveSource: (index: number) => void;
  onReadSource: (conceptId: string) => void;
  onSave: () => void;
  onCancel: () => void;
}): ReactElement {
  const { draft } = editor;
  const fieldDisabled = saving || Boolean(draft.submittedRequest) || Boolean(draft.saved);
  const sourceRows = currentSourceList(draft, concepts);
  const titleId = useId();
  const promptId = useId();
  const answerId = useId();
  const notesId = useId();
  const currentMaterialChecked = draft.sourceChecked && sourceRows.every((row) => row.current);
  return <section className="practice-cards-editor" aria-labelledby={titleId}>
    <div className="practice-cards-section-heading">
      <div><span className="practice-cards-kicker">{editor.mode === 'create' ? '新建卡片' : '修订卡片'}</span><h3 id={titleId}>{editor.mode === 'create' ? '写一张私人练习卡' : '修订当前卡片'}</h3></div>
      <button type="button" className="practice-cards-close-small" onClick={onCancel} disabled={saving} aria-label="取消编辑">×</button>
    </div>
    {draft.previousEventId ? <p className="practice-cards-notice">每次修订都会追加一个新版本；旧版本和它引用的来源版本会保留在历史中。</p> : null}
    <div className="practice-cards-kind" role="group" aria-label="卡片类型">
      {(['detail', 'comparison'] as const).map((kind) => <button key={kind} type="button" aria-pressed={draft.kind === kind} disabled={fieldDisabled} onClick={() => onKindChange(kind)}>{KIND_LABELS[kind]}</button>)}
    </div>
    <label className="practice-cards-field" htmlFor={titleId}><span>卡片标题</span><input id={titleId} maxLength={PRACTICE_TITLE_MAX_LENGTH} value={draft.title} disabled={fieldDisabled} onChange={(event) => onChange('title', event.target.value)} placeholder="例如：解释一个关键机制" /></label>
    <label className="practice-cards-field" htmlFor={promptId}><span>题干</span><textarea id={promptId} maxLength={PRACTICE_PROMPT_MAX_LENGTH} value={draft.prompt} disabled={fieldDisabled} onChange={(event) => onChange('prompt', event.target.value)} placeholder="写下练习时只给自己的问题。不要把答案写进题干。" /></label>
    <label className="practice-cards-field" htmlFor={answerId}><span>核对答案</span><textarea id={answerId} maxLength={PRACTICE_REFERENCE_MAX_LENGTH} value={draft.referenceAnswer} disabled={fieldDisabled} onChange={(event) => onChange('referenceAnswer', event.target.value)} placeholder="提交回答后显示的手工核对依据。" /></label>
    <label className="practice-cards-field" htmlFor={notesId}><span>出处 / 理由</span><textarea id={notesId} maxLength={PRACTICE_NOTES_MAX_LENGTH} value={draft.referenceNotes} disabled={fieldDisabled} onChange={(event) => onChange('referenceNotes', event.target.value)} placeholder="说明这条核对依据来自哪里，以及为什么足以支持答案。" /></label>

    <fieldset className="practice-cards-sources" disabled={fieldDisabled}>
      <legend>关联来源（{draft.kind === 'detail' ? '1 个' : '2–4 个不同来源'}）</legend>
      {sourceRows.map(({ source, concept, current }, index) => <div className="practice-cards-source-row" key={`${index}:${source.conceptId}:${source.sourceRevision}`}>
        <select aria-label={`来源 ${index + 1}`} value={source.conceptId} onChange={(event) => onSourceChange(index, event.target.value)}>
          <option value="">请选择当前概念</option>
          {!current && source.conceptId ? <option value={source.conceptId}>{concept ? `${concept.title}（旧版本，重新选择以确认当前版）` : `已删除来源：${source.conceptId}`}</option> : null}
          {concepts.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.title} · {candidate.domain}</option>)}
        </select>
        {concept ? <span className={current ? 'practice-cards-source-current' : 'practice-cards-source-old'}>{current ? `当前 ${sourceRevisionLabel(concept.source.revision)}` : `原 ${sourceRevisionLabel(source.sourceRevision)}，当前 ${sourceRevisionLabel(concept.source.revision)}`}</span> : <span className="practice-cards-source-old">来源已删除，请重新选择</span>}
        {concept ? <button type="button" className="practice-cards-link-button" onClick={() => onReadSource(concept.id)}>阅读当前资料</button> : null}
        {draft.kind === 'comparison' && draft.sources.length > 2 ? <button type="button" className="practice-cards-link-button" onClick={() => onRemoveSource(index)} aria-label={`移除来源 ${index + 1}`}>移除</button> : null}
        {concept && readConcepts[concept.id] ? <div className="practice-cards-editor-material"><strong>{readingConceptId === concept.id ? '正在读取…' : `当前资料：${readConcepts[concept.id].title} · ${sourceRevisionLabel(readConcepts[concept.id].source.revision)}`}</strong>
          <MarkdownView content={readConcepts[concept.id].body} compact source={{ sourceId: editor.originSourceId,
            conceptId: concept.id, sourceRevision: readConcepts[concept.id].source.revision }} /></div> : null}
      </div>)}
      {draft.kind === 'comparison' && draft.sources.length < 4 ? <button type="button" className="practice-cards-button secondary" onClick={onAddSource}>添加来源</button> : null}
      {draft.kind === 'comparison' && draft.sources.length === 2 ? <p className="practice-cards-muted">至少保留两个不同来源。</p> : null}
    </fieldset>
    {readError ? <p className="practice-cards-error" role="alert">{readError.message} <button type="button" className="practice-cards-link-button" onClick={() => onReadSource(readError.conceptId)}>重试读取资料</button></p> : null}
    <label className="practice-cards-confirm"><input type="checkbox" checked={currentMaterialChecked} disabled={fieldDisabled || !canWrite} onChange={(event) => onChange('sourceChecked', event.currentTarget.checked)} /><span>我已经核对当前资料，并确认上面的题干、答案和出处仍然准确。</span></label>
    {locked ? <p className="practice-cards-warning" role="alert">当前写入已锁定：{canWrite ? '仍可编辑草稿，解锁后才能保存。' : '来源空间已变化，当前冻结请求只能保留。'}</p> : null}
    {!canWrite && !locked ? <p className="practice-cards-warning" role="alert">当前资料空间已变化；请回到原空间后再保存这份冻结草稿。</p> : null}
    {draft.validationError ? <p className="practice-cards-error" role="alert">{draft.validationError}</p> : null}
    {draft.saveError ? <p className="practice-cards-error" role="alert">{draft.saveError}</p> : null}
    <div className="practice-cards-actions">
      <button type="button" className="practice-cards-button secondary" onClick={onCancel} disabled={saving}>取消</button>
      <button type="button" className="practice-cards-button primary" onClick={onSave} disabled={saving || Boolean(draft.saved) || ((!canWrite || locked) && !draft.submittedRequest) || !draft.sourceChecked}>{saving ? '保存中…' : draft.submittedRequest ? '重试保存' : '保存卡片'}</button>
    </div>
  </section>;
}

export function PracticeCardsDialog({
  sourceId,
  concepts,
  initialConceptId,
  lockedReason,
  handlers,
  wasSourceViewed,
  onSourceExposed,
  onClose,
}: PracticeCardsDialogProps): ReactElement {
  const [cards, setCards] = useState<PracticeCardsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<CardFilter>('all');
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [practice, setPractice] = useState<PracticeSessionState | null>(null);
  const [practiceOriginSourceId, setPracticeOriginSourceId] = useState<string | null>(null);
  const [attemptSaving, setAttemptSaving] = useState(false);
  const [cardSaving, setCardSaving] = useState(false);
  const [pendingCardWrite, setPendingCardWrite] = useState<PendingCardWrite | null>(null);
  const [history, setHistory] = useState<HistoryState | null>(null);
  const [readConcepts, setReadConcepts] = useState<Record<string, Concept>>({});
  const [readingConceptId, setReadingConceptId] = useState<string | null>(null);
  const [readError, setReadError] = useState<{ conceptId: string; message: string } | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const loadControllerRef = useRef<AbortController | null>(null);
  const loadRequestRef = useRef(0);
  const historyAbortRef = useRef<AbortController | null>(null);
  const historyRequestRef = useRef(0);
  const readRequestRef = useRef(0);
  const readOwnerRef = useRef('');
  const attemptSavingRef = useRef(false);
  const cardSavingRef = useRef(false);
  const exposedAttemptRef = useRef<string | null>(null);
  const exposedHistoryRef = useRef<string>('');
  const exposedEditorRef = useRef<string>('');
  const handlersRef = useRef(handlers);
  const sourceIdRef = useRef(sourceId);
  const conceptsRef = useRef(concepts);
  const onSourceExposedRef = useRef(onSourceExposed);
  handlersRef.current = handlers;
  sourceIdRef.current = sourceId;
  conceptsRef.current = concepts;
  onSourceExposedRef.current = onSourceExposed;
  const titleId = useId();

  const locked = Boolean(lockedReason);
  const canWriteOrigin = (originSourceId: string | null | undefined) => Boolean(originSourceId && originSourceId === sourceId && !locked);

  const invalidateReadRequests = () => {
    readRequestRef.current += 1;
    historyRequestRef.current += 1;
    historyAbortRef.current?.abort();
    historyAbortRef.current = null;
    readOwnerRef.current = '';
    setReadingConceptId(null);
    setReadError(null);
  };

  const refreshCards = useCallback(async (showLoading = true) => {
    loadControllerRef.current?.abort();
    const controller = new AbortController();
    const requestId = loadRequestRef.current + 1;
    loadRequestRef.current = requestId;
    loadControllerRef.current = controller;
    if (showLoading) setLoading(true);
    setLoadError(null);
    try {
      const response = await handlersRef.current.loadCards(controller.signal);
      if (controller.signal.aborted || requestId !== loadRequestRef.current || sourceIdRef.current !== sourceId) return;
      if (response.sourceId !== sourceId) throw new Error('练习卡来自另一资料空间，请刷新后重试。');
      setCards(response);
    } catch (error: unknown) {
      if (controller.signal.aborted || requestId !== loadRequestRef.current || isAbortError(error)) return;
      setLoadError(errorMessage(error, '练习卡加载失败，请重试。'));
    } finally {
      if (requestId === loadRequestRef.current) {
        setLoading(false);
        if (loadControllerRef.current === controller) loadControllerRef.current = null;
      }
    }
  }, [sourceId]);

  useEffect(() => {
    void refreshCards();
    return () => {
      loadRequestRef.current += 1;
      loadControllerRef.current?.abort();
      loadControllerRef.current = null;
      historyRequestRef.current += 1;
      historyAbortRef.current?.abort();
      historyAbortRef.current = null;
      readRequestRef.current += 1;
      readOwnerRef.current = '';
    };
  }, [refreshCards]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || typeof document === 'undefined') return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    if (!dialog.open && typeof dialog.showModal === 'function') dialog.showModal();
    else if (!dialog.open) dialog.setAttribute('open', '');
    return () => {
      if (dialog.open) dialog.close();
      else dialog.removeAttribute('open');
      document.body.style.overflow = previousOverflow;
      const previous = previousFocusRef.current;
      if (previous?.isConnected && !previous.closest('[inert]')) previous.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    invalidateReadRequests();
    setReadConcepts({});
  }, [sourceId]);

  const filteredItems = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return (cards?.items ?? []).filter((view) => {
      if (filter === 'detail' && view.card.kind !== 'detail') return false;
      if (filter === 'comparison' && view.card.kind !== 'comparison') return false;
      if (filter === 'paused' && !view.card.paused) return false;
      if (filter === 'source-review' && !cardHasSourceReview(view)) return false;
      return !query || cardSearchText(view, concepts).includes(query);
    });
  }, [cards, concepts, filter, search]);

  const notify = useCallback((sourceRefs: readonly { conceptId: string }[]) => {
    notifySources(sourceRefs, conceptsRef.current, onSourceExposedRef.current);
  }, []);

  useEffect(() => {
    if (!editor) {
      exposedEditorRef.current = '';
      return;
    }
    const key = `${editor.draft.cardId}:${editor.draft.previousEventId ?? 'new'}:${editor.draft.sources.map((source) => `${source.conceptId}:${source.sourceRevision}`).join('|')}`;
    if (exposedEditorRef.current === key) return;
    exposedEditorRef.current = key;
    notify(editor.draft.sources);
  }, [editor, notify]);

  useEffect(() => {
    if (!practice || practice.stage !== 'feedback') {
      exposedAttemptRef.current = null;
      return;
    }
    if (exposedAttemptRef.current === practice.card.eventId) return;
    exposedAttemptRef.current = practice.card.eventId;
    notify(practice.card.sources);
  }, [practice, notify]);

  useEffect(() => {
    if (!history?.data) {
      exposedHistoryRef.current = '';
      return;
    }
    const key = `${history.cardId}:${history.data.cards.map((card) => card.eventId).join('|')}`;
    if (exposedHistoryRef.current === key) return;
    exposedHistoryRef.current = key;
    for (const card of history.data.cards) notify(card.sources);
  }, [history, notify]);

  const openCreate = () => {
    invalidateReadRequests();
    setReadConcepts({});
    const initialConcept = initialConceptId ? concepts.find((concept) => concept.id === initialConceptId) : undefined;
    const draft = createPracticeCardDraft('detail', {
      originSourceId: sourceId,
      sources: initialConcept ? [{ conceptId: initialConcept.id, sourceRevision: initialConcept.source.revision }] : [],
    });
    setEditor({ mode: 'create', draft, originSourceId: sourceId });
    setPractice(null);
    setHistory(null);
  };

  const openRevision = (view: PracticeCardView) => {
    invalidateReadRequests();
    setReadConcepts({});
    setEditor({ mode: 'revise', draft: createPracticeCardDraftFromEvent(view.card, concepts, sourceId), originSourceId: sourceId });
    setPractice(null);
    setHistory(null);
  };

  const startPractice = (view: PracticeCardView) => {
    if (view.status !== 'ready' || view.card.paused) return;
    invalidateReadRequests();
    const sourceViewed = capturePracticeSourceExposure(view.card, concepts, wasSourceViewed);
    setPractice(createPracticeSessionState(view.card, sourceViewed));
    setPracticeOriginSourceId(sourceId);
    setEditor(null);
    setHistory(null);
    setReadConcepts({});
  };

  const updateEditor = <K extends keyof PracticeCardDraft>(key: K, value: PracticeCardDraft[K]) => {
    setEditor((current) => {
      if (!current || current.draft.submittedRequest || current.draft.saved) return current;
      return { ...current, draft: { ...current.draft, [key]: value, ...(key === 'sourceChecked' ? {} : { sourceChecked: key === 'paused' ? current.draft.sourceChecked : false }), validationError: null, saveError: null } };
    });
  };

  const updateEditorKind = (kind: PracticeKind) => {
    setEditor((current) => {
      if (!current || current.draft.submittedRequest || current.draft.saved || current.draft.kind === kind) return current;
      let sources = current.draft.sources;
      if (kind === 'detail') sources = sources.slice(0, 1);
      if (kind === 'comparison' && sources.length < 2) sources = [...sources, { conceptId: '', sourceRevision: '' }];
      return { ...current, draft: { ...current.draft, kind, sources, sourceChecked: false, validationError: null, saveError: null } };
    });
  };

  const updateEditorSource = (index: number, conceptId: string) => {
    setEditor((current) => {
      if (!current || current.draft.submittedRequest || current.draft.saved) return current;
      const concept = concepts.find((candidate) => candidate.id === conceptId);
      const sources = current.draft.sources.map((source, sourceIndex) => sourceIndex === index
        ? { conceptId, sourceRevision: concept?.source.revision ?? '' }
        : source);
      return { ...current, draft: { ...current.draft, sources, sourceChecked: false, validationError: null, saveError: null } };
    });
  };

  const addEditorSource = () => {
    setEditor((current) => {
      if (!current || current.draft.submittedRequest || current.draft.saved || current.draft.kind !== 'comparison' || current.draft.sources.length >= 4) return current;
      return { ...current, draft: { ...current.draft, sources: [...current.draft.sources, { conceptId: '', sourceRevision: '' }], sourceChecked: false, validationError: null, saveError: null } };
    });
  };

  const removeEditorSource = (index: number) => {
    setEditor((current) => {
      if (!current || current.draft.submittedRequest || current.draft.saved || current.draft.sources.length <= 2) return current;
      return { ...current, draft: { ...current.draft, sources: current.draft.sources.filter((_, sourceIndex) => sourceIndex !== index), sourceChecked: false, validationError: null, saveError: null } };
    });
  };

  const readConcept = async (conceptId: string) => {
    if (readingConceptId === conceptId) return;
    const concept = concepts.find((candidate) => candidate.id === conceptId);
    if (!concept) return;
    const requestId = readRequestRef.current + 1;
    const requestSourceId = sourceId;
    const owner = editor
      ? `editor:${editor.draft.cardId}`
      : practice
        ? `practice:${practice.card.eventId}`
        : history
          ? `history:${history.cardId}`
          : '';
    readRequestRef.current = requestId;
    readOwnerRef.current = owner;
    setReadError(null);
    setReadingConceptId(conceptId);
    try {
      const loaded = await handlersRef.current.readConcept(conceptId);
      if (requestId !== readRequestRef.current || sourceIdRef.current !== requestSourceId || readOwnerRef.current !== owner) return;
      setReadConcepts((current) => ({ ...current, [conceptId]: loaded }));
      onSourceExposedRef.current?.(loaded);
    } catch (error: unknown) {
      if (requestId === readRequestRef.current && sourceIdRef.current === requestSourceId && readOwnerRef.current === owner) {
        setReadError({ conceptId, message: errorMessage(error, '资料读取失败，请重试。') });
      }
    } finally {
      if (requestId === readRequestRef.current && readOwnerRef.current === owner) {
        setReadingConceptId((current) => current === conceptId ? null : current);
      }
    }
  };

  const saveEditor = async () => {
    if (!editor || cardSavingRef.current) return;
    const current = editor.draft;
    if (current.saved) return;
    if (!canWriteOrigin(editor.originSourceId) && !current.submittedRequest) return;
    let request = current.submittedRequest ?? null;
    if (!request) {
      const error = validatePracticeCardDraft(current, concepts);
      if (error) {
        setEditor((value) => value ? { ...value, draft: { ...value.draft, validationError: error } } : value);
        return;
      }
      try {
        request = buildPracticeCardRequest(current, new Date().toISOString(), newPracticeEventId());
      } catch (error: unknown) {
        setEditor((value) => value ? { ...value, draft: { ...value.draft, validationError: errorMessage(error, '请补充卡片内容。') } } : value);
        return;
      }
      setEditor((value) => value ? { ...value, draft: { ...value.draft, submittedRequest: request, validationError: null, saveError: null } } : value);
    }
    if (!request) return;
    cardSavingRef.current = true;
    setCardSaving(true);
    try {
      const saved = await handlersRef.current.saveCard(request);
      if (saved) {
        setEditor((value) => value ? { ...value, draft: { ...value.draft, submittedRequest: request, saved: true, saveError: null } } : value);
        invalidateReadRequests();
        setEditor(null);
        setHistory(null);
        await refreshCards();
      } else {
        setEditor((value) => value ? { ...value, draft: { ...value.draft, submittedRequest: request, saveError: '卡片没有确认写入，请检查连接后重试。' } } : value);
      }
    } catch (error: unknown) {
      setEditor((value) => value ? { ...value, draft: { ...value.draft, submittedRequest: request, saveError: errorMessage(error, '卡片保存失败，请重试。') } } : value);
    } finally {
      cardSavingRef.current = false;
      setCardSaving(false);
    }
  };

  const savePause = async (view: PracticeCardView, paused: boolean, retryRequest?: PracticeCardRequest) => {
    if (locked || cardSavingRef.current || sourceIdRef.current !== sourceId) return;
    const request = retryRequest ?? buildPracticeCardRevisionRequest(view.card, paused, new Date().toISOString(), newPracticeEventId());
    setPendingCardWrite({ request, cardId: view.card.cardId, error: null });
    cardSavingRef.current = true;
    setCardSaving(true);
    try {
      const saved = await handlersRef.current.saveCard(request);
      if (saved) {
        setPendingCardWrite(null);
        invalidateReadRequests();
        setHistory(null);
        await refreshCards();
      } else setPendingCardWrite({ request, cardId: view.card.cardId, error: '状态没有确认写入，请检查连接后重试。' });
    } catch (error: unknown) {
      setPendingCardWrite({ request, cardId: view.card.cardId, error: errorMessage(error, '状态保存失败，请重试。') });
    } finally {
      cardSavingRef.current = false;
      setCardSaving(false);
    }
  };

  const loadHistory = async (view: PracticeCardView) => {
    if (history?.cardId === view.card.cardId && history.data) {
      historyRequestRef.current += 1;
      historyAbortRef.current?.abort();
      historyAbortRef.current = null;
      readOwnerRef.current = '';
      setHistory(null);
      return;
    }
    historyAbortRef.current?.abort();
    const controller = new AbortController();
    const requestId = historyRequestRef.current + 1;
    const requestSourceId = sourceId;
    historyRequestRef.current = requestId;
    readOwnerRef.current = `history:${view.card.cardId}`;
    setReadError(null);
    historyAbortRef.current = controller;
    setHistory({ cardId: view.card.cardId, loading: true, error: null, data: null });
    try {
      const data = await handlersRef.current.loadHistory(view.card.cardId, controller.signal);
      if (controller.signal.aborted || requestId !== historyRequestRef.current || sourceIdRef.current !== requestSourceId || readOwnerRef.current !== `history:${view.card.cardId}`) return;
      if (data.sourceId !== requestSourceId) throw new Error('历史来自另一资料空间，请刷新后重试。');
      setHistory({ cardId: view.card.cardId, loading: false, error: null, data });
    } catch (error: unknown) {
      if (controller.signal.aborted || requestId !== historyRequestRef.current || isAbortError(error)) return;
      setHistory({ cardId: view.card.cardId, loading: false, error: errorMessage(error, '历史加载失败，请重试。'), data: null });
    } finally {
      if (requestId === historyRequestRef.current && historyAbortRef.current === controller) historyAbortRef.current = null;
    }
  };

  const submitPractice = () => {
    setPractice((current) => current ? submitPracticeAnswer(current, new Date().toISOString(), newPracticeEventId()) : current);
  };

  const savePractice = async () => {
    if (!practice || attemptSavingRef.current || practice.attemptSaved) return;
    if (!canWriteOrigin(practiceOriginSourceId) && !practice.submittedRequest) return;
    let request = practice.submittedRequest;
    if (!request) {
      try {
        request = buildPracticeAttemptRequest(practice);
      } catch (error: unknown) {
        setPractice((current) => current ? { ...current, validationError: errorMessage(error, '请补充自评后保存。') } : current);
        return;
      }
      setPractice((current) => current ? { ...current, submittedRequest: request, validationError: null, saveError: null } : current);
    }
    if (!request) return;
    attemptSavingRef.current = true;
    setAttemptSaving(true);
    try {
      const saved = await handlersRef.current.saveAttempt(request);
      if (saved) {
        setPractice((current) => current ? { ...current, submittedRequest: request, attemptSaved: true, saveError: null } : current);
        invalidateReadRequests();
        setPractice(null);
        setHistory(null);
        await refreshCards();
      } else setPractice((current) => current ? { ...current, submittedRequest: request, saveError: '练习记录没有确认写入，请检查连接后重试。' } : current);
    } catch (error: unknown) {
      setPractice((current) => current ? { ...current, submittedRequest: request, saveError: errorMessage(error, '练习记录保存失败，请重试。') } : current);
    } finally {
      attemptSavingRef.current = false;
      setAttemptSaving(false);
    }
  };

  const close = () => {
    if (attemptSaving || cardSaving) return;
    const editorDirty = editor ? hasUnsavedPracticeCardDraft(editor.draft) : false;
    const practiceDirty = practice ? hasUnsavedPracticeDraft(practice) : false;
    const pendingWrite = Boolean(pendingCardWrite);
    if ((editorDirty || practiceDirty || pendingWrite) && typeof window !== 'undefined' && typeof window.confirm === 'function'
      && !window.confirm('当前练习卡或回答尚未保存，关闭会丢弃这些输入。确定关闭吗？')) return;
    invalidateReadRequests();
    loadControllerRef.current?.abort();
    onClose();
  };

  const updatePractice = <K extends keyof PracticeSessionState>(key: K, value: PracticeSessionState[K]) => {
    setPractice((current) => {
      if (!current || current.submittedRequest || current.attemptSaved || current.stage !== 'feedback') return current;
      return { ...current, [key]: value, validationError: null, saveError: null };
    });
  };

  const renderPractice = () => {
    if (!practice) return null;
    if (practice.stage === 'predict') return <section className="practice-cards-practice" aria-labelledby={titleId}>
      <div className="practice-cards-section-heading"><div><span className="practice-cards-kicker">私人回忆</span><h3 id={titleId}>开始前先做一个预测</h3></div><button type="button" className="practice-cards-close-small" onClick={close} aria-label="退出练习">×</button></div>
      <p className="practice-cards-intro">你可以先记录自己有多大把握，也可以跳过。开始后只会看到题干和自己的回答。</p>
      <PracticeConfidence value={practice.confidence} onChange={(value) => setPractice((current) => current ? setPracticeConfidence(current, value) : current)} />
      <div className="practice-cards-actions"><button type="button" className="practice-cards-button secondary" onClick={close}>取消</button><button type="button" className="practice-cards-button primary" onClick={() => setPractice((current) => current ? startPracticeSession(current, current.confidence === null ? null : new Date().toISOString()) : current)}>开始回忆</button></div>
    </section>;
    if (practice.stage === 'answer') return <section className="practice-cards-practice" aria-labelledby={titleId}>
      <div className="practice-cards-section-heading"><div><span className="practice-cards-kicker">私人回忆 · 作答</span><h3 id={titleId}>先写下你的回答</h3></div><button type="button" className="practice-cards-close-small" onClick={close} aria-label="退出练习">×</button></div>
      <PracticeBlindAnswer prompt={practice.card.prompt} answer={practice.answer} disabled={false} onAnswer={(answer) => setPractice((current) => current && !current.submittedCore ? { ...current, answer, validationError: null } : current)} onSubmit={submitPractice} />
    </section>;
    const observedExposure = practice.submittedCore?.observedExposure === true;
    return <section className="practice-cards-practice" aria-labelledby={titleId}>
      <div className="practice-cards-section-heading"><div><span className="practice-cards-kicker">私人回忆 · 核对</span><h3 id={titleId}>核对你的回答</h3></div><button type="button" className="practice-cards-close-small" onClick={close} disabled={attemptSaving} aria-label="退出练习">×</button></div>
      <div className="practice-cards-answer-summary"><span>你的回答</span><p>{practice.submittedCore?.answer || '（空白回答）'}</p><small>回答时间：{practice.submittedCore ? formatDate(practice.submittedCore.answeredAt) : '时间未知'}{practice.submittedCore?.confidence !== null && practice.submittedCore?.confidence !== undefined ? ` · 事前信心 ${practice.submittedCore.confidence}%` : ' · 跳过事前预测'}</small></div>
      <div className="practice-cards-reference"><h4>核对依据</h4><MarkdownView content={practice.card.referenceAnswer} /><p className="practice-cards-reference-notes">{practice.card.referenceNotes}</p><div className="practice-cards-reference-sources"><span>关联资料</span>{practice.card.sources.map((source) => { const concept = concepts.find((candidate) => candidate.id === source.conceptId); return <button type="button" key={source.conceptId} disabled={!concept || readingConceptId === source.conceptId} onClick={() => void readConcept(source.conceptId)}>{readingConceptId === source.conceptId ? '读取中…' : concept ? `阅读 ${concept.title}` : `来源已删除：${source.conceptId}`}</button>; })}</div>{readError ? <p className="practice-cards-error" role="alert">{readError.message} <button type="button" className="practice-cards-link-button" onClick={() => void readConcept(readError.conceptId)}>重试读取资料</button></p> : null}</div>
      {Object.keys(readConcepts).length ? <div className="practice-cards-read-materials"><h4>已打开的资料</h4>{Object.values(readConcepts).map((concept) => <article key={concept.id}><h5>{concept.title}</h5><MarkdownView content={concept.body} source={{ sourceId, conceptId: concept.id, sourceRevision: concept.source.revision }} /></article>)}</div> : null}
      <fieldset className="practice-cards-feedback" disabled={Boolean(practice.submittedRequest) || attemptSaving}>
        <legend>这次练习的人工自评</legend>
        <label className="practice-cards-field"><span>结果</span><select value={practice.outcome} onChange={(event) => updatePractice('outcome', event.target.value as PracticeAttemptRequest['outcome'])}>{Object.entries(OUTCOME_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="practice-cards-field"><span>提示程度</span><select value={practice.cue} onChange={(event) => updatePractice('cue', event.target.value as PracticeAttemptRequest['cue'])}>{Object.entries(CUE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <fieldset className="practice-cards-exposure"><legend>提交前是否看过资料</legend>{Object.entries(EXPOSURE_LABELS).map(([value, label]) => <label key={value}><input type="radio" name={`practice-exposure-${practice.card.eventId}`} value={value} checked={practice.exposure === value} disabled={observedExposure} onChange={() => updatePractice('exposure', value as PracticeAttemptRequest['exposure'])} /><span>{label}</span></label>)}{observedExposure ? <small>系统记录到提交前已看过至少一个关联来源，因此会保留为“看过资料”。</small> : null}</fieldset>
        <label className="practice-cards-field"><span>核对笔记（可选）</span><textarea maxLength={PRACTICE_NOTES_MAX_LENGTH} value={practice.checkNotes} onChange={(event) => updatePractice('checkNotes', event.target.value)} placeholder="记录这次核对后需要记住的差异。" /></label>
      </fieldset>
      {practice.validationError ? <p className="practice-cards-error" role="alert">{practice.validationError}</p> : null}
      {practice.saveError ? <p className="practice-cards-error" role="alert">{practice.saveError}</p> : null}
      {!canWriteOrigin(practiceOriginSourceId) && !practice.submittedRequest ? <p className="practice-cards-warning" role="alert">当前资料空间已变化或写入被锁定；回答和核对结果已保留，恢复后才能保存。</p> : null}
      <div className="practice-cards-actions"><button type="button" className="practice-cards-button secondary" onClick={close} disabled={attemptSaving}>关闭</button><button type="button" className="practice-cards-button primary" onClick={() => void savePractice()} disabled={attemptSaving || practice.attemptSaved || (!canWriteOrigin(practiceOriginSourceId) && !practice.submittedRequest)}>{attemptSaving ? '保存中…' : practice.submittedRequest ? '重试保存' : '保存练习记录'}</button></div>
    </section>;
  };

  const renderList = () => <section className="practice-cards-list-view" aria-labelledby={titleId}>
    <header className="practice-cards-header"><div><span className="practice-cards-kicker">Private practice cards</span><h2 id={titleId}>私人练习卡</h2><p>手工维护问题和核对依据，练习记录独立保存，不改变时间衰减起点。</p></div><button type="button" className="practice-cards-close-small" onClick={close} disabled={loading || cardSaving} aria-label="关闭练习卡">×</button></header>
    {lockedReason ? <p className="practice-cards-lock" role="alert">当前暂不能写入练习卡：{lockedReason}。已经打开的草稿和阅读功能仍可保留。</p> : null}
    <div className="practice-cards-toolbar"><label className="practice-cards-search"><span className="sr-only">搜索练习卡</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索标题、题干或关联概念" /></label><button type="button" className="practice-cards-button primary" onClick={openCreate}>新建卡片</button></div>
    <div className="practice-cards-filters" role="group" aria-label="筛选练习卡">{(Object.keys(FILTER_LABELS) as CardFilter[]).map((value) => <button type="button" key={value} className={filter === value ? 'is-active' : ''} aria-pressed={filter === value} onClick={() => setFilter(value)}>{FILTER_LABELS[value]}</button>)}</div>
    {pendingCardWrite?.error ? <p className="practice-cards-error" role="alert">{pendingCardWrite.error} <button type="button" className="practice-cards-link-button" onClick={() => { const view = cards?.items.find((item) => item.card.cardId === pendingCardWrite.cardId); if (view) void savePause(view, !view.card.paused, pendingCardWrite.request); }}>重试原请求</button></p> : null}
    {readError ? <p className="practice-cards-error" role="alert">{readError.message} <button type="button" className="practice-cards-link-button" onClick={() => void readConcept(readError.conceptId)}>重试读取资料</button></p> : null}
    {loading ? <div className="practice-cards-loading" role="status"><span>正在加载练习卡…</span><button type="button" className="practice-cards-button secondary" onClick={() => { loadRequestRef.current += 1; loadControllerRef.current?.abort(); loadControllerRef.current = null; setLoading(false); }}>取消加载</button></div> : loadError ? <div className="practice-cards-error" role="alert"><span>{loadError}</span><button type="button" className="practice-cards-button secondary" onClick={() => void refreshCards()}>重试</button></div> : filteredItems.length === 0 ? <div className="practice-cards-empty"><strong>没有符合条件的练习卡</strong><p>可以新建一张卡，或清除筛选和搜索条件。</p></div> : <div className="practice-cards-items">{filteredItems.map((view) => <article key={view.card.cardId} className="practice-cards-item">
      <div className="practice-cards-item-heading"><div><span className="practice-cards-kind-label">{KIND_LABELS[view.card.kind]}</span><h3>{view.card.title}</h3></div><CardStatus view={view} /></div>
      <p className="practice-cards-item-prompt">{view.card.prompt}</p>
      <div className="practice-cards-item-meta"><span>{view.card.sources.length} 个来源</span><span>当前版本 {sourceRevisionLabel(view.card.eventId)}</span>{view.latest ? <span>最近自评：{OUTCOME_LABELS[view.latest.outcome]}</span> : <span>尚无练习记录</span>}</div>
      {cardHasSourceReview(view) ? <p className="practice-cards-warning">来源版本变化或来源已删除。请阅读当前资料并修订后才能开始练习；旧题目不会自动替换来源版本。</p> : null}
      <div className="practice-cards-item-actions"><button type="button" className="practice-cards-button primary" disabled={view.status !== 'ready' || view.card.paused} onClick={() => startPractice(view)}>{view.card.paused ? '已暂停' : '开始练习'}</button><button type="button" className="practice-cards-button secondary" disabled={Boolean(pendingCardWrite)} onClick={() => openRevision(view)}>修订</button>{view.status === 'ready' || view.status === 'paused' ? <button type="button" className="practice-cards-button secondary" disabled={locked || cardSaving || Boolean(pendingCardWrite)} onClick={() => void savePause(view, !view.card.paused)}>{view.card.paused ? '恢复' : '暂停'}</button> : null}<button type="button" className="practice-cards-link-button" onClick={() => void loadHistory(view)}>{history?.cardId === view.card.cardId && history.data ? '收起历史' : '查看历史'}</button></div>
      {history?.cardId === view.card.cardId ? <div>{history.loading ? <p className="practice-cards-muted" role="status">正在加载历史…</p> : history.error ? <p className="practice-cards-error" role="alert">{history.error} <button type="button" className="practice-cards-link-button" onClick={() => void loadHistory(view)}>重试</button></p> : history.data ? <PracticeCardHistory data={history.data} currentEventId={view.card.eventId} concepts={concepts} readConcept={(conceptId) => void readConcept(conceptId)} /> : null}</div> : null}
    </article>)}</div>}
    <footer className="practice-cards-footer"><span>{cards ? `共 ${cards.items.length} 张卡片` : '正在读取卡片列表'}</span><button type="button" className="practice-cards-button secondary" onClick={close} disabled={loading || cardSaving}>关闭</button></footer>
  </section>;

  return <dialog ref={dialogRef} className="practice-cards-dialog" aria-modal="true" aria-label="细节与概念辨别练习" onCancel={(event) => { event.preventDefault(); close(); }}>
    <div className="practice-cards-shell">
      {editor ? <CardEditor editor={editor} concepts={concepts} readConcepts={readConcepts} readingConceptId={readingConceptId} readError={readError} locked={locked} canWrite={canWriteOrigin(editor.originSourceId) || Boolean(editor.draft.submittedRequest)} saving={cardSaving} onChange={updateEditor} onKindChange={updateEditorKind} onSourceChange={updateEditorSource} onAddSource={addEditorSource} onRemoveSource={removeEditorSource} onReadSource={(conceptId) => void readConcept(conceptId)} onSave={() => void saveEditor()} onCancel={() => { if (!hasUnsavedPracticeCardDraft(editor.draft) || typeof window === 'undefined' || window.confirm('当前卡片草稿尚未保存，确定取消吗？')) setEditor(null); }} /> : practice ? renderPractice() : renderList()}
    </div>
  </dialog>;
}

export default PracticeCardsDialog;
export const PracticeCardsPanel = PracticeCardsDialog;
