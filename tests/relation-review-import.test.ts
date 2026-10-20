import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildImportPlan } from '../src/server/import-plan.js';
import { Store, StoreError } from '../src/server/store.js';
import { MODEL_VERSION, type ApplicationRecord, type Concept, type ExportData, type ExportDataV1, type RelationSuggestion } from '../src/shared/types.js';
import type { RelationReviewEvent } from '../src/shared/relation-reviews.js';

const now = '2026-01-10T00:00:00.000Z';
const options = { restoreLayout: false, restoreReviewPlan: false };
const source = { name: 'Synthetic target', mode: 'local' as const, conceptCount: 2, limit: 20, diagnostics: [] };
const alpha: Concept = { id: 'live-alpha', title: 'Current Alpha', aliases: [], domain: 'test', summary: '', body: '', source: { path: 'Alpha.md', revision: 'a1' } };
const beta: Concept = { ...alpha, id: 'live-beta', title: 'Current Beta', source: { path: 'Beta.md', revision: 'b1' } };
const live = [alpha, beta];
const suggestion: RelationSuggestion = { operation: 'change', source: { conceptId: 'backup-alpha', sourceRevision: 'a1', title: 'Original Alpha', path: 'Alpha.md' }, target: { conceptId: 'backup-beta', sourceRevision: 'b1', title: 'Original Beta', path: 'Beta.md' }, before: { type: 'related', description: 'old' }, after: { type: 'depends-on', description: 'new' } };
const app: ApplicationRecord = { eventId: 'application-alpha', conceptId: 'backup-alpha', sourceRevision: 'a1', occurredAt: '2026-01-02T00:00:00.000Z', recordedAt: '2026-01-02T00:01:00.000Z', kind: 'summary', context: '', content: 'Synthetic reason', outcome: 'unverified', assistance: 'unknown', result: '', limitations: '', insight: '', correction: '', references: '', relationSuggestion: suggestion };
function review(overrides: Partial<RelationReviewEvent> = {}): RelationReviewEvent {
  return { eventId: 'review-first', applicationEventId: app.eventId, conceptId: app.conceptId, occurredAt: '2026-01-03T00:00:00.000Z', recordedAt: '2026-01-03T00:01:00.000Z', previousEventId: null, status: 'resolved', note: '  historical evidence  ', basis: { source: { conceptId: suggestion.source.conceptId, current: { ...suggestion.source, title: 'Reviewed Alpha', sourceRevision: 'review-a' } }, target: { conceptId: suggestion.target.conceptId, current: { ...suggestion.target, title: 'Reviewed Beta', sourceRevision: 'review-b' } }, beforePresent: false, afterPresent: true }, ...overrides };
}
function data(overrides: Partial<ExportDataV1> = {}): ExportDataV1 {
  const config = { modelVersion: MODEL_VERSION, halfLifeDays: 7, revision: 1 };
  return { schemaVersion: 1, exportedAt: '2026-01-09T00:00:00.000Z', source: { ...source, name: 'Synthetic backup' }, concepts: [{ id: 'backup-alpha', title: 'Alpha', source: alpha.source }, { id: 'backup-beta', title: 'Beta', source: beta.source }], config, configHistory: [config], anchors: [], observations: [], retentions: [], applications: [app], corrections: [], relationReviews: [review()], layout: {}, ...overrides };
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'living-memory-relation-review-import-'));
  const store = new Store({ dataDir: dir, namespace: 'target', now: () => new Date(now) });
  return { store, cleanup() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
function plan(store: Store, incoming: ExportData, concepts = live, current = store.exportData(source, concepts)) {
  return buildImportPlan({ data: incoming, options, current, concepts, sourceId: 'target', now });
}
function commit(store: Store, incoming: ExportData, importId: string, concepts = live) {
  const preview = store.previewImport(incoming, options, source, concepts);
  assert.equal(preview.canImport, true, JSON.stringify(preview.issues));
  return store.commitImport({ data: incoming, options, previewToken: preview.token, confirmed: true, importId }, source, concepts, () => 'synthetic-backup');
}
const codes = (value: ReturnType<typeof plan>) => value.preview.issues.map((issue) => issue.code);

test('relation reviews remap both identities once while preserving frozen revisions and canonical retry', () => {
  const f = fixture();
  try {
    const incoming = data();
    const prepared = plan(f.store, incoming);
    assert.equal(prepared.preview.canImport, true, JSON.stringify(prepared.preview.issues));
    const expected: RelationReviewEvent = { ...review(), conceptId: alpha.id, basis: { ...review().basis, source: { ...review().basis.source, conceptId: alpha.id, current: { ...review().basis.source.current!, conceptId: alpha.id } }, target: { ...review().basis.target, conceptId: beta.id, current: { ...review().basis.target.current!, conceptId: beta.id } } } };
    assert.deepEqual(prepared.newRelationReviews, [expected]);
    assert.deepEqual(prepared.normalized.relationReviews, [expected]);
    assert.equal(prepared.preview.counts.relationReviews, 1);
    assert.equal(prepared.preview.counts.added.applications, 1);
    assert.ok(codes(prepared).includes('RELATION_REVIEW_SOURCE_REVISION_CHANGED'));
    commit(f.store, incoming, 'import-first');
    assert.deepEqual(f.store.exportData(source, live).relationReviews, [expected]);
    const { recordedAt: _recordedAt, ...request } = expected;
    assert.equal(f.store.addRelationReview(request).status, 'duplicate');
    const replay = plan(f.store, incoming);
    assert.equal(replay.preview.canImport, true, JSON.stringify(replay.preview.issues));
    assert.equal(replay.preview.counts.relationReviews, 0);
    assert.equal(replay.preview.counts.duplicates, 2);
    commit(f.store, incoming, 'import-again');
    assert.deepEqual(f.store.exportData(source, live).relationReviews, [expected]);
  } finally { f.cleanup(); }
});

test('legacy backups omit the additive count and malformed review sections are rejected', () => {
  const f = fixture();
  try {
    const legacy = data(); delete legacy.relationReviews;
    const prepared = plan(f.store, legacy);
    assert.equal(prepared.preview.canImport, true);
    assert.equal(Object.hasOwn(prepared.preview.counts, 'relationReviews'), false);
    assert.equal(Object.hasOwn(prepared.normalized, 'relationReviews'), false);
    assert.deepEqual(prepared.newRelationReviews, []);
    for (const relationReviews of [null, {}, [{ ...review(), extra: true }]]) {
      assert.throws(() => plan(f.store, { ...data(), relationReviews } as unknown as ExportData), StoreError);
    }
  } finally { f.cleanup(); }
});

test('missing endpoint metadata retains identity, null snapshot and historical review without live edge validation', () => {
  const f = fixture();
  try {
    const orphan = review({ status: 'open', basis: { ...review().basis, target: { conceptId: 'backup-beta', current: null }, beforePresent: null, afterPresent: null } });
    const incoming = data({ concepts: [data().concepts[0]], relationReviews: [orphan] });
    const prepared = plan(f.store, incoming, [alpha]);
    assert.equal(prepared.preview.canImport, true, JSON.stringify(prepared.preview.issues));
    assert.ok(prepared.preview.issues.some((issue) => issue.code === 'ORPHAN_CONCEPT_REFERENCE' && issue.conceptId === 'backup-beta'));
    assert.deepEqual(prepared.newRelationReviews[0].basis.target, orphan.basis.target);
    commit(f.store, incoming, 'orphan', [alpha]);
    assert.equal(f.store.exportData(source, [alpha]).relationReviews![0].basis.target.conceptId, 'backup-beta');
    assert.equal(f.store.exportData(source, [alpha]).relationReviews![0].basis.target.current, null);
    const invalid = plan(f.store, data({ concepts: [data().concepts[0]], relationReviews: [{ ...orphan, eventId: 'resolved-missing', status: 'resolved' }] }), [alpha]);
    assert.ok(codes(invalid).includes('RELATION_REVIEW_UNVERIFIED'));
  } finally { f.cleanup(); }
});

test('review chains reject forks, cycles, cross-application predecessors, time errors and bad frozen basis', () => {
  const f = fixture();
  try {
    const first = review();
    const next = review({ eventId: 'review-next', previousEventId: first.eventId, occurredAt: '2026-01-04T00:00:00.000Z', recordedAt: '2026-01-04T00:01:00.000Z' });
    const cases: Array<[ExportData, string]> = [
      [data({ relationReviews: [first, { ...first, eventId: 'another-root' }] }), 'RELATION_REVIEW_ROOT_BRANCH'],
      [data({ relationReviews: [first, next, { ...next, eventId: 'fork' }] }), 'RELATION_REVIEW_BRANCH'],
      [data({ relationReviews: [{ ...first, previousEventId: next.eventId }, next] }), 'RELATION_REVIEW_CYCLE'],
      [data({ applications: [app, { ...app, eventId: 'second-app' }], relationReviews: [first, { ...next, applicationEventId: 'second-app' }] }), 'RELATION_REVIEW_APPLICATION_MISMATCH'],
      [data({ relationReviews: [{ ...first, occurredAt: '2026-01-01T00:00:00.000Z' }] }), 'RELATION_REVIEW_BEFORE_APPLICATION'],
      [data({ relationReviews: [first, { ...next, occurredAt: '2026-01-02T23:00:00.000Z' }] }), 'RELATION_REVIEW_BEFORE_PREVIOUS'],
      [data({ relationReviews: [{ ...first, basis: { ...first.basis, beforePresent: true } }] }), 'RELATION_REVIEW_UNVERIFIED'],
      [data({ relationReviews: [{ ...first, basis: { ...first.basis, source: { conceptId: 'foreign', current: null }, beforePresent: null, afterPresent: null } }] }), 'RELATION_REVIEW_BASIS_MISMATCH'],
      [data({ relationReviews: [{ ...first, applicationEventId: 'missing' }] }), 'RELATION_REVIEW_APPLICATION_NOT_FOUND'],
      [data({ applications: [{ ...app, relationSuggestion: undefined }] }), 'RELATION_REVIEW_SOURCE_EMPTY'],
      [data({ relationReviews: [{ ...first, eventId: app.eventId }] }), 'EVENT_CONFLICT'],
      [data({ relationReviews: [first, first] }), 'DUPLICATE_EVENT_ID'],
    ];
    for (const [incoming, expected] of cases) {
      const prepared = plan(f.store, incoming);
      assert.equal(prepared.preview.canImport, false, expected);
      assert.ok(codes(prepared).includes(expected), `${expected}: ${JSON.stringify(prepared.preview.issues)}`);
    }
    assert.deepEqual(f.store.exportData(source, live).relationReviews ?? [], []);
  } finally { f.cleanup(); }
});

test('an imported old prefix stays harmless but every new decision must append to the current tail', () => {
  const f = fixture();
  try {
    const first = review();
    const next = review({ eventId: 'review-next', previousEventId: first.eventId, occurredAt: '2026-01-04T00:00:00.000Z', recordedAt: '2026-01-04T00:01:00.000Z' });
    commit(f.store, data({ relationReviews: [next, first] }), 'chain');
    const prefix = plan(f.store, data());
    assert.equal(prefix.preview.canImport, true, JSON.stringify(prefix.preview.issues));
    assert.equal(prefix.preview.counts.duplicates, 2);
    const stale = plan(f.store, data({ relationReviews: [first, { ...next, eventId: 'stale-fork' }] }));
    assert.ok(codes(stale).includes('RELATION_REVIEW_CHAIN_NOT_AT_HEAD'));
    const tail = review({ eventId: 'review-tail', previousEventId: next.eventId, occurredAt: '2026-01-05T00:00:00.000Z', recordedAt: '2026-01-05T00:01:00.000Z', status: 'open' });
    const extension = data({ relationReviews: [tail, first, next] });
    assert.deepEqual(plan(f.store, extension).newRelationReviews.map((event) => event.eventId), [tail.eventId]);
    commit(f.store, extension, 'extension');
    const conflict = plan(f.store, data({ relationReviews: [{ ...first, note: 'changed' }] }));
    assert.ok(codes(conflict).includes('EVENT_CONFLICT'));
    const reversed = plan(f.store, { ...extension, relationReviews: [...extension.relationReviews!].reverse() });
    assert.equal(reversed.preview.token, plan(f.store, extension).preview.token);
  } finally { f.cleanup(); }
});

test('collapsed mapped relation review endpoints block import alongside the parent suggestion', () => {
  const f = fixture();
  try {
    const incoming = data({ concepts: [{ id: 'backup-alpha', title: 'Alpha', source: alpha.source }, { id: 'backup-beta', title: 'Also Alpha', source: alpha.source }] });
    const prepared = plan(f.store, incoming);
    assert.equal(prepared.preview.canImport, false);
    assert.ok(prepared.preview.issues.some((issue) => issue.code === 'RELATION_ENDPOINT_MAPPING_COLLISION' && issue.eventId === review().eventId));
  } finally { f.cleanup(); }
});

test('SQL failure in a later review rolls back all events, configuration, metadata and receipt', () => {
  const f = fixture();
  try {
    const next = review({ eventId: 'review-second', previousEventId: review().eventId, occurredAt: '2026-01-04T00:00:00.000Z', recordedAt: '2026-01-04T00:01:00.000Z' });
    const newer = { modelVersion: MODEL_VERSION, halfLifeDays: 14, revision: 2 };
    const incoming = data({ config: newer, configHistory: [...data().configHistory, newer], relationReviews: [next, review()] });
    const preview = f.store.previewImport(incoming, options, source, live);
    assert.equal(preview.canImport, true, JSON.stringify(preview.issues));
    const before = f.store.exportData(source, live);
    const db = new DatabaseSync(f.store.dbPath);
    try {
      db.exec(`CREATE TRIGGER fail_second_review BEFORE INSERT ON relation_reviews WHEN NEW.event_id = 'review-second' BEGIN SELECT RAISE(ABORT, 'forced review failure'); END;`);
      const request = { data: incoming, options, previewToken: preview.token, confirmed: true as const, importId: 'atomic-reviews' };
      assert.throws(() => f.store.commitImport(request, source, live, () => 'synthetic-backup'), (error) => error instanceof StoreError && error.code === 'IMPORT_FAILED');
      assert.deepEqual(f.store.exportData(source, live), before);
      for (const table of ['applications', 'relation_reviews', 'imported_concepts', 'import_receipts']) assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE namespace = ?`).get('target') as { count: number }).count, 0);
      db.exec('DROP TRIGGER fail_second_review');
      assert.equal(f.store.commitImport(request, source, live, () => 'synthetic-backup').status, 'accepted');
      assert.equal(f.store.exportData(source, live).relationReviews!.length, 2);
    } finally { db.close(); }
  } finally { f.cleanup(); }
});

test('overlapping source and destination names cannot cascade endpoint mapping', () => {
  const f = fixture();
  try {
    // The first backup identity maps to live-alpha by path/revision. A backup
    // entry already named live-alpha has a different path; ID-first mapping
    // must block that collision, rather than treating it as a second remap.
    const concepts = [alpha, { ...beta, id: 'live-third', source: { path: 'Third.md', revision: 'c1' } }];
    const incoming = data({ concepts: [data().concepts[0], { id: alpha.id, title: 'Conflicting old Alpha', source: { path: 'Third.md', revision: 'c1' } }, data().concepts[1]] });
    const prepared = plan(f.store, incoming, concepts);
    assert.equal(prepared.preview.canImport, false);
    assert.ok(codes(prepared).includes('CONCEPT_ID_PATH_MISMATCH'));
    assert.equal(prepared.normalized.applications![0].conceptId, alpha.id);
    assert.equal(prepared.newApplications[0].conceptId, alpha.id);
    for (const event of [prepared.normalized.relationReviews![0], prepared.newRelationReviews[0]]) {
      assert.equal(event.conceptId, alpha.id);
      assert.equal(event.basis.source.conceptId, alpha.id);
      assert.equal(event.basis.source.current!.conceptId, alpha.id);
    }
  } finally { f.cleanup(); }
});

test('preview tokens include the frozen review basis and all review records', () => {
  const f = fixture();
  try {
    const original = data();
    const initial = plan(f.store, original);
    const changed = data({ relationReviews: [{ ...review(), basis: { ...review().basis, source: { ...review().basis.source, current: { ...review().basis.source.current!, title: 'Another frozen title' } } } }] });
    assert.equal(plan(f.store, changed).preview.canImport, true);
    assert.notEqual(initial.preview.token, plan(f.store, changed).preview.token);
    const changedStatus = data({ relationReviews: [review({ status: 'dismissed' })] });
    assert.notEqual(initial.preview.token, plan(f.store, changedStatus).preview.token);
    assert.deepEqual(initial.preview.counts.added, { anchors: 0, observations: 0, retentions: 0, applications: 1, corrections: 0 });
  } finally { f.cleanup(); }
});
