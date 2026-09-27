import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CorrectionOverview, CorrectionOverviewItem } from '../src/shared/correction-overview.js';
import type { LearningOverview } from '../src/shared/learning-overview.js';
import { CorrectionOverview as CorrectionOverviewPanel } from '../src/web/CorrectionOverview.js';
import { LearningOverviewDialog } from '../src/web/LearningOverviewDialog.js';

function correctionItem(overrides: Partial<CorrectionOverviewItem> = {}): CorrectionOverviewItem {
  return {
    applicationEventId: 'application-alpha',
    conceptId: 'alpha',
    title: 'Alpha 概念',
    domainId: '数学',
    sourceRevision: 'source-v2',
    applicationRevision: 'source-v1',
    kind: 'application',
    occurredAt: '2026-09-20T10:00:00.000Z',
    recordedAt: '2026-09-20T10:01:00.000Z',
    status: 'open',
    latestEventId: null,
    latestOccurredAt: null,
    reviewedRevision: null,
    sourceChanged: true,
    needsRecheck: false,
    ...overrides,
  };
}

function correctionOverview(items: CorrectionOverviewItem[] = [correctionItem()]): CorrectionOverview {
  return { items, unavailableCount: 0 };
}

function correctionPanel(overrides: Partial<ComponentProps<typeof CorrectionOverviewPanel>> = {}): string {
  return renderToStaticMarkup(createElement(CorrectionOverviewPanel, {
    overview: correctionOverview(),
    disabled: false,
    onSelect: () => undefined,
    ...overrides,
  }));
}

function learningOverview(): LearningOverview {
  return { sourceId: 'source-test', asOf: '2026-09-21T00:00:00.000Z', items: [] };
}

test('renders the default actionable correction queue as metadata only', () => {
  const html = correctionPanel({ overview: correctionOverview([
    correctionItem(),
    correctionItem({
      applicationEventId: 'summary-beta', conceptId: 'beta', title: 'Beta 总结', kind: 'summary',
      status: 'resolved', needsRecheck: true, latestEventId: 'decision-beta',
      latestOccurredAt: '2026-09-21T12:00:00.000Z', reviewedRevision: 'source-v1', sourceChanged: true,
    }),
    correctionItem({ applicationEventId: 'dismissed-gamma', conceptId: 'gamma', title: 'Gamma', status: 'dismissed' }),
  ]) });

  assert.equal((html.match(/data-correction-overview-item="true"/g) ?? []).length, 2);
  assert.match(html, /待处理/);
  assert.match(html, /版本待复核/);
  assert.match(html, /原建议可能来自旧资料版本/);
  assert.match(html, /应用记录时间/);
  assert.match(html, /总结记录时间/);
  assert.match(html, /定位原记录：Alpha 概念/);
  assert.match(html, /记录 ID：application-alpha/);
  assert.doesNotMatch(html, /private suggestion body|private answer|private note/);
  assert.doesNotMatch(html, /<table/);
});

test('distinguishes an older service response from an empty correction queue', () => {
  const html = correctionPanel({ overview: undefined });
  assert.match(html, /暂不支持知识修正待办/);
  assert.match(html, /不等于没有修正记录/);
  assert.doesNotMatch(html, /当前没有可定位/);
});

test('renders explicit empty and unavailable-history states', () => {
  const empty = correctionPanel({ overview: correctionOverview([]) });
  assert.match(empty, /当前没有可定位的修正待办/);

  const unavailable = correctionPanel({ overview: { items: [], unavailableCount: 2 } });
  assert.match(unavailable, /2 条修正历史对应的概念当前不在知识索引中/);
  assert.match(unavailable, /历史仍保留/);
});

test('disables locating rows when the view is disabled or no callback is supplied', () => {
  const disabled = correctionPanel({ disabled: true });
  assert.match(disabled, /aria-label="定位原记录：Alpha 概念" disabled/);

  const withoutCallback = correctionPanel({ onSelect: undefined });
  assert.match(withoutCallback, /aria-label="定位原记录：Alpha 概念" disabled/);
});

test('the existing overview exposes a third correction view without changing the default view', () => {
  const html = renderToStaticMarkup(createElement(LearningOverviewDialog, {
    overview: learningOverview(),
    loading: false,
    error: null,
    initialDomainId: '数学',
    pendingCount: 0,
    onRefresh: () => undefined,
    onClose: () => undefined,
    onSelect: () => undefined,
    onSelectCorrection: () => undefined,
  }));
  assert.match(html, /知识修正待办/);
  assert.match(html, /薄弱点总览/);
  assert.match(html, /时间与回忆对照/);
  assert.match(html, /标题或概念 ID/);
});
