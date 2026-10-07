import { useEffect, useRef, useState, type ChangeEvent, type ReactElement } from 'react';
import type { ApplicationRecord } from '../shared/types';
import type { CorrectionEvent, CorrectionHistory, CorrectionRequest, CorrectionStatus } from '../shared/corrections';

export interface SaveCorrectionResult {
  ok: boolean;
  queued?: boolean;
  error?: string;
}

/** The save boundary is kept in the parent so this panel never writes the KG itself. */
export type SaveCorrection = (payload: CorrectionRequest) => Promise<SaveCorrectionResult>;

export interface ApplicationCorrectionPanelProps {
  application: ApplicationRecord;
  currentRevision: string;
  history: CorrectionHistory | undefined;
  disabled: boolean;
  pending: boolean;
  onSave?: SaveCorrection;
  onRefreshHistory?: () => void;
  /** Parent uses the application ID to keep source refreshes from unmounting a draft. */
  onEditingChange?: (editing: boolean) => void;
}

const STATUS_LABELS: Record<CorrectionStatus, string> = {
  resolved: '确认已纳入当前版本',
  dismissed: '暂不采用',
  open: '待处理',
};

const ACTION_LABELS: Record<CorrectionStatus, string> = {
  resolved: '确认已纳入当前版本',
  dismissed: '暂不采用',
  open: '重新打开',
};

function newCorrectionEventId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `correction-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function compactRevision(value: string): string {
  const revision = value.trim();
  if (!revision) return '未记录';
  return revision.length > 24 ? `${revision.slice(0, 12)}…${revision.slice(-8)}` : revision;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '日期未知';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '日期未知';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(date);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : '保存没有完成，请重试。';
}

/**
 * Build one immutable correction request. Callers may provide event/time values
 * in tests; the component supplies them exactly once when the user confirms.
 */
export function buildCorrectionRequest(
  application: Pick<ApplicationRecord, 'eventId' | 'conceptId' | 'sourceRevision'>,
  currentRevision: string,
  history: CorrectionHistory | undefined,
  status: CorrectionStatus,
  note: string,
  eventId = newCorrectionEventId(),
  occurredAt = new Date().toISOString(),
): CorrectionRequest {
  return {
    eventId,
    applicationEventId: application.eventId,
    conceptId: application.conceptId,
    sourceRevision: currentRevision,
    occurredAt,
    previousEventId: history?.latest?.eventId ?? null,
    status,
    note: note.trim(),
  };
}

/** Alias with a creation-oriented name for callers that prefer it. */
export const createCorrectionRequest = buildCorrectionRequest;

function historyStatusLabel(event: CorrectionEvent): string {
  return STATUS_LABELS[event.status];
}

function CorrectionHistoryList({ events, total }: { events: readonly CorrectionEvent[]; total: number }): ReactElement | null {
  if (events.length === 0) return null;
  return (
    <div className="application-correction-history">
      <div className="application-correction-subheading">处理记录</div>
      {total > events.length ? <p className="application-correction-help">显示最近 {events.length} 条，共 {total} 条；完整历史见导出。</p> : null}
      <ol className="application-correction-history-list">
        {events.map((event) => (
          <li key={event.eventId} className="application-correction-history-item">
            <div className="application-correction-history-heading">
              <strong>人工决定：{historyStatusLabel(event)}</strong>
              <time dateTime={event.occurredAt}>发生于 {formatDate(event.occurredAt)}</time>
            </div>
            <div className="application-correction-history-meta">
              <span>保存于 {formatDate(event.recordedAt)}</span>
              <span>确认版本 {compactRevision(event.sourceRevision)}</span>
            </div>
            {event.note ? <p>处理说明：{event.note}</p> : null}
            {event.status === 'resolved' ? <small>这是本人记录的处理决定，资料是否包含修正仍以本人判断为准。</small> : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

function SourceRevisionSummary({ application, currentRevision }: {
  application: ApplicationRecord;
  currentRevision: string;
}): ReactElement {
  return (
    <div className="application-correction-revisions" aria-label="修正所依据的资料版本">
      <span>原版本 <code title={application.sourceRevision}>{compactRevision(application.sourceRevision)}</code></span>
      <span>当前版本 <code title={currentRevision}>{compactRevision(currentRevision)}</code></span>
    </div>
  );
}

export function ApplicationCorrectionPanel({
  application,
  currentRevision,
  history,
  disabled,
  pending,
  onSave,
  onRefreshHistory,
  onEditingChange,
}: ApplicationCorrectionPanelProps): ReactElement | null {
  const hasCorrection = Boolean(application.correction.trim());
  const latest = history?.latest ?? null;
  const [decision, setDecision] = useState<CorrectionStatus>(() => latest?.status ?? 'open');
  const [note, setNote] = useState(() => latest?.note ?? '');
  const [confirmedCurrent, setConfirmedCurrent] = useState(false);
  const [frozenRequest, setFrozenRequest] = useState<CorrectionRequest | null>(null);
  const [submitState, setSubmitState] = useState<'idle' | 'saving' | 'failed' | 'queued' | 'accepted'>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [seenLatestId, setSeenLatestId] = useState<string | null>(latest?.eventId ?? null);
  const [draftDirty, setDraftDirty] = useState(false);
  const [draftPreviousEventId, setDraftPreviousEventId] = useState<string | null>(latest?.eventId ?? null);
  const [draftStale, setDraftStale] = useState<'history' | 'revision' | null>(null);
  const observedRevisionRef = useRef(currentRevision);
  const editingCallbackRef = useRef(onEditingChange);

  const currentChanged = currentRevision !== application.sourceRevision;
  const oldResolved = latest?.status === 'resolved' && latest.sourceRevision !== currentRevision;
  const isFrozen = Boolean(frozenRequest);
  const isBusy = submitState === 'saving';
  const queueLocked = submitState === 'queued' || pending;
  const serviceUnavailable = !onSave;
  const writeDisabled = disabled || queueLocked || serviceUnavailable || isBusy || submitState === 'accepted';
  const resolveBlocked = decision === 'resolved' && (!currentChanged || !confirmedCurrent);
  const submitDisabled = writeDisabled || resolveBlocked || Boolean(draftStale);
  const isEditing = draftDirty || (Boolean(frozenRequest) && (submitState === 'saving' || submitState === 'failed'));

  useEffect(() => {
    editingCallbackRef.current = onEditingChange;
  }, [onEditingChange]);

  useEffect(() => {
    if (!hasCorrection) return undefined;
    editingCallbackRef.current?.(isEditing);
    return () => editingCallbackRef.current?.(false);
  }, [application.eventId, hasCorrection, isEditing]);

  useEffect(() => {
    if (observedRevisionRef.current !== currentRevision) {
      if (isEditing) setDraftStale('revision');
      observedRevisionRef.current = currentRevision;
    }
  }, [currentRevision, isEditing]);

  // A successful response does not change the displayed status. Once the
  // refreshed history contains that event, release the frozen request and
  // synchronize the form with the server's decision.
  useEffect(() => {
    const refreshedLatest = history?.latest ?? null;
    const refreshedEvents = history?.events ?? [];
    const frozenEventRefreshed = Boolean(frozenRequest && refreshedEvents.some((event) => event.eventId === frozenRequest.eventId));
    const acknowledgedEvent = refreshedLatest ?? refreshedEvents.find((event) => event.eventId === frozenRequest?.eventId) ?? null;
    if ((submitState === 'accepted' || submitState === 'queued')
      && frozenRequest && acknowledgedEvent && (acknowledgedEvent.eventId === frozenRequest.eventId || frozenEventRefreshed)) {
      setFrozenRequest(null);
      setSubmitState('idle');
      setSaveError(null);
      setDecision(acknowledgedEvent.status);
      setNote(acknowledgedEvent.note);
      setConfirmedCurrent(false);
      setDraftDirty(false);
      setDraftStale(null);
      setDraftPreviousEventId(acknowledgedEvent.eventId);
      setSeenLatestId(acknowledgedEvent.eventId);
      return;
    }
    if (frozenRequest || draftDirty) {
      if (refreshedLatest?.eventId !== seenLatestId && refreshedLatest?.eventId !== frozenRequest?.eventId) {
        setDraftStale('history');
        setSeenLatestId(refreshedLatest?.eventId ?? null);
      }
      return;
    }
    if (refreshedLatest?.eventId !== seenLatestId) {
      setDecision(refreshedLatest?.status ?? 'open');
      setNote(refreshedLatest?.note ?? '');
      setConfirmedCurrent(false);
      setDraftPreviousEventId(refreshedLatest?.eventId ?? null);
      setSeenLatestId(refreshedLatest?.eventId ?? null);
    }
  }, [draftDirty, frozenRequest, history?.events, history?.latest, seenLatestId, submitState]);

  const beginEditing = () => {
    if (!draftDirty) setDraftPreviousEventId(history?.latest?.eventId ?? null);
    setDraftDirty(true);
  };

  const editDecision = (value: CorrectionStatus) => {
    beginEditing();
    setDecision(value);
    setConfirmedCurrent(false);
    if (frozenRequest) {
      setFrozenRequest(null);
      setSubmitState('idle');
      setSaveError(null);
    }
  };

  const editNote = (event: ChangeEvent<HTMLTextAreaElement>) => {
    beginEditing();
    const value = event.target.value;
    setNote(value);
    if (frozenRequest) {
      setFrozenRequest(null);
      setSubmitState('idle');
      setSaveError(null);
    }
  };

  const resetFrozenRequest = () => {
    if (disabled || isBusy || queueLocked || (submitState === 'accepted' && !draftStale)) return;
    setFrozenRequest(null);
    setSubmitState('idle');
    setSaveError(null);
    // Rechecking explicitly accepts the new basis, retaining the person's
    // decision and explanation even after a failed request.
    setDraftDirty(true);
    setDraftStale(null);
    setConfirmedCurrent(false);
    setDraftPreviousEventId(history?.latest?.eventId ?? null);
    setSeenLatestId(history?.latest?.eventId ?? null);
  };

  const submit = async () => {
    if (submitDisabled || !onSave) return;
    if (draftStale) {
      setSaveError(draftStale === 'history'
        ? '历史已有新的处理决定，请点击“重新核对当前状态”后再提交。'
        : '资料版本已更新，请点击“重新核对当前状态”后再提交。');
      return;
    }
    if (decision === 'resolved' && !currentChanged) {
      setSaveError('当前资料版本尚未变化，确认纳入当前版本前请先更新原有知识资料。');
      return;
    }
    if (decision === 'resolved' && !confirmedCurrent) {
      setSaveError('请先勾选“已核对当前资料，确认包含该修正”。');
      return;
    }
    const basePreviousEventId = draftDirty ? draftPreviousEventId : history?.latest?.eventId ?? null;
    const request = frozenRequest ?? {
      ...buildCorrectionRequest(application, currentRevision, history, decision, note),
      previousEventId: basePreviousEventId,
    };
    if (!frozenRequest) setFrozenRequest(request);
    if (!draftDirty) {
      setDraftPreviousEventId(basePreviousEventId);
      setDraftDirty(true);
    }
    setSubmitState('saving');
    setSaveError(null);
    try {
      const result = await onSave(request);
      if (result.queued) {
        setSubmitState('queued');
        setSaveError(result.error ?? null);
        setDraftDirty(false);
        setDraftStale(null);
        return;
      }
      if (result.ok) {
        setSubmitState('accepted');
        setSaveError(null);
        setDraftDirty(false);
        setDraftStale(null);
        return;
      }
      setSubmitState('failed');
      setDraftDirty(true);
      setSaveError(result.error ?? '保存没有完成，请重试。');
    } catch (error: unknown) {
      setSubmitState('failed');
      setDraftDirty(true);
      setSaveError(errorText(error));
    }
  };

  const statusText = history === undefined ? '复核历史不可用' : latest ? STATUS_LABELS[latest.status] : '待处理';

  if (!hasCorrection) return null;

  return (
    <section className="application-correction-panel" aria-label="知识修正复核">
      <div className="application-correction-heading">
        <div>
          <span className="application-correction-kicker">知识修正建议</span>
          <strong>{statusText}</strong>
        </div>
        {history === undefined ? <span className="application-correction-latest">服务未返回历史</span> : latest ? <span className="application-correction-latest">最新决定已保存</span> : <span className="application-correction-latest">待人工处理</span>}
      </div>

      <p className="application-correction-proposal">{application.correction}</p>
      {application.relationSuggestion ? <p className="application-correction-help">下方处理结果仅针对文字修正，不表示关系建议已纳入知识源。</p> : null}
      <SourceRevisionSummary application={application} currentRevision={currentRevision} />

      {history === undefined ? (
        <p className="application-correction-service-note" role="status">当前服务未提供修正复核历史，请更新服务后再处理；现有状态不会被推测。</p>
      ) : null}
      {history && !latest && currentChanged ? <p className="application-correction-warning" role="status">来源已更新，待人工核对。</p> : null}
      {oldResolved ? <p className="application-correction-warning" role="status">上次核对的是旧版资料（{compactRevision(latest?.sourceRevision ?? '')}）；当前资料为 {compactRevision(currentRevision)}，状态保持原决定，请重新核对当前资料。</p> : null}
      {draftStale === 'history' ? <p className="application-correction-warning" role="status">历史已出现新的处理决定，当前草稿保留；请点击“重新核对当前状态”后再提交。</p> : null}
      {draftStale === 'revision' ? <p className="application-correction-warning" role="status">资料版本已更新，当前草稿保留；请点击“重新核对当前状态”后再提交。</p> : null}
      {pending || submitState === 'queued' ? <p className="application-correction-pending" role="status">原记录待同步，已保留本次决定；同步完成并刷新历史前不能重复提交。</p> : null}
      {submitState === 'accepted' ? <p className="application-correction-pending" role="status">决定已提交，等待历史刷新；当前显示的状态仍以服务历史为准。</p> : null}

      {history !== undefined ? (
        <div className="application-correction-form">
          <label className="application-correction-field">
            <span>处理决定</span>
            <select value={decision} onChange={(event) => editDecision(event.target.value as CorrectionStatus)} disabled={writeDisabled}>
              <option value="resolved">{ACTION_LABELS.resolved}</option>
              <option value="dismissed">{ACTION_LABELS.dismissed}</option>
              <option value="open">{ACTION_LABELS.open}</option>
            </select>
          </label>
          {decision === 'resolved' ? (
            <label className="application-correction-check">
              <input type="checkbox" checked={confirmedCurrent} onChange={(event) => {
                beginEditing();
                setConfirmedCurrent(event.target.checked);
                if (frozenRequest) {
                  setFrozenRequest(null);
                  setSubmitState('idle');
                  setSaveError(null);
                }
              }} disabled={writeDisabled || !currentChanged} />
              <span>已核对当前资料，确认包含该修正</span>
            </label>
          ) : null}
          {decision === 'resolved' && !currentChanged ? <p className="application-correction-help">当前版本仍是提交应用时的版本；请先去原有知识图谱更新资料后刷新。</p> : null}
          {decision === 'resolved' && currentChanged && !confirmedCurrent ? <p className="application-correction-help">确认前请阅读当前资料，并明确确认它已包含这条修正。</p> : null}
          <label className="application-correction-field">
            <span>处理说明（可选）</span>
            <textarea value={note} onChange={editNote} maxLength={4000} rows={3} disabled={writeDisabled} placeholder="记录这次人工决定的依据。" />
          </label>
          {saveError ? <p className="application-correction-error" role="alert">{saveError}</p> : null}
          {serviceUnavailable ? <p className="application-correction-help">当前页面未连接修正保存服务。</p> : null}
          <div className="application-correction-actions">
            <button type="button" onClick={() => void submit()} disabled={submitDisabled}>
              {isBusy ? '保存中…' : submitState === 'failed' ? '重试原记录' : '确认并保存决定'}
            </button>
            {(isFrozen && submitState === 'failed' || draftStale) ? <button type="button" className="application-correction-reset" disabled={disabled || isBusy || queueLocked} onClick={resetFrozenRequest}>重新核对当前状态</button> : null}
            {submitState === 'failed' && onRefreshHistory ? <button type="button" className="application-correction-reset" disabled={disabled || isBusy} onClick={onRefreshHistory}>刷新处理历史</button> : null}
          </div>
          {isFrozen && submitState === 'failed' ? <p className="application-correction-help">重试会沿用原记录的时间、ID和前序事件；只有编辑决定或说明，或点击“重新核对当前状态”，才会生成新操作。</p> : null}
          <p className="application-correction-help">切换节点、收起记录或刷新页面前，请先保存说明。如提示资料版本变化，请先复制说明，再刷新知识源。</p>
        </div>
      ) : null}

      {history ? <CorrectionHistoryList events={history.events} total={history.total} /> : null}
    </section>
  );
}

export default ApplicationCorrectionPanel;
