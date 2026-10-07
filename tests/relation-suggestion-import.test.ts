import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildImportPlan } from '../src/server/import-plan.js';
import { Store, StoreError } from '../src/server/store.js';
import { MODEL_VERSION, type ApplicationRecord, type Concept, type ExportData, type RelationSuggestion } from '../src/shared/types.js';

const now = '2026-01-10T00:00:00.000Z';
const options = { restoreLayout: false, restoreReviewPlan: false };
const source = { name: 'synthetic target root', mode: 'local' as const, conceptCount: 2, limit: 20, diagnostics: [] };
const alpha: Concept = { id: 'live-alpha', title: 'Current Alpha', aliases: [], domain: 'test', summary: 'synthetic', body: 'synthetic', source: { path: 'Alpha.md', revision: 'a1' } };
const beta: Concept = { ...alpha, id: 'live-beta', title: 'Current Beta', source: { path: 'Beta.md', revision: 'b1' } };
const live = [alpha, beta];
const relation: RelationSuggestion = { operation: 'change', source: { conceptId: 'backup-alpha', sourceRevision: 'a1', title: 'Historical Alpha', path: 'Alpha.md' }, target: { conceptId: 'backup-beta', sourceRevision: 'b1', title: 'Historical Beta', path: 'Beta.md' }, before: { type: 'related', description: 'old' }, after: { type: 'depends-on', description: 'new' } };
function application(overrides: Partial<ApplicationRecord> = {}): ApplicationRecord {
  return { eventId: 'application-alpha', conceptId: 'backup-alpha', sourceRevision: 'a1', occurredAt: '2026-01-02T00:00:00.000Z', recordedAt: '2026-01-02T00:01:00.000Z', kind: 'application', context: 'synthetic context', content: 'synthetic evidence', outcome: 'unverified', assistance: 'unknown', result: '', limitations: '', insight: '', correction: '', references: '', relationSuggestion: relation, ...overrides };
}
function data(overrides: Partial<ExportData> = {}): ExportData {
  const config = { modelVersion: MODEL_VERSION, halfLifeDays: 7, revision: 1 };
  return { schemaVersion: 1, exportedAt: '2026-01-09T00:00:00.000Z', source: { ...source, name: 'synthetic backup root' }, concepts: [{ id: 'backup-alpha', title: 'Manifest Alpha', source: alpha.source }, { id: 'backup-beta', title: 'Manifest Beta', source: beta.source }], config, configHistory: [config], anchors: [], observations: [], retentions: [], applications: [application()], corrections: [], layout: {}, ...overrides };
}
function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'living-memory-relation-import-'));
  const store = new Store({ dataDir, namespace: 'target', now: () => new Date(now) });
  return { store, dataDir, cleanup() { store.close(); rmSync(dataDir, { recursive: true, force: true }); } };
}
function plan(store: Store, incoming: ExportData, concepts = live) {
  return buildImportPlan({ data: incoming, options, current: store.exportData(source, concepts), concepts, sourceId: 'target', now });
}
function commit(store: Store, incoming: ExportData, importId: string, concepts = live) {
  const preview = store.previewImport(incoming, options, source, concepts);
  assert.equal(preview.canImport, true, JSON.stringify(preview.issues));
  return store.commitImport({ data: incoming, options, previewToken: preview.token, confirmed: true, importId }, source, concepts, () => 'synthetic-backup');
}

for (const reverse of [false, true]) {
  test(`maps both endpoints between roots with parent at ${reverse ? 'target' : 'source'} and deduplicates every retry path`, () => {
    const f = fixture();
    try {
      const incoming = data({ applications: [application(reverse ? { conceptId: 'backup-beta', sourceRevision: 'b1' } : {})] });
      const prepared = plan(f.store, incoming);
      assert.equal(prepared.preview.canImport, true, JSON.stringify(prepared.preview.issues));
      assert.equal(prepared.preview.counts.remappedConcepts, 2);
      const expected = { ...incoming.applications![0], conceptId: reverse ? beta.id : alpha.id, relationSuggestion: { ...relation, source: { ...relation.source, conceptId: alpha.id }, target: { ...relation.target, conceptId: beta.id } } };
      assert.deepEqual(prepared.normalized.applications, [expected]);
      assert.deepEqual(prepared.newApplications, prepared.normalized.applications);
      assert.deepEqual(f.store.previewImport(incoming, options, source, live), prepared.preview);
      const receipt = commit(f.store, incoming, 'first');
      assert.equal(receipt.counts.added.applications, 1);
      assert.deepEqual(f.store.getApplications(), prepared.newApplications);
      const { recordedAt: _recordedAt, ...mappedRequest } = expected;
      assert.equal(f.store.addApplication(mappedRequest).status, 'duplicate');
      const replay = plan(f.store, incoming);
      assert.equal(replay.preview.canImport, true, JSON.stringify(replay.preview.issues));
      assert.equal(replay.preview.counts.added.applications, 0);
      assert.equal(replay.preview.counts.duplicates, 1);
      assert.deepEqual(replay.newApplications, []);
      assert.deepEqual(replay.normalized.applications, [expected]);
      const second = commit(f.store, incoming, 'second');
      assert.equal(second.counts.added.applications, 0);
      assert.equal(second.counts.duplicates, 1);
      assert.equal(f.store.getApplications().length, 1);
      assert.deepEqual(f.store.getCorrections(), []);
    } finally { f.cleanup(); }
  });
}

test('blocks endpoints that collapse to one live identity without writing any event', () => {
  const f = fixture();
  try {
    const incoming = data({ concepts: [{ id: 'backup-alpha', title: 'Alpha', source: alpha.source }, { id: 'backup-beta', title: 'Alias Alpha', source: alpha.source }] });
    const prepared = plan(f.store, incoming);
    assert.equal(prepared.preview.canImport, false);
    assert.ok(prepared.preview.issues.some((issue) => issue.code === 'RELATION_ENDPOINT_MAPPING_COLLISION' && issue.severity === 'error'));
    const before = f.store.exportData(source, live);
    assert.throws(() => f.store.commitImport({ data: incoming, options, previewToken: prepared.preview.token, confirmed: true, importId: 'blocked' }, source, live, () => { throw new Error('blocked import must not invoke backup'); }));
    assert.deepEqual(f.store.exportData(source, live), before);
    assert.equal(f.store.hasEvent('application-alpha'), false);
  } finally { f.cleanup(); }
});

test('collects a secondary orphan absent from the manifest and preserves export recovery metadata', () => {
  const f = fixture();
  try {
    const incoming = data({ concepts: [data().concepts[0]] });
    const prepared = plan(f.store, incoming, [alpha]);
    assert.equal(prepared.preview.canImport, true, JSON.stringify(prepared.preview.issues));
    assert.ok(prepared.preview.issues.some((issue) => issue.code === 'ORPHAN_CONCEPT_REFERENCE' && issue.conceptId === 'backup-beta' && issue.severity === 'warning'));
    assert.ok(prepared.preview.matches.some((match) => match.fromId === 'backup-beta' && match.match === 'unresolved'));
    commit(f.store, incoming, 'orphan', [alpha]);
    assert.deepEqual(f.store.getApplications(), prepared.newApplications);
    const recovered = f.store.exportData(source, [alpha]);
    assert.deepEqual(recovered.concepts.find((item) => item.id === 'backup-beta'), { id: 'backup-beta', title: relation.target.title, source: { path: relation.target.path, revision: relation.target.sourceRevision } });
    assert.equal(recovered.applications![0].relationSuggestion!.target.conceptId, 'backup-beta');
  } finally { f.cleanup(); }
});

test('retains both historical revisions with warnings and does not require a current edge', () => {
  const f = fixture();
  try {
    const historical: RelationSuggestion = { ...relation, source: { ...relation.source, conceptId: alpha.id, sourceRevision: 'a-old' }, target: { ...relation.target, conceptId: beta.id, sourceRevision: 'b-old' } };
    const incoming = data({ concepts: [{ id: alpha.id, title: 'Old Alpha', source: { path: 'Alpha.md', revision: 'a-old' } }, { id: beta.id, title: 'Old Beta', source: { path: 'Beta.md', revision: 'b-old' } }], applications: [application({ conceptId: alpha.id, sourceRevision: 'a-old', relationSuggestion: historical })] });
    const prepared = plan(f.store, incoming);
    assert.equal(prepared.preview.canImport, true, JSON.stringify(prepared.preview.issues));
    for (const endpoint of [alpha.id, beta.id]) assert.ok(prepared.preview.issues.some((issue) => issue.code === 'RELATION_SOURCE_REVISION_CHANGED' && issue.conceptId === endpoint && issue.severity === 'warning'));
    assert.deepEqual(prepared.newApplications[0].relationSuggestion, historical);
    assert.equal(prepared.newApplications[0].sourceRevision, 'a-old');
    commit(f.store, incoming, 'historical');
    assert.deepEqual(f.store.getApplications(), prepared.newApplications);
  } finally { f.cleanup(); }
});

test('rejects malformed relation payloads before any import mutation', () => {
  const f = fixture();
  try {
    const before = f.store.exportData(source, live);
    const badValues = [null, [], { ...relation, extra: true }, { ...relation, source: { ...relation.source, conceptId: 'foreign' } }, { ...relation, after: relation.before }];
    for (const bad of badValues) {
      const incoming = data({ applications: [{ ...application(), relationSuggestion: bad } as unknown as ApplicationRecord] });
      assert.throws(() => plan(f.store, incoming), (error: unknown) => error instanceof StoreError && error.code === 'INVALID_BODY');
    }
    assert.deepEqual(f.store.exportData(source, live), before);
  } finally { f.cleanup(); }
});

test('second application SQL failure rolls back first relation, config, manifest and receipt atomically', () => {
  const f = fixture();
  try {
    const newerConfig = { modelVersion: MODEL_VERSION, halfLifeDays: 14, revision: 2 };
    const incoming = data({ config: newerConfig, configHistory: [...data().configHistory, newerConfig], applications: [application({ eventId: 'application-first' }), application({ eventId: 'application-second', occurredAt: '2026-01-03T00:00:00.000Z', recordedAt: '2026-01-03T00:01:00.000Z' })] });
    const preview = f.store.previewImport(incoming, options, source, live);
    assert.equal(preview.canImport, true, JSON.stringify(preview.issues));
    assert.equal(preview.counts.configurations, 1);
    const request = { data: incoming, options, previewToken: preview.token, confirmed: true as const, importId: 'atomic' };
    const before = f.store.exportData(source, live);
    const db = new DatabaseSync(f.store.dbPath);
    try {
      db.exec(`CREATE TRIGGER fail_second_relation BEFORE INSERT ON applications WHEN NEW.event_id = 'application-second' BEGIN SELECT RAISE(ABORT, 'forced second relation failure'); END;`);
      assert.throws(() => f.store.commitImport(request, source, live, () => 'synthetic-before-abort'), (error) => error instanceof StoreError && error.code === 'IMPORT_FAILED');
      assert.deepEqual(f.store.exportData(source, live), before);
      assert.equal(f.store.hasEvent('application-first'), false);
      assert.equal(f.store.hasEvent('application-second'), false);
      for (const table of ['applications', 'imported_concepts', 'import_receipts']) assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE namespace = ?`).get('target') as { count: number }).count, 0);
      assert.equal((db.prepare('SELECT COUNT(*) AS count FROM config_history WHERE namespace = ?').get('target') as { count: number }).count, 1);
      db.exec('DROP TRIGGER fail_second_relation');
      assert.equal(f.store.commitImport(request, source, live, () => 'synthetic-after-abort').status, 'accepted');
      assert.equal(f.store.getApplications().length, 2);
    } finally { db.close(); }
  } finally { f.cleanup(); }
});
