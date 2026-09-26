import { useId, type ReactElement } from 'react';

export interface BriefReviewPanelProps {
  domainLabel: string;
  candidateCount: number;
  budget: 3 | 5;
  disabledReason: string | null;
  onBudgetChange: (budget: 3 | 5) => void;
  onStart: () => void;
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
}

function displayCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
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
}: BriefReviewPanelProps): ReactElement {
  const budgetId = useId();
  const count = displayCount(candidateCount);
  const hasCandidates = count > 0;
  const startDisabled = !hasCandidates || disabledReason !== null;

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
        <button type="button" className="brief-review-start" disabled={startDisabled} onClick={onStart}>
          开始复习
        </button>
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
            <button type="button" className="brief-review-next" disabled={busy || lockedReason !== null} onClick={onNext}>
              下一条
            </button>
          ) : null}
          <button type="button" className="brief-review-end" disabled={busy} onClick={onEnd}>
            结束复习
          </button>
        </div>
      </div>
    </div>
  );
}
