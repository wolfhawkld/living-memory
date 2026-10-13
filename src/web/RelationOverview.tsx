import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { selectRelationOverviewItems } from '../core/relation-overview.js';
import type {
  RelationOverview as RelationOverviewData,
  RelationOverviewFilter,
  RelationOverviewItem,
} from '../shared/relation-overview.js';

const PAGE_SIZE = 50;
const FILTERS: ReadonlyArray<{ value: RelationOverviewFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'actionable', label: '待跟进' },
  { value: 'open', label: '待处理' },
  { value: 'recheck', label: '依据待复核' },
  { value: 'resolved', label: '当前已采纳' },
  { value: 'dismissed', label: '暂不采用' },
];
const OPERATION_LABELS: Record<RelationOverviewItem['operation'], string> = {
  add: '新增关系', change: '修改关系', remove: '移除关系',
};

export interface RelationOverviewProps {
  overview: RelationOverviewData | undefined;
  domainId?: string;
  query?: string;
  disabled: boolean;
  onSelect?: (item: RelationOverviewItem) => void;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '日期未知';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(date);
}

function formatCount(value: number): string {
  return String(Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0);
}

function statusLabel(item: RelationOverviewItem): string {
  if (item.chainInvalid) return '处理链异常／无法判定';
  if (item.status === 'resolved') return item.needsRecheck ? '曾确认采纳' : '当前已采纳';
  if (item.status === 'dismissed') return '暂不采用';
  if (item.status === 'open') return '待处理';
  return '状态未知';
}

function RelationOverviewRow({ item, disabled, onSelect }: {
  item: RelationOverviewItem;
  disabled: boolean;
  onSelect?: (item: RelationOverviewItem) => void;
}): ReactElement {
  const navigationDisabled = disabled || !onSelect;
  return <li className="relation-overview-row" data-relation-overview-item="true">
    <div className="relation-overview-row-main">
      <button type="button" className="relation-overview-locate"
        aria-label={`定位原记录：${item.title}`} disabled={navigationDisabled}
        onClick={() => onSelect?.(item)}>
        <strong>{item.title}</strong>
        <small>{item.domainId || '未分配领域'} · {item.conceptId}</small>
        <span>定位原记录：{item.title}</span>
      </button>
      <div className="relation-overview-record-meta">
        <span className="relation-overview-kind">{item.kind === 'summary' ? '总结' : '应用'}记录时间</span>
        <time dateTime={item.occurredAt}>{formatDate(item.occurredAt)}</time>
        <small>记录 ID：{item.applicationEventId}</small>
      </div>
    </div>

    <div className="relation-overview-endpoints" aria-label="有向关系建议">
      <strong>{OPERATION_LABELS[item.operation]}</strong>
      <div className="relation-overview-direction">
        <span><b>{item.source.title || item.source.conceptId}</b><small>起点 · {item.source.conceptId}</small>
          {!item.basis.source.current ? <small className="relation-overview-warning">当前起点不在知识索引中</small> : null}</span>
        <span className="relation-overview-arrow" aria-label="指向">→</span>
        <span><b>{item.target.title || item.target.conceptId}</b><small>终点 · {item.target.conceptId}</small>
          {!item.basis.target.current ? <small className="relation-overview-warning">当前终点不在知识索引中</small> : null}</span>
      </div>
    </div>

    <div className="relation-overview-decision">
      <span className={`relation-overview-status relation-overview-status-${item.chainInvalid ? 'invalid' : item.status ?? 'unknown'}`}>{statusLabel(item)}</span>
      <small>{item.chainInvalid
        ? '无法从处理链确定当前决定，请定位原记录核查。'
        : item.latestOccurredAt ? `最近决定于 ${formatDate(item.latestOccurredAt)}` : '尚未有处理决定'}</small>
      {item.needsRecheck ? <span className="relation-overview-recheck">依据待复核</span> : null}
      {item.basisChanged ? <small className="relation-overview-warning">{item.status === 'dismissed'
        ? '依据已变化；保留「暂不采用」决定。' : '核对依据已变化，请回原记录核对。'}</small> : null}
    </div>

    <div className="relation-overview-structure">
      <strong>结构提示</strong>
      <span>{item.structureMatches === null
        ? '端点缺失，结构未知'
        : item.structureMatches ? '符合建议结构，待本人核对' : '当前结构尚不符合建议，待本人核对'}</span>
      <small>结构提示不代表人工采纳决定。</small>
      <small>原记录资料版本：{item.applicationRevision || '未知'}</small>
      <small>{item.sourceChanged ? '当前主概念资料已变化；原建议可能来自旧资料版本。' : `当前主概念资料版本：${item.sourceRevision || '未知'}`}</small>
    </div>
  </li>;
}

export function RelationOverview({ overview, domainId, query, disabled, onSelect }: RelationOverviewProps): ReactElement {
  const [filter, setFilter] = useState<RelationOverviewFilter>('actionable');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const normalizedDomain = domainId?.trim() || undefined;
  const normalizedQuery = query ?? '';
  const selectedItems = useMemo(() => overview
    ? selectRelationOverviewItems(overview.items, { domainId: normalizedDomain, query: normalizedQuery, filter })
    : [], [overview, normalizedDomain, normalizedQuery, filter]);
  const scopedCounts = useMemo(() => Object.fromEntries(FILTERS.map(({ value }) => [value,
    overview ? selectRelationOverviewItems(overview.items, {
      domainId: normalizedDomain, query: normalizedQuery, filter: value,
    }).length : 0,
  ])) as Record<RelationOverviewFilter, number>, [overview, normalizedDomain, normalizedQuery]);

  useEffect(() => { setVisibleCount(PAGE_SIZE); }, [overview, normalizedDomain, normalizedQuery, filter]);

  if (!overview) return <section className="relation-overview" aria-label="关系建议待办">
    <div className="relation-overview-empty relation-overview-legacy" role="status">
      <strong>当前本地服务暂不支持关系建议待办</strong>
      <p>当前服务没有返回关系待办数据，请更新或刷新本地服务后再查看；缺少这个字段不等于没有关系建议记录。</p>
    </div>
  </section>;

  const visibleItems = selectedItems.slice(0, visibleCount);
  const navigationDisabled = disabled || !onSelect;
  return <section className="relation-overview" aria-label="关系建议待办">
    <div className="relation-overview-toolbar">
      <div className="relation-overview-filter-group" role="group" aria-label="关系建议处理状态">
        {FILTERS.map(({ value, label }) => <button type="button" key={value}
          className={filter === value ? 'is-active' : ''} aria-pressed={filter === value}
          onClick={() => setFilter(value)}>{label} <span>({formatCount(scopedCounts[value])})</span></button>)}
      </div>
    </div>

    {overview.unavailableCount > 0 ? <p className="relation-overview-unavailable" role="status">
      当前知识空间另有 {formatCount(overview.unavailableCount)} 条关系建议历史对应的主概念当前不在知识索引中；历史仍保留，但暂时无法定位原记录。
    </p> : null}

    {selectedItems.length === 0 ? <div className="relation-overview-empty" role="status">
      <strong>{overview.items.length > 0 ? '当前筛选没有关系待办' : '当前没有可定位的关系待办'}</strong>
      <p>{overview.items.length > 0 ? '可以切换处理状态、知识域或清空搜索。' : '在应用或总结中填写「关系建议」后，对应记录会出现在这里。若有不可定位历史，请先刷新知识源。'}</p>
    </div> : <>
      <div className="relation-overview-result-meta">
        <span>显示 {visibleItems.length} / {selectedItems.length} 条</span>
        <span>{navigationDisabled ? '当前不可定位原记录' : '仅显示元数据，点击按钮定位原记录'}</span>
      </div>
      <ol className="relation-overview-list">
        {visibleItems.map((item) => <RelationOverviewRow key={item.applicationEventId} item={item} disabled={disabled} onSelect={onSelect} />)}
      </ol>
      {visibleCount < selectedItems.length ? <button type="button" className="relation-overview-more"
        onClick={() => setVisibleCount((count) => Math.min(count + PAGE_SIZE, selectedItems.length))}>显示更多（每批 {PAGE_SIZE} 条）</button> : null}
    </>}
  </section>;
}

export default RelationOverview;
