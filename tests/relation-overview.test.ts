import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildRelationOverview, relationOverviewIsActionable, selectRelationOverviewItems, type RelationOverviewInput } from '../src/core/relation-overview.js';
import { buildRelationReviewBasis, type RelationReviewEvent } from '../src/shared/relation-reviews.js';
import type { ApplicationRecord, Concept, GraphLink, RelationSuggestion } from '../src/shared/types.js';

const asOf = '2026-01-10T00:00:00.000Z';
const concepts: Concept[] = ['alpha', 'beta'].map((id, index) => ({ id, title: id, aliases: [], domain: 'synthetic', summary: 'PRIVATE SUMMARY', body: 'PRIVATE BODY', source: { path: `${index ? 'AI' : 'Math'}/${id}.md`, revision: `${id}-1` } }));
const [source, target] = concepts.map((concept) => ({ conceptId: concept.id, title: concept.title, path: concept.source.path, sourceRevision: concept.source.revision }));
const suggestion: RelationSuggestion = { source, target, operation: 'change', before: { type: 'old', description: 'PRIVATE OLD RELATION' }, after: { type: 'new', description: ' PRIVATE NEW RELATION ' } };
const links: GraphLink[] = [{ id: 'edge', source: 'alpha', target: 'beta', ...suggestion.after }];
const app: ApplicationRecord = { eventId: 'app', conceptId: 'alpha', sourceRevision: 'alpha-1', kind: 'application', occurredAt: '2026-01-02T00:00:00.000Z', recordedAt: '2026-01-02T00:00:00.000Z', relationSuggestion: suggestion, context: 'PRIVATE CONTEXT', content: 'PRIVATE CONTENT', outcome: 'unverified', assistance: 'unknown', result: 'PRIVATE RESULT', limitations: 'PRIVATE LIMIT', insight: 'PRIVATE INSIGHT', correction: 'PRIVATE CORRECTION', references: 'PRIVATE REFERENCES' };
function review(overrides: Partial<RelationReviewEvent> = {}): RelationReviewEvent {
  return { eventId: 'review', applicationEventId: 'app', conceptId: 'alpha', occurredAt: '2026-01-03T00:00:00.000Z', recordedAt: '2026-01-03T00:00:00.000Z', previousEventId: null, status: 'resolved', note: 'PRIVATE NOTE', basis: buildRelationReviewBasis(suggestion, concepts, links), ...overrides };
}
function overview(overrides: Partial<RelationOverviewInput> = {}) {
  return buildRelationOverview({ concepts, links, applications: [app], reviews: [], asOf, ...overrides });
}

test('full directed exact tuple presence supports add, change and remove without deciding human status', () => {
  const current = overview().items[0];
  assert.equal(current.structureMatches, true);
  assert.equal(current.status, 'open');
  for (const changed of [{ source: 'beta', target: 'alpha' }, { type: 'NEW' }, { description: suggestion.after.description.trim() }]) {
    assert.equal(overview({ links: [{ ...links[0], ...changed }] }).items[0].structureMatches, false);
  }
  const beforeLink = { ...links[0], id: 'before', ...suggestion.before };
  assert.equal(overview({ links: [...links, beforeLink] }).items[0].structureMatches, false);
  for (const relationSuggestion of [
    { source, target, operation: 'add', after: suggestion.after },
    { source, target, operation: 'remove', before: suggestion.before },
  ] as RelationSuggestion[]) {
    assert.equal(overview({ applications: [{ ...app, relationSuggestion }] }).items[0].structureMatches, true);
  }
});

test('resolved decisions require recheck when the other endpoint or exact graph changes despite unchanged primary revision', () => {
  const reviews = [review()];
  assert.equal(overview({ reviews }).items[0].needsRecheck, false);
  for (const change of [
    { concepts: [concepts[0], { ...concepts[1], source: { ...concepts[1].source, revision: 'beta-2' } }] },
    { concepts: [concepts[0], { ...concepts[1], title: 'renamed beta' }] },
    { links: [] },
  ]) {
    const item = overview({ reviews, ...change }).items[0];
    assert.equal(item.sourceChanged, false);
    assert.equal(item.status, 'resolved');
    assert.equal(item.basisChanged, true);
    assert.equal(item.needsRecheck, true);
    assert.equal(relationOverviewIsActionable(item), true);
  }
});

test('missing other endpoint remains unknown with frozen display fallback; missing primary counted globally', () => {
  const result = overview({ concepts: [concepts[0]], reviews: [review()] });
  const item = result.items[0];
  assert.equal(item.structureMatches, null);
  assert.equal(item.basis.target.current, null);
  assert.deepEqual(item.target, target);
  assert.equal(item.needsRecheck, true);
  const absent = overview({ concepts: [concepts[1]] });
  assert.deepEqual(absent, { items: [], unavailableCount: 1 });
});

test('manual states remain independent of graph match; dismissed changes stay out of default queue', () => {
  for (const status of ['open', 'resolved', 'dismissed'] as const) {
    const item = overview({ reviews: [review({ status })], links: [] }).items[0];
    assert.equal(item.status, status);
    assert.equal(item.basisChanged, true);
    assert.equal(item.needsRecheck, status === 'resolved');
    assert.equal(selectRelationOverviewItems([item]).length, status === 'dismissed' ? 0 : 1);
    assert.equal(selectRelationOverviewItems([item], { filter: 'recheck' }).length, status === 'resolved' ? 1 : 0);
    assert.equal(selectRelationOverviewItems([item], { filter: 'resolved' }).length, 0);
    assert.equal(selectRelationOverviewItems([item], { filter: 'dismissed' }).length, status === 'dismissed' ? 1 : 0);
  }
});

test('chains follow predecessors, not time ordering; malformed chains cannot masquerade as open or resolved', () => {
  const first = review();
  const last = review({ eventId: 'last', previousEventId: 'review', status: 'dismissed' });
  assert.equal(overview({ reviews: [last, first] }).items[0].latestEventId, 'last');
  const malformed: RelationReviewEvent[][] = [
    [first, first],
    [first, review({ eventId: 'other-root' })],
    [last],
    [first, last, { ...last, eventId: 'branch' }],
    [{ ...first, previousEventId: 'last' }, last],
    [first, review({ eventId: 'cycle-a', previousEventId: 'cycle-b' }), review({ eventId: 'cycle-b', previousEventId: 'cycle-a' })],
    [first, { ...last, conceptId: 'beta' }],
    [{ ...first, basis: { ...first.basis, source: { conceptId: 'wrong', current: null } } }],
    [{ ...first, occurredAt: '2026-01-01T00:00:00.000Z' }],
    [{ ...first, recordedAt: '2026-01-02T00:00:00.000Z' }],
    [first, { ...first, applicationEventId: 'other' }],
  ];
  for (const reviews of malformed) {
    const item = overview({ reviews }).items[0];
    assert.equal(item.chainInvalid, true);
    assert.equal(item.status, null);
    assert.equal(item.latestEventId, null);
    assert.equal(selectRelationOverviewItems([item]).length, 1);
    assert.equal(selectRelationOverviewItems([item], { filter: 'open' }).length, 0);
  }
  assert.equal(overview({ reviews: [{ ...last, applicationEventId: 'other' }, first] }).items[0].status, 'resolved');
  assert.equal(overview({ reviews: [first, { ...last, previousEventId: 'foreign' }, review({ eventId: 'foreign', applicationEventId: 'other' })] }).items[0].chainInvalid, true);
});

test('both occurrence and recording timestamps gate applications and reviews at asOf', () => {
  for (const field of ['occurredAt', 'recordedAt'] as const) {
    assert.deepEqual(overview({ applications: [{ ...app, [field]: '2026-01-11T00:00:00.000Z' }] }), { items: [], unavailableCount: 0 });
    assert.equal(overview({ reviews: [review({ [field]: '2026-01-11T00:00:00.000Z' })] }).items[0].status, 'open');
  }
  assert.equal(overview({ asOf: 'invalid' }).items.length, 0);
  const first = review();
  const futureParent = review({ eventId: 'future', recordedAt: '2026-01-11T00:00:00.000Z' });
  assert.equal(overview({ reviews: [futureParent, { ...first, previousEventId: 'future' }] }).items[0].chainInvalid, true);
});

test('primary domain, cross-domain endpoint search and stable actionable/time/id ordering', () => {
  const applications = [app, { ...app, eventId: 'b' }, { ...app, eventId: 'a' }, { ...app, eventId: 'other-domain', conceptId: 'beta', sourceRevision: 'beta-1' }];
  const result = overview({ applications, reviews: [review({ status: 'resolved' })] });
  assert.deepEqual(selectRelationOverviewItems(result.items, { filter: 'all' }).map((item) => item.applicationEventId), ['a', 'b', 'other-domain', 'app']);
  assert.equal(selectRelationOverviewItems(result.items, { domainId: 'Math', query: ' BETA ', filter: 'all' }).length, 3);
  assert.equal(selectRelationOverviewItems(result.items, { domainId: 'AI', query: 'alpha' }).length, 1);
  assert.equal(selectRelationOverviewItems(result.items, { query: 'OTHER-DOMAIN' }).length, 1);
  const newer = overview({ applications, reviews: [review({ eventId: 'b-review', applicationEventId: 'b', status: 'open' })] });
  assert.equal(selectRelationOverviewItems(newer.items)[0].applicationEventId, 'b');
});

test('output contains no private relation text, bodies, notes or history, and inputs remain unchanged', () => {
  const input: RelationOverviewInput = { concepts: structuredClone(concepts), links: structuredClone(links), applications: [structuredClone(app)], reviews: [review()], asOf };
  const before = structuredClone(input);
  const result = buildRelationOverview(input);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.deepEqual(input, before);
  selectRelationOverviewItems(result.items, { filter: 'all' });
  assert.deepEqual(input, before);
  assert.notEqual(result.items[0].source, input.concepts[0]);
});
