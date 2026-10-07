import { useEffect, useMemo, useState, type ReactElement } from 'react';
import type { LearningOverviewItem } from '../shared/learning-overview.js';
import type {
  TimeRecallBand,
  TimeRecallCondition,
  TimeRecallEvidence,
  TimeRecallFocus,
} from '../shared/time-recall.js';
import { selectTimeRecall } from '../core/time-recall.js';

const PAGE_SIZE = 50;

type TimeRecallAnchorKind = 'review' | 'estimated';
type TimeRecallSelectionResult = ReturnType<typeof selectTimeRecall>;
type TimeRecallBandResult = TimeRecallSelectionResult['bands'][number];
type TimeRecallRowResult = TimeRecallSelectionResult['rows'][number];
type TimeRecallCounts = TimeRecallBandResult['ratings'];

export interface TimeRecallComparisonProps {
  items: readonly LearningOverviewItem[];
  disabled: boolean;
  onSelect: (item: LearningOverviewItem) => void;
}

const BAND_META: ReadonlyArray<{ band: TimeRecallBand; label: string; description: string }> = [
  { band: 'recent', label: '少于 1H', description: '记录当时的时间间隔小于一倍 H' },
  { band: 'revisit', label: '1H 至不足 2H', description: '记录当时的时间间隔达到 H 但不足 2H' },
  { band: 'stale', label: '至少 2H', description: '记录当时的时间间隔达到两倍 H' },
];

const RATING_LABELS: Record<keyof TimeRecallCounts, string> = {
  clear: '清晰',
  partial: '模糊',
  blank: '想不起',
};

const BAND_LABELS: Record<TimeRecallBand, string> = {
  recent: '少于 1H',
  revisit: '1H 至不足 2H',
  stale: '至少 2H',
};

function formatDate(value: string | null | undefined): string {
  if (!value) return '日期未知';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '日期未知';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function formatNumber(value: number | null | undefined, suffix = ''): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '未知';
  return `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value)}${suffix}`;
}

function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '0';
  return String(Math.max(0, Math.floor(value)));
}

function ratingLabel(rating: TimeRecallEvidence['rating']): string {
  return RATING_LABELS[rating] ?? '未记录';
}

function bandResult(selection: TimeRecallSelectionResult, band: TimeRecallBand): TimeRecallBandResult {
  const found = selection.bands.find((candidate) => candidate.band === band);
  return found ?? { band, count: 0, conceptCount: 0, ratings: { clear: 0, partial: 0, blank: 0 } };
}

function TimeRecallBandCard({
  band,
  count,
  ratings,
  conceptCount,
  maxCount,
}: TimeRecallBandResult & { maxCount: number }): ReactElement {
  const fill = maxCount > 0 && Number.isFinite(count) ? Math.min(100, Math.max(0, (count / maxCount) * 100)) : 0;
  const meta = BAND_META.find((candidate) => candidate.band === band) ?? BAND_META[0];
  return <li className={`time-recall-band time-recall-band-${band}`}>
    <div className="time-recall-band-heading">
      <div>
        <strong>{meta.label}</strong>
        <small>{meta.description}</small>
      </div>
      <strong className="time-recall-band-count">{formatCount(count)}</strong>
    </div>
    <div className="time-recall-band-track" aria-hidden="true"><span style={{ width: `${fill}%` }} /></div>
    <div className="time-recall-band-meta">
      <span>记录 {formatCount(count)} 条 · 概念 {formatCount(conceptCount) } 个</span>
      <span>清晰 {formatCount(ratings.clear)} · 模糊 {formatCount(ratings.partial)} · 想不起 {formatCount(ratings.blank)}</span>
    </div>
  </li>;
}

function TimeRecallRow({ row, disabled, onSelect }: {
  row: TimeRecallRowResult;
  disabled: boolean;
  onSelect: (item: LearningOverviewItem) => void;
}): ReactElement {
  const { item, evidence } = row;
  return <tr className="time-recall-row" data-time-recall-item="true">
    <td className="time-recall-concept-cell">
      <button
        type="button"
        className="time-recall-concept"
        aria-label={`查看节点：${item.title}`}
        disabled={disabled}
        onClick={() => onSelect(item)}
      >
        <strong>{item.title}</strong>
        <small>{item.domainId} · {item.conceptId}</small>
      </button>
    </td>
    <td>
      <div className="time-recall-detail">
        <strong>{ratingLabel(evidence.rating)}{evidence.evidenceMode === 'mental' ? ' · 脑中自报' : ''}</strong>
        <small>{evidence.evidenceMode === 'written' ? '书面回答' : evidence.evidenceMode === 'mental' ? '未记录原答，不视为独立作答' : '作答方式未记录'}</small>
        <time dateTime={evidence.observedAt}>{formatDate(evidence.observedAt)}</time>
        <small>时间起点：{formatDate(evidence.anchorOccurredAt)}</small>
      </div>
    </td>
    <td>
      <dl className="time-recall-frozen">
        <div><dt>当时距重温</dt><dd>{formatNumber(evidence.elapsedDays, ' 天')}</dd></div>
        <div><dt>时间指标 D</dt><dd>{formatNumber(evidence.decay)}</dd></div>
        <div><dt>当时 H</dt><dd>{formatNumber(evidence.halfLifeDays, ' 天')}</dd></div>
        <div><dt>参数版本</dt><dd>{formatCount(evidence.configRevision)}</dd></div>
      </dl>
    </td>
    <td><span className={`time-recall-band-label time-recall-band-label-${row.band}`}>{BAND_LABELS[row.band]}</span></td>
    <td><span className="time-recall-matching-count">{formatCount(row.matchingCount)} 条</span><small>同条件记录</small></td>
  </tr>;
}

function noConcepts(): ReactElement {
  return <div className="time-recall-empty">
    <strong>当前筛选没有概念</strong>
    <p>可以切换知识域或清空搜索，再查看时间与回忆对照。</p>
  </div>;
}

function legacyService(): ReactElement {
  return <div className="time-recall-empty time-recall-legacy" role="status">
    <strong>本地服务暂不支持时间与回忆对照</strong>
    <p>当前本地服务版本没有返回时间回忆数据，请更新或刷新本地服务后再查看；缺少这份数据不等于历史记录为 0。</p>
  </div>;
}

function noValidRecords(): ReactElement {
  return <div className="time-recall-empty time-recall-no-data" role="status">
    <strong>当前条件下暂无可对照记录</strong>
    <p>可以切换日期依据或提示条件，或确认 / 补记实际重温日期后完成一次回忆并保存自评。</p>
  </div>;
}

function exclusionNote(selection: TimeRecallSelectionResult): ReactElement {
  const scenario = selection.excluded.scenario;
  const missingTime = selection.excluded.missingTime;
  const invalidTime = selection.excluded.invalidTime;
  const unavailable = selection.unavailableConcepts;
  return <div className="time-recall-exclusions">
    <p>场景记录单独排除：{scenario} 条；这些记录不纳入时间与回忆对照。</p>
    {unavailable > 0 ? <p>{unavailable} 个概念缺少服务返回的数据，请更新或刷新服务后重试；不把它们当作 0 条历史。</p> : null}
    <details>
      <summary>查看被排除的时间记录</summary>
      <p>缺少时间 {missingTime} 条 · 时间无效 {invalidTime} 条。它们不会被当作想不起，也不会补成 0 天。</p>
    </details>
  </div>;
}

export function TimeRecallComparison({ items, disabled, onSelect }: TimeRecallComparisonProps): ReactElement {
  const [anchorKind, setAnchorKind] = useState<TimeRecallAnchorKind>('review');
  const [condition, setCondition] = useState<TimeRecallCondition>('unexposed');
  const [focus, setFocus] = useState<TimeRecallFocus>('all');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  const hasTimeRecall = items.some((item) => item.timeRecall != null);
  const selection = useMemo<TimeRecallSelectionResult | null>(() => {
    if (!items.length || !hasTimeRecall) return null;
    const selected = selectTimeRecall(items, { anchorKind, condition, focus });
    return selected;
  }, [anchorKind, condition, focus, hasTimeRecall, items]);

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [anchorKind, condition, focus, items]);

  if (!items.length) return <section className="time-recall-comparison" aria-label="时间与回忆对照">{noConcepts()}</section>;
  if (!hasTimeRecall) return <section className="time-recall-comparison" aria-label="时间与回忆对照">{legacyService()}</section>;
  if (!selection) return <section className="time-recall-comparison" aria-label="时间与回忆对照">{noValidRecords()}</section>;

  const bands = BAND_META.map(({ band }) => bandResult(selection, band));
  const maxCount = Math.max(0, ...bands.map((band) => Number.isFinite(band.count) ? band.count : 0));
  const rows = selection.rows;
  const visibleRows = rows.slice(0, visibleCount);

  return <section className="time-recall-comparison" aria-label="时间与回忆对照">
    <div className="time-recall-toolbar" aria-label="时间与回忆对照筛选">
      <label><span>时间起点</span><select aria-label="时间起点" value={anchorKind} onChange={(event) => setAnchorKind(event.target.value as TimeRecallAnchorKind)}>
        <option value="review">确认重温</option>
        <option value="estimated">估计日期</option>
      </select></label>
      <label><span>材料状态</span><select aria-label="材料状态" value={condition} onChange={(event) => setCondition(event.target.value as TimeRecallCondition)}>
        <option value="unexposed">未报告提示</option>
        <option value="assisted">提示或查阅</option>
        <option value="unknown">条件不明</option>
      </select></label>
      <label><span>关注</span><select aria-label="关注" value={focus} onChange={(event) => setFocus(event.target.value as TimeRecallFocus)}>
        <option value="all">全部</option>
        <option value="recent-difficulty">近期仍模糊</option>
        <option value="stale-clear">较久仍清晰</option>
      </select></label>
    </div>

    <div className="time-recall-explanation">
      <p>按每次回忆保存的间隔与 H 分组；时间指标 D 不是回忆概率。记录是本人自评，未报告提示不证明无近期接触，同一概念重复练习不等于独立实验。</p>
      <p>后续重温或调整 H 不会改写过去的记录。条形长度表示记录数量；同一概念可能有多次练习记录。</p>
    </div>

    <ol className="time-recall-bands" aria-label="时间阶段统计">
      {bands.map((band) => <TimeRecallBandCard key={band.band} {...band} maxCount={maxCount} />)}
    </ol>

    <div className="time-recall-result-meta">
      <span>样本 {formatCount(selection.sampleCount)} 条 · 概念 {formatCount(selection.conceptCount)} 个</span>
      <span>焦点筛选只影响下方列表，阶段统计保持完整</span>
    </div>

    {selection.sampleCount === 0 ? noValidRecords() : null}
    {selection.sampleCount > 0 && !rows.length ? <div className="time-recall-empty time-recall-focus-empty" role="status"><strong>当前关注条件没有匹配概念</strong><p>可以切换“关注”条件；上面的时间阶段统计仍保留全部样本。</p></div> : null}

    {rows.length > 0 ? <>
      <div className="time-recall-table-wrap">
        <table className="time-recall-table">
          <thead><tr><th scope="col">概念</th><th scope="col">观察日期与自评</th><th scope="col">当时的时间指标</th><th scope="col">时间阶段</th><th scope="col">匹配记录</th></tr></thead>
          <tbody>{visibleRows.map((row) => <TimeRecallRow key={`${row.item.conceptId}:${row.evidence.eventId}`} row={row} disabled={disabled} onSelect={onSelect} />)}</tbody>
        </table>
      </div>
      {visibleCount < rows.length ? <button type="button" className="time-recall-more" onClick={() => setVisibleCount((count) => Math.min(count + PAGE_SIZE, rows.length))}>显示更多（每批 {PAGE_SIZE} 条）</button> : null}
    </> : null}

    {exclusionNote(selection)}
  </section>;
}

export default TimeRecallComparison;
