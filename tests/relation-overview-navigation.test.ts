import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildRelationOverview } from '../src/core/relation-overview.js';
import type { LearningOverview } from '../src/shared/learning-overview.js';
import type { ApplicationRecord, Concept, Snapshot } from '../src/shared/types.js';
import type { RelationReviewResponse } from '../src/shared/relation-reviews.js';
import { resolveRelationOverviewSelection } from '../src/web/learning-overview-loader.js';

const sourceId = 'private-relation-space';
const asOf = '2026-10-13T02:00:00.000Z';
const primary: Concept = { id: 'primary', title: '主概念', domain: 'Math', aliases: [], body: '', summary: '',
  source: { path: 'Math/primary.md', revision: 'primary-v1' } };
const secondary: Concept = { id: 'secondary', title: '另一端', domain: 'AI', aliases: [], body: '', summary: '',
  source: { path: 'AI/secondary.md', revision: 'secondary-v1' } };
const endpoint = (concept: Concept) => ({ conceptId: concept.id, title: concept.title,
  path: concept.source.path, sourceRevision: concept.source.revision });
const application: ApplicationRecord = {
  eventId: 'application-relation', conceptId: primary.id, sourceRevision: primary.source.revision,
  occurredAt: '2026-10-12T02:00:00.000Z', recordedAt: '2026-10-12T02:01:00.000Z',
  kind: 'summary', context: '', content: 'PRIVATE_BODY', outcome: 'unverified', assistance: 'independent',
  result: '', limitations: '', insight: '', correction: '', references: '',
  relationSuggestion: { operation: 'add', source: endpoint(primary), target: endpoint(secondary),
    after: { type: 'supports', description: 'PRIVATE_RELATION_DESCRIPTION' } },
};

function fixture(concepts = [primary, secondary]) {
  const relations = buildRelationOverview({ concepts, links: [], applications: [application], reviews: [], asOf });
  const item = relations.items[0];
  const overview: LearningOverview = { sourceId, asOf, items: [], relations };
  const snapshot: Snapshot = { concepts, links: [], source: { name: 'synthetic', mode: 'local', conceptCount: concepts.length,
    limit: 1, diagnostics: [] }, config: { modelVersion: 'time-only-v0', revision: 1, halfLifeDays: 7 },
    states: {}, observationsCount: 0, asOf };
  const inspection: RelationReviewResponse = { sourceId, applicationEventId: application.eventId,
    conceptId: primary.id, asOf, basis: structuredClone(item.basis), history: { latest: null, events: [], total: 0 } };
  return { item, overview, snapshot, inspection };
}

test('relation navigation binds the original application independently of the text-correction queue', () => {
  const f = fixture();
  assert.equal(f.overview.corrections, undefined);
  assert.equal(resolveRelationOverviewSelection(sourceId, f.overview, f.item, f.snapshot, f.inspection), primary);
  assert.throws(() => resolveRelationOverviewSelection('foreign', f.overview, f.item, f.snapshot, f.inspection), /知识空间/);
  assert.throws(() => resolveRelationOverviewSelection(sourceId, f.overview, f.item, f.snapshot,
    { ...f.inspection, sourceId: 'foreign' }), /知识空间/);
  assert.throws(() => resolveRelationOverviewSelection(sourceId, { ...f.overview, relations: undefined }, f.item, f.snapshot, f.inspection), /不在当前总览/);
  for (const altered of [{ applicationEventId: 'foreign-app' }, { conceptId: 'foreign-concept' }, { sourceRevision: 'new-revision' }]) {
    assert.throws(() => resolveRelationOverviewSelection(sourceId, f.overview, { ...f.item, ...altered }, f.snapshot, f.inspection), /不在当前总览/);
  }
  for (const altered of [{ applicationEventId: 'foreign-app' }, { conceptId: 'foreign-concept' }]) {
    assert.throws(() => resolveRelationOverviewSelection(sourceId, f.overview, f.item, f.snapshot,
      { ...f.inspection, ...altered }), /处理决定已变化/);
  }
});

test('a changed exact relation or newer decision invalidates navigation even when the primary revision is unchanged', () => {
  const f = fixture();
  const changedRelation = { ...f.inspection, basis: { ...f.inspection.basis, afterPresent: true } };
  assert.throws(() => resolveRelationOverviewSelection(sourceId, f.overview, f.item, f.snapshot, changedRelation), /关系依据或处理决定已变化/);
  const latest = { eventId: 'new-decision', applicationEventId: application.eventId, conceptId: primary.id,
    occurredAt: asOf, recordedAt: asOf, previousEventId: null, status: 'dismissed', note: '', basis: f.inspection.basis } as const;
  assert.throws(() => resolveRelationOverviewSelection(sourceId, f.overview, f.item, f.snapshot,
    { ...f.inspection, history: { latest, events: [latest], total: 1 } }), /关系依据或处理决定已变化/);
});

test('navigation checks both endpoints against the fresh full snapshot, including names and paths', () => {
  const f = fixture();
  for (const changed of [
    { ...secondary, source: { ...secondary.source, revision: 'secondary-v2' } },
    { ...secondary, source: { ...secondary.source, path: 'Elsewhere/moved.md' } },
    { ...secondary, title: '改名后的另一端' },
  ]) {
    assert.throws(() => resolveRelationOverviewSelection(sourceId, f.overview, f.item,
      { ...f.snapshot, concepts: [primary, changed] }, f.inspection), /关系双端资料已变化/);
  }
  assert.throws(() => resolveRelationOverviewSelection(sourceId, f.overview, f.item,
    { ...f.snapshot, concepts: [primary] }, f.inspection), /关系双端资料已变化/);
  assert.throws(() => resolveRelationOverviewSelection(sourceId, f.overview, f.item,
    { ...f.snapshot, concepts: [secondary] }, f.inspection), /概念已移动/);
});

test('a consistently missing secondary endpoint allows inspecting the original record without claiming deletion success', () => {
  const f = fixture([primary]);
  assert.equal(f.item.structureMatches, null);
  assert.equal(resolveRelationOverviewSelection(sourceId, f.overview, f.item, f.snapshot, f.inspection), primary);
  assert.throws(() => resolveRelationOverviewSelection(sourceId, f.overview, f.item,
    { ...f.snapshot, concepts: [primary, secondary] }, f.inspection), /关系双端资料已变化/);
});
