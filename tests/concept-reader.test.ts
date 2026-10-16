import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Concept } from '../src/shared/types.ts';
import { canShowConceptReader, relativeSource, type ReaderRequest } from '../src/web/concept-reader-state.ts';

const concept: Concept = {
  id: 'math-boolean', title: '布尔逻辑', aliases: [], domain: 'Math', summary: '真值判断', body: '# 布尔逻辑\n知识正文',
  source: { path: 'Cognition/Math/Boolean.md', revision: 'revision-1' },
};
const request: ReaderRequest = { sourceId: 'source-a', conceptId: concept.id, sourceRevision: concept.source.revision, section: 'body' };

test('the same rendered material is available in normal reading and after submitting a recall answer', () => {
  assert.equal(canShowConceptReader(request, 'source-a', concept, null, false), true);
  assert.equal(canShowConceptReader(request, 'source-a', concept, 'feedback', false), true);
  assert.equal(canShowConceptReader(request, 'source-a', concept, 'answer', false), false);
  assert.equal(canShowConceptReader(request, 'source-a', concept, 'prediction', false), false);
});

test('an open reader cannot expose a different concept, source or revision, including while reconnecting', () => {
  assert.equal(canShowConceptReader(request, 'source-b', concept, null, false), false);
  assert.equal(canShowConceptReader(request, 'source-a', { ...concept, id: 'other' }, null, false), false);
  assert.equal(canShowConceptReader(request, 'source-a', { ...concept, source: { ...concept.source, revision: 'revision-2' } }, null, false), false);
  assert.equal(canShowConceptReader(request, 'source-a', concept, null, true), false);
  assert.equal(canShowConceptReader(request, 'source-a', null, null, false), false);
  assert.equal(canShowConceptReader(null, 'source-a', concept, null, false), false);
});

test('reader path labels preserve relative knowledge paths without exposing the local root', () => {
  assert.equal(relativeSource('/home/private-owner/progressive-kg/Cognition/Math/Boolean.md'), 'Cognition/Math/Boolean.md');
  assert.equal(relativeSource('C:\\Users\\private-owner\\progressive-kg\\Cognition\\Math\\Boolean.md'), 'Cognition/Math/Boolean.md');
});

test('chapter metadata is accepted only for the rendered concept and source revision', async () => {
  const { referencesMatchConcept } = await import('../src/web/concept-reader-state.ts');
  assert.equal(referencesMatchConcept({ conceptId: concept.id, sourceRevision: 'revision-1' }, concept), true);
  assert.equal(referencesMatchConcept({ conceptId: concept.id, sourceRevision: 'stale' }, concept), false);
  assert.equal(referencesMatchConcept({ conceptId: 'other', sourceRevision: 'revision-1' }, concept), false);
  assert.equal(referencesMatchConcept(null, concept), false);
});

test('unresolved chapter references give distinct safe full-document fallbacks', async () => {
  const { sectionNavigationMessage } = await import('../src/web/concept-reader-state.ts');
  assert.match(sectionNavigationMessage('ambiguous'), /多个匹配/);
  assert.match(sectionNavigationMessage('unsupported-block'), /块引用/);
  assert.match(sectionNavigationMessage('unsafe'), /未打开本地文件/);
  assert.match(sectionNavigationMessage('missing-section'), /全文/);
  assert.match(sectionNavigationMessage('missing-concept'), /未找到/);
});
