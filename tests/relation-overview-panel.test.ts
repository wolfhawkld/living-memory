import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RelationOverview, RelationOverviewItem } from '../src/shared/relation-overview.js';
import { RelationOverview as RelationOverviewPanel } from '../src/web/RelationOverview.js';

function relationItem(overrides: Partial<RelationOverviewItem> = {}): RelationOverviewItem {
  const source = { conceptId: 'alpha', sourceRevision: 'source-v1', title: 'Alpha 概念', path: 'math/alpha.md' };
  const target = { conceptId: 'beta', sourceRevision: 'target-v1', title: 'Beta 概念', path: 'ai/beta.md' };
  return {
    applicationEventId: 'application-alpha', conceptId: 'alpha', title: '主概念 Alpha', domainId: '数学',
    sourceRevision: 'source-v2', applicationRevision: 'source-v1', kind: 'application',
    occurredAt: '2026-09-20T10:00:00.000Z', recordedAt: '2026-09-20T10:01:00.000Z',
    operation: 'add', source, target, status: 'open', latestEventId: null, latestOccurredAt: null,
    basis: { source: { conceptId: source.conceptId, current: source }, target: { conceptId: target.conceptId, current: target }, beforePresent: null, afterPresent: false },
    basisChanged: false, needsRecheck: false, chainInvalid: false, structureMatches: false,
    sourceChanged: true, ...overrides,
  };
}

function overview(items: RelationOverviewItem[] = [relationItem()]): RelationOverview {
  return { items, unavailableCount: 0 };
}

function panel(overrides: Partial<ComponentProps<typeof RelationOverviewPanel>> = {}): string {
  return renderToStaticMarkup(createElement(RelationOverviewPanel, {
    overview: overview(), disabled: false, onSelect: () => undefined, ...overrides,
  }));
}

test('shows only metadata, directed endpoints and the original-record locator in the default follow-up queue', () => {
  const item = Object.assign(relationItem(), {
    description: 'private relation description', context: 'private work context',
    content: 'private application body', note: 'private decision note',
  });
  const html = panel({ overview: overview([item, relationItem({
    applicationEventId: 'summary-beta', title: '总结 Beta', kind: 'summary', operation: 'change',
    status: 'resolved', needsRecheck: true, basisChanged: true, latestEventId: 'decision-beta',
    latestOccurredAt: '2026-09-21T12:00:00.000Z',
  })]) });
  assert.equal((html.match(/data-relation-overview-item="true"/g) ?? []).length, 2);
  assert.match(html, /应用记录时间/);
  assert.match(html, /总结记录时间/);
  assert.match(html, /记录 ID：application-alpha/);
  assert.match(html, /定位原记录：主概念 Alpha/);
  assert.match(html, /新增关系/);
  assert.match(html, /修改关系/);
  assert.match(html, /Alpha 概念/);
  assert.match(html, /Beta 概念/);
  assert.match(html, /起点 · alpha/);
  assert.match(html, /终点 · beta/);
  assert.match(html, /aria-label="指向">→/);
  assert.match(html, /曾确认采纳/);
  assert.match(html, /依据待复核/);
  assert.match(html, /原建议可能来自旧资料版本/);
  assert.doesNotMatch(html, /private relation description|private work context|private application body|private decision note/);
  assert.doesNotMatch(html, /<table|<form|确认采纳<\/button>/);
});

test('never presents matching graph structure as an adoption decision', () => {
  const html = panel({ overview: overview([relationItem({ structureMatches: true })]) });
  assert.match(html, /符合建议结构，待本人核对/);
  assert.match(html, /结构提示不代表人工采纳决定/);
  assert.match(html, /relation-overview-status-open">待处理/);
  assert.match(html, /尚未有处理决定/);
  assert.doesNotMatch(html, /relation-overview-status-resolved/);
});

test('keeps a missing secondary endpoint visible and locatable with unknown structure', () => {
  const base = relationItem();
  const html = panel({ overview: overview([relationItem({
    operation: 'remove', structureMatches: null,
    basis: { ...base.basis, target: { conceptId: 'beta', current: null }, beforePresent: null, afterPresent: null },
  })]) });
  assert.match(html, /移除关系/);
  assert.match(html, /当前终点不在知识索引中/);
  assert.match(html, /端点缺失，结构未知/);
  assert.match(html, /aria-label="定位原记录：主概念 Alpha"/);
  assert.doesNotMatch(html, /aria-label="定位原记录：主概念 Alpha" disabled/);
});

test('an invalid decision chain is explicitly unknown instead of appearing as an untouched suggestion', () => {
  const html = panel({ overview: overview([relationItem({
    status: null, chainInvalid: true, latestEventId: null, latestOccurredAt: null,
  })]) });
  assert.match(html, /处理链异常／无法判定/);
  assert.match(html, /无法从处理链确定当前决定/);
  assert.doesNotMatch(html, /尚未有处理决定/);
  assert.doesNotMatch(html, /relation-overview-status-open/);
});

test('all six counts follow the main domain and query while settled items stay outside the default queue', () => {
  const html = panel({ domainId: '数学', query: 'Alpha', overview: overview([
    relationItem(),
    relationItem({ applicationEventId: 'resolved-alpha', status: 'resolved' }),
    relationItem({ applicationEventId: 'recheck-alpha', status: 'resolved', needsRecheck: true, basisChanged: true }),
    relationItem({ applicationEventId: 'dismissed-alpha', status: 'dismissed', basisChanged: true }),
    relationItem({ applicationEventId: 'invalid-alpha', status: null, chainInvalid: true }),
    relationItem({ applicationEventId: 'other-domain', domainId: 'AI' }),
    relationItem({ applicationEventId: 'other-title', conceptId: 'gamma', title: 'Gamma', source: { conceptId: 'gamma', title: 'Gamma', path: 'gamma.md', sourceRevision: 'v1' }, target: { conceptId: 'delta', title: 'Delta', path: 'delta.md', sourceRevision: 'v1' } }),
  ]) });
  assert.match(html, /全部 <span>\(5\)<\/span>/);
  assert.match(html, /aria-pressed="true">待跟进 <span>\(3\)<\/span>/);
  assert.match(html, /待处理 <span>\(1\)<\/span>/);
  assert.match(html, /依据待复核 <span>\(1\)<\/span>/);
  assert.match(html, /当前已采纳 <span>\(1\)<\/span>/);
  assert.match(html, /暂不采用 <span>\(1\)<\/span>/);
  assert.equal((html.match(/data-relation-overview-item="true"/g) ?? []).length, 3);
  assert.doesNotMatch(html, /记录 ID：dismissed-alpha|记录 ID：resolved-alpha|记录 ID：other-domain|记录 ID：other-title/);
});

test('distinguishes an unsupported older service, no records and an empty filtered result', () => {
  const legacy = panel({ overview: undefined });
  assert.match(legacy, /暂不支持关系建议待办/);
  assert.match(legacy, /不等于没有关系建议记录/);
  assert.doesNotMatch(legacy, /当前没有可定位/);

  assert.match(panel({ overview: overview([]) }), /当前没有可定位的关系待办/);
  assert.match(panel({ query: 'nonexistent' }), /当前筛选没有关系待办/);
});

test('unavailable primary records are a whole-space count even when domain and query hide rows', () => {
  const html = panel({ domainId: 'AI', query: 'missing', overview: { items: [relationItem()], unavailableCount: 2 } });
  assert.match(html, /当前知识空间另有 2 条关系建议历史对应的主概念当前不在知识索引中/);
  assert.match(html, /历史仍保留/);
  assert.match(html, /当前筛选没有关系待办/);
});

test('disables locating original records if disabled or no callback is supplied', () => {
  assert.match(panel({ disabled: true }), /aria-label="定位原记录：主概念 Alpha" disabled/);
  assert.match(panel({ onSelect: undefined }), /aria-label="定位原记录：主概念 Alpha" disabled/);
});

test('limits initial rendering to fifty records and exposes a further batch without dropping the total', () => {
  const html = panel({ overview: overview(Array.from({ length: 51 }, (_, index) => relationItem({
    applicationEventId: `application-${index.toString().padStart(3, '0')}`,
  }))) });
  assert.equal((html.match(/data-relation-overview-item="true"/g) ?? []).length, 50);
  assert.match(html, /显示 50 \/ 51 条/);
  assert.match(html, /显示更多（每批 50 条）/);
});
