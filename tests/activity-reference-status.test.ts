import assert from 'node:assert/strict';
import test from 'node:test';
import type { ActivityRecord, ActivityReference } from '../src/shared/activity';
import type { Concept, KnowledgeGraph } from '../src/shared/types';
import type { KnowledgeSource } from '../src/server/kg';
import { getKnowledgeReferences } from '../src/server/knowledge-references';
import { inspectRecordedActivityReferences } from '../src/server/activity-reference-status';

const original: Concept = { id: 'concept-original', title: '定义知识', aliases: [], domain: 'Math', summary: '摘要内容。',
  body: '# 定义\n\n定义原理。\n\n## 应用\n\n适用场景。', source: { path: 'Math/A.md', revision: 'revision-1' } };
function source(concepts: Concept[] = [original], namespace = 'alice'): KnowledgeSource {
  const graph: KnowledgeGraph = { concepts, links: [], source: { name: 'Synthetic only', mode: 'local', conceptCount: concepts.length, limit: 100, diagnostics: [] } };
  return { graph, index: graph, namespace, root: '/synthetic-only' };
}
function recorded(refs: ActivityReference[]): ActivityRecord {
  return { epoch: 0, receivedAt: '2026-10-16T08:00:01.000Z', recordedBy: { principalId: 'alice', sessionKind: 'accounts' },
    referenceInspections: refs.map(() => ({ status: 'current' })), event: {
      schemaVersion: 1, eventId: 'event-frozen', operationId: 'operation-frozen', stepKey: 'visible', occurredAt: '2026-10-16T08:00:00.000Z',
      actor: { kind: 'user' }, channel: 'web', kind: 'content.visible', refs, payload: {},
    } };
}
function locationReferences(knowledge: KnowledgeSource): ActivityReference[] {
  const metadata = getKnowledgeReferences(knowledge, original.id, original.source.revision);
  const block = metadata.blocks!.find((entry) => entry.kind === 'paragraph' && entry.contentPart === 'body')!;
  const section = metadata.sections[1];
  const base = { conceptId: original.id, sourceRevision: original.source.revision, path: original.source.path };
  return [
    { ...base, scope: 'block', blockId: block.blockId, contentPart: block.contentPart, bodyRange: block.bodyRange,
      ...(block.sectionId ? { sectionId: block.sectionId } : {}) },
    { ...base, scope: 'section', sectionId: section.sectionId, bodyRange: section.bodyRange },
  ];
}

test('frozen exact blocks and sections locate in the same revision without mutating source or original evidence', () => {
  const knowledge = source(); const record = recorded(locationReferences(knowledge));
  const before = JSON.stringify({ record, knowledge });
  const statuses = inspectRecordedActivityReferences(record, knowledge);
  assert.deepEqual(statuses.map((status) => status.status), ['current', 'current']);
  assert.deepEqual(statuses.map((status) => status.refIndex), [0, 1]);
  assert.ok(statuses.every((status) => !status.pathChanged && !status.revisionChanged));
  assert.equal(JSON.stringify({ record, knowledge }), before);
});

test('changed revisions stay changed even when the new document has exactly the same heading slug', () => {
  const record = recorded(locationReferences(source()));
  const current = { ...original, body: original.body.replace('定义原理。', '完全不同的定义原理。'), source: { ...original.source, revision: 'revision-2' } };
  const statuses = inspectRecordedActivityReferences(record, source([current]));
  assert.ok(statuses.every((status) => status.status === 'source-changed' && status.revisionChanged && !status.pathChanged));
  assert.equal(statuses[0].current!.sourceRevision, 'revision-2');
  assert.equal(record.event.refs[0].sourceRevision, 'revision-1');
});

test('explicit same-identity moves report path changes and revision changes take priority when both changed', () => {
  const record = recorded(locationReferences(source()));
  const moved = { ...original, source: { ...original.source, path: 'New/A.md' } };
  assert.ok(inspectRecordedActivityReferences(record, source([moved])).every((status) => status.status === 'source-moved' && status.pathChanged && !status.revisionChanged));
  const changedAndMoved = { ...moved, source: { path: 'New/A.md', revision: 'revision-2' } };
  assert.ok(inspectRecordedActivityReferences(record, source([changedAndMoved])).every((status) => status.status === 'source-changed' && status.pathChanged && status.revisionChanged));
});

test('removed IDs never match similarly named replacement concepts or another owner index', () => {
  const record = recorded(locationReferences(source()));
  const replacement = { ...original, id: 'different-identity', source: { ...original.source, path: 'Math/replacement.md' } };
  const bobOnly = { ...original, id: 'bob-private', title: 'Bob secret title', source: { path: 'Bob/private.md', revision: 'bob-revision' } };
  for (const knowledge of [source([replacement]), source([bobOnly], 'bob'), source([])]) {
    assert.deepEqual(inspectRecordedActivityReferences(record, knowledge), [
      { refIndex: 0, status: 'missing-concept', revisionChanged: false, pathChanged: false },
      { refIndex: 1, status: 'missing-concept', revisionChanged: false, pathChanged: false },
    ]);
  }
});

test('corrupt range, content part, block ID or section affiliation stays location-unresolved', () => {
  const knowledge = source(); const [block, section] = locationReferences(knowledge);
  const refs: ActivityReference[] = [
    { ...block, bodyRange: { ...block.bodyRange!, endOffset: block.bodyRange!.endOffset + 1 } },
    { ...block, sectionId: 'wrong-heading' }, { ...block, blockId: 'missing-block' }, { ...block, contentPart: 'summary' },
    { ...section, sectionId: 'missing-section' }, { ...section, bodyRange: { ...section.bodyRange!, startLine: 999 } },
  ];
  assert.ok(inspectRecordedActivityReferences(recorded(refs), knowledge).every((status) => status.status === 'location-unresolved'));
});

test('document-level references remain current and old receipt inspections are preserved as historical facts', () => {
  const knowledge = source();
  const refs: ActivityReference[] = (['result', 'summary', 'body'] as const).map((scope) => ({ conceptId: original.id,
    sourceRevision: original.source.revision, path: original.source.path, scope }));
  const record = recorded(refs);
  record.referenceInspections = refs.map(() => ({ status: 'historical-or-unresolved' }));
  assert.ok(inspectRecordedActivityReferences(record, knowledge).every((status) => status.status === 'current'));
  assert.ok(record.referenceInspections.every((inspection) => inspection.status === 'historical-or-unresolved'));
});

test('an actual catalog parsing failure propagates rather than claiming a missing or current location', () => {
  const record = recorded(locationReferences(source()));
  const broken = { ...original, body: null as unknown as string };
  assert.throws(() => inspectRecordedActivityReferences(record, source([broken])));
});
