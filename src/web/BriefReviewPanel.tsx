import { useId, type ReactElement } from 'react';

export interface BriefReviewPanelProps {
  domainLabel: string;
  candidateCount: number;
  budget: 3 | 5;
  disabledReason: string | null;
  onBudgetChange: (budget: 3 | 5) => void;
  onStart: () => void;
  daily?: {
    budget: number;
    completed: number;
    pending: number;
    remaining: number;
    timeZone: string;
  };
  onOpenPlan?: () => void;
  planDisabled?: boolean;
  suspended?: {
    domainLabel: string;
    index: number;
    total: number;
    savedAt: string;
    hasAnswer: boolean;
  };
  onResume?: () => void;
  onDiscard?: () => void;
  onCopyAnswer?: () => void;
  resumeError?: string | null;
}

export interface BriefReviewProgressProps {
  title: string;
  index: number;
  total: number;
  result: 'saved' | 'queued' | 'skipped' | 'unavailable';
  saved: number;
  queued: number;
  skipped: number;
  reviewStatus: 'idle' | 'saved' | 'queued';
  busy: boolean;
  lockedReason: string | null;
  reviewDisabledReason?: string | null;
  onReview: () => void;
  onNext: () => void;
  onEnd: () => void;
  onPause?: () => void;
}

function displayCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function displayReviewDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function resultMessage(result: BriefReviewProgressProps['result']): string {
  if (result === 'saved') return '本条观察已保存；观察不会自动改变重温时间。';
  if (result === 'queued') return '本条观察已进入待同步队列；观察不会自动改变重温时间。';
  if (result === 'skipped') return '本条已跳过，不改变重温时间。';
  return '本条状态或内容已变化，或有待同步记录，已跳过；不改变重温时间。';
}

function reviewStatusMessage(
  result: BriefReviewProgressProps['result'],
  reviewStatus: BriefReviewProgressProps['reviewStatus'],
): string {
  if (reviewStatus === 'saved') return '重温已确认。';
  if (reviewStatus === 'queued') return '重温已记录，待同步。';
  if (result === 'saved') return '只有明确确认本条已重温后，才会更新重温时间。';
  return '本条没有重温确认。';
}

export function BriefReviewPanel({
  domainLabel,
  candidateCount,
  budget,
  disabledReason,
  onBudgetChange,
  onStart,
  daily,
  onOpenPlan,
  planDisabled = false,
  suspended,
  onResume,
  onDiscard,
  onCopyAnswer,
  resumeError = null,
}: BriefReviewPanelProps): ReactElement {
  const budgetId = useId();
  const count = displayCount(candidateCount);
  const hasCandidates = count > 0;
  const startDisabled = !hasCandidates || disabledReason !== null || Boolean(suspended);
  const dailyBudget = daily ? displayCount(daily.budget) : 0;
  const dailyCompleted = daily ? displayCount(daily.completed) : 0;
  const dailyPending = daily ? displayCount(daily.pending) : 0;
  const dailyRemaining = daily ? displayCount(daily.remaining) : 0;
  const dailyExhausted = daily !== undefined && dailyRemaining === 0;
  const suspendedTotal = suspended ? Math.max(displayCount(suspended.total), 1) : 0;
  const suspendedIndex = suspended ? displayCount(suspended.index) : 0;
  const suspendedPosition = suspended ? `${Math.min(suspendedIndex + 1, suspendedTotal)} / ${suspendedTotal}` : null;

  return (
    <section className="brief-review-panel" aria-label="少量复习">
      <div className="brief-review-heading">
        <div className="brief-review-heading-main">
          <span className="brief-review-kicker">自愿练习</span>
          <h2>少量复习</h2>
        </div>
        <span className="brief-review-count">本轮 {count} 个</span>
      </div>
      <p className="brief-review-domain">当前领域：{domainLabel || '未选择'}</p>
      <p className="brief-review-description">
        按距重温时间排序，只选再访阶段，排除长期保持。
      </p>
      {daily ? <div className="brief-review-daily" aria-label="今日复习进度">
        <div className="brief-review-daily-metrics">
          <div><span>今日预算</span><strong>{dailyBudget} 个概念</strong></div>
          <div><span>已回忆</span><strong>{dailyCompleted} 个概念</strong></div>
          <div><span>剩余</span><strong>{dailyRemaining} 个概念</strong></div>
        </div>
        <p>今日预算跨领域共享，按概念数统计，不代表掌握分数；待同步 {dailyPending} 条。时区：{daily.timeZone || '浏览器时区'}</p>
        {dailyExhausted ? <p className="brief-review-daily-notice" role="status">今日预算已用完；可以打开复习安排调整预算，或处理已暂停的复习。</p> : null}
      </div> : null}
      {suspended ? <div className="brief-review-suspended" role="status">
        <div className="brief-review-suspended-heading"><strong>有一轮复习已暂停</strong><span>{suspendedPosition} · {suspended.domainLabel || '当前领域'}</span></div>
        <p>保存于 {displayReviewDate(suspended.savedAt)}。请继续或放弃这轮后再开始新一轮。</p>
        {resumeError ? <p className="brief-review-resume-error" role="alert">继续复习失败：{resumeError}</p> : null}
        <div className="brief-review-suspended-actions">
          <button type="button" className="brief-review-resume" disabled={disabledReason !== null || !onResume} onClick={onResume}>继续复习</button>
          <button type="button" className="brief-review-discard" disabled={!onDiscard} onClick={onDiscard}>放弃这轮</button>
          {suspended.hasAnswer ? <button type="button" className="brief-review-copy" disabled={!onCopyAnswer} onClick={onCopyAnswer}>复制未提交作答</button> : null}
        </div>
        {disabledReason !== null ? <p className="brief-review-disabled" role="status">当前无法继续：{disabledReason}</p> : null}
      </div> : null}
      {hasCandidates ? (
        <p className="brief-review-candidate-note" role="status">可随时跳过或结束，不需要清空所有待复习项。</p>
      ) : (
        disabledReason === null ? <p className="brief-review-empty" role="status">当前没有可按时间推荐的概念。未知或待确认的概念仍可手动回忆。</p> : null
      )}
      {disabledReason !== null ? <p className="brief-review-disabled" role="status">{disabledReason}</p> : null}
      <div className="brief-review-controls">
        <label className="brief-review-budget" htmlFor={budgetId}>
          <span>本轮最多</span>
          <select
            id={budgetId}
            value={budget}
            disabled={disabledReason !== null}
            onChange={(event) => {
              const nextBudget = Number(event.currentTarget.value);
              if (nextBudget === 3 || nextBudget === 5) onBudgetChange(nextBudget);
            }}
          >
            <option value={3}>3 个</option>
            <option value={5}>5 个</option>
          </select>
        </label>
        <button type="button" className="brief-review-start" disabled={startDisabled || dailyExhausted} onClick={onStart}>
          {suspended ? '请先处理暂停的复习' : '开始复习'}
        </button>
        {onOpenPlan ? <button type="button" className="brief-review-plan" disabled={planDisabled} onClick={onOpenPlan}>复习安排</button> : null}
      </div>
    </section>
  );
}

export function BriefReviewProgress({
  title,
  index,
  total,
  result,
  saved,
  queued,
  skipped,
  reviewStatus,
  busy,
  lockedReason,
  reviewDisabledReason = null,
  onReview,
  onNext,
  onEnd,
  onPause,
}: BriefReviewProgressProps): ReactElement {
  const titleId = useId();
  const safeIndex = Number.isFinite(index) ? Math.max(0, Math.floor(index)) : 0;
  const safeTotal = Number.isFinite(total) ? Math.max(1, Math.floor(total)) : 1;
  const position = Math.min(safeIndex + 1, safeTotal);
  const isLast = safeIndex >= safeTotal - 1;
  const reviewLocked = busy || lockedReason !== null;

  return (
    <div className="modal-backdrop brief-review-progress-backdrop" role="presentation">
      <div
        className="modal-card brief-review-progress-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={busy}
      >
        <div className="brief-review-progress-kicker">少量复习 · 进度</div>
        <div className="brief-review-progress-meta">
          <span>第 {position} / {safeTotal} 条</span>
          <span>观察结果</span>
        </div>
        <h2 id={titleId}>{title || '当前概念'}</h2>
        <p className={`brief-review-result brief-review-result-${result}`} role="status">{resultMessage(result)}</p>
        <div className="brief-review-counts" aria-label="本轮结果统计">
          <div><span>已保存</span><strong>{displayCount(saved)}</strong></div>
          <div><span>已入待同步</span><strong>{displayCount(queued)}</strong></div>
          <div><span>已跳过</span><strong>{displayCount(skipped)}</strong></div>
        </div>
        {result === 'saved' && reviewStatus === 'idle' ? (
          <button type="button" className="brief-review-confirm" disabled={reviewLocked || reviewDisabledReason !== null} onClick={onReview}>
            {busy ? '处理中…' : '确认本条已重温'}
          </button>
        ) : (
          <p className={`brief-review-status brief-review-status-${reviewStatus}`} role="status">
            {reviewStatusMessage(result, reviewStatus)}
          </p>
        )}
        {result === 'saved' && reviewStatus === 'idle' && reviewDisabledReason ? <p className="brief-review-locked">{reviewDisabledReason}</p> : null}
        {lockedReason !== null ? <p className="brief-review-locked" role="status">{lockedReason}</p> : null}
        <div className="brief-review-progress-actions">
          {!isLast ? (
            <>
              {onPause ? <button type="button" className="brief-review-pause" disabled={busy || lockedReason !== null} onClick={onPause}>暂停，稍后继续</button> : null}
              <button type="button" className="brief-review-next" disabled={busy || lockedReason !== null} onClick={onNext}>下一条</button>
            </>
          ) : null}
          <button type="button" className="brief-review-end" disabled={busy} onClick={onEnd}>
            结束复习
          </button>
        </div>
      </div>
    </div>
  );
}
