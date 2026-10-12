import { useEffect, useId, useRef, useState } from 'react';
import type { ApplicationRecord } from '../shared/types';
import { relationReviewMatches, type RelationReviewBasis, type RelationReviewRequest, type RelationReviewResponse } from '../shared/relation-reviews';
import { buildRelationReviewRequest, relationReviewBasisEqual, relationReviewResponseMatches, relationReviewSubmissionMode, relationReviewCanRebase } from './relation-review';

export type SaveRelationReview = (payload: RelationReviewRequest) => Promise<{ ok: boolean; queued?: boolean; error?: string; errorCode?: string }>;
export interface ApplicationRelationReviewPanelProps {
  application: ApplicationRecord;
  sourceId: string;
  refreshKey: string;
  loadReview: (applicationEventId: string, sourceId: string, signal: AbortSignal) => Promise<RelationReviewResponse>;
  onSave?: SaveRelationReview;
  disabled: boolean;
  pending: boolean;
  onEditingChange?: (editing: boolean) => void;
  onRefreshHistory?: () => void;
}
const LABELS = { open: '待处理', resolved: '人工确认已采纳', dismissed: '暂不采用' };
const presence = (value: boolean | null) => value === null ? '未知 / 不适用' : value ? '存在' : '不存在';

/** Shared with history rendering: this displays the saved basis without recomputing it. */
export function RelationReviewBasisPreview({ basis, label }: { basis: RelationReviewBasis; label: string }) {
  return <section className="relation-review-basis" aria-label={label}>
    <strong>{label}</strong>
    <dl>{(['source', 'target'] as const).map((side) => <div key={side} style={{ display: 'contents' }}>
      <dt>{side === 'source' ? '源概念' : '目标概念'}</dt>
      <dd>{basis[side].conceptId}{basis[side].current ? <><br />{basis[side].current.title}<br />路径：{basis[side].current.path}<br />版本：{basis[side].current.sourceRevision}</> : <><br />当前知识源中缺失</>}</dd>
    </div>)}<dt>原精确关系</dt><dd>{presence(basis.beforePresent)}</dd><dt>建议精确关系</dt><dd>{presence(basis.afterPresent)}</dd></dl>
  </section>;
}

export function ApplicationRelationReviewPanel({ application, sourceId, refreshKey, loadReview, onSave, disabled, pending, onEditingChange, onRefreshHistory }: ApplicationRelationReviewPanelProps) {
  const labelId = useId();
  const noteLabelId = useId();
  const [response, setResponse] = useState<RelationReviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [decision, setDecision] = useState<RelationReviewRequest['status']>('open');
  const [note, setNote] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [draftBasis, setDraftBasis] = useState<RelationReviewBasis | null>(null);
  const [draftPrevious, setDraftPrevious] = useState<string | null>(null);
  const [frozen, setFrozen] = useState<RelationReviewRequest | null>(null);
  const [state, setState] = useState<'idle' | 'saving' | 'failed' | 'accepted' | 'queued'>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveErrorCode, setSaveErrorCode] = useState<string | undefined>();
  const [dirty, setDirty] = useState(false);
  const callback = useRef(onEditingChange);
  const mounted = useRef(true);
  const draftRef = useRef({ dirty, frozen });
  const recheckingDraft = useRef(false);
  const frozenScope = useRef<string | null>(null);
  draftRef.current = { dirty, frozen };
  callback.current = onEditingChange;
  const requestKey = `${sourceId}\u0000${application.eventId}\u0000${application.conceptId}`;
  const latestKey = useRef(requestKey);
  latestKey.current = requestKey;
  const suggestion = application.relationSuggestion;
  const validResponse = response && relationReviewResponseMatches(response, application, sourceId) ? response : null;
  const latest = validResponse?.history.latest ?? null;
  const stale = Boolean(validResponse && draftBasis && (!relationReviewBasisEqual(draftBasis, validResponse.basis) || draftPrevious !== (latest?.eventId ?? null)));
  const matching = Boolean(suggestion && validResponse && relationReviewMatches(suggestion, validResponse.basis));
  const locked = disabled || pending || state === 'saving' || state === 'accepted' || state === 'queued';
  const editing = dirty || state === 'saving' || state === 'failed';
  const submissionMode = relationReviewSubmissionMode({ locked, available: Boolean(onSave), hasFrozen: Boolean(frozen),
    frozenInScope: frozenScope.current === requestKey && frozen?.applicationEventId === application.eventId && frozen?.conceptId === application.conceptId,
    currentAvailable: Boolean(validResponse) && !loading && !loadError, stale, decision, matching, confirmed });

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    setResponse(null); setDecision('open'); setNote(''); setConfirmed(false); setDraftBasis(null);
    setDraftPrevious(null); setFrozen(null); setState('idle'); setSaveError(null); setDirty(false);
    recheckingDraft.current = false;
    frozenScope.current = null;
    draftRef.current = { dirty: false, frozen: null };
  }, [requestKey]);
  useEffect(() => { callback.current?.(editing); return () => callback.current?.(false); }, [editing, requestKey]);
  useEffect(() => {
    if (!suggestion) return;
    const controller = new AbortController();
    const key = requestKey;
    setLoading(true); setLoadError(null);
    void loadReview(application.eventId, sourceId, controller.signal).then((next) => {
      if (controller.signal.aborted || latestKey.current !== key) return;
      if (!relationReviewResponseMatches(next, application, sourceId)) throw new Error('关系核对响应与当前记录不匹配，请重新核对。');
      setResponse(next);
      if (recheckingDraft.current) {
        recheckingDraft.current = false;
        setDraftBasis(structuredClone(next.basis)); setDraftPrevious(next.history.latest?.eventId ?? null);
        setDirty(true); setConfirmed(false);
        return;
      }
      const acknowledged = draftRef.current.frozen && next.history.events.some((event) => event.eventId === draftRef.current.frozen?.eventId);
      if (acknowledged || (!draftRef.current.dirty && !draftRef.current.frozen)) {
        setDecision(next.history.latest?.status ?? 'open'); setNote(next.history.latest?.note ?? '');
        setConfirmed(false); setDirty(false); setDraftBasis(null); setFrozen(null); setState('idle'); setSaveError(null);
      }
    }).catch((error: unknown) => {
      if (!controller.signal.aborted && latestKey.current === key) setLoadError(error instanceof Error ? error.message : '关系核对暂不可用。');
    }).finally(() => { if (!controller.signal.aborted && latestKey.current === key) setLoading(false); });
    return () => controller.abort();
  }, [application.eventId, application.conceptId, sourceId, refreshKey, reload, loadReview, requestKey, suggestion]);

  function beginEdit() {
    if (!dirty && validResponse) { setDraftBasis(structuredClone(validResponse.basis)); setDraftPrevious(latest?.eventId ?? null); }
    setDirty(true);
  }
  function recheck() {
    if (loading) return;
    if ((frozen && !relationReviewCanRebase(saveErrorCode)) || locked) { setReload((value) => value + 1); return; }
    // The person explicitly abandons the previous submission basis, retaining prose.
    setFrozen(null); setState('idle'); setSaveError(null); setSaveErrorCode(undefined); setConfirmed(false);
    recheckingDraft.current = dirty || Boolean(frozen);
    setDraftBasis(null); setReload((value) => value + 1);
  }
  async function submit() {
    if (!onSave || submissionMode === 'blocked') return;
    const payload = frozen ?? buildRelationReviewRequest(application, draftBasis ?? validResponse!.basis, dirty ? draftPrevious : latest?.eventId ?? null, decision, note);
    frozenScope.current = requestKey;
    setFrozen(payload); setState('saving'); setSaveError(null); setSaveErrorCode(undefined); setDirty(true);
    const key = requestKey;
    try {
      const result = await onSave(payload);
      if (!mounted.current || latestKey.current !== key) return;
      if (result.queued) { setState('queued'); setDirty(false); setSaveError(result.error ?? null); }
      else if (result.ok) { setState('accepted'); setDirty(false); setReload((value) => value + 1); onRefreshHistory?.(); }
      else { setState('failed'); setSaveError(result.error ?? '保存未完成，请重试原记录。'); setSaveErrorCode(result.errorCode); }
    } catch (error: unknown) {
      if (mounted.current && latestKey.current === key) { setState('failed'); setSaveError(error instanceof Error ? error.message : '保存未完成，请重试原记录。'); }
    }
  }
  if (!suggestion) return null;
  const controlsLocked = locked || Boolean(frozen) || loading || Boolean(loadError) || !validResponse;
  const lastBasisChanged = Boolean(latest && validResponse && !relationReviewBasisEqual(latest.basis, validResponse.basis));
  return <section className="application-relation-review" aria-label="关系建议复核">
    <h4>关系建议复核：{latest ? LABELS[latest.status] : validResponse ? '待人工处理' : '核对结果尚不可用'}</h4>
    <p className="relation-review-help">原始建议及方向见上方快照。这里只记录人工决定，不修改知识源、学习表现或记忆时间。</p>
    {loading ? <p role="status">正在核对当前双端点与精确关系…</p> : null}
    {loadError ? <p className="relation-review-error" role="alert">{loadError}；已有决定保持不变。</p> : null}
    {validResponse ? <><RelationReviewBasisPreview basis={validResponse.basis} label="当前知识源核对依据" />
      <p className="relation-review-help">结构核对：{validResponse.basis.source.current && validResponse.basis.target.current ? matching ? '符合建议结果' : '不符合建议结果' : '未知'}。此提示不替代人工确认。</p></> : null}
    {lastBasisChanged ? <p className="relation-review-warning" role="status">上次决定的依据已变化，保留原决定；请重新核对当前知识源。</p> : null}
    {stale ? <p className="relation-review-warning" role="status">{frozen ? '当前依据或决定链已变化；原请求保留，仍可原样重试以确认保存结果。' : '草稿期间知识源依据或决定链已变化；草稿保留，请点击“重新核对当前状态”后再确认。'}</p> : null}
    {pending || state === 'queued' ? <p role="status">关系决定待同步，原记录已保留，同步并刷新历史前不能重复提交。</p> : null}
    {state === 'accepted' ? <p role="status">已提交，等待服务历史确认。</p> : null}
    <label className="relation-review-field"><span id={labelId}>关系处理决定</span><select aria-labelledby={labelId} value={decision} disabled={controlsLocked} onChange={(event) => { beginEdit(); setDecision(event.target.value as RelationReviewRequest['status']); setConfirmed(false); }}>
      <option value="open">待处理 / 重新打开</option><option value="resolved">人工确认已采纳</option><option value="dismissed">暂不采用</option>
    </select></label>
    {decision === 'resolved' ? <><label className="relation-review-check"><input type="checkbox" checked={confirmed} disabled={controlsLocked || !matching} onChange={(event) => { beginEdit(); setConfirmed(event.target.checked); }} /><span>我已核对当前知识源，确认该关系建议已采纳</span></label>{!matching ? <p className="relation-review-warning">当前精确关系未符合建议结果或端点缺失，暂不能确认采纳。</p> : null}</> : null}
    <label className="relation-review-field"><span id={noteLabelId}>关系处理说明（可选）</span><textarea aria-labelledby={noteLabelId} rows={3} maxLength={4000} value={note} disabled={controlsLocked} onChange={(event) => { beginEdit(); setNote(event.target.value); }} /></label>
    {saveError ? <p className="relation-review-error" role="alert">{saveError}</p> : null}
    {!onSave ? <p className="relation-review-help">未连接关系决定保存服务。</p> : null}
    <div className="relation-review-actions"><button type="button" onClick={() => void submit()} disabled={submissionMode === 'blocked'}>{state === 'saving' ? '保存中…' : state === 'failed' ? '重试原关系决定' : '保存关系决定'}</button>
      <button type="button" disabled={loading} onClick={recheck}>{!locked && ((!frozen && (dirty || stale)) || relationReviewCanRebase(saveErrorCode)) ? '重新核对当前状态' : '刷新关系核对'}</button>
    </div>
    {state === 'failed' ? <p className="relation-review-help">{relationReviewCanRebase(saveErrorCode) ? '服务已明确拒绝本次依据或前序事件；可重新核对当前状态，保留说明并创建新的决定。' : '保存结果尚未确认；重试沿用原ID、时间、前序事件和核对依据。刷新仅重新读取，不丢弃原请求。'}</p> : null}
    {validResponse?.history.events.length ? <><p className="relation-review-help">关系处理记录（显示 {validResponse.history.events.length} / {validResponse.history.total} 条）</p><ol className="relation-review-history">{validResponse.history.events.map((event) => <li key={event.eventId}><strong>人工决定：{LABELS[event.status]}</strong><time dateTime={event.occurredAt}>发生于 {event.occurredAt}；保存于 {event.recordedAt}</time>{event.note ? <p>{event.note}</p> : null}<RelationReviewBasisPreview basis={event.basis} label="作出决定时的冻结依据" /></li>)}</ol></> : null}
  </section>;
}
