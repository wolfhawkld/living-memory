import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ActivityChannel, ActivityExport, ActivityListOptions, ActivityPage, ActivityRecord, ActivityReference, ActivitySettings, ActivitySettingsUpdate } from '../shared/activity';
import type { ActivityReferenceCurrentStatus, ActivityViewRecord } from '../shared/activity-reference-status';

export interface ActivityHistoryDialogProps {
  scopeKey: string;
  initialConceptId?: string;
  concepts: readonly { id: string; title: string }[];
  settings: ActivitySettings;
  queueStatus: { pending: number; conflicts: number; exhausted: number; message?: string };
  onClose: () => void;
  loadPage: (options: ActivityListOptions, signal?: AbortSignal) => Promise<ActivityPage>;
  onUpdateSettings: (input: ActivitySettingsUpdate) => Promise<ActivitySettings>;
  onClear: (input: { scope: 'all'; expectedEpoch: number } | { scope: 'operation'; expectedEpoch: number; operationId: string }) => Promise<{ settings: ActivitySettings; deletedEvents: number; deletedDeliveries: number }>;
  onExport: () => Promise<ActivityExport>;
  onRetry: () => Promise<void>;
  onReviewReference?: (reference: ActivityReference, status: ActivityReferenceCurrentStatus) => void;
}
export function groupActivityPage(items: readonly ActivityRecord[]): { operationId: string; steps: ActivityRecord[] }[] {
  const groups = new Map<string, ActivityRecord[]>();
  for (const item of items) { const group = groups.get(item.event.operationId) ?? []; group.push(item); groups.set(item.event.operationId, group); }
  return [...groups].map(([operationId, steps]) => ({ operationId, steps: steps.sort((a, b) => Date.parse(a.event.occurredAt) - Date.parse(b.event.occurredAt) || Date.parse(a.receivedAt) - Date.parse(b.receivedAt)) }));
}
export function activityReferenceLabel(ref: ActivityReference): string {
  const scope = { result: '查询候选', summary: '摘要', body: '完整正文', section: '章节', block: '可见块' }[ref.scope];
  return `${scope}${ref.contentPart ? ` · ${ref.contentPart === 'summary' ? '摘要' : '正文'}` : ''}${ref.sectionId ? ` · ${ref.sectionId}` : ''}${ref.blockId ? ` · ${ref.blockId}` : ''}${ref.bodyRange ? ` · 第 ${ref.bodyRange.startLine}–${ref.bodyRange.endLine} 行（渲染文本）` : ''}`;
}
export function activityStepLabel(kind: ActivityRecord['event']['kind']): string {
  return { 'query.submitted': '提交查询', 'query.selected': '选中知识', 'reader.opened': '打开资料', 'content.visible': '资料进入可见范围',
    'content.delivery': '内容传递结果', 'workflow.reported': '工作流报告' }[kind];
}
export function savedActivityQuery(record: ActivityRecord): string | null {
  const payload = record.event.payload;
  return 'queryTextSavedByUser' in payload && payload.queryTextSavedByUser === true && 'queryText' in payload && typeof payload.queryText === 'string' ? payload.queryText : null;
}

export function ActivityHistorySteps({ records, onReviewReference }: { records: readonly ActivityRecord[];
  onReviewReference?: ActivityHistoryDialogProps['onReviewReference'] }) {
  return <ol>{records.map((record) => <li key={record.event.eventId}>
          <p><strong>{activityStepLabel(record.event.kind)}</strong> · <time dateTime={record.event.occurredAt}>{new Date(record.event.occurredAt).toLocaleString('zh-CN')}</time> · {record.event.channel}</p>
          {savedActivityQuery(record) !== null && <blockquote>主动保存的查询：{savedActivityQuery(record)}</blockquote>}
          {record.event.kind === 'query.submitted' && <p>结果数量：{record.event.payload.resultCount}</p>}
          {record.event.kind === 'content.delivery' && <p>{record.event.payload.medium} · {record.event.payload.outcome === 'prepared' ? '已准备 CLI 输出' : record.event.payload.outcome === 'platform-accepted' ? '平台已接受投递' : '失败或结果未知'} · {record.event.payload.coverage}
            {record.event.payload.page && ` · 第 ${record.event.payload.page} / ${record.event.payload.pageCount} 页`}。不代表本人已阅读。</p>}
          {record.event.kind === 'workflow.reported' && <p>{record.event.payload.workflow} 工作流自报成功并完成刷新；不代表本人已看到。</p>}
          {record.event.refs.map((ref, index) => <div className="activity-history-reference" key={`${index}:${ref.conceptId}`}>
            <strong>{ref.title || ref.conceptId}</strong><p>{ref.path} · 版本 {ref.sourceRevision}</p><p>{activityReferenceLabel(ref)}</p>
            <span>{record.referenceInspections[index]?.status === 'current' ? '接收时版本吻合' : '接收时未确认版本或来源已变化'}</span>
            {(() => {
              const status = (record as Partial<ActivityViewRecord>).currentReferenceStatuses?.find((entry) => entry.refIndex === index);
              if (!status) return <p>当前定位状态尚未核对。</p>;
              const label = { current: '当前仍可定位', 'source-changed': '资料版本已变化', 'source-moved': '资料路径已移动',
                'missing-concept': '原概念已移除，待人工核对', 'location-unresolved': '原章节或正文块已失效' }[status.status];
              return <p>{label}{status.pathChanged && status.revisionChanged ? ' · 路径也已变化' : ''}
                {onReviewReference && <button type="button" onClick={() => onReviewReference(ref, status)}>核对当前资料</button>}</p>;
            })()}
          </div>)}
        </li>)}</ol>;
}

export function ActivityHistoryDialog(props: ActivityHistoryDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  const [conceptId, setConceptId] = useState(props.initialConceptId ?? '');
  const [channel, setChannel] = useState<ActivityChannel | ''>('');
  const [period, setPeriod] = useState<'7' | '30' | 'all'>('7');
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [refresh, setRefresh] = useState(0);
  const [localSettings, setLocalSettings] = useState({ scopeKey: props.scopeKey, settings: props.settings });
  const settings = localSettings.scopeKey === props.scopeKey ? localSettings.settings : props.settings;
  const [page, setPage] = useState<{ key: string; value: ActivityPage } | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [noticeState, setNoticeState] = useState({ scopeKey: props.scopeKey, text: '' });
  const notice = noticeState.scopeKey === props.scopeKey ? noticeState.text : '';
  const setNotice = (text: string) => setNoticeState({ scopeKey: props.scopeKey, text });
  type ClearChoice = { scope: 'all' } | { scope: 'operation'; operationId: string };
  const [confirmationState, setConfirmationState] = useState<{ scopeKey: string; choice: ClearChoice } | null>(null);
  const confirmation = confirmationState?.scopeKey === props.scopeKey ? confirmationState.choice : null;
  const setConfirmation = (choice: ClearChoice | null) => setConfirmationState(choice ? { scopeKey: props.scopeKey, choice } : null);
  const generation = useRef(0);
  const actionPending = useRef(false);
  const latestScope = useRef(props.scopeKey); latestScope.current = props.scopeKey;
  const from = useMemo(() => period === 'all' ? undefined : new Date(Date.now() - Number(period) * 86400000).toISOString(), [period, conceptId, channel, props.scopeKey]);
  const options = useMemo<ActivityListOptions>(() => ({ limit: 50, ...(conceptId ? { conceptId } : {}), ...(channel ? { channel } : {}), ...(from ? { from } : {}), ...(cursors.at(-1) ? { cursor: cursors.at(-1) } : {}) }), [conceptId, channel, from, cursors]);
  const key = JSON.stringify([props.scopeKey, options]);
  const current = page?.key === key ? page.value : null;

  useEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden'; element?.showModal();
    return () => { generation.current += 1; if (element?.open) element.close(); document.body.style.overflow = overflow; if (previous?.isConnected && !previous.closest('[inert]')) previous.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => {
    actionPending.current = false; setConceptId(props.initialConceptId ?? ''); setCursors([undefined]); setNotice(''); setBusy(false); setConfirmation(null);
  }, [props.scopeKey, props.initialConceptId]);
  useEffect(() => { setLocalSettings({ scopeKey: props.scopeKey, settings: props.settings }); }, [props.scopeKey, props.settings]);
  useEffect(() => {
    const controller = new AbortController();
    const epoch = ++generation.current;
    setLoading(true);
    void Promise.resolve().then(() => props.loadPage(options, controller.signal)).then((value) => {
      if (!controller.signal.aborted && epoch === generation.current) setPage({ key, value });
    }).catch((error) => { if (!controller.signal.aborted && epoch === generation.current) setNotice(error instanceof Error ? error.message : '查阅记录暂时无法加载。'); })
      .finally(() => { if (!controller.signal.aborted && epoch === generation.current) setLoading(false); });
    return () => { controller.abort(); generation.current += 1; };
  }, [key, refresh, props.loadPage]);

  const act = async (action: (isCurrent: () => boolean) => Promise<void>, clear = false) => {
    if (actionPending.current) return;
    actionPending.current = true;
    const scope = props.scopeKey, epoch = generation.current;
    const isCurrent = () => latestScope.current === scope && generation.current === epoch;
    setBusy(true); setNotice('');
    try { await action(isCurrent); }
    catch (error) {
      if (latestScope.current === scope && generation.current === epoch) {
        setNotice(clear ? '清除结果未确认，请重新加载核对；不会自动重发清除请求。' : error instanceof Error ? error.message : '操作暂时失败，请重试。');
        if (clear) setRefresh((value) => value + 1);
      }
    } finally { if (isCurrent()) { actionPending.current = false; setBusy(false); } }
  };
  const clearConfirmed = () => {
    if (!confirmation) return;
    const input = { ...confirmation, expectedEpoch: settings.epoch };
    const scope = props.scopeKey;
    void act(async (isCurrent) => {
      const result = await props.onClear(input);
      if (!isCurrent()) return;
      setLocalSettings({ scopeKey: scope, settings: result.settings }); setConfirmation(null);
      setPage((previous) => previous?.key === key ? { key, value: { ...previous.value, items: input.scope === 'all' ? [] : previous.value.items.filter((item) => item.event.operationId !== input.operationId), nextCursor: null } } : previous);
      setNotice(`已清除 ${result.deletedEvents} 条活动记录和 ${result.deletedDeliveries} 条递送记录。`);
      setCursors([undefined]); setRefresh((value) => value + 1);
    }, true);
  };
  const changeFilter = (change: () => void) => { change(); setCursors([undefined]); setNotice(''); };

  return <dialog ref={dialog} className="activity-history-dialog" aria-labelledby={heading} onCancel={(event) => { event.preventDefault(); props.onClose(); }}>
    <header><div><h2 id={heading}>查阅记录</h2><p>记录操作与可见资料范围，不代表读完或记住。</p></div><button type="button" onClick={props.onClose} aria-label="关闭查阅记录">×</button></header>
    <div className="activity-history-actions">
      <span>自动记录：{settings.enabled ? '开启' : '暂停'}</span>
      <button type="button" disabled={busy} onClick={() => { const scope = props.scopeKey; void act(async (isCurrent) => { const value = await props.onUpdateSettings({ enabled: !settings.enabled, expectedRevision: settings.revision }); if (isCurrent()) setLocalSettings({ scopeKey: scope, settings: value }); }); }}>{settings.enabled ? '暂停记录' : '恢复记录'}</button>
      <button type="button" disabled={busy} onClick={() => setConfirmation({ scope: 'all' })}>清除全部查阅记录</button>
      <button type="button" disabled={busy} onClick={() => { const scope = props.scopeKey; void act(async (isCurrent) => {
        const value = await props.onExport(); if (!isCurrent()) return;
        const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
        const anchor = document.createElement('a'); anchor.href = url; anchor.download = `living-memory-activity-${new Date().toISOString().slice(0, 10)}.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 0);
      }); }}>独立导出</button>
    </div>
    <div className="activity-history-queue" role="status">待同步 {props.queueStatus.pending} · 冲突 {props.queueStatus.conflicts} · 已暂停重试 {props.queueStatus.exhausted}
      <button type="button" disabled={busy} onClick={() => { void act(async (isCurrent) => { await props.onRetry(); if (isCurrent()) setRefresh((value) => value + 1); }); }}>重试同步</button>
      {props.queueStatus.message && <p>{props.queueStatus.message}</p>}
    </div>
    <div className="activity-history-filters">
      <label>概念<select value={conceptId} disabled={busy} onChange={(event) => changeFilter(() => setConceptId(event.target.value))}><option value="">全部概念</option>{props.concepts.map((concept) => <option key={concept.id} value={concept.id}>{concept.title}</option>)}</select></label>
      <label>渠道<select value={channel} disabled={busy} onChange={(event) => changeFilter(() => setChannel(event.target.value as ActivityChannel | ''))}><option value="">全部渠道</option>{(['web', 'cli', 'progressive-kg', 'feishu'] as const).map((value) => <option key={value} value={value}>{value === 'web' ? 'Web' : value === 'feishu' ? '飞书' : value}</option>)}</select></label>
      <label>时间<select value={period} disabled={busy} onChange={(event) => changeFilter(() => setPeriod(event.target.value as typeof period))}><option value="7">最近 7 天</option><option value="30">最近 30 天</option><option value="all">全部时间</option></select></label>
      <button type="button" disabled={busy || loading} onClick={() => setRefresh((value) => value + 1)}>重新加载</button>
    </div>
    {notice && <p className="activity-history-notice" role="status">{notice}</p>}
    {confirmation && <section className="activity-history-confirm" aria-label="确认清除范围"><p>{confirmation.scope === 'all' ? '清除当前账号整个知识空间（所有领域）的全部查阅记录、已保存查询原文与递送记录。' : `清除本次操作 ${confirmation.operationId} 在所有领域、所有页面中的查阅记录、已保存查询原文与递送记录，不限当前筛选或当前页。`}不会修改学习记录或记忆状态。</p><button type="button" disabled={busy} onClick={clearConfirmed}>确认清除</button><button type="button" disabled={busy} onClick={() => setConfirmation(null)}>取消</button></section>}
    <div className="activity-history-scroll" aria-busy={loading}>
      <p className="activity-history-page-note">每页最多 50 条；以下操作分组仅包含当前页，可能不是一次操作的完整记录。</p>
      {loading && <p role="status">正在加载查阅记录…</p>}
      {!loading && current?.items.length === 0 && <p>此范围暂无查阅记录。</p>}
      {groupActivityPage(current?.items ?? []).map((group) => <section className="activity-history-operation" key={group.operationId}>
        <div className="activity-history-operation-heading"><h3>操作 {group.operationId}</h3><button type="button" disabled={busy} onClick={() => setConfirmation({ scope: 'operation', operationId: group.operationId })}>清除此操作</button></div>
        <ActivityHistorySteps records={group.steps} onReviewReference={props.onReviewReference} />
      </section>)}
    </div>
    <footer><span>第 {cursors.length} 页</span><button type="button" disabled={busy || loading || cursors.length <= 1} onClick={() => setCursors((value) => value.slice(0, -1))}>上一页</button><button type="button" disabled={busy || loading || !current?.nextCursor} onClick={() => { if (current?.nextCursor) setCursors((value) => [...value, current.nextCursor!]); }}>下一页</button></footer>
  </dialog>;
}
