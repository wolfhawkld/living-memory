import { useEffect, useId, useRef, useState, type ChangeEvent, type ReactElement } from 'react';
import {
  DEFAULT_IMPORT_OPTIONS,
  MAX_IMPORT_BYTES,
  type ImportCommitRequest,
  type ImportConceptMatch,
  type ImportCounts,
  type ImportEventKind,
  type ImportIssue,
  type ImportOptions,
  type ImportPreview,
  type ImportPreviewRequest,
  type ImportReceipt,
} from '../shared/import-data.js';

const EVENT_KINDS: readonly ImportEventKind[] = ['anchors', 'observations', 'retentions', 'applications', 'corrections'];
const EVENT_LABELS: Record<ImportEventKind, string> = {
  anchors: '重温起点',
  observations: '回忆观察',
  retentions: '长期保持',
  applications: '应用 / 总结',
  corrections: '知识修正复核',
};

export interface ImportDataDialogProps {
  sourceId: string;
  accountLabel: string;
  lockedReason: string | null;
  onPreview: (request: ImportPreviewRequest) => Promise<ImportPreview>;
  onCommit: (request: ImportCommitRequest) => Promise<ImportReceipt>;
  onClose: () => void;
  onImported: (receipt: ImportReceipt) => void;
}

interface SelectedFile {
  name: string | null;
  size: number | null;
  data: unknown | null;
  reading: boolean;
  error: string | null;
}

export type ImportCommitFailureKind = 'stale' | 'unknown-file-options' | 'retry';

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

function isFileOrOptionsCode(code: string | null): boolean {
  if (!code) return false;
  const normalized = code.toUpperCase();
  return normalized === 'FILE' || normalized === 'OPTIONS'
    || normalized.includes('IMPORT_FILE') || normalized.includes('IMPORT_OPTIONS')
    || /(?:^|[_-])(FILE|OPTIONS)(?:$|[_-])/.test(normalized);
}

/** Keep retry policy deterministic so a failed commit never silently changes its request. */
export function classifyImportCommitFailure(error: unknown): ImportCommitFailureKind {
  const code = errorCode(error);
  if (code === 'IMPORT_STALE') return 'stale';
  if (isFileOrOptionsCode(code)) return 'unknown-file-options';
  return 'retry';
}

export function createImportId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return `import-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** Parse only a JSON object; callers keep the result in memory until the server preview. */
export function parseImportJsonText(text: string): unknown {
  if (typeof TextEncoder !== 'undefined' && new TextEncoder().encode(text).byteLength > MAX_IMPORT_BYTES) {
    throw new Error('文件超过 20 MiB 上限。');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('文件不是有效的 JSON。');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('导入文件必须是 JSON 对象。');
  }
  return parsed;
}

export function buildImportCommitRequest(
  previewRequest: ImportPreviewRequest,
  preview: ImportPreview,
  importId: string,
): ImportCommitRequest {
  return {
    data: previewRequest.data,
    options: { ...previewRequest.options },
    importId,
    previewToken: preview.token,
    confirmed: true,
  };
}

function finiteCount(value: number | null | undefined): number {
  return Number.isFinite(value) && value !== undefined && value !== null && value >= 0 ? Math.floor(value) : 0;
}

function formatBytes(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '大小未知';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MiB`;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '时间未知';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function matchLabel(match: ImportConceptMatch['match']): string {
  if (match === 'id') return '概念 ID 相同';
  if (match === 'path-revision') return '路径 + 版本精确迁移';
  return '未关联';
}

function safeMeta(value: string | null | undefined): string {
  return value && value.trim() ? value : '—';
}

function CountSummary({ counts }: { counts: ImportCounts }): ReactElement {
  return <div className="import-data-count-grid" aria-label="导入影响统计">
    {EVENT_KINDS.map((kind) => <div className="import-data-count-card" key={kind}>
      <span>{EVENT_LABELS[kind]}</span>
      <strong>{finiteCount(counts.added?.[kind])}</strong>
      <small>新增</small>
    </div>)}
    <div className="import-data-count-card import-data-count-card-muted"><span>重复记录</span><strong>{finiteCount(counts.duplicates)}</strong><small>幂等跳过</small></div>
    <div className="import-data-count-card import-data-count-card-muted"><span>配置变化</span><strong>{finiteCount(counts.configurations)}</strong><small>模型 / 参数</small></div>
    <div className="import-data-count-card import-data-count-card-muted"><span>未关联概念</span><strong>{finiteCount(counts.unresolvedConcepts)}</strong><small>历史保留</small></div>
  </div>;
}

function MatchTable({ matches, expanded, onExpand }: { matches: ImportConceptMatch[]; expanded: boolean; onExpand: () => void }): ReactElement {
  const visible = expanded ? matches : matches.slice(0, 50);
  const unresolved = matches.filter((item) => item.match === 'unresolved').length;
  return <section className="import-data-section" aria-labelledby="import-data-mapping-title">
    <div className="import-data-section-heading"><div><h3 id="import-data-mapping-title">来源版本与路径对应</h3><p>{matches.length} 条概念映射 · 未关联 {unresolved} 条</p></div>{matches.length > 50 ? <button type="button" className="import-data-secondary-button" onClick={onExpand}>{expanded ? '收起映射' : `显示其余 ${matches.length - 50} 条`}</button> : null}</div>
    {matches.length ? <div className="import-data-table-wrap"><table className="import-data-table"><thead><tr><th scope="col">概念</th><th scope="col">备份路径</th><th scope="col">备份版本</th><th scope="col">当前版本</th><th scope="col">对应关系</th></tr></thead><tbody>{visible.map((item) => <tr key={`${item.fromId}:${item.path}:${item.backupRevision ?? ''}`} className={item.match === 'unresolved' ? 'is-unresolved' : undefined}><td><strong>{safeMeta(item.title)}</strong><small>{item.toId ? `当前 ID：${item.toId}` : `备份 ID：${item.fromId}`}</small></td><td title={item.path}>{safeMeta(item.path)}</td><td>{safeMeta(item.backupRevision)}</td><td>{safeMeta(item.currentRevision)}</td><td><span className={`import-data-match import-data-match-${item.match}`}>{matchLabel(item.match)}</span></td></tr>)}</tbody></table></div> : <p className="import-data-muted">导出文件没有概念映射。</p>}
    {unresolved ? <p className="import-data-unresolved-note">未关联的历史记录会导入数据库并保留，但当前不会连接到知识图谱，也不会被当作当前节点的学习证据。</p> : null}
  </section>;
}

function IssueList({ issues, issueCount }: { issues: ImportIssue[]; issueCount: number }): ReactElement {
  const total = Math.max(issues.length, finiteCount(issueCount));
  if (!total) return <p className="import-data-ok-note" role="status">服务器没有发现需要处理的导入问题。</p>;
  const visible = issues.slice(0, 100);
  return <section className="import-data-section" aria-labelledby="import-data-issues-title">
    <div className="import-data-section-heading"><div><h3 id="import-data-issues-title">检查结果</h3><p>服务器报告 {total} 条提示或问题 · 当前显示 {visible.length} 条</p></div></div>
    {visible.length ? <ul className="import-data-issues">{visible.map((issue, index) => <li key={`${issue.code}:${issue.eventId ?? ''}:${issue.conceptId ?? ''}:${index}`} className={`import-data-issue import-data-issue-${issue.severity}`}><div><strong>{issue.severity === 'error' ? '阻止导入' : '提示'}</strong><span>{safeMeta(issue.code)}</span></div><p>{safeMeta(issue.message)}</p>{issue.eventId || issue.conceptId ? <small>{issue.eventId ? `事件 ${issue.eventId}` : ''}{issue.eventId && issue.conceptId ? ' · ' : ''}{issue.conceptId ? `概念 ${issue.conceptId}` : ''}</small> : null}</li>)}</ul> : <p className="import-data-muted">服务器报告了问题，但没有返回具体明细，请重新预览。</p>}
    {total > visible.length ? <p className="import-data-muted">还有 {total - visible.length} 条检查结果未展开。</p> : null}
  </section>;
}

export function ImportDataDialog({
  sourceId,
  accountLabel,
  lockedReason,
  onPreview,
  onCommit,
  onClose,
  onImported,
}: ImportDataDialogProps): ReactElement {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const mountedRef = useRef(true);
  const sourceRef = useRef(sourceId);
  const operationVersionRef = useRef(0);
  const commitVersionRef = useRef(0);
  const previewBusyRef = useRef(false);
  const commitBusyRef = useRef(false);
  sourceRef.current = sourceId;

  const [file, setFile] = useState<SelectedFile>({ name: null, size: null, data: null, reading: false, error: null });
  const [options, setOptions] = useState<ImportOptions>({ ...DEFAULT_IMPORT_OPTIONS });
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [previewRequest, setPreviewRequest] = useState<ImportPreviewRequest | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [showAllMatches, setShowAllMatches] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [commitRequest, setCommitRequest] = useState<ImportCommitRequest | null>(null);
  const [commitLoading, setCommitLoading] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [needsRepreview, setNeedsRepreview] = useState(false);
  const [receipt, setReceipt] = useState<ImportReceipt | null>(null);
  const titleId = useId();
  const fileId = useId();

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      operationVersionRef.current += 1;
      commitVersionRef.current += 1;
    };
  }, []);

  useEffect(() => {
    operationVersionRef.current += 1;
    commitVersionRef.current += 1;
    previewBusyRef.current = false;
    commitBusyRef.current = false;
    setFile({ name: null, size: null, data: null, reading: false, error: null });
    setOptions({ ...DEFAULT_IMPORT_OPTIONS });
    setPreview(null);
    setPreviewRequest(null);
    setPreviewLoading(false);
    setPreviewError(null);
    setShowAllMatches(false);
    setConfirmed(false);
    setCommitRequest(null);
    setCommitLoading(false);
    setCommitError(null);
    setNeedsRepreview(false);
    setReceipt(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [sourceId]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || typeof document === 'undefined') return undefined;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    }
    const autofocus = dialog.querySelector<HTMLElement>('[data-import-data-autofocus]');
    autofocus?.focus({ preventScroll: true });
    return () => {
      if (dialog.open) dialog.close();
      else dialog.removeAttribute('open');
      const previous = previousFocusRef.current;
      if (previous?.isConnected && !previous.closest('[inert]')) previous.focus({ preventScroll: true });
    };
  }, []);

  const clearPreview = () => {
    operationVersionRef.current += 1;
    setPreview(null);
    setPreviewRequest(null);
    setPreviewError(null);
    setShowAllMatches(false);
    setConfirmed(false);
    setCommitRequest(null);
    setCommitError(null);
    setNeedsRepreview(false);
    setReceipt(null);
  };

  const handleOptionsChange = (field: keyof ImportOptions, value: boolean) => {
    if (commitBusyRef.current || commitRequest || needsRepreview || receipt) return;
    clearPreview();
    setOptions((current) => ({ ...current, [field]: value }));
  };

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    if (commitBusyRef.current || commitRequest || needsRepreview || receipt) return;
    const selected = event.currentTarget.files?.[0] ?? null;
    event.currentTarget.value = '';
    clearPreview();
    if (!selected) {
      setFile({ name: null, size: null, data: null, reading: false, error: null });
      return;
    }
    const version = ++operationVersionRef.current;
    setFile({ name: selected.name, size: selected.size, data: null, reading: true, error: null });
    if (selected.size > MAX_IMPORT_BYTES) {
      setFile({ name: selected.name, size: selected.size, data: null, reading: false, error: '文件超过 20 MiB 上限。' });
      return;
    }
    try {
      const text = await selected.text();
      const data = parseImportJsonText(text);
      if (!mountedRef.current || sourceRef.current !== sourceId || operationVersionRef.current !== version) return;
      setFile({ name: selected.name, size: selected.size, data, reading: false, error: null });
    } catch (error: unknown) {
      if (!mountedRef.current || sourceRef.current !== sourceId || operationVersionRef.current !== version) return;
      setFile({ name: selected.name, size: selected.size, data: null, reading: false, error: `文件读取失败：${errorText(error)}` });
    }
  };

  const previewNow = async (explicitRetry = false) => {
    if (!file.data || file.reading || previewBusyRef.current || commitBusyRef.current || lockedReason || receipt) return;
    if (commitRequest && !explicitRetry) return;
    if (needsRepreview && !explicitRetry) return;
    if (explicitRetry) {
      setNeedsRepreview(false);
      setCommitRequest(null);
      setCommitError(null);
      setReceipt(null);
    }
    const request: ImportPreviewRequest = { data: file.data, options: { ...options } };
    const version = ++operationVersionRef.current;
    previewBusyRef.current = true;
    setPreviewLoading(true);
    setPreviewError(null);
    setPreview(null);
    setPreviewRequest(null);
    setShowAllMatches(false);
    setConfirmed(false);
    try {
      const result = await onPreview(request);
      if (!mountedRef.current || sourceRef.current !== sourceId || operationVersionRef.current !== version) return;
      setPreview(result);
      setPreviewRequest(request);
      if (result.sourceId !== sourceId) setPreviewError('服务器返回的知识空间与当前账号不一致，不能确认导入。');
    } catch (error: unknown) {
      if (!mountedRef.current || sourceRef.current !== sourceId || operationVersionRef.current !== version) return;
      setPreviewError(`预览失败：${errorText(error)}`);
    } finally {
      if (mountedRef.current && sourceRef.current === sourceId && operationVersionRef.current === version) {
        previewBusyRef.current = false;
        setPreviewLoading(false);
      }
    }
  };

  const close = () => {
    if (commitBusyRef.current || commitLoading) return;
    onClose();
  };

  const previewMatchesCurrentSource = Boolean(preview && preview.sourceId === sourceId);
  const canConfirm = Boolean(preview && preview.canImport && previewMatchesCurrentSource && !previewLoading && !commitLoading && !needsRepreview && !lockedReason && !receipt);
  const canCommit = canConfirm && confirmed && Boolean(previewRequest);

  const commit = async () => {
    if (!canCommit || !preview || !previewRequest || commitBusyRef.current) return;
    commitBusyRef.current = true;
    const version = ++commitVersionRef.current;
    const request = commitRequest ?? buildImportCommitRequest(previewRequest, preview, createImportId());
    setCommitRequest(request);
    setCommitLoading(true);
    setCommitError(null);
    try {
      const result = await onCommit(request);
      if (!mountedRef.current || sourceRef.current !== sourceId || commitVersionRef.current !== version) return;
      if (result.sourceId !== sourceId || result.importId !== request.importId) {
        setCommitError('服务器返回的导入回执与当前请求不一致；请重新预览此文件。');
        setNeedsRepreview(true);
        return;
      }
      setReceipt(result);
      setCommitRequest(null);
      setCommitError(null);
      setNeedsRepreview(false);
      onImported(result);
    } catch (error: unknown) {
      if (!mountedRef.current || sourceRef.current !== sourceId || commitVersionRef.current !== version) return;
      const policy = classifyImportCommitFailure(error);
      if (policy === 'stale') {
        setNeedsRepreview(true);
        setCommitError('导入预览已过期（IMPORT_STALE），请重新预览；原请求不会自动重放。');
      } else if (policy === 'unknown-file-options') {
        setNeedsRepreview(true);
        setCommitError('文件或导入选项的处理结果无法确认。为避免重复写入，已暂停自动重试；请重新预览此文件，系统不会自动重放原请求。');
      } else {
        setCommitError(`导入尚未确认完成：${errorText(error)}。可以重试同一个导入请求。`);
      }
    } finally {
      if (mountedRef.current && sourceRef.current === sourceId && commitVersionRef.current === version) {
        commitBusyRef.current = false;
        setCommitLoading(false);
      }
    }
  };

  const fileDisabled = commitLoading || Boolean(commitRequest) || needsRepreview || Boolean(receipt);
  const previewDisabled = !file.data || file.reading || previewLoading || commitLoading || Boolean(commitRequest) || Boolean(lockedReason) || needsRepreview || Boolean(receipt);
  const commitLabel = commitLoading ? '导入中…' : commitRequest ? '重试导入' : '确认导入';

  return <dialog
    ref={dialogRef}
    className="import-data-dialog"
    aria-labelledby={titleId}
    aria-modal="true"
    aria-busy={previewLoading || commitLoading}
    onCancel={(event) => { event.preventDefault(); close(); }}
  >
    <div className="import-data-shell">
      <header className="import-data-header">
        <div>
          <span className="import-data-kicker">学习数据 · 本地恢复</span>
          <h2 id={titleId}>导入学习数据</h2>
          <p>当前账号：{accountLabel || '当前账号'}。只导入学习记录、配置和可选布局，不导入知识 Markdown。</p>
        </div>
        <button type="button" className="import-data-close" onClick={close} disabled={commitLoading} aria-label="关闭导入窗口">×</button>
      </header>

      <div className="import-data-body">
        {lockedReason ? <div className="import-data-lock" role="alert">当前暂不能确认新导入：{lockedReason}。已选择的文件和预览结果会保留，关闭窗口仍然可用。</div> : null}
        <section className="import-data-section import-data-file-section" aria-labelledby="import-data-file-title">
          <div className="import-data-section-heading"><div><h3 id="import-data-file-title">选择备份文件</h3><p>文件只在本机解析，确认预览后才会发送给本地服务。</p></div><span className="import-data-size-limit">上限 20 MiB</span></div>
          <label className="import-data-file-picker" htmlFor={fileId}>
            <span>{file.name ? file.name : '选择 JSON 备份文件'}</span>
            <small>{file.name ? `${formatBytes(file.size)} · ${file.reading ? '读取中…' : file.error ? '读取失败' : '已在本机解析'}` : '通常来自“导出学习数据”下载'}</small>
            <input ref={fileInputRef} id={fileId} data-import-data-autofocus type="file" accept="application/json,.json" disabled={fileDisabled} onChange={(event) => void handleFileChange(event)} />
          </label>
          {file.error ? <p className="import-data-error" role="alert">{file.error}</p> : null}
        </section>

        <section className="import-data-section" aria-labelledby="import-data-options-title">
          <div className="import-data-section-heading"><div><h3 id="import-data-options-title">恢复选项</h3><p>修改文件或选项后，之前的预览和确认会自动作废，不会自动写入。</p></div></div>
          <div className="import-data-options">
            <label className="import-data-checkbox"><input type="checkbox" checked={options.restoreLayout} disabled={fileDisabled} onChange={(event) => handleOptionsChange('restoreLayout', event.currentTarget.checked)} /><span><strong>恢复备份布局</strong><small>同节点的备份坐标优先；不会改变知识内容。</small></span></label>
            <label className="import-data-checkbox"><input type="checkbox" checked={options.restoreReviewPlan} disabled={fileDisabled} onChange={(event) => handleOptionsChange('restoreReviewPlan', event.currentTarget.checked)} /><span><strong>恢复每日预算并合并重点 / 暂缓</strong><small>同节点的备份设置优先；不覆盖记忆事件。</small></span></label>
          </div>
          <button type="button" className="import-data-primary-button" disabled={previewDisabled} onClick={() => void previewNow()}>{previewLoading ? '正在预览…' : '预览导入影响'}</button>
          {needsRepreview && file.data && !receipt ? <div className="import-data-repreview"><p>当前导入请求的结果无法安全自动重试，需要重新取得服务端预览。</p><button type="button" className="import-data-secondary-button" disabled={previewLoading || commitLoading || Boolean(lockedReason)} onClick={() => void previewNow(true)}>重新预览此文件</button></div> : null}
        </section>

        {previewError ? <div className="import-data-error import-data-wide-error" role="alert">{previewError}</div> : null}
        {commitError ? <div className="import-data-error import-data-wide-error" role="alert">{commitError}</div> : null}

        {preview ? <section className="import-data-preview" aria-labelledby="import-data-preview-title">
          <div className="import-data-preview-heading"><div><span className="import-data-kicker">服务器预览</span><h3 id="import-data-preview-title">确认导入影响</h3></div><span className={`import-data-can-import ${preview.canImport && previewMatchesCurrentSource ? 'is-allowed' : 'is-blocked'}`}>{preview.canImport && previewMatchesCurrentSource ? '可以确认' : '暂不能确认'}</span></div>
          <div className="import-data-preview-meta"><span>备份生成：{formatDate(preview.exportedAt)}</span><span>{preview.sourceId === sourceId ? '对应当前账号知识空间' : '知识空间不一致'}</span><span>选项：{preview.options.restoreLayout ? '恢复布局' : '不恢复布局'} · {preview.options.restoreReviewPlan ? '恢复复习安排' : '不恢复复习安排'}</span></div>
          <CountSummary counts={preview.counts} />
          <div className="import-data-model-grid"><div><span>半衰时间 H（当前）</span><strong>{preview.config.before.halfLifeDays} 天</strong></div><div><span>半衰时间 H（备份）</span><strong>{preview.config.after.halfLifeDays} 天</strong></div><div><span>布局</span><strong>{preview.layoutChanged ? '将恢复变化' : '无变化'}</strong></div><div><span>复习安排</span><strong>{preview.reviewPlanChanged ? '将合并变化' : '无变化'}</strong></div></div>
          <MatchTable matches={preview.matches} expanded={showAllMatches} onExpand={() => setShowAllMatches((value) => !value)} />
          <IssueList issues={preview.issues} issueCount={preview.issueCount} />
          {!preview.canImport ? <p className="import-data-error" role="alert">服务器没有允许这次导入。请根据检查结果修正文件或选项后重新预览。</p> : null}
          {preview.canImport && previewMatchesCurrentSource && !needsRepreview && !receipt ? <label className="import-data-confirm"><input type="checkbox" checked={confirmed} disabled={!canConfirm} onChange={(event) => setConfirmed(event.currentTarget.checked)} /><span>我已核对以上对应关系及影响，导入到当前账号</span></label> : null}
          {receipt ? <div className="import-data-success" role="status"><strong>学习数据已导入</strong><span>{receipt.status === 'duplicate' ? '这是同一导入请求的幂等重试，服务端未重复写入。' : '服务端已确认写入当前账号。'}</span><small>导入 ID：{receipt.importId} · 备份回滚点：{receipt.backupId} · 完成于 {formatDate(receipt.importedAt)}</small><CountSummary counts={receipt.counts} /></div> : null}
          <div className="import-data-preview-actions"><button type="button" className="import-data-primary-button" disabled={!canCommit} onClick={() => void commit()}>{commitLabel}</button><button type="button" className="import-data-secondary-button" onClick={close} disabled={commitLoading}>关闭</button></div>
        </section> : null}

        {!preview && !previewLoading ? <div className="import-data-empty" role="status"><strong>先选择文件，再预览影响</strong><p>导入前会显示记录数量、版本对应关系、未关联历史和可选设置；知识正文与回答不会在这里展示。</p></div> : null}
        {previewLoading ? <div className="import-data-loading" role="status">正在向本地服务读取导入影响…</div> : null}
      </div>

      <footer className="import-data-footer"><span>导入只处理当前账号的学习数据；知识 Markdown 仍需先放入知识目录并刷新。</span><button type="button" className="import-data-footer-close" onClick={close} disabled={commitLoading}>完成</button></footer>
    </div>
  </dialog>;
}

export default ImportDataDialog;
