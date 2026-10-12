import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store, StoreError, parseRelationReviewRequest as parseStoreRequest } from '../src/server/store.js';
import { buildRelationReviewBasis, parseRelationReviewRequest, relationReviewMatches, validateRelationReviewBasis, type RelationReviewRequest } from '../src/shared/relation-reviews.js';
import type { ApplicationRecordRequest, Concept, GraphLink, RelationSuggestion } from '../src/shared/types.js';
const now = '2026-01-10T00:00:00.000Z';
const concepts: Concept[] = ['alpha', 'beta'].map((id) => ({ id, title: id, aliases: [], domain: 'synthetic', summary: '', body: '', source: { path: `${id}.md`, revision: `${id}-1` } }));
const [source, target] = concepts.map((c) => ({ conceptId: c.id, title: c.title, path: c.source.path, sourceRevision: c.source.revision }));
const suggestion: RelationSuggestion = { operation: 'change', source, target, before: { type: 'old', description: 'exact' }, after: { type: 'new', description: ' keep spaces ' } };
const links: GraphLink[] = [{ id: 'one', source: 'alpha', target: 'beta', type: 'new', description: ' keep spaces ' }];
const app: ApplicationRecordRequest = { eventId: 'app', conceptId: 'alpha', sourceRevision: 'alpha-1', occurredAt: '2026-01-02T00:00:00.000Z', kind: 'summary', context: '', content: 'synthetic reason', outcome: 'unverified', assistance: 'unknown', result: '', limitations: '', insight: '', correction: '', references: '', relationSuggestion: suggestion };
const basis = buildRelationReviewBasis(suggestion, concepts, links);
function request(overrides: Partial<RelationReviewRequest> = {}): RelationReviewRequest { return { eventId: 'review', applicationEventId: 'app', conceptId: 'alpha', occurredAt: '2026-01-03T00:00:00.000Z', previousEventId: null, status: 'resolved', note: ' human decision ', basis, ...overrides }; }
function fixture() { const dir = mkdtempSync(join(tmpdir(), 'lm-relation-review-')); const dbPath = join(dir, 'test.sqlite'); return { dbPath, open: (namespace = 'test') => new Store({ dbPath, namespace, now: () => new Date(now) }), cleanup: () => rmSync(dir, { recursive: true, force: true }) }; }
const code = (expected: string) => (error: unknown) => error instanceof StoreError && error.code === expected;

test('relation review helpers enforce exact directed tuples, missing identity, frozen strict requests', () => {
  assert.equal(relationReviewMatches(suggestion, basis), true);
  assert.equal(basis.beforePresent, false); assert.equal(basis.afterPresent, true);
  assert.equal(relationReviewMatches(suggestion, buildRelationReviewBasis(suggestion, concepts, [{ ...links[0], description: 'keep spaces' }])), false);
  assert.equal(relationReviewMatches(suggestion, buildRelationReviewBasis(suggestion, concepts, [{ ...links[0], source: 'beta', target: 'alpha' }])), false);
  assert.equal(relationReviewMatches(suggestion, buildRelationReviewBasis(suggestion, concepts, [...links, { ...links[0], id: 'old', ...suggestion.before }])), false);
  const missing = buildRelationReviewBasis(suggestion, concepts.slice(0, 1), links);
  assert.deepEqual(missing.target, { conceptId: 'beta', current: null });
  assert.equal(missing.beforePresent, null); assert.equal(missing.afterPresent, null); assert.equal(relationReviewMatches(suggestion, missing), false);
  const add: RelationSuggestion = { operation: 'add', source, target, after: suggestion.after };
  const remove: RelationSuggestion = { operation: 'remove', source, target, before: suggestion.before };
  assert.equal(relationReviewMatches(add, buildRelationReviewBasis(add, concepts, links)), true);
  assert.equal(relationReviewMatches(remove, buildRelationReviewBasis(remove, concepts, links)), true);
  assert.throws(() => validateRelationReviewBasis(add, { ...basis, beforePresent: false }));
  assert.throws(() => validateRelationReviewBasis(suggestion, { ...basis, source: { ...basis.source, conceptId: 'other' } }));
  const input = request({ occurredAt: '2026-01-03T08:00:00+08:00' }); const parsed = parseRelationReviewRequest(input);
  assert.equal(parsed.occurredAt, '2026-01-03T00:00:00.000Z'); assert.equal(parsed.note, ' human decision ');
  assert.ok(Object.isFrozen(parsed) && Object.isFrozen(parsed.basis) && Object.isFrozen(parsed.basis.target.current));
  for (const value of [null, [], { ...input, extra: 1 }, { ...input, previousEventId: undefined }, { ...input, status: 'auto' }, { ...input, occurredAt: 'tomorrow' }, { ...input, note: 'x'.repeat(4001) }, { ...input, basis: { ...missing, beforePresent: false } }, { ...input, basis: { ...basis, target: { ...basis.target, current: { ...target, conceptId: 'other' } } } }]) assert.throws(() => parseStoreRequest(value), code('INVALID_BODY'));
});

test('relation decisions append CAS history, duplicate exact original after later decision and reopen', () => {
  const f = fixture(); let store = f.open();
  try {
    store.addApplication(app);
    assert.equal(store.addRelationReview(request()).status, 'accepted');
    const changed = request({ eventId: 'open', previousEventId: 'review', status: 'open', occurredAt: '2026-01-04T00:00:00.000Z', basis: buildRelationReviewBasis(suggestion, concepts, []) });
    store.addRelationReview(changed);
    assert.equal(store.addRelationReview(request()).status, 'duplicate');
    assert.throws(() => store.addRelationReview(request({ note: 'changed' })), code('EVENT_CONFLICT'));
    assert.throws(() => store.addRelationReview(request({ eventId: 'stale' })), code('RELATION_REVIEW_CONFLICT'));
    assert.throws(() => store.addRelationReview(request({ eventId: 'past', previousEventId: 'open', occurredAt: app.occurredAt })), code('RELATION_REVIEW_CONFLICT'));
    assert.throws(() => store.addRelationReview(request({ eventId: 'future', occurredAt: '2027-01-01T00:00:00.000Z' })), code('FUTURE_EVENT'));
    assert.throws(() => store.addRelationReview(request({ eventId: 'no-parent', applicationEventId: 'absent' })), code('APPLICATION_NOT_FOUND'));
    assert.throws(() => store.addRelationReview(request({ eventId: 'wrong-owner', conceptId: 'beta' })), code('RELATION_REVIEW_CONFLICT'));
    assert.throws(() => store.addRelationReview(request({ eventId: 'not-matched', previousEventId: 'open', occurredAt: changed.occurredAt, basis: changed.basis })), code('RELATION_REVIEW_NOT_MATCHED'));
    assert.throws(() => store.addApplication({ ...app, eventId: 'review' }), code('EVENT_CONFLICT'));
    assert.throws(() => store.addRelationReview(request({ eventId: 'app' })), code('EVENT_CONFLICT'));
    assert.equal(store.getRelationReviews('beta').length, 0);
    assert.equal(store.getRelationReviewHistory('app', 1).total, 2);
    assert.deepEqual(store.getRelationReviewHistory('app').events.map((event) => event.eventId), ['open', 'review']);
    assert.throws(() => store.getRelationReviewHistory('app', 0), code('INVALID_HISTORY_LIMIT'));
    store.close(); store = f.open();
    assert.equal(store.getRelationReviewHistory('app').latest?.eventId, 'open'); assert.equal(store.addRelationReview(request()).status, 'duplicate');
    const other = f.open('other'); try { assert.deepEqual(other.getRelationReviews(), []); assert.throws(() => other.addRelationReview(request()), code('APPLICATION_NOT_FOUND')); } finally { other.close(); }
  } finally { store.close(); f.cleanup(); }
});

test('relation review table migrates old store without rewriting legacy payload or changing memory', () => {
  const f = fixture(); let store = f.open();
  store.addApplication({ ...app, relationSuggestion: undefined }); store.close();
  const db = new DatabaseSync(f.dbPath); db.exec('DROP TABLE relation_reviews');
  const oldPayload = db.prepare('SELECT request_payload FROM applications').get(); db.close();
  try {
    store = f.open();
    assert.equal(store.addApplication({ ...app, relationSuggestion: undefined }).status, 'duplicate');
    assert.throws(() => store.addRelationReview(request()), code('INVALID_BODY'));
    const migrated = new DatabaseSync(f.dbPath); try { assert.deepEqual(migrated.prepare('SELECT request_payload FROM applications').get(), oldPayload); } finally { migrated.close(); }
    const exportSource = { name: 'synthetic', mode: 'local' as const, conceptCount: 2, limit: 10, diagnostics: [] };
    assert.equal(Object.hasOwn(store.exportData(exportSource, concepts), 'relationReviews'), false);
    store.addApplication({ ...app, eventId: 'relation-app' });
    store.addReview({ eventId: 'anchor', conceptId: 'alpha', sourceRevision: 'alpha-1', kind: 'review', occurredAt: '2026-01-01T00:00:00.000Z' });
    store.addRetention({ eventId: 'pin', conceptId: 'alpha', sourceRevision: 'alpha-1', active: true, occurredAt: '2026-01-02T00:00:00.000Z', previousEventId: null }, null);
    const snapshot = () => ({ anchors: store.getAnchors(), observations: store.getObservations(), retentions: store.getRetentions(), config: store.getConfig(), configHistory: store.getConfigHistory(), states: store.getStates(concepts, now), applications: store.getApplications(), corrections: store.getCorrections(), layout: store.getLayout(), plan: store.getReviewPlan() });
    const before = snapshot();
    store.addRelationReview(request({ applicationEventId: 'relation-app' }));
    assert.deepEqual(snapshot(), before);
    assert.equal(store.exportData(exportSource, concepts).relationReviews?.length, 1);
    assert.deepEqual(store.getConceptHistory(concepts[0], now, 20).entries.filter((event) => event.type === 'observation'), []);
  } finally { store.close(); f.cleanup(); }
});

test('relation history bounds to 50, accepts same-instant chain order and rejects malformed multi-tail', () => {
  const f = fixture(); const store = f.open();
  try {
    store.addApplication(app);
    let previousEventId: string | null = null;
    for (let index = 0; index < 53; index++) {
      const eventId = `decision-${index}`;
      store.addRelationReview(request({ eventId, status: index % 2 ? 'open' : 'dismissed', previousEventId }));
      previousEventId = eventId;
    }
    const history = store.getRelationReviewHistory('app', 1000);
    assert.equal(history.events.length, 50); assert.equal(history.total, 53);
    assert.equal(history.latest?.eventId, 'decision-52'); assert.equal(history.events.at(-1)?.eventId, 'decision-3');
    assert.equal(store.getRelationReviews(undefined, 'app').length, 53);
    const db = new DatabaseSync(f.dbPath);
    try {
      db.prepare(`INSERT INTO relation_reviews(namespace, event_id, application_event_id, concept_id, basis_json, occurred_at, recorded_at, previous_event_id, status, note, request_payload)
        SELECT namespace, 'branched', application_event_id, concept_id, basis_json, occurred_at, recorded_at, previous_event_id, status, note, request_payload FROM relation_reviews WHERE event_id = 'decision-52'`).run();
    } finally { db.close(); }
    assert.throws(() => store.getRelationReviewHistory('app'), code('RELATION_REVIEW_CONFLICT'));
    assert.throws(() => store.addRelationReview(request({ eventId: 'unsafe', previousEventId: 'decision-52' })), code('RELATION_REVIEW_CONFLICT'));
    // An already accepted request remains idempotent even after corrupt external history.
    assert.equal(store.addRelationReview(request({ eventId: 'decision-0', status: 'dismissed' })).status, 'duplicate');
  } finally { store.close(); f.cleanup(); }
});
