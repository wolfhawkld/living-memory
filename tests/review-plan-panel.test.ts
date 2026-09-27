import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReviewPlanResponse } from '../src/shared/review-plan.js';
import { BriefReviewPanel, BriefReviewProgress } from '../src/web/BriefReviewPanel.js';
import { ConceptReviewControls, ReviewPlanDialog } from '../src/web/ReviewPlanControls.js';

function response(overrides: Partial<ReviewPlanResponse> = {}): ReviewPlanResponse {
  return {
    sourceId: 'source-a',
    asOf: '2026-09-27T08:00:00.000Z',
    timeZone: 'Asia/Shanghai',
    dayKey: '2026-09-27',
    plan: { revision: 3, dailyBudget: 12, concepts: {} },
    completedConceptIds: ['concept-a', 'concept-a', 'concept-b'],
    ...overrides,
  };
}

function panel(overrides: Partial<React.ComponentProps<typeof BriefReviewPanel>> = {}): string {
  return renderToStaticMarkup(createElement(BriefReviewPanel, {
    domainLabel: '数学',
    candidateCount: 4,
    budget: 3,
    disabledReason: null,
    onBudgetChange: () => undefined,
    onStart: () => undefined,
    ...overrides,
  }));
}

function progress(overrides: Partial<React.ComponentProps<typeof BriefReviewProgress>> = {}): string {
  return renderToStaticMarkup(createElement(BriefReviewProgress, {
    title: 'LogSumExp',
    index: 0,
    total: 2,
    result: 'saved',
    saved: 1,
    queued: 0,
    skipped: 0,
    reviewStatus: 'idle',
    busy: false,
    lockedReason: null,
    onReview: () => undefined,
    onNext: () => undefined,
    onEnd: () => undefined,
    ...overrides,
  }));
}

test('brief review panel exposes daily concept progress, plan entry, and suspended actions without answer text', () => {
  const html = panel({
    daily: { budget: 12, completed: 2, pending: 1, remaining: 10, timeZone: 'Asia/Shanghai' },
    onOpenPlan: () => undefined,
    planDisabled: false,
    suspended: { domainLabel: '数学', index: 1, total: 4, savedAt: '2026-09-27T07:00:00.000Z', hasAnswer: true },
    onResume: () => undefined,
    onDiscard: () => undefined,
    onCopyAnswer: () => undefined,
    resumeError: '当前资料已变化',
  });

  assert.match(html, /今日预算/);
  assert.match(html, /12 个概念/);
  assert.match(html, /今日预算跨领域共享/);
  assert.match(html, /不代表掌握分数/);
  assert.match(html, /时区：Asia\/Shanghai/);
  assert.match(html, /复习安排/);
  assert.match(html, /有一轮复习已暂停/);
  assert.match(html, /继续复习/);
  assert.match(html, /放弃这轮/);
  assert.match(html, /复制未提交作答/);
  assert.match(html, /继续复习失败：当前资料已变化/);
  assert.match(html, /disabled/);
  assert.doesNotMatch(html, /我记得|答案|原始作答/);
});

test('daily exhaustion prevents starting a new round but keeps the plan entry available', () => {
  const html = panel({
    daily: { budget: 5, completed: 5, pending: 0, remaining: 0, timeZone: 'UTC' },
    onOpenPlan: () => undefined,
    planDisabled: false,
  });
  assert.match(html, /今日预算已用完/);
  assert.match(html, /复习安排/);
  assert.match(html, /class="brief-review-start" disabled=""[^>]*>开始复习/);
});

test('resume is blocked by its guard while discard and copy remain available', () => {
  const html = panel({
    suspended: { domainLabel: 'AI', index: 0, total: 1, savedAt: '2026-09-27T07:00:00.000Z', hasAnswer: true },
    disabledReason: '正在同步',
    onResume: () => undefined,
    onDiscard: () => undefined,
    onCopyAnswer: () => undefined,
  });
  const resumeButton = html.match(/<button[^>]*>继续复习<\/button>/)?.[0] ?? '';
  const discardButton = html.match(/<button[^>]*>放弃这轮<\/button>/)?.[0] ?? '';
  const copyButton = html.match(/<button[^>]*>复制未提交作答<\/button>/)?.[0] ?? '';
  assert.match(resumeButton, /disabled/);
  assert.doesNotMatch(discardButton, /disabled/);
  assert.doesNotMatch(copyButton, /disabled/);
  assert.match(html, /当前无法继续：正在同步/);
});

test('progress offers pause only before the last item and always keeps end action', () => {
  const html = progress({ onPause: () => undefined });
  assert.match(html, /暂停，稍后继续/);
  assert.match(html, /结束复习/);
  assert.doesNotMatch(progress({ index: 1, onPause: () => undefined }), /暂停，稍后继续/);
  assert.match(progress({ index: 1, onPause: () => undefined }), /结束复习/);
});

test('review plan dialog renders bounded budget, unique daily recall count, timezone, and failure draft note', () => {
  const html = renderToStaticMarkup(createElement(ReviewPlanDialog, {
    response: response(),
    loading: false,
    error: '保存失败',
    onClose: () => undefined,
    onRefresh: () => undefined,
    onSaveBudget: () => undefined,
  }));
  assert.match(html, /每日复习预算/);
  assert.match(html, /min="1"/);
  assert.match(html, /max="50"/);
  assert.match(html, /今日已保存概念回忆.*2 个/);
  assert.match(html, /同一节点每天只计 1 次/);
  assert.match(html, /Asia\/Shanghai/);
  assert.match(html, /保存失败/);
  assert.match(html, /已保留当前草稿/);
  assert.match(html, /暂缓状态在对应节点设置中调整/);
  assert.match(html, /重点只优先时间到期候选/);
  assert.doesNotMatch(html, /原始答案/);
});

test('review plan dialog makes loading, empty, and initial error states explicit', () => {
  const loading = renderToStaticMarkup(createElement(ReviewPlanDialog, {
    response: null,
    loading: true,
    error: null,
    onClose: () => undefined,
    onRefresh: () => undefined,
    onSaveBudget: () => undefined,
  }));
  assert.match(loading, /正在加载复习安排/);

  const error = renderToStaticMarkup(createElement(ReviewPlanDialog, {
    response: null,
    loading: false,
    error: '网络不可用',
    onClose: () => undefined,
    onRefresh: () => undefined,
    onSaveBudget: () => undefined,
  }));
  assert.match(error, /复习安排加载或保存失败：网络不可用/);
  assert.match(error, /重试/);
  assert.doesNotMatch(error, /每日预算.*12/);
});

test('concept controls expose focus aria state, defer durations, expiry, and retained guard note', () => {
  const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const active = renderToStaticMarkup(createElement(ConceptReviewControls, {
    preference: { focus: true, deferUntil: future },
    disabled: false,
    onChange: () => undefined,
  }));
  assert.match(active, /重点：开启/);
  assert.match(active, /aria-pressed="true"/);
  assert.match(active, /暂缓 1 天/);
  assert.match(active, /暂缓 7 天/);
  assert.match(active, /取消暂缓/);
  assert.match(active, /暂缓至/);
  assert.match(active, /不覆盖长期保持状态/);

  const expired = renderToStaticMarkup(createElement(ConceptReviewControls, {
    preference: { focus: false, deferUntil: '2020-01-01T00:00:00.000Z' },
    disabled: true,
    onChange: () => undefined,
  }));
  assert.match(expired, /暂缓已到期/);
  assert.match(expired, /重点：关闭/);
  assert.match(expired, /disabled/);
});
