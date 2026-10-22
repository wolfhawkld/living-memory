import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { initializeAnswerClearingSchemaV3 } from '../src/server/answer-clearing-schema.js';
import { AnswerClearingStore } from '../src/server/answer-clearing-store.js';
import { LearningImportRepository } from '../src/server/learning-import-repository.js';
import { LearningSnapshotRepository } from '../src/server/learning-snapshot-repository.js';
import { buildAnswerClearingImportPlan } from '../src/server/answer-clearing-import.js';
import { fullExport, clearedExport, concepts, clone, now, sourceId } from './helpers/answer-clearing-json-fixture.js';

const options = { restoreLayout: true, restoreReviewPlan: true };
function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
  initializeAnswerClearingSchemaV3(db, { recordedAt: now });
  for (const namespace of [sourceId, 'other']) {
    db.prepare('INSERT INTO namespaces(namespace,created_at) VALUES (?,?)').run(namespace, now);
    db.prepare('INSERT INTO config_history(namespace,revision,model_version,half_life_days,recorded_at) VALUES (?,1,?,7,?)')
      .run(namespace, 'time-only-v0', '2025-12-31T00:00:00.000Z');
  }
  db.exec('COMMIT');
  const reader = new LearningSnapshotRepository({ db, namespace: sourceId, now: () => new Date(now), schemaVersion: 3 });
  const writer = new LearningImportRepository({ db, namespace: sourceId, now: () => new Date(now), schemaVersion: 3 });
  const privacy = new AnswerClearingStore({ db, namespace: sourceId, now: () => new Date(now) });
  const current = () => reader.exportData(fullExport().source, concepts);
  const plan = (data = fullExport()) => buildAnswerClearingImportPlan({ data, current: current(), concepts, sourceId, now, options });
  return { db, reader, writer, privacy, current, plan };
}
function rows(db: DatabaseSync) {
  return db.prepare("SELECT name FROM main.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map(({ name }) => ({ name, rows: db.prepare(`SELECT * FROM main."${String(name)}" ORDER BY rowid`).all() }));
}

test('explicit v3 writer persists complete cleared history, both NULLs and first marker without losing event occupancy', () => {
  const f = fixture();
  try {
    const data = clearedExport();
    const plan = f.plan(data);
    assert.equal(plan.preview.canImport, true);
    f.db.exec('BEGIN IMMEDIATE');
    f.writer.applyPreparedImport(plan, options);
    assert.equal(f.db.isTransaction, true);
    assert.deepEqual(f.writer.findEvent('observation-alpha'), { kind: 'observation', payload: null });
    const row = f.db.prepare('SELECT answer,request_payload,answer_cleared_at FROM observations WHERE namespace=?').get(sourceId)!;
    assert.equal(row.answer, null);
    assert.equal(row.request_payload, null);
    assert.equal(row.answer_cleared_at, '2026-01-08T03:00:00.000Z');
    const exported = f.current();
    assert.deepEqual(exported.observations, data.observations);
    for (const key of ['anchors', 'observationRevisions', 'retentions', 'applications', 'corrections', 'relationReviews', 'practice'] as const) {
      assert.deepEqual(exported[key], data[key], key);
    }
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM observations WHERE namespace=?').get('other')!.n, 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM import_receipts').get()!.n, 0);
    f.db.exec('COMMIT');
    const repeated = f.plan(data);
    assert.equal(repeated.newObservations.length, 0);
    f.db.exec('BEGIN IMMEDIATE');
    f.writer.applyPreparedImport(repeated, options);
    f.db.exec('COMMIT');
    assert.deepEqual(f.current().observations, data.observations);
  } finally { if (f.db.isTransaction) f.db.exec('ROLLBACK'); f.db.close(); }
});

test('v3 writer checks every observation before any write even when a prepared duplicate shortcut is stale', () => {
  const f = fixture();
  try {
    const stale = f.plan();
    f.db.exec('BEGIN IMMEDIATE'); f.writer.applyPreparedImport(stale, options); f.db.exec('COMMIT');
    const duplicate = f.plan();
    assert.equal(duplicate.newObservations.length, 0);
    f.privacy.clear({ observationEventId: 'observation-alpha' });
    const before = rows(f.db);
    for (const prepared of [stale, duplicate]) {
      f.db.exec('BEGIN IMMEDIATE');
      assert.throws(() => f.writer.applyPreparedImport(prepared, options), { code: 'ANSWER_CLEARED' });
      assert.equal(f.db.isTransaction, true);
      assert.deepEqual(rows(f.db), before);
      f.db.exec('ROLLBACK');
    }
  } finally { if (f.db.isTransaction) f.db.exec('ROLLBACK'); f.db.close(); }
});

test('v3 writer rejects external clearing of intact rows and changed first markers', () => {
  const f = fixture();
  try {
    const importedCleared = f.plan(clearedExport());
    f.db.exec('BEGIN IMMEDIATE'); f.writer.applyPreparedImport(f.plan(), options); f.db.exec('COMMIT');
    let before = rows(f.db);
    f.db.exec('BEGIN IMMEDIATE');
    assert.throws(() => f.writer.applyPreparedImport(importedCleared, options), { code: 'LOCAL_CLEARING_REQUIRED' });
    assert.deepEqual(rows(f.db), before); f.db.exec('ROLLBACK');
    f.privacy.clear({ observationEventId: 'observation-alpha' });
    before = rows(f.db);
    f.db.exec('BEGIN IMMEDIATE');
    assert.throws(() => f.writer.applyPreparedImport(importedCleared, options), { code: 'CLEARING_CONFLICT' });
    assert.deepEqual(rows(f.db), before); f.db.exec('ROLLBACK');
  } finally { if (f.db.isTransaction) f.db.exec('ROLLBACK'); f.db.close(); }
});

test('v3 writer validates marker pairs and retains caller ownership across late failure', () => {
  const f = fixture();
  try {
    const plan = f.plan(clearedExport());
    const before = rows(f.db);
    assert.throws(() => f.writer.applyPreparedImport(plan, options), { code: 'IMPORT_TRANSACTION_REQUIRED' });
    const invalid = clone(plan);
    Object.assign(invalid.normalized.observations[0], { answer: '' });
    f.db.exec('BEGIN IMMEDIATE');
    assert.throws(() => f.writer.applyPreparedImport(invalid, options), { code: 'INVALID_IMPORT_DATA' });
    assert.deepEqual(rows(f.db), before); f.db.exec('ROLLBACK');
    f.db.exec("CREATE TEMP TRIGGER fail_import_plan BEFORE INSERT ON review_plans BEGIN SELECT RAISE(ABORT,'late failure'); END; BEGIN IMMEDIATE");
    assert.throws(() => f.writer.applyPreparedImport(plan, options));
    assert.equal(f.db.isTransaction, true);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM observations WHERE namespace=?').get(sourceId)!.n, 1);
    f.db.exec('ROLLBACK');
    assert.deepEqual(rows(f.db), before);
  } finally { if (f.db.isTransaction) f.db.exec('ROLLBACK'); f.db.close(); }
});
