import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { LearningOverview, LearningOverviewItem, OverviewObservation } from '../src/shared/learning-overview.js';
import { LearningOverviewDialog, type LearningOverviewDialogProps } from '../src/web/LearningOverviewDialog.js';

function observation(overrides: Partial<OverviewObservation> = {}): OverviewObservation {
  return {
    eventId: 'observation-1',
    observedAt: '2026-09-20T10:00:00.000Z',
    rating: 'partial',
    exposure: 'unexposed',
    observedExposure: false,
    cue: 'independent',
    outcome: 'partial',
    basis: 'self-check',
    ...overrides,
  };
}

function item(overrides: Partial<LearningOverviewItem> = {}): LearningOverviewItem {
  return {
    conceptId: 'math:boolean',
    title: '布尔逻辑',
    domainId: '数学',
    sourceRevision: 'revision-2',
    memory: { status: 'revisit', elapsedDays: 8.5, lastReviewedAt: '2026-09-12T10:00:00.000Z', estimated: false },
    recall: { total: 3, clear: 0, partial: 2, blank: 1, latest: observation() },
    scenario: { total: 2, independentSuccess: 0, assisted: 1, partial: 1, failure: 0, unverified: 1, latest: observation({ eventId: 'scenario-1', outcome: 'unverified', cue: 'lookup' }) },
    calibration: {
      concept: { count: 2, meanConfidence: 75, successRate: 50, gap: 25, brier: .2 },
      scenario: { count: 0, meanConfidence: null, successRate: null, gap: null, brier: null },
    },
    applications: { application: 2, summary: 1, latestAt: '2026-09-19T10:00:00.000Z' },
    evidence: { currentObservations: 3, previousObservations: 1, previousApplications: 1, latestAt: '2026-09-20T10:00:00.000Z' },
    ...overrides,
  };
}

function overview(items: LearningOverviewItem[] = [item()]): LearningOverview {
  return { sourceId: 'source-test', asOf: '2026-09-21T00:00:00.000Z', items };
}

function panel(overrides: Partial<LearningOverviewDialogProps> = {}): string {
  return renderToStaticMarkup(createElement(LearningOverviewDialog, {
    overview: overview(),
    loading: false,
    error: null,
    initialDomainId: '数学',
    pendingCount: 2,
    onRefresh: () => undefined,
    onClose: () => undefined,
    onSelect: () => undefined,
    ...overrides,
  }));
}

test('SSR renders the wide overview dialog with evidence metadata, caveats and current-domain shortcut', () => {
  const html = panel();
  assert.match(html, /知识薄弱点总览/);
  assert.match(html, /当前领域：数学/);
  assert.match(html, /待同步记录：2 条（本总览未包含）/);
  assert.match(html, /信心对照来自自报核对，样本少时不推断稳定能力/);
  assert.match(html, /百分比表示已核对结果，不是记忆率/);
  assert.match(html, /当前资料版本 · 数据截至/);
  assert.match(html, /旧版本记录仅保留在计数中，不进入当前版本统计/);
  assert.match(html, /布尔逻辑/);
  assert.match(html, /数学/);
  assert.match(html, /需要再访|回忆困难/);
  assert.match(html, /模糊/);
  assert.match(html, /查阅资料/);
  assert.match(html, /信心 75%/);
  assert.match(html, /差值 \+25 个百分点/);
  assert.match(html, /应用 2 · 总结 1/);
  assert.match(html, /查看节点：布尔逻辑/);
  assert.match(html, /关闭知识薄弱点总览/);
  assert.match(html, /标题或概念 ID/);
  assert.doesNotMatch(html, /原始回答内容|具体业务场景内容|答案正文内容/);
});

test('loading keeps existing rows visible but disables node navigation, while initial loading has an explicit state', () => {
  const refreshing = panel({ loading: true });
  assert.match(refreshing, /正在刷新总览/);
  assert.match(refreshing, /aria-label="查看节点：布尔逻辑" disabled/);
  assert.match(refreshing, /刷新中…/);

  const initial = panel({ overview: null, loading: true, pendingCount: 0 });
  assert.match(initial, /正在加载知识薄弱点总览/);
  assert.doesNotMatch(initial, /布尔逻辑/);
});

test('initial errors, empty data and empty filtered results are explicit', () => {
  const error = panel({ overview: null, error: '服务暂时不可用' });
  assert.match(error, /总览加载失败：服务暂时不可用/);
  assert.match(error, />重试</);

  const empty = panel({ overview: overview([]), pendingCount: 0 });
  assert.match(empty, /当前知识源没有概念/);
  assert.match(empty, /添加或刷新知识源/);
});

test('marks estimated memory timing and exposed scenario evidence without exposing scenario text', () => {
  const html = panel({ overview: overview([item({
    memory: { status: 'stale', elapsedDays: 20, lastReviewedAt: '2026-09-01T00:00:00.000Z', estimated: true },
    scenario: { ...item().scenario, latest: observation({ exposure: 'exposed', observedExposure: true, cue: 'independent', outcome: 'success' }) },
  })]) });
  assert.match(html, /补记起点/);
  assert.match(html, /成功 · 独立想到/);
  assert.match(html, /已查看资料/);
});

test('renders no more than 50 rows initially and exposes a progressive-more control', () => {
  const items = Array.from({ length: 51 }, (_, index) => item({ conceptId: `concept-${index}`, title: `概念 ${index}` }));
  const html = panel({ overview: overview(items) });
  assert.equal((html.match(/data-overview-item="true"/g) ?? []).length, 50);
  assert.match(html, /显示更多（每批 50 条）/);
});
