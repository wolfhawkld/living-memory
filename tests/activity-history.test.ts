import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ActivityRecord } from '../src/shared/activity.ts';
import { ActivityHistoryDialog, ActivityHistorySteps, activityReferenceLabel, groupActivityPage, savedActivityQuery } from '../src/web/ActivityHistoryDialog.tsx';

function record(id: string, operationId = 'operation-a', occurredAt = '2026-10-16T08:00:00.000Z'): ActivityRecord {
  return { event: { schemaVersion: 1, eventId: id, operationId, stepKey: id, occurredAt, actor: { kind: 'user' }, channel: 'web', kind: 'query.submitted', refs: [], payload: { resultCount: 0 } }, epoch: 0, receivedAt: '2026-10-16T09:00:00.000Z', recordedBy: { principalId: 'owner', sessionKind: 'account' }, referenceInspections: [] };
}

test('history groups only supplied page entries and sorts each operation by frozen event time', () => {
  const late = record('late'), early = record('early', 'operation-a', '2026-10-15T08:00:00.000Z'), other = record('other', 'operation-b');
  const input = [late, other, early];
  const groups = groupActivityPage(input);
  assert.deepEqual(groups.map((group) => [group.operationId, group.steps.map((step) => step.event.eventId)]), [['operation-a', ['early', 'late']], ['operation-b', ['other']]]);
  assert.deepEqual(input, [late, other, early]);
});

test('history displays query text only when the saved-by-user flag is explicitly true', () => {
  const item = record('query');
  assert.equal(savedActivityQuery(item), null);
  item.event.payload = { resultCount: 1, queryText: 'explicit query', queryTextSavedByUser: true };
  assert.equal(savedActivityQuery(item), 'explicit query');
  const malformed = { ...item, event: { ...item.event, payload: { queryText: 'must stay hidden' } } } as unknown as ActivityRecord;
  assert.equal(savedActivityQuery(malformed), null);
  assert.doesNotMatch(renderToStaticMarkup(createElement(ActivityHistorySteps, { records: [malformed] })), /must stay hidden/);
});

test('frozen references and receipt-time inspection do not claim today’s version or memory quality', () => {
  const item = record('read');
  item.event.refs = [{ conceptId: 'concept', sourceRevision: 'old-revision', title: 'Frozen title', path: 'Math/Original.md', scope: 'block', contentPart: 'body', blockId: 'block-body-0-10', sectionId: 'heading', bodyRange: { coordinateSpace: 'render-markdown-v1', startOffset: 0, endOffset: 10, startLine: 1, endLine: 2 } }];
  item.referenceInspections = [{ status: 'current' }];
  const html = renderToStaticMarkup(createElement(ActivityHistorySteps, { records: [item] }));
  assert.match(html, /Frozen title/); assert.match(html, /Math\/Original.md/); assert.match(html, /old-revision/);
  assert.match(html, /接收时版本吻合/); assert.doesNotMatch(html, /当前版本|已经记住|完成阅读/);
  assert.match(activityReferenceLabel(item.event.refs[0]!), /可见块 · 正文 · heading · block-body-0-10 · 第 1–2 行（渲染文本）/);
});

test('history entry offers separate controls, scoped filtering and an explicit partial-page disclaimer', () => {
  let calls = 0;
  const html = renderToStaticMarkup(createElement(ActivityHistoryDialog, {
    scopeKey: 'owner:source', concepts: [{ id: 'concept', title: 'Concept' }], settings: { enabled: true, epoch: 0, revision: 0 },
    queueStatus: { pending: 2, conflicts: 1, exhausted: 1 }, onClose() {},
    async loadPage() { calls += 1; return { items: [], nextCursor: null }; },
    async onUpdateSettings() { throw new Error(); }, async onClear() { throw new Error(); }, async onExport() { throw new Error(); }, async onRetry() {},
  }));
  assert.equal(calls, 0);
  for (const label of ['查阅记录', '不代表读完或记住', '暂停记录', '独立导出', '清除全部查阅记录', '重试同步', '最近 7 天', '最近 30 天', '全部时间', '仅包含当前页']) assert.ok(html.includes(label), label);
  assert.doesNotMatch(html, /确认重温|更新记忆/);
});

test('operation steps compare actual instants rather than timezone spellings', () => {
  const earlier = record('early-offset', 'operation', '2026-10-16T09:00:00+08:00');
  const later = record('later-utc', 'operation', '2026-10-16T08:00:00Z');
  assert.deepEqual(groupActivityPage([later, earlier])[0]?.steps.map((item) => item.event.eventId), ['early-offset', 'later-utc']);
});
