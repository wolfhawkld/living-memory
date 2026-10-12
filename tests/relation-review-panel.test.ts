import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ApplicationRecord } from '../src/shared/types.js';
import type { RelationReviewBasis, RelationReviewResponse } from '../src/shared/relation-reviews.js';
import { ApplicationRelationReviewPanel, RelationReviewBasisPreview, type ApplicationRelationReviewPanelProps } from '../src/web/ApplicationRelationReviewPanel.js';
import { buildRelationReviewRequest, relationReviewBasisEqual, relationReviewResponseMatches, relationReviewSubmissionMode, relationReviewCanRebase } from '../src/web/relation-review.js';
import { RelationSuggestionPreview } from '../src/web/RelationSuggestionPreview.js';

const endpoint = (conceptId: string) => ({ conceptId, sourceRevision: `revision-${conceptId}`, title: `Title ${conceptId}`, path: `domain/${conceptId}.md` });
function basis(): RelationReviewBasis { return { source: { conceptId: 'a', current: endpoint('a') }, target: { conceptId: 'b', current: endpoint('b') }, beforePresent: null, afterPresent: true }; }
function application(): ApplicationRecord {
  return { eventId: 'application-1', conceptId: 'a', sourceRevision: 'revision-a', occurredAt: '2026-10-12T08:00:00.000Z', recordedAt: '2026-10-12T08:01:00.000Z', kind: 'summary', context: '', content: '理由', outcome: 'partial', assistance: 'independent', result: '', limitations: '', insight: '', correction: '', references: '', relationSuggestion: { operation: 'add', source: endpoint('a'), target: endpoint('b'), after: { type: 'uses', description: 'exact description' } } };
}
function response(): RelationReviewResponse { return { sourceId: 'source-1', applicationEventId: 'application-1', conceptId: 'a', asOf: '2026-10-12T08:02:00.000Z', basis: basis(), history: { latest: null, events: [], total: 0 } }; }
function panel(overrides: Partial<ApplicationRelationReviewPanelProps> = {}) {
  return renderToStaticMarkup(createElement(ApplicationRelationReviewPanel, { application: application(), sourceId: 'source-1', refreshKey: 'history-1', loadReview: async () => response(), disabled: false, pending: false, onSave: async () => ({ ok: true }), ...overrides }));
}

test('relation review builder detaches and deeply freezes basis, time and chain for retries', () => {
  const original = basis();
  const result = buildRelationReviewRequest(application(), original, 'previous-1', 'resolved', '  核对说明  ', 'review-1', '2026-10-12T08:03:00.000Z');
  original.target.current!.title = 'mutated'; original.afterPresent = false;
  assert.equal(result.basis.target.current?.title, 'Title b');
  assert.equal(result.basis.afterPresent, true);
  assert.equal(result.previousEventId, 'previous-1'); assert.equal(result.occurredAt, '2026-10-12T08:03:00.000Z'); assert.equal(result.note, '核对说明');
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.basis)); assert.ok(Object.isFrozen(result.basis.target.current));
  assert.throws(() => { result.basis.target.current!.path = 'changed'; }, TypeError);
});

test('response identity requires matching source, primary concept and application together', () => {
  assert.equal(relationReviewResponseMatches(response(), application(), 'source-1'), true);
  for (const patch of [{ sourceId: 'other' }, { applicationEventId: 'other' }, { conceptId: 'b' }]) {
    assert.equal(relationReviewResponseMatches({ ...response(), ...patch }, application(), 'source-1'), false);
  }
});

test('basis equality notices metadata, disappearance and exact presence changes independent of property order', () => {
  const current = basis();
  assert.equal(relationReviewBasisEqual(current, structuredClone(current)), true);
  const reordered = { afterPresent: true, beforePresent: null, target: current.target, source: current.source };
  assert.equal(relationReviewBasisEqual(current, reordered), true);
  for (const field of ['title', 'sourceRevision', 'path'] as const) {
    const changed = structuredClone(current); changed.target.current![field] += ' changed';
    assert.equal(relationReviewBasisEqual(current, changed), false);
  }
  assert.equal(relationReviewBasisEqual(current, { ...current, afterPresent: false }), false);
  assert.equal(relationReviewBasisEqual(current, { ...current, target: { conceptId: 'b', current: null } }), false);
});

test('initial loading fails closed, with stable explicit select label and no inferred adoption', () => {
  const html = panel();
  assert.match(html, /正在核对当前双端点与精确关系/); assert.match(html, /核对结果尚不可用/);
  assert.match(html, /<select[^>]*aria-labelledby="([^"]+)"[^>]*disabled/);
  const label = html.match(/aria-labelledby="([^"]+)"/)![1];
  assert.ok(html.includes(`id="${label}"`)); assert.match(html, /<textarea[^>]*disabled/);
  assert.match(html, /不修改知识源、学习表现或记忆时间/);
  assert.equal(panel({ application: { ...application(), relationSuggestion: undefined } }), '');
});

test('pending relation decision is visibly locked before the current source loads', () => {
  const html = panel({ pending: true });
  assert.match(html, /关系决定待同步/); assert.match(html, /<select[^>]*disabled/); assert.match(html, /<button[^>]*disabled[^>]*>保存关系决定/);
});

test('frozen basis preview shows missing endpoint identity and distinguishes unknown from absence', () => {
  const snapshot = { ...basis(), target: { conceptId: 'missing-target', current: null }, beforePresent: null, afterPresent: null };
  const html = renderToStaticMarkup(createElement(RelationReviewBasisPreview, { basis: snapshot, label: '作出决定时的冻结依据' }));
  assert.match(html, /missing-target/); assert.match(html, /当前知识源中缺失/); assert.match(html, /未知 \/ 不适用/);
  const existing = renderToStaticMarkup(createElement(RelationReviewBasisPreview, { basis: { ...basis(), afterPresent: false }, label: '当前依据' }));
  assert.match(existing, /不存在/); assert.match(existing, /revision-b/); assert.match(existing, /domain\/b.md/);
});

test('original suggestion hint explicitly refers to recording time and separate current review', () => {
  const html = renderToStaticMarkup(createElement(RelationSuggestionPreview, { suggestion: application().relationSuggestion! }));
  assert.match(html, /记录建议时：待核对建议，尚未验证采纳/); assert.match(html, /当前人工处理结果见关系建议复核/);
});

test('uncertain frozen retry bypasses changed read evidence but never bypasses write or scope locks', () => {
  const retry = { locked: false, available: true, frozenInScope: true, hasFrozen: true,
    currentAvailable: false, stale: true, decision: 'resolved' as const, matching: false, confirmed: false };
  assert.equal(relationReviewSubmissionMode(retry), 'retry');
  assert.equal(relationReviewSubmissionMode({ ...retry, locked: true }), 'blocked');
  assert.equal(relationReviewSubmissionMode({ ...retry, available: false }), 'blocked');
  assert.equal(relationReviewSubmissionMode({ ...retry, frozenInScope: false }), 'blocked');
  assert.equal(relationReviewSubmissionMode({ ...retry, hasFrozen: false }), 'blocked');
  const fresh = { ...retry, hasFrozen: false, currentAvailable: true, stale: false, matching: true, confirmed: true };
  assert.equal(relationReviewSubmissionMode(fresh), 'new');
  assert.equal(relationReviewSubmissionMode({ ...fresh, confirmed: false }), 'blocked');
  assert.equal(relationReviewSubmissionMode({ ...fresh, stale: true }), 'blocked');
  assert.equal(relationReviewSubmissionMode({ ...fresh, decision: 'dismissed', matching: false, confirmed: false }), 'new');
});

test('only explicit rejected basis or chain codes allow abandoning a frozen request', () => {
  assert.equal(relationReviewCanRebase('RELATION_REVIEW_SOURCE_CHANGED'), true);
  assert.equal(relationReviewCanRebase('RELATION_REVIEW_CONFLICT'), true);
  for (const code of [undefined, 'EVENT_CONFLICT', 'NETWORK_ERROR', 'HTTP_500', 'SOURCE_MISMATCH', 'INVALID_BODY']) assert.equal(relationReviewCanRebase(code), false);
});
