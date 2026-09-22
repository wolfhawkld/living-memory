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
