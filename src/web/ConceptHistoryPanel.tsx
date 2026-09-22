import { useState, type ReactElement } from 'react';
import type {
  AnchorEvent,
  ConceptHistory,
  ConceptHistoryEntry,
  MemoryState,
  Observation,
} from '../shared/types';

export interface ConceptHistoryPanelProps {
  history: ConceptHistory | null;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  onRetry: () => void;
  onLoadMore: () => void;
  onRevealAnswer: () => void;
  pendingCount: number;
  simulated: boolean;
}

export interface HistoryObservationAnswerProps {
  event: Observation;
  onRevealAnswer: () => void;
}

function formatDate(value: string | null | undefined, withTime = true): string {
  if (!value) return '日期未知';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '日期未知';
  return new Intl.DateTimeFormat('zh-CN', withTime
    ? { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
}

function formatNumber(value: number | null | undefined, digits = 3): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '未记录';
  return value.toFixed(digits);
}

function formatElapsed(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'Δt 未记录';
  return `Δt ${formatNumber(value, value < 10 ? 2 : 1)} 天`;
}

function anchorKindLabel(kind: AnchorEvent['kind']): string {
  return kind === 'estimated' ? '补记起点' : '重温起点';
}

function ratingLabel(rating: Observation['rating']): string {
  if (rating === 'clear') return '能解释';
  if (rating === 'partial') return '有些模糊';
  return '想不起';
}

function exposureLabel(event: Observation): string {
  if (event.observedExposure) return '资料已查看';
  if (event.exposure === 'unexposed') return '资料未查看';
  if (event.exposure === 'exposed') return '资料看过';
  return '资料是否查看：不确定';
}

function oldRevisionLabel(event: { sourceRevision: string }, history: ConceptHistory): string | null {
  return event.sourceRevision === history.sourceRevision ? null : '来源版本已变化 · 不用于当前曲线';
}

function statusLabel(state: MemoryState): string {
  if (state.status === 'retained') return '保留的时间起点 · 衰减暂停';
  if (state.status === 'pending') return '最新起点 · 待确认';
  return '当前有效起点';
}

function eventDate(entry: ConceptHistoryEntry): string {
  return entry.type === 'observation' ? entry.event.observedAt : entry.event.occurredAt;
}

/** An answer is inserted only after the user explicitly asks to reveal it. */
export function HistoryObservationAnswer({ event, onRevealAnswer }: HistoryObservationAnswerProps) {
  const [revealed, setRevealed] = useState(false);
  if (!revealed) {
    return (
      <button
        type="button"
        className="concept-history-answer-toggle"
        aria-expanded="false"
        onClick={() => {
          setRevealed(true);
          onRevealAnswer();
        }}
      >
        展开原始回答
      </button>
    );
  }
  return (
    <div className="concept-history-answer" aria-live="polite">
      {event.learning?.scenario ? <p className="concept-history-scenario">场景：{event.learning.scenario}</p> : null}
      <span className="concept-history-answer-label">原始回答</span>
      <p>{event.answer || '（空白回答）'}</p>
      {event.learning?.applicability ? <p className="concept-history-scenario">核对补充：{event.learning.applicability}</p> : null}
    </div>
  );
}

function CurrentAnchorSummary({ history }: { history: ConceptHistory }): ReactElement | null {
  const anchor = history.state.anchor;
  if (!anchor) return null;
  const oldRevision = oldRevisionLabel(anchor, history);
  return (
    <section className={`concept-history-anchor${history.state.status === 'pending' ? ' concept-history-anchor-is-pending' : ''}`} aria-label="当前时间起点">
      <div className="concept-history-anchor-heading">
        <span className="concept-history-kicker">时间起点</span>
        <strong>{statusLabel(history.state)}</strong>
      </div>
      <div className="concept-history-anchor-main">
        <time dateTime={anchor.occurredAt}>{formatDate(anchor.occurredAt)}</time>
        <span>{anchorKindLabel(anchor.kind)}</span>
      </div>
      <div className="concept-history-anchor-detail">
        <span>记录于 {formatDate(anchor.recordedAt)}</span>
        <span>来源版本 {anchor.sourceRevision}</span>
      </div>
      {history.state.status === 'pending' ? (
        <p className="concept-history-anchor-note">这个起点尚未确认，不计入当前有效曲线。</p>
      ) : null}
      {oldRevision ? <p className="concept-history-old-note">{oldRevision}</p> : null}
    </section>
  );
}

function AnchorEntry({ entry, history }: { entry: Extract<ConceptHistoryEntry, { type: 'anchor' }>; history: ConceptHistory }): ReactElement {
  const event = entry.event;
  const isCurrentAnchor = history.state.anchor?.eventId === event.eventId;
  const oldRevision = oldRevisionLabel(event, history);
  return (
    <li className={`concept-history-entry concept-history-entry-anchor${oldRevision ? ' concept-history-entry-is-old' : ''}`}>
      <span className="concept-history-dot" aria-hidden="true" />
      <div className="concept-history-entry-card">
        <div className="concept-history-entry-heading">
          <strong>{anchorKindLabel(event.kind)}</strong>
          {isCurrentAnchor ? <span className="concept-history-current-badge">{statusLabel(history.state)}</span> : null}
        </div>
        <time className="concept-history-event-time" dateTime={event.occurredAt}>{formatDate(event.occurredAt)}</time>
        <div className="concept-history-secondary">
          <span>记录于 {formatDate(event.recordedAt)}</span>
          <span>来源版本 {event.sourceRevision}</span>
        </div>
        {oldRevision ? <p className="concept-history-old-note">{oldRevision}</p> : null}
      </div>
    </li>
  );
}

function ObservationEntry({
  entry,
  history,
  onRevealAnswer,
}: {
  entry: Extract<ConceptHistoryEntry, { type: 'observation' }>;
  history: ConceptHistory;
  onRevealAnswer: () => void;
}): ReactElement {
  const event = entry.event;
  const oldRevision = oldRevisionLabel(event, history);
  return (
    <li className={`concept-history-entry concept-history-entry-observation${oldRevision ? ' concept-history-entry-is-old' : ''}`}>
      <span className="concept-history-dot" aria-hidden="true" />
      <div className="concept-history-entry-card">
        <div className="concept-history-entry-heading">
          <strong>{event.learning?.task === 'scenario' ? '场景调用观察' : '学习观察'}</strong>
          <span className="concept-history-rating">{event.learning?.task === 'scenario' ? { success: '适用', partial: '部分适用', failure: '未成功', unverified: '未核对' }[event.learning.outcome] : ratingLabel(event.rating)}</span>
        </div>
        <time className="concept-history-event-time" dateTime={event.observedAt}>{formatDate(event.observedAt)}</time>
        <div className="concept-history-secondary">
          <span>记录于 {formatDate(event.recordedAt)}</span>
          <span>来源版本 {event.sourceRevision}</span>
        </div>
        <div className="concept-history-metrics" aria-label="冻结的观察指标">
          <span>{formatElapsed(event.elapsedDays)}</span>
          <span>D {formatNumber(event.decay)}</span>
          <span>H {event.halfLifeDays} 天</span>
          <span>配置 v{event.configRevision}</span>
          <span>{exposureLabel(event)}</span>
        </div>
        {oldRevision ? <p className="concept-history-old-note">{oldRevision}</p> : null}
        {event.learning ? <div className="concept-history-learning">
          <div>事前信心：{event.learning.confidence === null ? '未预测' : `${event.learning.confidence}%`}</div>
          <div>作答方式：{{ independent: '独立作答', hinted: '借助提示', lookup: '查阅后作答', unknown: '不确定' }[event.learning.cue]}</div>
          <div>核对结果：{{ success: '成功', partial: '部分成功', failure: '未成功', unverified: '尚未核对' }[event.learning.outcome]} · {{ 'self-check': '自己对照资料', application: '实际应用核对', unknown: '依据未记录' }[event.learning.basis]}</div>
        </div> : null}
        <HistoryObservationAnswer event={event} onRevealAnswer={onRevealAnswer} />
      </div>
    </li>
  );
}

function HistoryEntry({ entry, history, onRevealAnswer }: {
  entry: ConceptHistoryEntry;
  history: ConceptHistory;
  onRevealAnswer: () => void;
}): ReactElement {
  if (entry.type === 'retention') return <li className="concept-history-entry">
    <span className="concept-history-dot" aria-hidden="true" />
    <div className="concept-history-entry-card">
      <strong>{entry.event.active ? '长期保持（本人确认）' : '手动恢复时间衰减'}</strong>
      <time className="concept-history-event-time" dateTime={entry.event.occurredAt}>{formatDate(entry.event.occurredAt)}</time>
      <div className="concept-history-secondary"><span>记录于 {formatDate(entry.event.recordedAt)}</span><span>来源版本 {entry.event.sourceRevision}</span></div>
      <p className="concept-history-old-note">{entry.event.active ? '固定保持，直到本人手动解除；未新增复习起点。' : '沿用原有重温起点；未新增复习起点。'}</p>
      {entry.event.sourceRevision !== history.sourceRevision ? <p className="concept-history-old-note">资料版本已变化，长期保持设置仍按本人最近一次选择执行。</p> : null}
    </div>
  </li>;
  return entry.type === 'anchor'
    ? <AnchorEntry entry={entry} history={history} />
    : <ObservationEntry entry={entry} history={history} onRevealAnswer={onRevealAnswer} />;
}

function PendingNotice({ count }: { count: number }): ReactElement | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  return <div className="concept-history-pending" role="status">还有 {Math.floor(count)} 条记录待同步；它们不会混入已保存历史。</div>;
}

export function ConceptHistoryPanel({
  history,
  loading,
  loadingMore,
  error,
  onRetry,
  onLoadMore,
  onRevealAnswer,
  pendingCount,
  simulated,
}: ConceptHistoryPanelProps) {
  // Before the first effect decides whether history is needed, avoid claiming
  // that the concept has no history. A pending count is still useful here.
  if (!history && !loading && !error && pendingCount <= 0) return null;

  return (
    <section className="concept-history-panel" aria-label="概念学习历史" aria-busy={loading || loadingMore ? true : undefined}>
      <div className="concept-history-heading">
        <div>
          <span className="concept-history-kicker">真实记录</span>
          <h2>学习历史</h2>
        </div>
        {history ? <span className="concept-history-total">已保存 {history.total} 条</span> : null}
      </div>

      <PendingNotice count={pendingCount} />
      {simulated ? <p className="concept-history-simulated" role="status">当前为时间预览，真实学习历史不会随预览时间改变。</p> : null}

      {error && history ? (
        <div className="concept-history-error" role="alert">
          <span>历史加载失败：{error}</span>
          <button type="button" onClick={onRetry}>重试</button>
        </div>
      ) : null}

      {!history && loading ? <div className="concept-history-loading" role="status">正在加载学习历史…</div> : null}
      {!history && !loading && error ? (
        <div className="concept-history-error concept-history-error-is-initial" role="alert">
          <p>历史加载失败：{error}</p>
          <button type="button" onClick={onRetry}>重试加载</button>
        </div>
      ) : null}

      {history ? (
        <>
          <CurrentAnchorSummary history={history} />
          {history.entries.length > 0 ? (
            <ol className="concept-history-timeline" aria-label="按发生时间排列的学习事件">
              {history.entries.map((entry) => (
                <HistoryEntry
                  key={`${entry.type}:${entry.event.eventId}`}
                  entry={entry}
                  history={history}
                  onRevealAnswer={onRevealAnswer}
                />
              ))}
            </ol>
          ) : (
            <p className="concept-history-empty">还没有已保存的学习记录。</p>
          )}
          {loading ? <div className="concept-history-loading" role="status">正在刷新历史…</div> : null}
          {history.nextCursor ? (
            <button
              type="button"
              className="concept-history-load-more"
              onClick={onLoadMore}
              disabled={loading || loadingMore}
            >
              {loadingMore ? '加载中…' : '加载更多历史'}
            </button>
          ) : null}
          {loadingMore ? <span className="concept-history-loading-more" role="status">正在加载更多…</span> : null}
        </>
      ) : null}
    </section>
  );
}
