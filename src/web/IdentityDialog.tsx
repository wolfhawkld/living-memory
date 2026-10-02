import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactElement } from 'react';
import type {
  IdentityBinding,
  IdentityConcept,
  IdentityCounts,
  IdentityLinkCommit,
  IdentityLinkPreview,
  IdentityLinkReceipt,
  IdentityLinkRequest,
  IdentityStatus,
} from '../shared/identity.js';

const BINDING_PREVIEW_LIMIT = 30;

export interface IdentityDialogProps {
  sourceId: string;
  lockedReason: string | null;
  onLoad: () => Promise<IdentityStatus>;
  onPreview: (request: IdentityLinkRequest) => Promise<IdentityLinkPreview>;
  onCommit: (request: IdentityLinkCommit) => Promise<IdentityLinkReceipt>;
  onLinked: (receipt: IdentityLinkReceipt) => void;
  onClose: () => void;
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const value = error as { code?: unknown; details?: { code?: unknown } };
  if (typeof value.code === 'string' && value.code) return value.code;
  if (typeof value.details?.code === 'string' && value.details.code) return value.details.code;
  return null;
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : '操作没有完成，请稍后重试。';
  return message.length > 400 ? `${message.slice(0, 397)}…` : message;
}

function finiteCount(value: number | null | undefined): number {
  return Number.isFinite(value) && value !== null && value !== undefined && value >= 0 ? Math.floor(value) : 0;
}

function countTotal(counts: IdentityCounts): number {
  return finiteCount(counts.anchors) + finiteCount(counts.observations)
    + finiteCount(counts.retentions) + finiteCount(counts.applications)
    + finiteCount(counts.practiceCards) + finiteCount(counts.practiceAttempts);
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, 'zh-CN') || left.localeCompare(right);
}

function conceptSearchText(concept: IdentityConcept): string {
  return [concept.conceptId, concept.title, concept.path ?? '', concept.sourceRevision ?? '']
    .join('\u0000').toLocaleLowerCase();
}

export function filterIdentityConcepts(concepts: readonly IdentityConcept[], query: string): IdentityConcept[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return [...concepts];
  return concepts.filter((concept) => conceptSearchText(concept).includes(normalized));
}

export function sortIdentityConcepts(concepts: readonly IdentityConcept[]): IdentityConcept[] {
  return [...concepts].sort((left, right) => compareText(left.title, right.title) || compareText(left.conceptId, right.conceptId));
}

/** Exact source revisions are surfaced first, but the caller still requires an explicit choice. */
export function sortIdentityTargets(targets: readonly IdentityConcept[], sourceRevision: string | null): IdentityConcept[] {
  return [...targets].sort((left, right) => {
    const leftExact = sourceRevision !== null && left.sourceRevision === sourceRevision;
    const rightExact = sourceRevision !== null && right.sourceRevision === sourceRevision;
    if (leftExact !== rightExact) return leftExact ? -1 : 1;
    return compareText(left.title, right.title) || compareText(left.conceptId, right.conceptId);
  });
}

export function sortIdentityBindings(bindings: readonly IdentityBinding[]): IdentityBinding[] {
  return [...bindings].sort((left, right) => {
    const leftTime = Date.parse(left.confirmedAt);
    const rightTime = Date.parse(right.confirmedAt);
    const leftValue = Number.isFinite(leftTime) ? leftTime : Number.NEGATIVE_INFINITY;
    const rightValue = Number.isFinite(rightTime) ? rightTime : Number.NEGATIVE_INFINITY;
    return rightValue - leftValue || compareText(right.operationId, left.operationId);
  });
}

export function recentIdentityBindings(bindings: readonly IdentityBinding[], limit = BINDING_PREVIEW_LIMIT): IdentityBinding[] {
  return sortIdentityBindings(bindings).slice(0, Math.max(0, Math.floor(limit)));
}

export function createIdentityOperationId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return `identity-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** Freeze the exact pair and preview token used by a retryable commit. */
export function buildIdentityLinkCommit(
  request: IdentityLinkRequest,
  preview: IdentityLinkPreview,
  operationId: string,
): IdentityLinkCommit {
  return {
    fromConceptId: request.fromConceptId,
    toConceptId: request.toConceptId,
    operationId,
    previewToken: preview.token,
    confirmed: true,
  };
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '时间未知';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function displayPath(path: string | null | undefined): string {
  return path && path.trim() ? path : '来源路径未知';
}

function displayRevision(revision: string | null | undefined): string {
  return revision && revision.trim() ? revision : '来源版本未知';
}

function matchRevision(left: IdentityConcept | null, right: IdentityConcept | null): boolean {
  return Boolean(left && right && left.sourceRevision !== null && left.sourceRevision === right.sourceRevision);
}

const COUNT_LABELS: ReadonlyArray<[keyof IdentityCounts, string]> = [
  ['anchors', '重温起点'],
  ['observations', '回忆观察'],
  ['retentions', '长期保持'],
  ['applications', '应用 / 总结'],
  ['practiceCards', '练习卡'],
  ['practiceAttempts', '练习答题'],
];

function CountGrid({ counts, compact = false }: { counts: IdentityCounts; compact?: boolean }): ReactElement {
  return <div className={`identity-count-grid${compact ? ' identity-count-grid-compact' : ''}`} aria-label="历史记录数量">
    {COUNT_LABELS.map(([key, label]) => <div className="identity-count" key={key}>
      <span>{label}</span><strong>{finiteCount(counts[key])}</strong>
    </div>)}
  </div>;
}

function ConceptMeta({ concept, kind }: { concept: IdentityConcept; kind: 'old' | 'target' }): ReactElement {
  const exact = kind === 'target';
  return <div className="identity-concept-meta">
    <div className="identity-concept-title"><strong>{concept.title || '未命名概念'}</strong><small>{concept.conceptId}</small></div>
    <div className="identity-concept-path" title={displayPath(concept.path)}>{displayPath(concept.path)}</div>
    <div className="identity-concept-revision">{exact ? '当前版本' : '旧版本'}：{displayRevision(concept.sourceRevision)}</div>
    {kind === 'old' && !concept.path ? <span className="identity-unknown-path">未知来源路径 · 需要人工确认</span> : null}
  </div>;
}

function IssueList({ issues }: { issues: IdentityLinkPreview['issues'] }): ReactElement | null {
  if (!issues.length) return <p className="identity-ok-note" role="status">服务器没有发现阻止绑定的问题。</p>;
  return <ul className="identity-issues" aria-label="历史衔接检查结果">
    {issues.map((issue, index) => <li className={`identity-issue identity-issue-${issue.severity}`} key={`${issue.code}:${index}`}>
      <div><strong>{issue.severity === 'error' ? '阻止绑定' : '提示'}</strong><span>{issue.code}</span></div>
      <p>{issue.message}</p>
    </li>)}
  </ul>;
}

function layoutActionLabel(action: IdentityLinkPreview['layoutAction']): string {
  if (action === 'keep-original') return '保留旧概念布局';
  if (action === 'adopt-target') return '采用当前目标布局';
  return '无布局变化';
}

function bindingPath(binding: IdentityBinding, side: 'from' | 'to'): string {
  return displayPath(side === 'from' ? binding.fromPath : binding.toPath);
}

export function IdentityDialog({
  sourceId,
  lockedReason,
  onLoad,
  onPreview,
  onCommit,
  onLinked,
  onClose,
}: IdentityDialogProps): ReactElement {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onLoadRef = useRef(onLoad);
  const mountedRef = useRef(true);
  const sourceRef = useRef(sourceId);
  const loadVersionRef = useRef(0);
  const previewVersionRef = useRef(0);
  const commitVersionRef = useRef(0);
  const loadBusyRef = useRef(false);
  const previewBusyRef = useRef(false);
  const commitBusyRef = useRef(false);
  onLoadRef.current = onLoad;
  sourceRef.current = sourceId;

  const [status, setStatus] = useState<IdentityStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [oldQuery, setOldQuery] = useState('');
  const [targetQuery, setTargetQuery] = useState('');
  const [fromConceptId, setFromConceptId] = useState<string | null>(null);
  const [toConceptId, setToConceptId] = useState<string | null>(null);
  const [preview, setPreview] = useState<IdentityLinkPreview | null>(null);
  const [previewRequest, setPreviewRequest] = useState<IdentityLinkRequest | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [commitRequest, setCommitRequest] = useState<IdentityLinkCommit | null>(null);
  const [commitLoading, setCommitLoading] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [needsRepreview, setNeedsRepreview] = useState(false);
  const [receipt, setReceipt] = useState<IdentityLinkReceipt | null>(null);
  const titleId = useId();

  const clearPreview = useCallback(() => {
    previewVersionRef.current += 1;
    setPreview(null);
    setPreviewRequest(null);
    setPreviewError(null);
    setConfirmed(false);
    setCommitRequest(null);
    setCommitError(null);
    setNeedsRepreview(false);
    setReceipt(null);
  }, []);

  const loadStatus = useCallback(async () => {
    if (loadBusyRef.current) return;
    const version = ++loadVersionRef.current;
    const requestedSource = sourceId;
    loadBusyRef.current = true;
    setLoading(true);
    setLoadError(null);
    try {
      const next = await onLoadRef.current();
      if (!mountedRef.current || sourceRef.current !== requestedSource || loadVersionRef.current !== version) return;
      if (next.sourceId !== requestedSource) throw new Error('服务器返回的知识空间与当前页面不一致，请重新加载页面。');
      setStatus(next);
    } catch (error: unknown) {
      if (!mountedRef.current || sourceRef.current !== requestedSource || loadVersionRef.current !== version) return;
      setLoadError(errorText(error));
    } finally {
      if (mountedRef.current && sourceRef.current === requestedSource && loadVersionRef.current === version) {
        loadBusyRef.current = false;
        setLoading(false);
      }
    }
  }, [sourceId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      loadVersionRef.current += 1;
      previewVersionRef.current += 1;
      commitVersionRef.current += 1;
    };
  }, []);

  useEffect(() => {
    sourceRef.current = sourceId;
    loadVersionRef.current += 1;
    previewVersionRef.current += 1;
    commitVersionRef.current += 1;
    loadBusyRef.current = false;
    previewBusyRef.current = false;
    commitBusyRef.current = false;
    setStatus(null);
    setLoading(true);
    setLoadError(null);
    setOldQuery('');
    setTargetQuery('');
    setFromConceptId(null);
    setToConceptId(null);
    setPreview(null);
    setPreviewRequest(null);
    setPreviewLoading(false);
    setPreviewError(null);
    setConfirmed(false);
    setCommitRequest(null);
    setCommitLoading(false);
    setCommitError(null);
    setNeedsRepreview(false);
    setReceipt(null);
    void loadStatus();
  }, [loadStatus, sourceId]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || typeof document === 'undefined') return undefined;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) {
      try {
        if (typeof dialog.showModal === 'function') dialog.showModal();
        else dialog.setAttribute('open', '');
      } catch {
        dialog.setAttribute('open', '');
      }
    }
    const autofocus = dialog.querySelector<HTMLElement>('[data-identity-autofocus]');
    autofocus?.focus({ preventScroll: true });
    return () => {
      if (dialog.open) dialog.close();
      else dialog.removeAttribute('open');
      const previous = previousFocusRef.current;
      if (previous?.isConnected && !previous.closest('[inert]')) previous.focus({ preventScroll: true });
    };
  }, []);

  const selectedFrom = useMemo(() => status?.orphans.find((concept) => concept.conceptId === fromConceptId) ?? null, [fromConceptId, status?.orphans]);
  const selectedTo = useMemo(() => status?.targets.find((concept) => concept.conceptId === toConceptId) ?? null, [status?.targets, toConceptId]);
  const oldConcepts = useMemo(() => sortIdentityConcepts(filterIdentityConcepts(status?.orphans ?? [], oldQuery)), [oldQuery, status?.orphans]);
  const targetConcepts = useMemo(() => {
    const filtered = filterIdentityConcepts(status?.targets ?? [], targetQuery);
    return sortIdentityTargets(filtered, selectedFrom?.sourceRevision ?? null);
  }, [selectedFrom?.sourceRevision, status?.targets, targetQuery]);
  const bindings = useMemo(() => recentIdentityBindings(status?.bindings ?? []), [status?.bindings]);
  const totalBindings = status?.bindings.length ?? 0;
  const selectionLocked = previewLoading || commitLoading || Boolean(commitRequest) || needsRepreview || Boolean(receipt);
  const sourceMatchesPreview = Boolean(preview && preview.sourceId === sourceId);
  const previewCanLink = Boolean(preview && preview.canLink && sourceMatchesPreview && !lockedReason && !needsRepreview);
  const canPreview = Boolean(selectedFrom && selectedTo && !previewLoading && !commitLoading && !commitRequest && !needsRepreview && !receipt && !lockedReason);
  const canCommit = Boolean(previewCanLink && confirmed && previewRequest && !commitLoading && !commitRequest && !receipt)
    || Boolean(previewCanLink && confirmed && previewRequest && commitRequest && !commitLoading && !receipt);
  const refreshDisabled = loading || previewLoading || commitLoading || Boolean(commitRequest);

  const selectFrom = (conceptId: string) => {
    if (selectionLocked) return;
    clearPreview();
    setFromConceptId(conceptId);
    setToConceptId(null);
    setTargetQuery('');
  };

  const selectTo = (conceptId: string) => {
    if (selectionLocked) return;
    clearPreview();
    setToConceptId(conceptId || null);
  };

  const previewNow = async (explicitRetry = false) => {
    if (!selectedFrom || !selectedTo || previewBusyRef.current || commitBusyRef.current || lockedReason || receipt) return;
    if (needsRepreview && !explicitRetry) return;
    if (commitRequest && !explicitRetry) return;
    if (explicitRetry) {
      setNeedsRepreview(false);
      setCommitRequest(null);
      setCommitError(null);
      setConfirmed(false);
      setReceipt(null);
    }
    const request: IdentityLinkRequest = { fromConceptId: selectedFrom.conceptId, toConceptId: selectedTo.conceptId };
    const version = ++previewVersionRef.current;
    previewBusyRef.current = true;
    setPreviewLoading(true);
    setPreviewError(null);
    setCommitError(null);
    setPreview(null);
    setPreviewRequest(request);
    setConfirmed(false);
    try {
      const result = await onPreview(request);
      if (!mountedRef.current || sourceRef.current !== sourceId || previewVersionRef.current !== version) return;
      setPreview(result);
      if (result.sourceId !== sourceId) setPreviewError('服务器返回的知识空间与当前页面不一致，不能确认绑定。');
    } catch (error: unknown) {
      if (!mountedRef.current || sourceRef.current !== sourceId || previewVersionRef.current !== version) return;
      setPreviewError(`预览失败：${errorText(error)}`);
    } finally {
      if (mountedRef.current && sourceRef.current === sourceId && previewVersionRef.current === version) {
        previewBusyRef.current = false;
        setPreviewLoading(false);
      }
    }
  };

  const commit = async () => {
    if (!preview || !previewRequest || !canCommit || commitBusyRef.current) return;
    commitBusyRef.current = true;
    const version = ++commitVersionRef.current;
    const request = commitRequest ?? buildIdentityLinkCommit(previewRequest, preview, createIdentityOperationId());
    setCommitRequest(request);
    setCommitLoading(true);
    setCommitError(null);
    try {
      const result = await onCommit(request);
      if (!mountedRef.current || sourceRef.current !== sourceId || commitVersionRef.current !== version) return;
      if (result.sourceId !== sourceId || result.operationId !== request.operationId) {
        setCommitError('服务器返回的绑定回执与当前请求不一致；原请求已保留，可重试同一请求。');
        return;
      }
      setReceipt(result);
      setCommitRequest(null);
      setCommitError(null);
      setNeedsRepreview(false);
      try { onLinked(result); } catch { /* A successful receipt remains successful if UI refresh fails. */ }
    } catch (error: unknown) {
      if (!mountedRef.current || sourceRef.current !== sourceId || commitVersionRef.current !== version) return;
      if (errorCode(error) === 'IDENTITY_STALE') {
        setNeedsRepreview(true);
        setCommitRequest(null);
        setConfirmed(false);
        setCommitError('绑定预览已过期（IDENTITY_STALE），请重新预览；原请求不会自动重放。');
      } else {
        setCommitError(`绑定尚未确认完成：${errorText(error)}。可以重试同一个绑定请求。`);
      }
    } finally {
      if (mountedRef.current && sourceRef.current === sourceId && commitVersionRef.current === version) {
        commitBusyRef.current = false;
        setCommitLoading(false);
      }
    }
  };

  const close = () => {
    if (commitBusyRef.current || commitLoading) return;
    // Closing may unmount the dialog asynchronously; invalidate an in-flight
    // preview immediately so a late response cannot repopulate it.
    previewVersionRef.current += 1;
    onClose();
  };

  return <dialog
    ref={dialogRef}
    className="identity-dialog"
    aria-labelledby={titleId}
    aria-modal="true"
    aria-busy={loading || previewLoading || commitLoading}
    onCancel={(event) => { if (commitBusyRef.current || commitLoading) event.preventDefault(); else { event.preventDefault(); close(); } }}
  >
    <div className="identity-shell">
      <header className="identity-header">
        <div>
          <span className="identity-kicker">知识源迁移 · 历史保留</span>
          <h2 id={titleId}>历史衔接</h2>
          <p>请先在知识库中改名或移动文件，再刷新知识源。确认是同一概念后，系统会沿用旧节点 ID；学习事件和原时间不会改写。</p>
        </div>
        <button type="button" className="identity-close" onClick={close} disabled={commitLoading} aria-label="关闭历史衔接窗口">×</button>
      </header>

      <div className="identity-body">
        {lockedReason ? <div className="identity-lock" role="alert">当前暂不能开始新的历史衔接：{lockedReason}。已选概念和预览信息会保留，仍可关闭窗口。</div> : null}
        <section className="identity-section" aria-labelledby="identity-source-title">
          <div className="identity-section-heading">
            <div><h3 id="identity-source-title">选择旧概念</h3><p>只列出当前知识源中缺少来源文件的历史概念；路径未知时需要人工核对。</p></div>
            <button type="button" className="identity-secondary-button" disabled={refreshDisabled} onClick={() => void loadStatus()}>{loading ? '读取中…' : '刷新列表'}</button>
          </div>
          <label className="identity-search"><span>搜索旧概念</span><input data-identity-autofocus type="search" value={oldQuery} onChange={(event) => setOldQuery(event.target.value)} placeholder="标题、概念 ID、路径或版本" disabled={loading || selectionLocked} /></label>
          {loadError ? <div className="identity-error" role="alert"><span>历史衔接列表读取失败：{loadError}</span><button type="button" className="identity-secondary-button" disabled={loading} onClick={() => void loadStatus()}>重试</button></div> : null}
          {loading && !status ? <div className="identity-loading" role="status">正在读取可衔接的历史概念…</div> : null}
          {status && !oldConcepts.length && !loading ? <p className="identity-empty">没有符合搜索条件的旧概念。</p> : null}
          {status && oldConcepts.length ? <div className="identity-concept-list" role="listbox" aria-label="旧概念列表">
            {oldConcepts.map((concept) => <button
              type="button"
              role="option"
              aria-selected={fromConceptId === concept.conceptId}
              className={`identity-concept-option${fromConceptId === concept.conceptId ? ' is-selected' : ''}`}
              key={concept.conceptId}
              disabled={selectionLocked}
              onClick={() => selectFrom(concept.conceptId)}
            >
              <ConceptMeta concept={concept} kind="old" />
              <CountGrid counts={concept.counts} compact />
            </button>)}
          </div> : null}
          {status ? <p className="identity-list-meta">旧概念 {status.orphans.length} 个 · 当前页面只显示元数据和历史数量，不显示正文。</p> : null}
        </section>

        <section className="identity-section" aria-labelledby="identity-target-title">
          <div className="identity-section-heading"><div><h3 id="identity-target-title">选择当前目标</h3><p>系统只把来源版本相同的候选排在前面；不会自动替你选择或提交。</p></div></div>
          <label className="identity-search"><span>搜索当前概念</span><input type="search" value={targetQuery} onChange={(event) => setTargetQuery(event.target.value)} placeholder="标题、概念 ID、路径或版本" disabled={!selectedFrom || selectionLocked} /></label>
          <label className="identity-target-select"><span>目标概念</span><select value={toConceptId ?? ''} disabled={!selectedFrom || selectionLocked} onChange={(event) => selectTo(event.currentTarget.value)}>
            <option value="">请选择一个当前概念</option>
            {targetConcepts.map((concept) => <option key={concept.conceptId} value={concept.conceptId}>{matchRevision(selectedFrom, concept) ? '版本相同 · ' : ''}{concept.title || '未命名概念'} · {displayPath(concept.path)}</option>)}
          </select></label>
          {!selectedFrom ? <p className="identity-empty">先选择上方旧概念，再从当前概念中人工选择目标。</p> : null}
          {selectedTo ? <div className="identity-selected-target"><ConceptMeta concept={selectedTo} kind="target" /><CountGrid counts={selectedTo.counts} compact /><p>目标已有历史或身份绑定时，服务端会拒绝合并；请以预览检查结果为准。</p></div> : null}
          {selectedFrom && !selectedTo && targetConcepts.length === 0 ? <p className="identity-empty">没有符合搜索条件的当前概念。</p> : null}
        </section>

        {selectedFrom && selectedTo ? <section className="identity-preview" aria-labelledby="identity-preview-title">
          <div className="identity-preview-heading"><div><span className="identity-kicker">服务器预览</span><h3 id="identity-preview-title">核对历史衔接</h3></div><span className={`identity-can-link${previewCanLink ? ' is-allowed' : ' is-blocked'}`}>{preview ? (previewCanLink ? '可以确认' : '暂不能确认') : '尚未预览'}</span></div>
          <div className="identity-pair-grid">
            <div><span>旧概念 · 原始身份</span><ConceptMeta concept={selectedFrom} kind="old" /><CountGrid counts={selectedFrom.counts} /></div>
            <div><span>当前目标 · 新文件</span><ConceptMeta concept={selectedTo} kind="target" /><CountGrid counts={selectedTo.counts} /></div>
          </div>
          {preview ? <>
            <div className="identity-preview-meta"><span>旧路径：{displayPath(preview.from.path)}</span><span>新路径：{displayPath(preview.to.path)}</span><span>旧版本：{displayRevision(preview.from.sourceRevision)}</span><span>新版本：{displayRevision(preview.to.sourceRevision)}</span></div>
            <div className="identity-model-grid"><div><span>版本对应</span><strong>{preview.revisionMatches ? '版本相同' : '版本不同'}</strong></div><div><span>布局处理</span><strong>{layoutActionLabel(preview.layoutAction)}</strong></div><div><span>旧概念历史</span><strong>{countTotal(preview.from.counts)} 条</strong></div><div><span>目标概念历史</span><strong>{countTotal(preview.to.counts)} 条</strong></div></div>
            <IssueList issues={preview.issues} />
            {!preview.canLink && !preview.issues.length ? <p className="identity-error" role="alert">服务端不允许绑定这两个概念；目标可能已有学习记录或身份绑定，请保留当前历史并选择其他目标。</p> : null}
            {!preview.revisionMatches ? <p className="identity-warning">不同来源版本的历史会保留，事件时间不会改写；当前时间起点需要重新核对。已有长期保持也不会自动解除，仍需手工解除。</p> : null}
            {preview.canLink && sourceMatchesPreview && !needsRepreview && !receipt ? <label className="identity-confirm"><input type="checkbox" checked={confirmed} disabled={Boolean(lockedReason) || previewLoading || commitLoading || Boolean(commitRequest)} onChange={(event) => setConfirmed(event.currentTarget.checked)} /><span>我确认这是同一概念，并同意沿用旧节点 ID</span></label> : null}
          </> : null}
          {previewError ? <div className="identity-error" role="alert">{previewError}</div> : null}
          {commitError ? <div className="identity-error" role="alert">{commitError}</div> : null}
          {needsRepreview && !receipt ? <div className="identity-repreview"><span>预览已过期，必须重新读取服务端检查结果后才能继续。</span><button type="button" className="identity-secondary-button" disabled={previewLoading || commitLoading || Boolean(lockedReason)} onClick={() => void previewNow(true)}>重新预览</button></div> : null}
          {receipt ? <div className="identity-success" role="status"><strong>历史衔接已确认</strong><span>原始概念 ID {receipt.conceptId} 已沿用到 {receipt.linkedPath}。</span><small>操作 ID：{receipt.operationId} · 备份标识：{receipt.backupId} · 确认于 {formatDate(receipt.confirmedAt)}</small></div> : null}
          <div className="identity-preview-actions"><button type="button" className="identity-primary-button" disabled={!canPreview} onClick={() => void previewNow()}>{previewLoading ? '正在预览…' : '预览绑定影响'}</button><button type="button" className="identity-primary-button" disabled={!canCommit} onClick={() => void commit()}>{commitLoading ? '确认写入中…' : commitRequest ? '重试同一绑定' : '确认绑定'}</button><button type="button" className="identity-secondary-button" onClick={close} disabled={commitLoading}>关闭</button></div>
        </section> : null}

        {status && totalBindings > 0 ? <details className="identity-bindings"><summary>已有身份绑定（最近 {Math.min(BINDING_PREVIEW_LIMIT, totalBindings)} / {totalBindings} 条）</summary><p>这里只显示路径、时间和身份 ID，不显示知识正文。</p><ul>{bindings.map((binding) => <li key={binding.operationId}><strong>{binding.rawConceptId} → {binding.conceptId}</strong><span>{bindingPath(binding, 'from')} → {bindingPath(binding, 'to')}</span><time dateTime={binding.confirmedAt}>{formatDate(binding.confirmedAt)}</time></li>)}</ul>{totalBindings > bindings.length ? <small>还有 {totalBindings - bindings.length} 条更早的绑定未展开。</small> : null}</details> : null}
      </div>

      <footer className="identity-footer"><span>历史衔接只关联概念身份；学习事件、原发生时间和正文不会在此窗口改写。</span><button type="button" className="identity-footer-close" onClick={close} disabled={commitLoading}>完成</button></footer>
    </div>
  </dialog>;
}

export default IdentityDialog;
