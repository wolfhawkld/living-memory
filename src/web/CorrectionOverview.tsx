import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { selectCorrectionOverviewItems } from '../core/correction-overview.js';
import type {
  CorrectionOverview as CorrectionOverviewData,
  CorrectionOverviewFilter,
  CorrectionOverviewItem,
} from '../shared/correction-overview.js';

const PAGE_SIZE = 50;

const FILTERS: ReadonlyArray<{ value: CorrectionOverviewFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'actionable', label: '待跟进' },
  { value: 'open', label: '待处理' },
  { value: 'recheck', label: '版本待复核' },
  { value: 'resolved', label: '当前已纳入' },
  { value: 'dismissed', label: '暂不采用' },
];

const STATUS_LABELS: Record<CorrectionOverviewItem['status'], string> = {
  open: '待处理',
  resolved: '当前已纳入',
  dismissed: '暂不采用',
};

export interface CorrectionOverviewProps {
  overview: CorrectionOverviewData | undefined;
  domainId?: string;
  query?: string;
  disabled: boolean;
  onSelect?: (item: CorrectionOverviewItem) => void;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '日期未知';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '日期未知';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(date);
}

function formatCount(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '0';
  return String(Math.max(0, Math.floor(value)));
}

function legacyService(): ReactElement {
  return <div className="correction-overview-empty correction-overview-legacy" role="status">
    <strong>当前本地服务暂不支持知识修正待办</strong>
    <p>当前服务没有返回修正待办数据，请更新或刷新本地服务后再查看；缺少这个字段不等于没有修正记录。</p>
  </div>;
}

function emptyResult(hasItems: boolean): ReactElement {
  return <div className="correction-overview-empty" role="status">
    <strong>{hasItems ? '当前筛选没有修正待办' : '当前没有可定位的修正待办'}</strong>
    <p>{hasItems ? '可以切换处理状态、知识域或清空搜索。' : '在应用或总结中填写「知识修正建议」后，对应记录会出现在这里。若有不可定位历史，请先刷新知识源。'}</p>
  </div>;
}

function statusLabel(item: CorrectionOverviewItem): string {
  if (item.needsRecheck) return '曾确认纳入';
  return STATUS_LABELS[item.status] ?? '状态未知';
}

function CorrectionOverviewRow({ item, disabled, onSelect }: {
  item: CorrectionOverviewItem;
  disabled: boolean;
  onSelect?: (item: CorrectionOverviewItem) => void;
}): ReactElement {
  const navigationDisabled = disabled || !onSelect;
  const recordKind = item.kind === 'summary' ? '总结' : '应用';
  return <li className="correction-overview-row" data-correction-overview-item="true">
    <div className="correction-overview-row-main">
      <button
        type="button"
        className="correction-overview-locate"
        aria-label={`定位原记录：${item.title}`}
        disabled={navigationDisabled}
        onClick={() => onSelect?.(item)}
      >
        <strong>{item.title}</strong>
        <small>{item.domainId || '未分配领域'} · {item.conceptId}</small>
        <span>定位原记录：{item.title}</span>
      </button>
      <div className="correction-overview-record-meta">
        <span className="correction-overview-kind">{recordKind}记录时间</span>
        <time dateTime={item.occurredAt}>{formatDate(item.occurredAt)}</time>
        <small>记录 ID：{item.applicationEventId}</small>
      </div>
    </div>

    <div className="correction-overview-decision">
      <span className={`correction-overview-status correction-overview-status-${item.status}`}>{statusLabel(item)}</span>
      <small>{item.latestOccurredAt ? `最近决定于 ${formatDate(item.latestOccurredAt)}` : '尚未有处理决定'}</small>
      {item.needsRecheck ? <span className="correction-overview-recheck">版本待复核</span> : null}
    </div>

    <div className="correction-overview-revisions">
      <small>原记录资料版本：{item.applicationRevision || '未知'}</small>
      <small>{item.reviewedRevision ? `最近核对资料版本：${item.reviewedRevision}` : '尚未记录核对资料版本'}</small>
      {item.sourceChanged
        ? <span>当前资料已变化；原建议可能来自旧资料版本。</span>
        : <span>当前资料版本：{item.sourceRevision || '未知'}</span>}
    </div>
  </li>;
}

export function CorrectionOverview({ overview, domainId, query, disabled, onSelect }: CorrectionOverviewProps): ReactElement {
  const [filter, setFilter] = useState<CorrectionOverviewFilter>('actionable');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const normalizedDomain = domainId?.trim() || undefined;
  const normalizedQuery = query ?? '';

  const selectedItems = useMemo(() => overview
    ? selectCorrectionOverviewItems(overview.items, { domainId: normalizedDomain, query: normalizedQuery, filter })
    : [], [filter, normalizedDomain, normalizedQuery, overview]);
  const scopedCounts = useMemo(() => {
    if (!overview) return null;
    const options = { domainId: normalizedDomain, query: normalizedQuery };
    return {
      all: selectCorrectionOverviewItems(overview.items, { ...options, filter: 'all' }).length,
      actionable: selectCorrectionOverviewItems(overview.items, { ...options, filter: 'actionable' }).length,
      open: selectCorrectionOverviewItems(overview.items, { ...options, filter: 'open' }).length,
      recheck: selectCorrectionOverviewItems(overview.items, { ...options, filter: 'recheck' }).length,
      resolved: selectCorrectionOverviewItems(overview.items, { ...options, filter: 'resolved' }).length,
      dismissed: selectCorrectionOverviewItems(overview.items, { ...options, filter: 'dismissed' }).length,
    } satisfies Record<CorrectionOverviewFilter, number>;
  }, [normalizedDomain, normalizedQuery, overview]);

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [filter, normalizedDomain, normalizedQuery, overview]);

  if (!overview) return <section className="correction-overview" aria-label="知识修正待办">{legacyService()}</section>;

  const visibleItems = selectedItems.slice(0, visibleCount);
  const navigationDisabled = disabled || !onSelect;
  return <section className="correction-overview" aria-label="知识修正待办">
    <div className="correction-overview-toolbar" aria-label="修正待办筛选">
      <div className="correction-overview-filter-group" role="group" aria-label="修正处理状态">
        {FILTERS.map((item) => <button
          type="button"
          key={item.value}
          className={filter === item.value ? 'is-active' : ''}
          aria-pressed={filter === item.value}
          onClick={() => setFilter(item.value)}
        >{item.label} <span>({formatCount(scopedCounts?.[item.value])})</span></button>)}
      </div>
    </div>

    {overview.unavailableCount > 0 ? <p className="correction-overview-unavailable" role="status">
      当前知识空间另有 {formatCount(overview.unavailableCount)} 条修正历史对应的概念当前不在知识索引中；历史仍保留，但暂时无法定位原记录。
    </p> : null}

    {selectedItems.length === 0 ? emptyResult(overview.items.length > 0) : <>
      <div className="correction-overview-result-meta">
        <span>显示 {visibleItems.length} / {selectedItems.length} 条</span>
        <span>{navigationDisabled ? '当前不可定位原记录' : '仅显示元数据，点击按钮定位原记录'}</span>
      </div>
      <ol className="correction-overview-list">
        {visibleItems.map((item) => <CorrectionOverviewRow key={item.applicationEventId} item={item} disabled={disabled} onSelect={onSelect} />)}
      </ol>
      {visibleCount < selectedItems.length ? <button type="button" className="correction-overview-more" onClick={() => setVisibleCount((count) => Math.min(count + PAGE_SIZE, selectedItems.length))}>显示更多（每批 {PAGE_SIZE} 条）</button> : null}
    </>}
  </section>;
}

export default CorrectionOverview;
