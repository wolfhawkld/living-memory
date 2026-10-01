import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { LearningOverview, LearningOverviewItem } from '../src/shared/learning-overview.js';
import type { TimeRecallEvidence, TimeRecallSummary } from '../src/shared/time-recall.js';
import { LearningOverviewDialog } from '../src/web/LearningOverviewDialog.js';
import { TimeRecallComparison } from '../src/web/TimeRecallComparison.js';

const observedAt = '2026-09-20T10:00:00.000Z';

function evidence(overrides: Partial<TimeRecallEvidence> = {}): TimeRecallEvidence {
  return {
    eventId: 'recall-1',
    observedAt,
    recordedAt: '2026-09-20T10:01:00.000Z',
    rating: 'partial',
    elapsedDays: 8.25,
    decay: 0.48,
    halfLifeDays: 7,
    configRevision: 4,
    anchorOccurredAt: '2026-09-12T10:00:00.000Z',
    ...overrides,
  };
}

function timeRecall(overrides: Partial<TimeRecallSummary> = {}): TimeRecallSummary {
  const latest = evidence();
  return {
    buckets: [{
      band: 'revisit',
      anchorKind: 'review',
      condition: 'unexposed',
      count: 2,
      ratings: { clear: 1, partial: 1, blank: 0 },
      latest,
      latestClear: evidence({ eventId: 'clear-1', rating: 'clear' }),
      latestDifficulty: latest,
    }],
    excluded: { scenario: 1, missingTime: 2, invalidTime: 1 },
    ...overrides,
  };
}

function item(overrides: Partial<LearningOverviewItem> = {}): LearningOverviewItem {
  return {
    conceptId: 'math:boolean',
    title: '布尔逻辑题干',
    domainId: '数学',
    sourceRevision: 'revision-2',
    memory: { status: 'stale', elapsedDays: 20, lastReviewedAt: '2026-09-01T10:00:00.000Z', estimated: false },
    recall: { total: 2, clear: 1, partial: 1, blank: 0, latest: null },
    scenario: { total: 0, independentSuccess: 0, assisted: 0, partial: 0, failure: 0, unverified: 0, latest: null },
    calibration: {
      concept: { count: 0, meanConfidence: null, successRate: null, gap: null, brier: null },
      scenario: { count: 0, meanConfidence: null, successRate: null, gap: null, brier: null },
    },
    applications: { application: 0, summary: 0, latestAt: null },
    evidence: { currentObservations: 2, previousObservations: 0, previousApplications: 0, latestAt: observedAt },
    timeRecall: timeRecall(),
    ...overrides,
  };
}

function comparison(overrides: Partial<React.ComponentProps<typeof TimeRecallComparison>> = {}): string {
  return renderToStaticMarkup(createElement(TimeRecallComparison, {
    items: [item()],
    disabled: false,
    onSelect: () => undefined,
    ...overrides,
  }));
}

function overview(items: LearningOverviewItem[] = [item()]): LearningOverview {
  return { sourceId: 'source-test', asOf: '2026-09-21T00:00:00.000Z', items };
}

test('SSR renders the three time bands, ratings, frozen metadata, labels, and counts without answer text', () => {
  const html = comparison();
  assert.match(html, /少于 1H/);
  assert.match(html, /1H 至不足 2H/);
  assert.match(html, /至少 2H/);
  assert.match(html, /确认重温/);
  assert.match(html, /估计日期/);
  assert.match(html, /未报告提示/);
  assert.match(html, /提示或查阅/);
  assert.match(html, /条件不明/);
  assert.match(html, /近期仍模糊/);
  assert.match(html, /较久仍清晰/);
  assert.match(html, /清晰 1 · 模糊 1 · 想不起 0/);
  assert.match(html, /样本 2 条 · 概念 1 个/);
  assert.match(html, /当时距重温/);
  assert.match(html, /8\.25 天/);
  assert.match(html, /时间指标 D/);
  assert.match(html, />0\.48</);
  assert.match(html, /当时 H/);
  assert.match(html, /7 天/);
  assert.match(html, /参数版本/);
  assert.match(html, />4</);
  assert.match(html, /时间起点/);
  assert.match(html, /场景记录单独排除：1 条/);
  assert.match(html, /缺少时间 2 条 · 时间无效 1 条/);
  assert.match(html, /未报告提示.*不证明无近期接触/);
  assert.doesNotMatch(html, /答案正文|私密回答|我记得/);
});

test('SSR keeps concept navigation disabled while loading or in an error state', () => {
  const html = comparison({ disabled: true });
  assert.match(html, /aria-label="查看节点：布尔逻辑题干" disabled/);
});

test('old services are explicit and are not rendered as zero historical samples', () => {
  const html = comparison({ items: [item({ timeRecall: undefined })] });
  assert.match(html, /本地服务暂不支持时间与回忆对照/);
  assert.match(html, /更新或刷新本地服务/);
  assert.match(html, /不等于历史记录为 0/);
  assert.doesNotMatch(html, /样本 0 条/);
});

test('empty selected conditions explain how to obtain a comparable record', () => {
  const html = comparison({ items: [item({ timeRecall: timeRecall({ buckets: [] }) })] });
  assert.match(html, /当前条件下暂无可对照记录/);
  assert.match(html, /切换日期依据或提示条件/);
  assert.match(html, /确认 \/ 补记实际重温日期/);
});

test('dialog defaults to the original overview and exposes the paired view switch', () => {
  const html = renderToStaticMarkup(createElement(LearningOverviewDialog, {
    overview: overview(),
    loading: false,
    error: null,
    initialDomainId: '数学',
    pendingCount: 0,
    onRefresh: () => undefined,
    onClose: () => undefined,
    onSelect: () => undefined,
  }));
  assert.match(html, /知识薄弱点总览/);
  assert.match(html, /薄弱点总览/);
  assert.match(html, /时间与回忆对照/);
  assert.match(html, /aria-pressed="true"[^>]*>薄弱点总览/);
  assert.match(html, /aria-pressed="false"[^>]*>时间与回忆对照/);
  assert.doesNotMatch(html, /time-recall-band/);
});
