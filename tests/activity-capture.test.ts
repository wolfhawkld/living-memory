import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createActivityCapture } from '../src/web/activity-capture.js';
import type { ActivityAppendRequest } from '../src/shared/activity.js';
import type { KnowledgeContentBlock } from '../src/shared/knowledge-references.js';

const concept = { id: 'concept_a', title: 'Alpha', source: { path: 'Alpha.md', revision: 'revision_a' } };
function fixture() {
  const requests: ActivityAppendRequest[] = []; let sequence = 0;
  const timers = new Map<number, () => void>();
  const capture = createActivityCapture({ emit: (request) => requests.push(request), id: () => `activity_${++sequence}`,
    now: () => '2026-10-16T02:00:00.000Z', schedule: (callback) => { const key = ++sequence; timers.set(key, callback); return key; },
    cancel: (handle) => { timers.delete(handle as number); } });
  const flush = () => { for (const [key, callback] of timers) { timers.delete(key); callback(); } };
  capture.setContext({ scopeKey: 'owner:source', epoch: 0, enabled: true });
  return { capture, requests, flush };
}
const block = (index: number): KnowledgeContentBlock => ({ blockId: `block-body-${index}-${index + 1}`, contentPart: 'body', kind: 'paragraph',
  bodyRange: { coordinateSpace: 'render-markdown-v1', startOffset: index, endOffset: index + 1, startLine: 1, endLine: 1 } });
const fact = { conceptId: concept.id, sourceRevision: concept.source.revision, contentPart: 'body' as const };

test('explicit query gestures keep zero-result submissions and store raw text only for that opt-in query', () => {
  const { capture, requests } = fixture();
  capture.query({ query: 'private draft', results: [], resultCount: 0, saveQueryText: false });
  assert.equal(requests.length, 1); assert.deepEqual(requests[0].event.payload, { resultCount: 0 });
  const input = { query: 'explicit text', results: [concept], resultCount: 1, saveQueryText: true };
  const operation = capture.query(input);
  capture.query(input, concept, operation);
  assert.equal(requests.length, 3);
  assert.equal(requests[1].event.operationId, requests[2].event.operationId);
  assert.equal(requests[2].event.kind, 'query.selected');
  assert.deepEqual(requests[2].event.payload, { queryText: 'explicit text', queryTextSavedByUser: true });
});

test('reading tracks only reported blocks, deduplicates navigation and flushes observed facts on ordinary close', () => {
  const { capture, requests, flush } = fixture();
  capture.opened(fact, concept); assert.equal(requests.length, 0);
  capture.beginReading(); capture.opened(fact, concept); capture.opened(fact, concept);
  capture.visible({ ...fact, blocks: [block(1), block(2), block(1)] }, concept);
  assert.equal(requests.length, 1);
  capture.endReading(); assert.equal(requests.length, 2);
  flush(); assert.equal(requests.length, 2);
  assert.equal(requests[0].event.operationId, requests[1].event.operationId);
  assert.deepEqual(requests[1].event.refs.map((ref) => ref.blockId), ['block-body-1-2', 'block-body-2-3']);
});

test('clear and pause discard unqueued facts and cannot rebuild deleted reading until an explicit new opening', () => {
  const { capture, requests, flush } = fixture();
  capture.beginReading(); capture.visible({ ...fact, blocks: [block(1)] }, concept); capture.cancel(); flush();
  capture.setContext({ scopeKey: 'owner:source', epoch: 1, enabled: true });
  capture.opened(fact, concept); capture.visible({ ...fact, blocks: [block(2)] }, concept); flush();
  assert.equal(requests.length, 0);
  capture.beginReading(); capture.opened(fact, concept); assert.equal(requests[0].epoch, 1);
  capture.setContext({ scopeKey: 'member:source', epoch: 1, enabled: false });
  capture.query({ query: 'x', results: [], resultCount: 0, saveQueryText: true });
  assert.equal(requests.length, 1);
});

test('visible batches have at most 50 refs and keep the first observation time', () => {
  const { capture, requests, flush } = fixture(); capture.beginReading();
  capture.visible({ ...fact, blocks: Array.from({ length: 51 }, (_, index) => block(index)) }, concept); flush();
  assert.deepEqual(requests.map((request) => request.event.refs.length), [50, 1]);
  assert.notEqual(requests[0].event.stepKey, requests[1].event.stepKey);
  assert.ok(requests.every((request) => request.event.occurredAt === '2026-10-16T02:00:00.000Z'));
});

test('an oversized opt-in query keeps metadata without silently saving truncated original text', () => {
  const { capture, requests } = fixture();
  capture.query({ query: '字'.repeat(1001), results: [], resultCount: 0, saveQueryText: true });
  assert.deepEqual(requests[0].event.payload, { resultCount: 0 });
});
