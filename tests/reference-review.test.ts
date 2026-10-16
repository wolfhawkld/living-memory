import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReferenceReviewDialog, initialReferenceCandidate, referenceReviewDisabledReason, referenceReviewStatusMessage,
  type ReferenceReviewDialogProps } from '../src/web/ReferenceReviewDialog';
import type { Concept } from '../src/shared/types';
import type { ActivityReference } from '../src/shared/activity';
import type { KnowledgeReferences } from '../src/shared/knowledge-references';

const concept: Concept = { id: 'concept-1', title: '当前资料', aliases: [], domain: 'Math', summary: '摘要', body: '# 定义\n新正文',
  source: { path: 'Math/new.md', revision: 'revision-new' } };
const reference: ActivityReference = { conceptId: 'concept-1', title: '旧资料', sourceRevision: 'revision-old', path: 'Math/old.md',
  scope: 'block', blockId: 'block-body-0-10', contentPart: 'body', sectionId: '定义',
  bodyRange: { coordinateSpace: 'render-markdown-v1', startOffset: 0, endOffset: 10, startLine: 1, endLine: 2 } };
const metadata: KnowledgeReferences = { conceptId: concept.id, sourceRevision: concept.source.revision, references: [], sections: [
  { sectionId: '定义', title: '定义', headingPath: ['定义'], parentId: null, level: 1,
    bodyRange: { coordinateSpace: 'render-markdown-v1', startOffset: 0, endOffset: 10, startLine: 1, endLine: 2 }, contentHash: 'synthetic' },
] };
const props: ReferenceReviewDialogProps = { scopeKey: 'account-source-scope', reference,
  status: { refIndex: 0, status: 'source-changed', revisionChanged: true, pathChanged: true }, concepts: [concept],
  loadReferences: async () => metadata, onConfirm: () => undefined, onClose: () => undefined };

test('reference review displays the frozen identity beside current metadata and starts without an explicit location', () => {
  const html = renderToStaticMarkup(createElement(ReferenceReviewDialog, props));
  assert.match(html, /旧资料/); assert.match(html, /Math\/old\.md/); assert.match(html, /revision-old/);
  assert.match(html, /当前资料/); assert.match(html, /Math\/new\.md/); assert.match(html, /revision-new/);
  assert.match(html, /block-body-0-10/); assert.match(html, /显示正文坐标/);
  assert.match(html, /旧章节不会自动对应到当前章节/);
  assert.match(html, /<option value="concept-1" selected="">/);
  assert.doesNotMatch(html, /checked=""/);
  assert.match(html, /<button type="button" disabled="">打开当前资料<\/button>/);
  assert.match(html, /不会复制旧学习表现、长期保持状态或自动登记概念身份/);
});

test('a missing old ID never preselects a new concept merely because its title matches', () => {
  const replacement = { ...concept, id: 'replacement', title: reference.title! };
  assert.equal(initialReferenceCandidate(reference, [replacement]), '');
  const html = renderToStaticMarkup(createElement(ReferenceReviewDialog, { ...props, concepts: [replacement],
    status: { refIndex: 0, status: 'missing-concept', revisionChanged: false, pathChanged: false } }));
  assert.match(html, /同名资料不会自动配对/);
  assert.match(html, /<option value="" selected="">请选择资料/);
  assert.doesNotMatch(html, /<option value="replacement" selected/);
});

test('even same-slug current chapters require an explicit selection and matching metadata before confirmation', () => {
  assert.match(referenceReviewDisabledReason(concept, metadata, null)!, /明确选择一个当前章节/);
  assert.equal(referenceReviewDisabledReason(concept, metadata, { kind: 'document' }), null);
  assert.equal(referenceReviewDisabledReason(concept, metadata, { kind: 'section', sectionId: '定义' }), null);
  assert.match(referenceReviewDisabledReason(concept, metadata, { kind: 'section', sectionId: 'removed' })!, /章节已失效/);
  assert.match(referenceReviewDisabledReason(concept, null, { kind: 'document' })!, /目录尚未核验/);
  assert.match(referenceReviewDisabledReason(concept, { ...metadata, sourceRevision: 'stale' }, { kind: 'document' })!, /目录尚未核验/);
  assert.match(referenceReviewDisabledReason(concept, { ...metadata, conceptId: 'another' }, { kind: 'section', sectionId: '定义' })!, /目录尚未核验/);
  assert.match(referenceReviewDisabledReason(null, metadata, { kind: 'document' })!, /选择一份当前资料/);
  assert.match(referenceReviewDisabledReason(concept, metadata, { kind: 'document' }, true)!, /正在核对并打开/);
});

test('each source failure explains why old evidence stays intact instead of silently relocating it', () => {
  assert.match(referenceReviewStatusMessage('source-changed'), /版本已经变化/);
  assert.match(referenceReviewStatusMessage('source-moved'), /路径已经变化/);
  assert.match(referenceReviewStatusMessage('missing-concept'), /不会自动配对/);
  assert.match(referenceReviewStatusMessage('location-unresolved'), /无法精确定位/);
  assert.match(referenceReviewStatusMessage('current'), /新的阅读/);
});
