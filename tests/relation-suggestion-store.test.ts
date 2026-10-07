import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store, StoreError, parseApplicationRequest } from '../src/server/store.js';
import { parseRelationSuggestion } from '../src/shared/relation-suggestions.js';
import type { ApplicationRecordRequest, Concept, RelationSuggestion } from '../src/shared/types.js';

const now = '2026-01-10T00:00:00.000Z';
const concept: Concept = { id: 'alpha', title: 'Alpha', aliases: [], domain: 'test', summary: 'synthetic', body: 'synthetic', source: { path: 'Alpha.md', revision: 'a1' } };
const source = { name: 'synthetic', mode: 'local' as const, conceptCount: 1, limit: 10, diagnostics: [] };
const suggestion: RelationSuggestion = { operation: 'change', source: { conceptId: 'alpha', sourceRevision: 'a1', title: 'Frozen Alpha', path: 'OldAlpha.md' }, target: { conceptId: 'beta', sourceRevision: 'b1', title: 'Frozen Beta', path: 'Beta.md' }, before: { type: ' related ', description: '' }, after: { type: 'depends-on', description: ' preserve spaces ' } };
function request(overrides: Partial<ApplicationRecordRequest> = {}): ApplicationRecordRequest {
  return { eventId: 'app', conceptId: 'alpha', sourceRevision: 'a1', occurredAt: '2026-01-09T00:00:00Z', kind: 'application', context: 'synthetic use', content: 'synthetic evidence', outcome: 'partial', assistance: 'independent', result: '', limitations: '', insight: '', correction: '', references: '', ...overrides };
}
function fixture(namespace = 'relations') {
  const dataDir = mkdtempSync(join(tmpdir(), 'living-memory-relations-'));
  const dbPath = join(dataDir, 'test.sqlite');
  const open = () => new Store({ dbPath, namespace, now: () => new Date(now) });
  return { dataDir, dbPath, open, cleanup: () => rmSync(dataDir, { recursive: true, force: true }) };
}
function invalid(value: unknown, parent = request()) {
  assert.throws(() => parseRelationSuggestion(value, parent));
  assert.throws(() => parseApplicationRequest({ ...parent, relationSuggestion: value }), (error) => error instanceof StoreError && error.code === 'INVALID_BODY');
}

test('relation parser copies and freezes exact strings, enforces discriminated fields and parent endpoint', () => {
  const parsed = parseRelationSuggestion(suggestion, request());
  assert.deepEqual(parsed, suggestion);
  assert.notEqual(parsed, suggestion);
  assert.notEqual(parsed.source, suggestion.source);
  assert.ok(Object.isFrozen(parsed) && Object.isFrozen(parsed.source) && Object.isFrozen(parsed.target));
  assert.ok('after' in parsed && Object.isFrozen(parsed.after));
  const add = { operation: 'add', source: suggestion.source, target: suggestion.target, after: { type: 'x', description: '' } };
  const remove = { operation: 'remove', source: suggestion.source, target: suggestion.target, before: { type: 'x', description: '' } };
  assert.equal(parseRelationSuggestion(add, request()).operation, 'add');
  assert.equal(parseRelationSuggestion(remove, request({ conceptId: 'beta', sourceRevision: 'b1' })).operation, 'remove');
  for (const bad of [null, [], {}, { ...suggestion, operation: 'invalid' }, { ...add, before: suggestion.before }, { ...remove, after: suggestion.after }, { ...suggestion, edgeId: 'edge' }, { ...suggestion, source: { ...suggestion.source, direction: 'out' } }, { ...suggestion, target: suggestion.source }, { ...suggestion, after: suggestion.before }, { ...suggestion, after: { type: '', description: '' } }, { ...suggestion, after: { type: 'x', description: 'x'.repeat(4001) } }]) invalid(bad);
  invalid(suggestion, request({ conceptId: 'absent' }));
  invalid(suggestion, request({ sourceRevision: 'other' }));
  for (const [field, max] of [['conceptId', 512], ['sourceRevision', 512], ['title', 1000], ['path', 4096]] as const) {
    invalid({ ...suggestion, target: { ...suggestion.target, [field]: '' } });
    invalid({ ...suggestion, target: { ...suggestion.target, [field]: 'x'.repeat(max + 1) } });
  }
  invalid({ ...suggestion, after: { type: 'x'.repeat(257), description: '' } });
  assert.equal(Object.hasOwn(parseApplicationRequest(request()), 'relationSuggestion'), false);
});

test('relations survive mixed history and restart with canonical conflicts and unchanged memory evidence', () => {
  const f = fixture();
  let store = f.open();
  try {
    store.addReview({ eventId: 'anchor', conceptId: 'alpha', sourceRevision: 'a1', kind: 'review', occurredAt: '2026-01-01T00:00:00Z' });
    store.addRetention({ eventId: 'retained', conceptId: 'alpha', sourceRevision: 'a1', active: true, previousEventId: null, occurredAt: '2026-01-02T00:00:00Z' }, null);
    const before = { anchors: store.getAnchors(), observations: store.getObservations(), retentions: store.getRetentions(), config: store.getConfig(), states: store.getStates([concept], now) };
    const input = request({ relationSuggestion: suggestion });
    assert.equal(store.addApplication(input).status, 'accepted');
    store.addApplication(request({ eventId: 'summary', kind: 'summary', context: '', relationSuggestion: { operation: 'remove', source: suggestion.source, target: suggestion.target, before: suggestion.before } }));
    const entries = store.getConceptHistory(concept, now, 20).entries;
    assert.deepEqual(entries.filter((entry) => entry.type === 'application').map((entry) => entry.event.relationSuggestion), [store.getApplications()[1].relationSuggestion, suggestion]);
    assert.deepEqual({ anchors: store.getAnchors(), observations: store.getObservations(), retentions: store.getRetentions(), config: store.getConfig(), states: store.getStates([concept], now) }, before);
    assert.deepEqual(store.getCorrections(), []);
    assert.deepEqual(store.getApplications('beta'), []);
    store.close(); store = f.open();
    assert.equal(store.addApplication(input).status, 'duplicate');
    const reordered = JSON.parse(JSON.stringify(suggestion));
    reordered.source = { path: suggestion.source.path, title: suggestion.source.title, sourceRevision: 'a1', conceptId: 'alpha' };
    assert.equal(store.addApplication({ ...input, relationSuggestion: reordered }).status, 'duplicate');
    assert.throws(() => store.addApplication({ ...input, relationSuggestion: { ...suggestion, after: { type: 'different', description: '' } } }), (error) => error instanceof StoreError && error.code === 'EVENT_CONFLICT');
    assert.throws(() => store.addApplication(request()), (error) => error instanceof StoreError && error.code === 'EVENT_CONFLICT');
    assert.deepEqual(store.getApplications()[0].relationSuggestion, suggestion);
  } finally { store.close(); f.cleanup(); }
});

test('legacy migration adds only nullable column and preserves old request payload and omission', () => {
  const f = fixture();
  let store = f.open();
  const old = request();
  store.addApplication(old); store.close();
  const db = new DatabaseSync(f.dbPath);
  const payload = (db.prepare('SELECT request_payload FROM applications').get() as { request_payload: string }).request_payload;
  db.exec('ALTER TABLE applications DROP COLUMN relation_suggestion_json');
  const schema = db.prepare('PRAGMA table_info(applications)').all();
  db.close();
  try {
    store = f.open();
    const migrated = new DatabaseSync(f.dbPath);
    try {
      const columns = migrated.prepare('PRAGMA table_info(applications)').all() as Array<{ name: string; notnull: number; dflt_value: unknown }>;
      assert.deepEqual(columns.slice(0, -1), schema);
      assert.equal(columns.at(-1)?.name, 'relation_suggestion_json');
      assert.equal(columns.at(-1)?.notnull, 0);
      assert.equal(columns.at(-1)?.dflt_value, null);
      assert.equal((migrated.prepare('SELECT request_payload FROM applications').get() as { request_payload: string }).request_payload, payload);
    } finally { migrated.close(); }
    assert.equal(store.addApplication(old).status, 'duplicate');
    assert.equal(Object.hasOwn(store.getApplications()[0], 'relationSuggestion'), false);
    const history = store.getConceptHistory(concept, now, 20).entries[0];
    assert.equal(Object.hasOwn(history.event, 'relationSuggestion'), false);
    assert.equal(Object.hasOwn(store.exportData(source, [concept]).applications![0], 'relationSuggestion'), false);
    assert.throws(() => store.addApplication({ ...old, relationSuggestion: suggestion }), (error) => error instanceof StoreError && error.code === 'EVENT_CONFLICT');
    store.close(); store = f.open();
    assert.equal(store.addApplication(old).status, 'duplicate');
  } finally { store.close(); f.cleanup(); }
});

test('export supplements missing endpoint metadata and imported relations retain canonical retry after restart', () => {
  const donor = fixture('donor'); const target = fixture('target');
  const a = donor.open(); let b = target.open();
  try {
    a.addApplication(request({ relationSuggestion: suggestion }));
    a.addApplication(request({ eventId: 'legacy' }));
    const data = a.exportData(source, [concept]);
    assert.deepEqual(data.concepts, [{ id: 'alpha', title: 'Alpha', source: concept.source }, { id: 'beta', title: 'Frozen Beta', source: { path: 'Beta.md', revision: 'b1' } }]);
    const options = { restoreLayout: false, restoreReviewPlan: false };
    const preview = b.previewImport(data, options, source, [concept]);
    assert.equal(preview.canImport, true, JSON.stringify(preview.issues));
    b.commitImport({ data, options, previewToken: preview.token, confirmed: true, importId: 'restore' }, source, [concept], () => 'synthetic-backup');
    assert.deepEqual(b.getApplications(), data.applications);
    b.close(); b = target.open();
    assert.equal(b.addApplication(request({ relationSuggestion: suggestion })).status, 'duplicate');
    assert.equal(b.addApplication(request({ eventId: 'legacy' })).status, 'duplicate');
    assert.deepEqual(b.exportData(source, [concept]).applications, data.applications);
    assert.deepEqual(b.getCorrections(), []);
    assert.deepEqual(b.getAnchors(), []);
    assert.deepEqual(b.getObservations(), []);
    assert.deepEqual(b.getRetentions(), []);
    const replay = b.previewImport(data, options, source, [concept]);
    assert.equal(replay.canImport, true);
    assert.equal(replay.counts.added.applications, 0);
  } finally { a.close(); b.close(); donor.cleanup(); target.cleanup(); }
});
