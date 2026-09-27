import { useEffect, useId, useRef, useState, type ReactElement } from 'react';
import {
  DEFAULT_DAILY_REVIEW_BUDGET,
  MAX_DAILY_REVIEW_BUDGET,
  type ConceptReviewPreference,
  type ReviewPlanResponse,
} from '../shared/review-plan.js';

export interface ReviewPlanDialogProps {
  response: ReviewPlanResponse | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onRefresh: () => void;
  onSaveBudget: (budget: number) => void;
}

export interface ConceptReviewControlsProps {
  preference: ConceptReviewPreference | undefined;
  disabled: boolean;
  onChange: (preference: ConceptReviewPreference) => void;
}

function clampBudget(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_DAILY_REVIEW_BUDGET;
  return Math.min(MAX_DAILY_REVIEW_BUDGET, Math.max(1, Math.floor(value)));
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '时间未知';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '浏览器时区';
  } catch {
    return '浏览器时区';
  }
}

function planFocusPreference(preference: ConceptReviewPreference | undefined): ConceptReviewPreference {
  return {
    focus: preference?.focus === true,
    deferUntil: preference?.deferUntil ?? null,
  };
}

function focusButtonLabel(focus: boolean): string {
  return focus ? '重点：开启' : '重点：关闭';
}

function deferState(deferUntil: string | null): { active: boolean; valid: boolean; label: string } {
  if (!deferUntil) return { active: false, valid: false, label: '未暂缓' };
  const date = new Date(deferUntil);
  if (!Number.isFinite(date.getTime())) return { active: false, valid: false, label: '暂缓时间无效' };
  if (date.getTime() <= Date.now()) return { active: false, valid: true, label: `暂缓已到期 · ${formatDate(deferUntil)}` };
  return { active: true, valid: true, label: `暂缓至 ${formatDate(deferUntil)}` };
}

export function ConceptReviewControls({
  preference,
  disabled,
  onChange,
}: ConceptReviewControlsProps): ReactElement {
  const current = planFocusPreference(preference);
  const defer = deferState(current.deferUntil);
  const setFocus = (focus: boolean) => onChange({ ...current, focus, deferUntil: defer.active ? current.deferUntil : null });
  const setDefer = (days: number) => onChange({
    ...current,
    deferUntil: new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString(),
  });

  return <section className="brief-review-concept-controls" aria-label="概念复习安排">
    <div className="brief-review-concept-control-heading">
      <strong>节点复习安排</strong>
      <span>只调整候选优先级与暂缓时间</span>
    </div>
    <div className="brief-review-concept-control-row">
      <span className="brief-review-concept-control-label">重点候选</span>
      <div className="brief-review-toggle-group" role="group" aria-label="重点候选开关">
        <button type="button" className={current.focus ? 'is-active' : ''} aria-pressed={current.focus} disabled={disabled} onClick={() => setFocus(true)}>{focusButtonLabel(true)}</button>
        <button type="button" className={!current.focus ? 'is-active' : ''} aria-pressed={!current.focus} disabled={disabled} onClick={() => setFocus(false)}>{focusButtonLabel(false)}</button>
      </div>
    </div>
    <div className="brief-review-concept-control-row">
      <span className="brief-review-concept-control-label">暂缓复习</span>
      <div className="brief-review-defer-group" role="group" aria-label="暂缓复习时长">
        <button type="button" disabled={disabled} onClick={() => setDefer(1)}>暂缓 1 天</button>
        <button type="button" disabled={disabled} onClick={() => setDefer(7)}>暂缓 7 天</button>
        <button type="button" disabled={disabled || !current.deferUntil} onClick={() => onChange({ ...current, deferUntil: null })}>取消暂缓</button>
      </div>
    </div>
    <p className={`brief-review-defer-status${defer.active ? ' is-active' : ''}`} role="status">{defer.label}</p>
    <p className="brief-review-concept-note">重点只优先时间到期的候选，不覆盖长期保持状态。</p>
  </section>;
}

export function ReviewPlanDialog({
  response,
  loading,
  error,
  onClose,
  onRefresh,
  onSaveBudget,
}: ReviewPlanDialogProps): ReactElement {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const initialBudget = clampBudget(response?.plan.dailyBudget ?? DEFAULT_DAILY_REVIEW_BUDGET);
  const [draftBudget, setDraftBudget] = useState(initialBudget);
  const draftBudgetRef = useRef(initialBudget);
  const draftDirtyRef = useRef(false);

  useEffect(() => {
    if (!response?.plan || !Number.isFinite(response.plan.dailyBudget)) return;
    const serverBudget = clampBudget(response.plan.dailyBudget);
    if (!draftDirtyRef.current) {
      draftBudgetRef.current = serverBudget;
      setDraftBudget(serverBudget);
    } else if (draftBudgetRef.current === serverBudget) {
      // A response reflecting the saved value confirms the draft. A refresh
      // that still has the old server value must leave the draft untouched.
      draftDirtyRef.current = false;
    }
  }, [response?.asOf, response?.plan.dailyBudget, response?.plan.revision]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || typeof document === 'undefined') return undefined;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    }
    const autofocus = dialog.querySelector<HTMLElement>('[data-review-plan-autofocus]');
    autofocus?.focus({ preventScroll: true });
    return () => {
      if (dialog.open) dialog.close();
      else dialog.removeAttribute('open');
      const previous = previousFocusRef.current;
      if (previous?.isConnected && !previous.closest('[inert]')) previous.focus({ preventScroll: true });
    };
  }, []);

  const serverBudget = response?.plan.dailyBudget;
  const budgetChanged = response !== null && draftBudget !== serverBudget;
  const completedCount = response ? new Set(response.completedConceptIds).size : 0;
  const timeZone = response?.timeZone || browserTimeZone();
  const canSave = Boolean(response) && budgetChanged && !loading;
  const updateDraftBudget = (value: number) => {
    const nextBudget = clampBudget(value);
    draftBudgetRef.current = nextBudget;
    draftDirtyRef.current = true;
    setDraftBudget(nextBudget);
  };

  return <dialog
    ref={dialogRef}
    className="brief-review-plan-dialog"
    aria-labelledby={titleId}
    aria-modal="true"
    aria-busy={loading}
    onCancel={(event) => { event.preventDefault(); onClose(); }}
  >
    <div className="brief-review-plan-shell">
      <header className="brief-review-plan-header">
        <div>
          <span className="brief-review-kicker">复习安排 · 个人设置</span>
          <h2 id={titleId}>复习安排</h2>
          <p>设置每日复习预算；概念的重点与暂缓状态在对应节点设置中调整。</p>
        </div>
        <button type="button" className="brief-review-plan-close" aria-label="关闭复习安排" onClick={onClose}>×</button>
      </header>

      <div className="brief-review-plan-body">
        <div className="brief-review-plan-notes">
          <p>按浏览器时区（{timeZone}）统计今日已保存的概念回忆；同一节点每天只计 1 次。</p>
          <p>重点只优先时间到期候选，不覆盖长期保持状态。</p>
          {response ? <p>数据截至 {formatDate(response.asOf)}</p> : null}
        </div>

        {response ? <div className="brief-review-plan-progress" aria-label="今日复习进度">
          <div><span>今日已保存概念回忆</span><strong>{completedCount} 个</strong></div>
          <div><span>今日预算</span><strong>{clampBudget(response.plan.dailyBudget)} 个</strong></div>
          <div><span>本地日期</span><strong>{response.dayKey}</strong></div>
        </div> : null}

        {loading && response ? <p className="brief-review-plan-status" role="status">正在刷新复习安排；当前修改草稿会保留。</p> : null}
        {error ? <div className="brief-review-plan-error" role="alert"><span>复习安排加载或保存失败：{error} {response ? '已保留当前草稿，可重试保存。' : ''}</span><button type="button" onClick={onRefresh} disabled={loading}>重试</button></div> : null}
        {loading && !response ? <p className="brief-review-plan-loading" role="status">正在加载复习安排…</p> : null}
        {!loading && !response && !error ? <div className="brief-review-plan-empty" role="status">尚未加载复习安排，点击刷新读取当前设置。</div> : null}

        <div className="brief-review-plan-budget-card">
          <div>
            <span className="brief-review-plan-label">每日复习预算</span>
            <strong>按概念数量计算</strong>
            <p>预算在所有知识域之间共享，不代表掌握分数。</p>
          </div>
          <label htmlFor="brief-review-daily-budget">
            <span>数量</span>
            <input
              id="brief-review-daily-budget"
              data-review-plan-autofocus
              type="number"
              min={1}
              max={MAX_DAILY_REVIEW_BUDGET}
              step={1}
              value={draftBudget}
              disabled={loading || !response}
              onChange={(event) => updateDraftBudget(Number(event.currentTarget.value))}
            />
            <small>1–{MAX_DAILY_REVIEW_BUDGET} 个概念</small>
          </label>
        </div>
        <button type="button" className="brief-review-plan-save" disabled={!canSave} onClick={() => onSaveBudget(clampBudget(draftBudget))}>{loading ? '保存中…' : '保存每日预算'}</button>
      </div>
      <footer className="brief-review-plan-footer"><span>今日已保存 {completedCount} 个概念回忆 · 时区 {timeZone}</span><button type="button" className="brief-review-plan-footer-close" onClick={onClose}>完成</button></footer>
    </div>
  </dialog>;
}

export default ReviewPlanDialog;
