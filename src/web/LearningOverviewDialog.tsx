import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type {
  LearningOverview,
  LearningOverviewFilter,
  LearningOverviewItem,
  OverviewObservation,
} from '../shared/learning-overview.js';
import {
  overviewHasRecallDifficulty,
  overviewNeedsScenarioCheck,
  selectLearningOverviewItems,
} from '../core/learning-overview.js';
import { TimeRecallComparison } from './TimeRecallComparison.js';

const PAGE_SIZE = 50;
type LearningOverviewView = 'overview' | 'time-recall';

const FILTERS: ReadonlyArray<{ value: LearningOverviewFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'recall', label: '回忆困难' },
  { value: 'scenario', label: '场景待核对' },
  { value: 'calibration', label: '信心对照' },
  { value: 'unobserved', label: '缺少练习证据' },
];

const STATUS_LABELS: Record<LearningOverviewItem['memory']['status'], string> = {
  unknown: '未评估',
  recent: '近期',
  revisit: '需要再访',
  stale: '较久未重温',
  pending: '待确认',
  retained: '长期保持',
};

const RATING_LABELS: Record<OverviewObservation['rating'], string> = {
  clear: '清晰',
  partial: '模糊',
  blank: '想不起',
};

const OUTCOME_LABELS: Record<OverviewObservation['outcome'], string> = {
  success: '成功',
  partial: '部分成功',
  failure: '未成功',
  unverified: '未核对',
};

const CUE_LABELS: Record<OverviewObservation['cue'], string> = {
  independent: '独立想到',
  hinted: '得到提示',
  lookup: '查阅资料',
  unknown: '方式不明',
};

const EXPOSURE_LABELS: Record<OverviewObservation['exposure'], string> = {
  unexposed: '未查看资料',
  exposed: '看过资料',
  unknown: '资料状态不明',
};

export interface LearningOverviewDialogProps {
  overview: LearningOverview | null;
  loading: boolean;
  error: string | null;
  initialDomainId: string | null;
  pendingCount: number;
  onRefresh: () => void;
  onClose: () => void;
  onSelect: (item: LearningOverviewItem) => void;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '日期未知';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '日期未知';
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
}

function formatElapsed(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '暂无重温间隔';
  return `距上次重温 ${value < 10 ? value.toFixed(1) : Math.round(value)} 天`;
}

function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '未知';
  return `${value.toFixed(0)}%`;
}

function formatGap(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '未知';
  return `${value > 0 ? '+' : ''}${value.toFixed(0)} 个百分点`;
}

function latestRecall(item: LearningOverviewItem): ReactElement {
  const latest = item.recall.latest;
  if (!latest) return <span className="learning-overview-muted">暂无回忆记录</span>;
  return <>
    <strong>{RATING_LABELS[latest.rating]}</strong>
    <small>{formatDate(latest.observedAt)} · {latest.observedExposure ? '已查看资料' : EXPOSURE_LABELS[latest.exposure]}</small>
  </>;
}

function latestScenario(item: LearningOverviewItem): ReactElement {
  const latest = item.scenario.latest;
  if (!latest) return <span className="learning-overview-muted">暂无场景证据</span>;
  return <>
    <strong>{OUTCOME_LABELS[latest.outcome]} · {CUE_LABELS[latest.cue]}</strong>
    <small>{formatDate(latest.observedAt)} · {latest.observedExposure ? '已查看资料' : EXPOSURE_LABELS[latest.exposure]} · 共 {item.scenario.total} 次</small>
  </>;
}

function calibrationBlock(label: string, value: LearningOverviewItem['calibration']['concept']): ReactElement {
  if (!value.count) return <div className="learning-overview-calibration-row"><span>{label}</span><small>暂无可校准样本</small></div>;
  return <div className="learning-overview-calibration-row">
    <span>{label} · n={value.count}</span>
    <small>信心 {formatPercent(value.meanConfidence)} · 成功 {formatPercent(value.successRate)} · 差值 {formatGap(value.gap)}</small>
  </div>;
}

function LearningOverviewRow({ item, disabled, onSelect }: {
  item: LearningOverviewItem;
  disabled: boolean;
  onSelect: (item: LearningOverviewItem) => void;
}): ReactElement {
  const recallDifficulty = overviewHasRecallDifficulty(item);
  const scenarioCheck = overviewNeedsScenarioCheck(item);
  return <tr className="learning-overview-row" data-overview-item="true">
    <td className="learning-overview-concept-cell">
      <button type="button" className="learning-overview-concept" aria-label={`查看节点：${item.title}`} disabled={disabled} onClick={() => onSelect(item)}>
        <strong>{item.title}</strong>
        <small>{item.domainId} · {item.conceptId}</small>
        <span className="learning-overview-badges">
          {recallDifficulty ? <span className="learning-overview-badge learning-overview-badge-warning">回忆困难</span> : null}
          {scenarioCheck ? <span className="learning-overview-badge learning-overview-badge-accent">场景待核对</span> : null}
        </span>
      </button>
    </td>
    <td>
      <div className={`learning-overview-status learning-overview-status-${item.memory.status}`}><strong>{STATUS_LABELS[item.memory.status]}</strong><small>{item.memory.estimated ? '补记起点 · ' : ''}{formatElapsed(item.memory.elapsedDays)}</small></div>
    </td>
    <td><div className="learning-overview-metric"><span>{latestRecall(item)}</span><small>累计 {item.recall.total} 次 · 清晰 {item.recall.clear} / 模糊 {item.recall.partial} / 空白 {item.recall.blank}</small></div></td>
    <td><div className="learning-overview-metric"><span>{latestScenario(item)}</span><small>独立成功 {item.scenario.independentSuccess} · 协助 {item.scenario.assisted}</small></div></td>
    <td><div className="learning-overview-calibration">{calibrationBlock('概念', item.calibration.concept)}{calibrationBlock('场景', item.calibration.scenario)}</div></td>
    <td><div className="learning-overview-metric"><strong>应用 {item.applications.application} · 总结 {item.applications.summary}</strong><small>当前观察 {item.evidence.currentObservations} · 既往观察 {item.evidence.previousObservations} · 既往应用 {item.evidence.previousApplications}</small><small>最近记录 {formatDate(item.evidence.latestAt ?? item.applications.latestAt)}</small></div></td>
  </tr>;
}

function noDataMessage(overview: LearningOverview | null, filtered: LearningOverviewItem[]): ReactElement {
  if (!overview) return <div className="learning-overview-empty"><strong>暂无总览数据</strong><p>点击刷新后读取已同步的学习记录。</p></div>;
  if (!overview.items.length) return <div className="learning-overview-empty"><strong>当前知识源没有概念</strong><p>请先添加或刷新知识源；已有概念即使还没有练习记录，也会在这里显示。</p></div>;
  if (!filtered.length) return <div className="learning-overview-empty"><strong>当前筛选没有结果</strong><p>可以切换筛选条件、知识域或清空搜索。</p></div>;
  return <></>;
}

export function LearningOverviewDialog({
  overview,
  loading,
  error,
  initialDomainId,
  pendingCount,
  onRefresh,
  onClose,
  onSelect,
}: LearningOverviewDialogProps): ReactElement {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [domainId, setDomainId] = useState('');
  const [filter, setFilter] = useState<LearningOverviewFilter>('all');
  const [query, setQuery] = useState('');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [view, setView] = useState<LearningOverviewView>('overview');

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || typeof document === 'undefined') return undefined;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    }
    const autofocus = dialog.querySelector<HTMLElement>('[data-learning-overview-autofocus]');
    autofocus?.focus({ preventScroll: true });
    return () => {
      if (dialog.open) dialog.close();
      else dialog.removeAttribute('open');
      const previous = previousFocusRef.current;
      if (previous?.isConnected && !previous.closest('[inert]')) previous.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [domainId, filter, query, overview?.sourceId]);

  const domains = useMemo(() => Array.from(new Set((overview?.items ?? []).map((item) => item.domainId).filter(Boolean))).sort((left, right) => left.localeCompare(right, 'zh-CN')), [overview?.items]);
  const filteredItems = useMemo(() => selectLearningOverviewItems(overview?.items ?? [], {
    domainId: domainId || undefined,
    filter,
    query,
  }), [domainId, filter, overview?.items, query]);
  const timeRecallItems = useMemo(() => selectLearningOverviewItems(overview?.items ?? [], {
    domainId: domainId || undefined,
    filter: 'all',
    query,
  }), [domainId, overview?.items, query]);
  const visibleItems = filteredItems.slice(0, visibleCount);
  const navigationDisabled = loading || Boolean(error);
  const dataVersion = overview?.asOf ? formatDate(overview.asOf) : '尚未读取';
  const timeRecallView = view === 'time-recall';
  const currentItems = timeRecallView ? timeRecallItems : filteredItems;

  return <dialog
    ref={dialogRef}
    className="learning-overview-dialog"
    aria-labelledby="learning-overview-title"
    aria-modal="true"
    onCancel={(event) => { event.preventDefault(); onClose(); }}
  >
    <div className="learning-overview-shell">
      <header className="learning-overview-header">
        <div>
          <span className="learning-overview-kicker">学习证据 · {timeRecallView ? '时间与回忆对照' : '薄弱点总览'}</span>
          <h2 id="learning-overview-title">{timeRecallView ? '时间与回忆对照' : '知识薄弱点总览'}</h2>
          <p className="learning-overview-subtitle">{timeRecallView ? '按记录当时的时间起点与回忆自评并列查看，保留每条记录冻结的时间参数。' : '按概念汇总回忆困难、场景调用和信心校准线索，帮助决定下一次练习从哪里开始。'}</p>
        </div>
        <button type="button" className="learning-overview-close" aria-label={`关闭${timeRecallView ? '时间与回忆对照' : '知识薄弱点总览'}`} onClick={onClose}>×</button>
      </header>

      <div className="learning-overview-body">
        {timeRecallView ? <div className="learning-overview-notes learning-overview-notes-compact">
          <p>当前资料版本 · 数据截至 {dataVersion} · 待同步记录：{Number.isFinite(pendingCount) && pendingCount > 0 ? `${Math.floor(pendingCount)} 条（本总览未包含）` : '0 条（本总览未包含）'}</p>
        </div> : <div className="learning-overview-notes">
          <p>仅统计已同步的学习证据与应用 / 总结元数据；不包含正文、业务场景、答案或待同步记录。</p>
          <p>当前资料版本 · 数据截至 {dataVersion} · 待同步记录：{Number.isFinite(pendingCount) && pendingCount > 0 ? `${Math.floor(pendingCount)} 条（本总览未包含）` : '0 条（本总览未包含）'}</p>
          <p>旧版本记录仅保留在计数中，不进入当前版本统计。百分比表示已核对结果，不是记忆率；信心对照来自自报核对，样本少时不推断稳定能力，也不生成综合评分。</p>
        </div>}

        <div className="learning-overview-toolbar" aria-label="总览筛选">
          <div className="learning-overview-view-switch" role="group" aria-label="总览视图">
            <button type="button" aria-pressed={!timeRecallView} className={!timeRecallView ? 'is-active' : ''} onClick={() => setView('overview')}>薄弱点总览</button>
            <button type="button" aria-pressed={timeRecallView} className={timeRecallView ? 'is-active' : ''} onClick={() => setView('time-recall')}>时间与回忆对照</button>
          </div>
          <label className="learning-overview-search"><span>搜索概念</span><input data-learning-overview-autofocus type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="标题或概念 ID" /></label>
          <label className="learning-overview-domain"><span>知识域</span><select value={domainId} onChange={(event) => setDomainId(event.target.value)}><option value="">全部领域</option>{domains.map((domain) => <option key={domain} value={domain}>{domain}</option>)}</select></label>
          {initialDomainId ? <button type="button" className="learning-overview-current-domain" onClick={() => setDomainId(initialDomainId)} disabled={!domains.includes(initialDomainId)}>当前领域：{initialDomainId}</button> : null}
          {!timeRecallView ? <div className="learning-overview-filter-group" role="group" aria-label="薄弱点筛选">{FILTERS.map((item) => <button type="button" key={item.value} className={filter === item.value ? 'is-active' : ''} aria-pressed={filter === item.value} onClick={() => setFilter(item.value)}>{item.label}</button>)}</div> : null}
          <button type="button" className="learning-overview-refresh" disabled={loading} onClick={onRefresh}>{loading ? '刷新中…' : '刷新数据'}</button>
        </div>

        {loading && overview ? <p className="learning-overview-status-note" role="status">正在刷新总览；已有数据暂时保留，查看节点操作暂不可用。</p> : null}
        {error ? <div className="learning-overview-error" role="alert"><span>总览加载失败：{error}</span>{!overview ? <button type="button" onClick={onRefresh} disabled={loading}>重试</button> : null}</div> : null}
        {loading && !overview ? <div className="learning-overview-loading" role="status">正在加载知识薄弱点总览…</div> : null}
        {!error && !loading && !overview ? noDataMessage(overview, currentItems) : null}
        {overview && overview.items.length === 0 ? noDataMessage(overview, currentItems) : null}
        {!timeRecallView && overview && overview.items.length > 0 && filteredItems.length === 0 ? noDataMessage(overview, filteredItems) : null}

        {!timeRecallView && overview && filteredItems.length > 0 ? <>
          <div className="learning-overview-result-meta"><span>显示 {visibleItems.length} / {filteredItems.length} 个概念</span><span>点击概念名称查看节点</span></div>
          <div className="learning-overview-table-wrap">
            <table className="learning-overview-table">
              <thead><tr><th scope="col">概念</th><th scope="col">时间状态</th><th scope="col">最近回忆</th><th scope="col">场景调用</th><th scope="col">信心对照</th><th scope="col">练习与应用</th></tr></thead>
              <tbody>{visibleItems.map((item) => <LearningOverviewRow key={item.conceptId} item={item} disabled={navigationDisabled} onSelect={onSelect} />)}</tbody>
            </table>
          </div>
          {visibleCount < filteredItems.length ? <button type="button" className="learning-overview-more" onClick={() => setVisibleCount((count) => Math.min(count + PAGE_SIZE, filteredItems.length))}>显示更多（每批 {PAGE_SIZE} 条）</button> : null}
        </> : null}
        {timeRecallView && overview && overview.items.length > 0 ? <TimeRecallComparison items={timeRecallItems} disabled={navigationDisabled} onSelect={onSelect} /> : null}
      </div>
      <footer className="learning-overview-footer"><span>总览只提供练习线索；选择概念后可在节点详情中进行回忆、场景调用或记录应用。</span><button type="button" className="learning-overview-footer-close" onClick={onClose}>完成</button></footer>
    </div>
  </dialog>;
}

export default LearningOverviewDialog;
