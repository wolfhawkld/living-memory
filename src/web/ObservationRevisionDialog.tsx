import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Observation } from '../shared/types';
import { assessmentFromObservation, observationAssessmentsEqual, observationRevisionRequestEqual, parseObservationRevisionRequest,
  type ObservationAssessment, type ObservationRevisionRequest, type ObservationRevisionReason } from '../shared/observation-revisions';
import type { ObservationRevisionHistory, ObservationRevisionReceipt } from '../shared/observation-revision-history';
import type { ObservationRevisionPendingRow } from './observation-revision-pending';
import { createObservationRevisionHistoryLoader, type RevisionHistoryLoader } from './observation-revision-history-loader';
export type RevisionSubmitResult = { status: 'confirmed'; receipt: ObservationRevisionReceipt; cleanupPending: boolean }
  | { status: 'queued' | 'rejected' | 'blocked'; persisted: true; message: string }
  | { status: 'not-saved'; persisted: false; message: string; outcomeUnknown?: true } | { status: 'context-changed' };
export interface RevisionPersistenceState { durable: boolean; uncertain: boolean; }
export function revisionPersistenceAfterResult(current: RevisionPersistenceState, result: RevisionSubmitResult | 'unexpected-error'): RevisionPersistenceState {
  if (result === 'unexpected-error') return { ...current, uncertain: true };
  if (result.status === 'context-changed') return current;
  if (result.status === 'not-saved') return result.outcomeUnknown ? { ...current, uncertain: true } : current;
  return { durable: true, uncertain: false };
}
export interface ObservationRevisionDialogProps {
  scopeKey: string; observation: Observation; disabledReason: string | null; pendingRow?: ObservationRevisionPendingRow | null;
  loadHistory: RevisionHistoryLoader; onSubmit(request: ObservationRevisionRequest): Promise<RevisionSubmitResult>;
  onRetryPending(expectedRequest: ObservationRevisionRequest): Promise<RevisionSubmitResult>; onRecheckRejected(expectedRow: ObservationRevisionPendingRow): Promise<boolean>;
  onRevealAnswer(): void; onClose(): void; onDirtyChange?(dirty: boolean): void;
}
export function revisionPendingRelation(frozen: ObservationRevisionRequest | null, row: ObservationRevisionPendingRow | null | undefined): 'own' | 'foreign' | 'none' {
  if (!row || row.state === 'archived') return 'none';
  try { return frozen && frozen.eventId === row.request.eventId && observationRevisionRequestEqual(frozen, row.request) ? 'own' : 'foreign'; }
  catch { return 'foreign'; }
}
export interface RevisionDraft { action: 'revise' | 'withdraw' | 'reinstate'; assessment: ObservationAssessment; reason: ObservationRevisionReason | ''; note: string; }
export function initialRevisionDraft(history: ObservationRevisionHistory): RevisionDraft {
  return { action: history.state.status === 'withdrawn' ? 'reinstate' : 'revise', assessment: structuredClone(history.state.currentAssessment), reason: '', note: '' };
}
export function revisionDraftDisabledReason(parent: Observation, history: ObservationRevisionHistory | null, draft: RevisionDraft | null, now = new Date().toISOString()): string | null {
  if (!history || !draft) return '请先成功加载当前修订状态。';
  if (!draft.reason) return '请选择本次决定的原因。';
  if (draft.note.length > 1000) return '说明不能超过 1000 个字符。';
  if (draft.action === 'reinstate' ? history.state.status !== 'withdrawn' : history.state.status !== 'active') return '当前采用状态已变化，请重新核对。';
  if (draft.action === 'revise' && Boolean(draft.assessment.learning) !== Boolean(parent.learning)) return '扩展判断必须保持原观察的字段结构。';
  if (draft.action === 'revise' && draft.assessment.learning && draft.assessment.learning.outcome !== 'unverified' && draft.assessment.learning.basis === 'unknown') return '核对结果需要明确的核对依据。';
  if (draft.action === 'revise') {
    try { if (observationAssessmentsEqual(draft.assessment, history.state.currentAssessment)) return '本次判断与当前采用判断相同。'; }
    catch { return '本次判断字段尚未完整，请核对自评、结果与依据。'; }
  }
  const tail = history.events.find(event => event.eventId === history.state.latestRevisionEventId);
  if (history.state.latestRevisionEventId && !tail) return '最新决定尚未完整核验，请重新读取状态。';
  if (!Number.isFinite(Date.parse(now)) || Date.parse(now) < Date.parse(parent.observedAt) || (tail && Date.parse(now) < Date.parse(tail.occurredAt))) return '本机时间早于原观察或上一决定，请校准时间后重试。';
  return null;
}
export function freezeRevisionDraft(parent: Observation, history: ObservationRevisionHistory, draft: RevisionDraft, eventId: string, now: string): ObservationRevisionRequest {
  const blocked = revisionDraftDisabledReason(parent, history, draft, now); if (blocked) throw new Error(blocked);
  return parseObservationRevisionRequest({ eventId, observationEventId: parent.eventId, previousEventId: history.state.latestRevisionEventId,
    occurredAt: now, action: draft.action, reason: draft.reason, ...(draft.note ? { note: draft.note } : {}),
    ...(draft.action === 'revise' ? { assessment: draft.assessment } : {}) });
}
const ratingLabels = { clear: '能解释', partial: '有些模糊', blank: '想不起' };
const outcomeLabels = { success: '成功', partial: '部分成功', failure: '未成功', unverified: '未核对' };
const basisLabels = { 'self-check': '自己对照资料', application: '实际应用核对', unknown: '依据未记录' };
const reasons = { 'input-error': '误点或输入错误', 'rechecked-original': '重新核对原记录', 'unreliable-evidence': '证据不可靠', other: '其他原因' };
const actions = { revise: '更正自评', withdraw: '暂不计入统计', reinstate: '恢复采用' };
function Assessment({ value }: { value: ObservationAssessment }) {
  return <><p>{ratingLabels[value.rating]}</p>{value.learning ? <p>{outcomeLabels[value.learning.outcome]} · {basisLabels[value.learning.basis]}</p> : <p>原记录无扩展核对结果</p>}</>;
}
export function RevisionJudgmentFields({ draft, status, disabled, idPrefix, onEdit }: {
  draft: RevisionDraft; status: 'active' | 'withdrawn'; disabled: boolean; idPrefix: string; onEdit(next: Partial<RevisionDraft>): void;
}) {
  return <>
    <label htmlFor={`${idPrefix}-action`}>操作</label><select id={`${idPrefix}-action`} disabled={disabled} value={draft.action} onChange={event => onEdit({ action: event.target.value as RevisionDraft['action'] })}>{Object.entries(actions).map(([value, text]) => <option key={value} value={value} disabled={value === 'reinstate' ? status !== 'withdrawn' : status !== 'active'}>{text}</option>)}</select>
    {draft.action === 'revise' ? <>
      <label htmlFor={`${idPrefix}-rating`}>自评</label><select id={`${idPrefix}-rating`} disabled={disabled} value={draft.assessment.rating} onChange={event => onEdit({ assessment: { ...draft.assessment, rating: event.target.value as ObservationAssessment['rating'] } })}>{Object.entries(ratingLabels).map(([v, text]) => <option key={v} value={v}>{text}</option>)}</select>
      {draft.assessment.learning ? <>
        <label htmlFor={`${idPrefix}-outcome`}>核对结果</label><select id={`${idPrefix}-outcome`} disabled={disabled} value={draft.assessment.learning.outcome} onChange={event => onEdit({ assessment: { ...draft.assessment, learning: { ...draft.assessment.learning!, outcome: event.target.value as NonNullable<ObservationAssessment['learning']>['outcome'] } } })}>{Object.entries(outcomeLabels).map(([v, text]) => <option key={v} value={v}>{text}</option>)}</select>
        <label htmlFor={`${idPrefix}-basis`}>核对依据</label><select id={`${idPrefix}-basis`} disabled={disabled} value={draft.assessment.learning.basis} onChange={event => onEdit({ assessment: { ...draft.assessment, learning: { ...draft.assessment.learning!, basis: event.target.value as NonNullable<ObservationAssessment['learning']>['basis'] } } })}>{Object.entries(basisLabels).map(([v, text]) => <option key={v} value={v}>{text}</option>)}</select>
      </> : <p>原记录未保存扩展核对结果，不新增该项。</p>}
    </> : <p>{draft.action === 'withdraw' ? '保留原记录，暂不作为有效样本。' : '恢复撤回前最后采用的判断，不新增练习。'}</p>}
  </>;
}
export function ObservationRevisionDialog(props: ObservationRevisionDialogProps) {
  // A keyed inner lifetime also isolates a parent change before effects run.
  return <RevisionDialog key={JSON.stringify([props.scopeKey, props.observation.eventId, props.observation.conceptId, props.observation.sourceRevision])} {...props} disabledReason={props.disabledReason ?? (props.pendingRow && props.pendingRow.request.observationEventId !== props.observation.eventId ? '待同步决定与原观察不匹配，不能操作。' : null)} pendingRow={props.pendingRow?.state === 'archived' ? null : props.pendingRow} />;
}
function RevisionDialog({ observation, disabledReason, pendingRow, loadHistory, onSubmit, onRetryPending, onRecheckRejected, onRevealAnswer, onClose, onDirtyChange }: ObservationRevisionDialogProps) {
  const titleId = useId(); const dialogRef = useRef<HTMLDialogElement>(null);
  const fetchRef = useRef(loadHistory); fetchRef.current = loadHistory;
  const loader = useMemo(() => createObservationRevisionHistoryLoader(observation, options => fetchRef.current(options)), [observation.eventId, observation.conceptId, observation.sourceRevision]);
  const state = useSyncExternalStore(loader.subscribe, loader.getSnapshot, loader.getSnapshot);
  const [draft, setDraft] = useState<RevisionDraft | null>(null); const [baseTail, setBaseTail] = useState<string | null>(pendingRow?.request.previousEventId ?? null);
  const [baseTotal, setBaseTotal] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false); const [stale, setStale] = useState(false);
  const [frozen, setFrozen] = useState<ObservationRevisionRequest | null>(pendingRow?.request ?? null);
  const pendingRelation = revisionPendingRelation(frozen, pendingRow);
  const ownPendingRow = pendingRelation === 'own' ? pendingRow : null;
  const foreignPending = pendingRelation === 'foreign';
  const [persistence, setPersistence] = useState<RevisionPersistenceState>({ durable: Boolean(pendingRow), uncertain: false });
  const { durable, uncertain } = persistence; const [busy, setBusy] = useState(false);
  const [contextInvalid, setContextInvalid] = useState(false);
  const [cleanupPending, setCleanupPending] = useState(false);
  const [confirmed, setConfirmed] = useState(false); const [message, setMessage] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false); const lock = useRef(false); const live = useRef(true);
  const dirtyCallback = useRef(onDirtyChange); dirtyCallback.current = onDirtyChange;
  useEffect(() => { live.current = true; loader.activate(); void loader.refresh(); return () => { live.current = false; loader.dispose(); }; }, [loader]);
  useEffect(() => {
    const dialog = dialogRef.current; if (!dialog) return;
    const focus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow; document.body.style.overflow = 'hidden'; dialog.showModal();
    return () => { if (dialog.open) dialog.close(); document.body.style.overflow = overflow; if (focus?.isConnected && !focus.closest('[inert]')) focus.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => { dirtyCallback.current?.(dirty && !durable); return () => dirtyCallback.current?.(false); }, [dirty, durable]);
  useEffect(() => { if (pendingRelation === 'own') setPersistence(current => ({ ...current, durable: true })); }, [pendingRelation]);
  useEffect(() => {
    if (!state.history) return;
    if (!draft && frozen) {
      setDraft({ ...initialRevisionDraft(state.history), action: frozen.action, reason: frozen.reason, note: frozen.note ?? '',
        ...(frozen.action === 'revise' ? { assessment: frozen.assessment } : {}) });
    }
    if (dirty || frozen) { if (baseTail !== state.history.state.latestRevisionEventId || (baseTotal !== null && baseTotal !== state.history.total)) setStale(true); }
    else if (!draft || baseTail !== state.history.state.latestRevisionEventId || baseTotal !== state.history.total) { setDraft(initialRevisionDraft(state.history)); setBaseTail(state.history.state.latestRevisionEventId); setBaseTotal(state.history.total); }
  }, [state.history, dirty, frozen, baseTail, baseTotal, draft]);
  function close() { if (lock.current) return; if (dirty && !durable && !window.confirm(uncertain ? '服务结果尚未确认，关闭可能丢失本页的固定请求。确定关闭吗？' : '这份修订尚未保存，关闭会丢弃草稿。确定关闭吗？')) return; onClose(); }
  function edit(next: Partial<RevisionDraft>) { if (!draft || busy || frozen || durable) return; setDirty(true); setDraft({ ...draft, ...next }); }
  async function refreshConfirmed() {
    const history = await loader.refresh(); if (!live.current) return;
    setMessage(history ? '已保存，当前采用状态已刷新。' : '已保存，状态刷新失败；请只重读状态，无需再次提交。');
  }
  async function handleResult(result: RevisionSubmitResult) {
    if (!live.current) return;
    setPersistence(current => revisionPersistenceAfterResult(current, result));
    if (result.status === 'context-changed') { setContextInvalid(true); setMessage('账号、知识源或实例已变化，请关闭后在原空间查看。'); return; }
    if (result.status === 'confirmed') {
      setCleanupPending(result.cleanupPending); setConfirmed(true); setDirty(false); setFrozen(null);
      setMessage(result.cleanupPending ? '已保存；本地回执仍待清理。' : '已保存，正在刷新状态。'); await refreshConfirmed();
    } else { setMessage(result.message); }
  }
  async function submit(retryPending = false) {
    if (lock.current || disabledReason || foreignPending || contextInvalid || confirmed) return;
    if (!retryPending && !frozen && (stale || durable || state.loading || state.error || revisionDraftDisabledReason(observation, state.history, draft))) return;
    lock.current = true; setBusy(true);
    try {
      if (retryPending) { if (!frozen || !ownPendingRow) return; await handleResult(await onRetryPending(frozen)); }
      else {
        const request = frozen ?? freezeRevisionDraft(observation, state.history!, draft!, `observation-revision:${crypto.randomUUID()}`, new Date().toISOString());
        setFrozen(request); setDirty(true); await handleResult(await onSubmit(request));
      }
    } catch { if (live.current) { setPersistence(current => revisionPersistenceAfterResult(current, 'unexpected-error')); setMessage('提交结果尚未确认，请保留原请求并原样重试，不要另建决定。'); } }
    finally { lock.current = false; if (live.current) setBusy(false); }
  }
  async function recheck() {
    if (lock.current || disabledReason || uncertain || foreignPending || contextInvalid || confirmed || (ownPendingRow && ownPendingRow.state !== 'rejected') || (durable && !ownPendingRow)) return;
    lock.current = true; setBusy(true);
    try {
      const fresh = await loader.refresh(); if (!fresh || !live.current) return;
      if (ownPendingRow && !await onRecheckRejected(ownPendingRow)) { if (live.current) setMessage('待同步记录已变化，未解除原请求，请重新打开。'); return; }
      if (!live.current) return;
      setFrozen(null); setPersistence({ durable: false, uncertain: false }); setStale(false); setDirty(false); setDraft(initialRevisionDraft(fresh)); setBaseTail(fresh.state.latestRevisionEventId); setBaseTotal(fresh.total);
      setMessage('已重新核对。请重新选择原因，确认后才会提交新的决定。');
    } catch { if (live.current) setMessage('重新核对未完成，原请求保持不变。'); }
    finally { lock.current = false; if (live.current) setBusy(false); }
  }
  const controlsLocked = foreignPending || contextInvalid || busy || Boolean(disabledReason) || durable || Boolean(frozen) || confirmed || stale || state.loading || Boolean(state.error) || !state.history;
  const blocked = (foreignPending ? '另一窗口已有同一原观察的待同步决定；请关闭后从独立待同步区先处理。当前草稿保持原样。' : null) || (contextInvalid ? '原操作空间已变化，请关闭后重新打开。' : null) || disabledReason || (stale ? '决定链已变化，请明确重新核对当前状态。' : state.error || revisionDraftDisabledReason(observation, state.history, draft));
  return <dialog ref={dialogRef} className="observation-revision-dialog" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); close(); }}>
    <header><h2 id={titleId}>修订已保存的学习观察</h2><button type="button" disabled={busy} onClick={close} aria-label="关闭修订">×</button></header>
    <div className="observation-revision-scroll">
      <p>原观察 {observation.eventId} · 原资料版本 {observation.sourceRevision}</p>
      <p>只更正采用的判断；原回答、提示条件、重温起点、H 与长期保持不变。</p>
      <div className="observation-revision-columns">
        <section><h3>原始判断</h3><Assessment value={assessmentFromObservation(observation)} /></section>
        <section><h3>{state.error ? '上次核验的采用判断（刷新失败）' : '当前采用'}</h3>{state.history ? <><p>{state.history.state.status === 'withdrawn' ? '暂不计入统计' : '采用中'}</p><Assessment value={state.history.state.currentAssessment} /></> : <p>尚未核验</p>}</section>
        <section><h3>本次判断</h3>{draft ? <RevisionJudgmentFields draft={draft} status={state.history?.state.status ?? 'active'} disabled={controlsLocked} idPrefix={titleId} onEdit={edit} /> : <p>请先加载状态。</p>}</section>
      </div>
      <label htmlFor={`${titleId}-reason`}>决定原因</label><select id={`${titleId}-reason`} disabled={controlsLocked} value={draft?.reason ?? ''} onChange={event => edit({ reason: event.target.value as RevisionDraft['reason'] })}><option value="">请选择原因</option>{Object.entries(reasons).map(([v, text]) => <option key={v} value={v}>{text}</option>)}</select>
      <label htmlFor={`${titleId}-note`}>说明（可选，最多 1000 字符）</label><textarea id={`${titleId}-note`} disabled={controlsLocked} maxLength={1000} value={draft?.note ?? ''} onChange={event => edit({ note: event.target.value })} />
      {observation.evidenceMode === 'mental' ? <p>脑中回忆，未记录原答；修订后仍不计入独立成功或信心校准。</p> : revealed ? <section aria-label="原始回答"><h3>原始回答</h3>{observation.learning?.scenario ? <p>{observation.learning.scenario}</p> : null}<p>{observation.answer || '（空白回答）'}</p>{observation.learning?.applicability ? <p>{observation.learning.applicability}</p> : null}</section> : <button type="button" onClick={() => { onRevealAnswer(); setRevealed(true); }}>展开原始回答</button>}
      {state.loading ? <p role="status">正在核对修订历史…</p> : null}{state.error ? <p role="alert">{state.error}</p> : null}
      {uncertain && !confirmed ? <p role="status">提交结果尚未确认；保留原事件与内容，不允许重新核对或另建决定。可原样重试，或暂时关闭。</p> : null}{confirmed && cleanupPending ? <p role="status">服务已确认保存；本地回执仍待清理，不会另建一条决定。</p> : null}{ownPendingRow && !confirmed ? <p role="status">{ownPendingRow.state === 'rejected' ? '原请求已被拒绝；保留冻结内容，重新核对后可另作决定。' : '原决定已持久保存为待同步请求，重试不会更改其时间或内容。'}</p> : null}{durable && !confirmed && pendingRelation === 'none' ? <p role="status">本机待同步副本目前未能核实；不据此认定已保存。请只重读状态或关闭，勿另建重复决定。</p> : null}{message ? <p role="status">{message}</p> : null}{blocked && !confirmed ? <p role="status">{blocked}</p> : null}
      <h3>决定审计</h3><ol>{state.history?.events.map(event => <li key={event.eventId}><strong>{actions[event.action]} · {reasons[event.reason]}</strong>{event.action === 'revise' ? <Assessment value={event.assessment} /> : null}<p>发生 {event.occurredAt} · 保存 {event.recordedAt}</p>{event.note !== undefined ? <p className="observation-revision-note">{event.note}</p> : null}</li>)}</ol>
      {state.history?.nextCursor ? state.history.events.length >= 100 ? <p>本次已显示最多 100 条决定，完整记录可通过学习数据导出留档。</p> : <button type="button" disabled={busy || state.loading} onClick={() => void loader.loadMore()}>再加载 20 条</button> : null}
    </div>
    <footer><button type="button" disabled={busy} onClick={() => void (confirmed ? refreshConfirmed() : loader.refresh())}>{confirmed ? '重读已保存状态' : '重读状态'}</button>
      {!confirmed && !uncertain && !foreignPending && (ownPendingRow?.state === 'rejected' || (!durable && (stale || frozen))) ? <button type="button" disabled={busy || contextInvalid || Boolean(disabledReason)} onClick={() => void recheck()}>重新核对当前状态</button> : null}
      {!confirmed && !foreignPending && durable ? !ownPendingRow || ownPendingRow.state === 'rejected' || foreignPending ? null : <button type="button" disabled={busy || contextInvalid || Boolean(disabledReason)} onClick={() => void submit(true)}>重试原待同步请求</button> : !confirmed && !foreignPending ? <button type="button" disabled={busy || foreignPending || contextInvalid || Boolean(disabledReason) || (!frozen && Boolean(blocked || state.loading || durable))} onClick={() => void submit()}>{busy ? '正在保存…' : frozen ? '原样重试这次决定' : '确认提交决定'}</button> : null}
    </footer>
  </dialog>;
}
