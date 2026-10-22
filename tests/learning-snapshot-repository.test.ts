import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { LearningSnapshotRepository } from '../src/server/learning-snapshot-repository.js';
import { LearningImportRepository } from '../src/server/learning-import-repository.js';
import { initializeLearningSchemaV2 } from '../src/server/learning-schema.js';
import { initializeAnswerClearingSchemaV3 } from '../src/server/answer-clearing-schema.js';
import { copyLearningSchemaV2ToV3 } from '../src/server/answer-clearing-migration.js';
import { AnswerClearingStore } from '../src/server/answer-clearing-store.js';
import { buildImportPlan } from '../src/server/import-plan.js';
import { ObservationRevisionStoreError } from '../src/server/observation-revision-store.js';
import { Store, StoreError } from '../src/server/store.js';
import { clone, concepts, emptyCurrent, fullExport, now, sourceId } from './helpers/answer-clearing-json-fixture.js';
import type { ExportDataV2 } from '../src/shared/types.js';

const options = { restoreLayout: true, restoreReviewPlan: true };
const legacy = (value = fullExport()): ExportDataV2 => ({ ...value, schemaVersion: 2,
  observations: value.observations.map(row => { assert.equal(typeof row.answer, 'string'); return { ...row, answer: row.answer as string }; }) });
function memory() { const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON'); return db; }
function seed(db: DatabaseSync) {
  initializeLearningSchemaV2(db, { recordedAt: now });
  for (const namespace of [sourceId, 'other-source']) {
    db.prepare('INSERT INTO namespaces VALUES (?,?)').run(namespace, now);
    db.prepare('INSERT INTO config_history VALUES (?,1,?,7,?)').run(namespace, 'time-only-v0', '2025-12-31T00:00:00.000Z');
  }
  const plan = buildImportPlan({ data: legacy(), current: legacy(emptyCurrent()), options, concepts, sourceId, now });
  assert.equal(plan.preview.canImport, true);
  db.exec('BEGIN IMMEDIATE');
  new LearningImportRepository({ db, namespace: sourceId, now: () => new Date(now) }).applyPreparedImport(plan, options);
  db.exec('COMMIT');
}
function repo(db: DatabaseSync, clock = () => new Date(now)) { return new LearningSnapshotRepository({ db, namespace: sourceId, now: clock }); }

test('complete v2 snapshot preserves every collection, restore metadata, field omission and one clock call', () => {
  const db = memory();
  try {
    seed(db); let calls = 0;
    const data = repo(db, () => { calls++; return new Date(now); }).exportData(fullExport().source, concepts);
    const expected = legacy();
    assert.equal(calls, 1);
    for (const field of ['anchors','observations','observationRevisions','retentions','applications','corrections','relationReviews','practice','reviewPlan','layout','config','configHistory'] as const) {
      assert.deepEqual(clone(data[field]), clone(expected[field]), field);
    }
    assert.equal(data.exportedAt, now);
    assert.equal(data.restoreMetadata?.sourceId, sourceId);
    assert.deepEqual(data.restoreMetadata?.anchorRequests, expected.restoreMetadata?.anchorRequests);
    assert.equal(Object.hasOwn(data.restoreMetadata!.anchorRequests![0], 'occurredAt'), false);
    assert.deepEqual(data.restoreMetadata?.configRecordedAt, expected.restoreMetadata?.configRecordedAt);
    assert.deepEqual(data.identityBindings, []); // Uploaded audit cannot create a local binding.
    const empty = new LearningSnapshotRepository({ db, namespace: 'other-source', now: () => new Date(now) }).exportData(expected.source, []);
    assert.deepEqual(empty.observations, []); assert.equal(Object.hasOwn(empty, 'practice'), false);
    assert.equal(Object.hasOwn(empty, 'relationReviews'), false);
    assert.deepEqual(empty.reviewPlan, { revision: 0, dailyBudget: 5, concepts: {} });
  } finally { db.close(); }
});

test('metadata precedence, binding exclusion and relationship-only endpoints retain the existing export rules', () => {
  const db = memory();
  try {
    seed(db);
    db.prepare('INSERT INTO identity_catalog VALUES (?,?,?,?,?)').run(sourceId, concepts[0].id, 'Catalog wins imported', 'Catalog.md', 'catalog-rev');
    db.prepare('INSERT INTO identity_catalog VALUES (?,?,?,?,?)').run(sourceId, 'raw-hidden', 'Hidden', 'Hidden.md', 'hidden-rev');
    db.prepare('INSERT INTO identity_bindings VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(sourceId, 'local-binding', 'raw-hidden', concepts[0].id,
      'Old.md', 'Alpha.md', 'rev-1', now, 'local-backup', 'PRIVATE-HASH', '{"private":"PRIVATE-RECEIPT"}');
    db.prepare('DELETE FROM imported_concepts WHERE namespace=? AND concept_id=?').run(sourceId, concepts[1].id);
    const fromCatalog = repo(db).exportData(fullExport().source, []);
    assert.equal(fromCatalog.concepts.find(c => c.id === concepts[0].id)?.title, 'Catalog wins imported');
    assert.equal(fromCatalog.concepts.find(c => c.id === concepts[1].id)?.source.path, concepts[1].source.path);
    assert.equal(fromCatalog.concepts.some(c => c.id === 'raw-hidden'), false);
    const fromLive = repo(db).exportData(fullExport().source, concepts);
    assert.equal(fromLive.concepts.find(c => c.id === concepts[0].id)?.title, concepts[0].title);
    assert.equal(fromLive.identityBindings?.[0].operationId, 'local-binding');
    assert.equal(JSON.stringify(fromLive).includes('PRIVATE-HASH'), false);
    assert.equal(JSON.stringify(fromLive).includes('PRIVATE-RECEIPT'), false);
    assert.deepEqual(fromLive.concepts.map(c => c.id), [...fromLive.concepts.map(c => c.id)].sort((a,b) => a.localeCompare(b)));
  } finally { db.close(); }
});

test('v2 optional legacy history remains tolerant while strict observation evidence still fails closed', () => {
  const db = memory();
  try {
    seed(db);
    db.prepare("UPDATE practice_cards SET scenario_json='broken' WHERE namespace=?").run(sourceId);
    db.prepare("UPDATE practice_attempts SET scenario_json='broken' WHERE namespace=?").run(sourceId);
    db.prepare("UPDATE layouts SET layout_json='broken' WHERE namespace=?").run(sourceId);
    const reader = repo(db);
    assert.deepEqual(reader.exportData(fullExport().source, concepts).layout, {});
    assert.equal(reader.getPracticeData().cards[0].scenario, undefined);
    db.prepare("UPDATE observations SET learning_json='broken' WHERE namespace=?").run(sourceId);
    assert.equal(reader.getObservations()[0].learning, undefined);
    assert.throws(() => reader.exportData(fullExport().source, concepts), e => e instanceof ObservationRevisionStoreError && e.code === 'OBSERVATION_REVISION_DATA_INVALID');
    assert.equal(db.isTransaction, false);
  } finally { db.close(); }
});

test('v3 complete snapshot retains cleared NULL/first marker, revisions and unrelated practice answers', () => {
  const source = memory(); const db = memory();
  try {
    seed(source); copyLearningSchemaV2ToV3(source, db, { recordedAt: now });
    new AnswerClearingStore({ db, namespace: sourceId, now: () => new Date(now) }).clear({ observationEventId: 'observation-alpha' });
    const data = new LearningSnapshotRepository({ db, namespace: sourceId, schemaVersion: 3, now: () => new Date(now) }).exportData(fullExport().source, concepts);
    assert.equal(data.schemaVersion, 3);
    assert.equal(data.observations[0].answer, null);
    assert.deepEqual('answerClearing' in data.observations[0] ? data.observations[0].answerClearing : undefined,
      { observationEventId: 'observation-alpha', clearedAt: now });
    assert.deepEqual(data.observationRevisions, fullExport().observationRevisions);
    assert.equal(data.practice?.attempts[0].answer, 'separate practice answer');
    assert.equal(JSON.stringify(data).includes('private-answer-sentinel'), false);
    for (const field of ['anchors','retentions','applications','corrections','relationReviews','practice','reviewPlan','layout'] as const) {
      assert.deepEqual(clone(data[field]), clone(fullExport()[field]), field);
    }
  } finally { source.close(); db.close(); }
});

test('snapshot reads uncommitted changes from its caller and never commits or rolls back the caller transaction', () => {
  const db = memory();
  try {
    seed(db); const reader = repo(db);
    db.exec('BEGIN IMMEDIATE');
    db.prepare('UPDATE config_history SET half_life_days=13 WHERE namespace=?').run(sourceId);
    assert.equal(reader.exportData(fullExport().source, concepts).config.halfLifeDays, 13);
    assert.equal(db.isTransaction, true);
    const broken = repo(db, () => { throw new Error('clock unavailable'); });
    assert.throws(() => broken.exportData(fullExport().source, concepts), /clock unavailable/);
    assert.equal(db.isTransaction, true);
    assert.equal(reader.getConfig().halfLifeDays, 13);
    db.exec('ROLLBACK');
    assert.equal(reader.getConfig().halfLifeDays, 7);
  } finally { if (db.isTransaction) db.exec('ROLLBACK'); db.close(); }
});

test('one WAL snapshot keeps later collections consistent when another connection commits during export', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lm-snapshot-')); const path = join(dir, 'test.sqlite');
  const db = new DatabaseSync(path); db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL');
  let writer: DatabaseSync | undefined;
  try {
    seed(db); writer = new DatabaseSync(path); writer.exec('PRAGMA foreign_keys=ON');
    const data = repo(db, () => {
      writer!.prepare('UPDATE config_history SET half_life_days=13 WHERE namespace=?').run(sourceId);
      return new Date(now);
    }).exportData(fullExport().source, concepts);
    assert.equal(data.config.halfLifeDays, 7);
    assert.equal(data.configHistory[0].halfLifeDays, 7);
    assert.equal(repo(db).getConfig().halfLifeDays, 13);
    assert.equal(db.isTransaction, false);
  } finally { writer?.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('schema checks are read-only and v3 requires explicit opt-in without namespace initialization', () => {
  for (const version of [0,2,3] as const) {
    const db = memory();
    try {
      if (version === 2) initializeLearningSchemaV2(db, { recordedAt: now });
      if (version === 3) {
        db.exec('BEGIN IMMEDIATE');
        initializeAnswerClearingSchemaV3(db, { recordedAt: now });
        db.exec('COMMIT');
      }
      const before = db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all();
      if (version === 2) new LearningSnapshotRepository({ db, namespace: 'absent' });
      else assert.throws(() => new LearningSnapshotRepository({ db, namespace: 'absent' }), e => e instanceof StoreError && e.code === 'LEARNING_SCHEMA_UNSUPPORTED_VERSION');
      if (version === 3) new LearningSnapshotRepository({ db, namespace: 'absent', schemaVersion: 3 });
      assert.deepEqual(db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all(), before);
      assert.equal(db.isTransaction, false);
      if (version !== 0) assert.equal(db.prepare('SELECT COUNT(*) AS count FROM namespaces').get()!.count, 0);
    } finally { db.close(); }
  }
});

test('product Store export delegates to the shared reader for an actual nonempty import and reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lm-store-snapshot-')); const path = join(dir, 'test.sqlite');
  let store: Store | undefined;
  try {
    store = new Store({ dbPath: path, namespace: sourceId, now: () => new Date(now) });
    const preview = store.previewImport(legacy(), options, fullExport().source, concepts);
    store.commitImport({ importId: 'snapshot-import', data: legacy(), options, previewToken: preview.token, confirmed: true }, fullExport().source, concepts, () => 'backup-snapshot');
    const exported = store.exportData(fullExport().source, concepts);
    assert.equal(exported.observations[0].answer, 'private-answer-sentinel');
    const original = LearningSnapshotRepository.prototype.exportData;
    let calls = 0;
    LearningSnapshotRepository.prototype.exportData = function(source, currentConcepts) { calls++; return original.call(this, source, currentConcepts); };
    try { assert.deepEqual(store.exportData(fullExport().source, concepts), exported); assert.equal(calls, 1); }
    finally { LearningSnapshotRepository.prototype.exportData = original; }
    store.close(); store = new Store({ dbPath: path, namespace: sourceId, now: () => new Date(now) });
    assert.deepEqual(store.exportData(fullExport().source, concepts), exported);
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});
