import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { AnswerClearingMigrationError, copyLearningSchemaV2ToV3,
  type AnswerClearingMigrationErrorCode } from '../src/server/answer-clearing-migration.js';
import { inspectAnswerClearingSchemaV3 } from '../src/server/answer-clearing-schema.js';
import { LEGACY_TABLE_SQL } from '../src/server/learning-schema-baseline.js';
import { migrateLearningSchemaV1ToV2 } from '../src/server/learning-schema.js';
import { createLegacyLearningFixture } from './helpers/legacy-learning-schema.js';

const recordedAt = '2026-10-22T00:00:00.000Z';
const tableNames = [...Object.keys(LEGACY_TABLE_SQL), 'observation_revisions'];
function memory(): DatabaseSync { const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON'); return db; }
function quote(name: string): string { return `"${name.replaceAll('"', '""')}"`; }
function stringify(value: unknown): string { return JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? { bigint: item.toString() } : item); }
function rows(db: DatabaseSync, table: string, columns?: string[]): unknown[] {
  const statement = db.prepare(`SELECT rowid AS __rowid,${columns?.map(quote).join(',') ?? '*'} FROM main.${quote(table)} ORDER BY rowid`);
  statement.setReadBigInts(true); return statement.all();
}
function snapshot(db: DatabaseSync): string {
  const objects = db.prepare('SELECT type,name,tbl_name,sql FROM main.sqlite_master ORDER BY type,name').all();
  return stringify({ objects, version: db.prepare('PRAGMA main.user_version').get(),
    tables: objects.filter(row => row.type === 'table' && !String(row.name).startsWith('sqlite_'))
      .map(row => [row.name, rows(db, String(row.name))]) });
}
function fails(action: () => unknown, code: AnswerClearingMigrationErrorCode): void {
  assert.throws(action, error => error instanceof AnswerClearingMigrationError && error.code === code && error.message === code);
}
function sourceFixture(variant: 'current' | 'altered-column-order' | 'missing-columns' = 'current'): DatabaseSync {
  const db = memory(); createLegacyLearningFixture(db, variant === 'missing-columns' ? 'current' : variant);
  if (variant === 'missing-columns') {
    for (const [table, column] of [['observations', 'learning_json'], ['observations', 'evidence_mode'],
      ['applications', 'relation_suggestion_json'], ['practice_attempts', 'scenario_json']]) {
      db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    }
  }
  migrateLearningSchemaV1ToV2(db, { recordedAt });
  // Put successors before their roots in rowid order, exercising deferred FKs.
  db.exec('BEGIN'); db.exec('PRAGMA defer_foreign_keys=ON');
  const insert = db.prepare(`INSERT INTO observation_revisions(rowid,namespace,event_id,observation_event_id,previous_event_id,
    concept_id,source_revision,occurred_at,recorded_at,action,reason,note,assessment_json,request_payload)
    VALUES(?,?,?,'observation-original',?,'concept-original','revision-original',?,?,'withdraw','other',NULL,NULL,?)`);
  for (const [index, namespace] of ['legacy-a', 'legacy-b'].entries()) {
    insert.run(index * 10 + 5, namespace, 'root', null, recordedAt, recordedAt, ' { "action" : "withdraw" }\r\n');
    insert.run(index * 10 + 1, namespace, 'successor', 'root', recordedAt, recordedAt, '{"untouched":"中文"}\n');
  }
  db.exec('COMMIT');
  db.prepare('UPDATE observations SET rowid=?,config_revision=?,request_payload=? WHERE namespace=?')
    .run(9007199254740993n, 9007199254740997n, ' \r\n{"raw":"中文"}\u0000tail', 'legacy-a');
  db.prepare('UPDATE observations SET rowid=? WHERE namespace=?').run(-9007199254740995n, 'legacy-b');
  db.prepare('UPDATE activity_settings SET epoch=? WHERE namespace=?').run(9007199254740999n, 'legacy-a');
  return db;
}

test('copies complete multi-namespace v2 into canonical v3, preserving named fields, rowids, integers and payload bytes', () => {
  for (const variant of ['current', 'altered-column-order', 'missing-columns'] as const) {
    const source = sourceFixture(variant), target = memory();
    try {
      const before = snapshot(source); source.exec('PRAGMA query_only=ON');
      assert.deepEqual(copyLearningSchemaV2ToV3(source, target, { recordedAt: '2026-10-22T08:00:00+08:00' }),
        { status: 'copied', schemaVersion: 3 });
      assert.equal(snapshot(source), before); assert.equal(source.isTransaction, false); assert.equal(target.isTransaction, false);
      assert.deepEqual(inspectAnswerClearingSchemaV3(target), { kind: 'current-v3', schemaVersion: 3, minimumReaderVersion: 3 });
      for (const table of tableNames) {
        const columns = source.prepare(`PRAGMA main.table_info(${quote(table)})`).all().map(row => String(row.name));
        assert.equal(stringify(rows(target, table, columns)), stringify(rows(source, table, columns)), table);
      }
      assert.equal(target.prepare('SELECT count(*) AS count FROM observations WHERE answer_cleared_at IS NOT NULL').get()!.count, 0);
      assert.deepEqual({ ...target.prepare('SELECT * FROM learning_schema_metadata').get() },
        { singleton: 1, schema_version: 3, minimum_reader_version: 3, recorded_at: recordedAt });
      assert.equal(target.prepare('PRAGMA foreign_keys').get()!.foreign_keys, 1);
      assert.equal(target.prepare('PRAGMA defer_foreign_keys').get()!.defer_foreign_keys, 0);
      assert.ok(source.isOpen && target.isOpen);
    } finally { source.close(); target.close(); }
  }
});

test('refuses v1, unknown, future and broken-FK sources without changing either database', () => {
  for (const setup of [
    (db: DatabaseSync) => { createLegacyLearningFixture(db); },
    (db: DatabaseSync) => { db.exec('CREATE TABLE unknown(private TEXT)'); },
    (db: DatabaseSync) => { db.exec('PRAGMA user_version=4'); },
    (db: DatabaseSync) => {
      createLegacyLearningFixture(db); migrateLearningSchemaV1ToV2(db, { recordedAt });
      db.exec('PRAGMA foreign_keys=OFF'); db.exec('DELETE FROM practice_cards'); db.exec('PRAGMA foreign_keys=ON');
    },
  ]) {
    const source = memory(), target = memory();
    try {
      setup(source); const beforeSource = snapshot(source), beforeTarget = snapshot(target);
      fails(() => copyLearningSchemaV2ToV3(source, target, { recordedAt }), 'ANSWER_CLEARING_MIGRATION_INVALID_SOURCE');
      assert.equal(snapshot(source), beforeSource); assert.equal(snapshot(target), beforeTarget);
      assert.equal(source.isTransaction, false); assert.equal(target.isTransaction, false);
    } finally { source.close(); target.close(); }
  }
});

test('refuses nonempty targets and identical connections without changing existing rows', () => {
  const source = sourceFixture(), target = memory();
  try {
    target.exec("CREATE TABLE existing(secret TEXT); INSERT INTO existing VALUES('private')");
    const beforeSource = snapshot(source), beforeTarget = snapshot(target);
    fails(() => copyLearningSchemaV2ToV3(source, target, { recordedAt }), 'ANSWER_CLEARING_MIGRATION_INVALID_TARGET');
    assert.equal(snapshot(source), beforeSource); assert.equal(snapshot(target), beforeTarget);
    fails(() => copyLearningSchemaV2ToV3(source, source, { recordedAt }), 'ANSWER_CLEARING_MIGRATION_INVALID_TARGET');
    assert.equal(snapshot(source), beforeSource);
  } finally { source.close(); target.close(); }
});

test('refuses caller transactions or disabled FK enforcement and leaves caller transactions open', () => {
  for (const side of ['source-transaction', 'target-transaction', 'source-foreign-keys', 'target-foreign-keys'] as const) {
    const source = sourceFixture(), target = memory();
    try {
      const db = side.startsWith('source') ? source : target;
      db.exec(side.endsWith('transaction') ? 'BEGIN' : 'PRAGMA foreign_keys=OFF');
      const sourceInTransaction = source.isTransaction, targetInTransaction = target.isTransaction;
      const beforeSource = snapshot(source), beforeTarget = snapshot(target);
      fails(() => copyLearningSchemaV2ToV3(source, target, { recordedAt }), 'ANSWER_CLEARING_MIGRATION_TRANSACTION_REQUIRED');
      assert.equal(snapshot(source), beforeSource); assert.equal(snapshot(target), beforeTarget);
      assert.equal(source.isTransaction, sourceInTransaction); assert.equal(target.isTransaction, targetInTransaction);
      if (db.isTransaction) db.exec('ROLLBACK');
    } finally { source.close(); target.close(); }
  }
});

test('rejects malformed or non-roundtrippable timestamps before starting transactions', () => {
  const source = sourceFixture(), target = memory();
  try {
    const beforeSource = snapshot(source), beforeTarget = snapshot(target);
    for (const time of ['invalid', '9999-12-31T23:00:00-02:00', '0000-01-01T00:00:00+02:00']) {
      fails(() => copyLearningSchemaV2ToV3(source, target, { recordedAt: time }), 'ANSWER_CLEARING_MIGRATION_INVALID_RECORDED_AT');
      assert.equal(snapshot(source), beforeSource); assert.equal(snapshot(target), beforeTarget);
      assert.equal(source.isTransaction, false); assert.equal(target.isTransaction, false);
    }
  } finally { source.close(); target.close(); }
});

test('actual mid-copy target CHECK failure rolls DDL and previously inserted rows back to an empty target', () => {
  const source = sourceFixture(), target = memory();
  try {
    // Legal under v2 TEXT affinity/NOT NULL, but forbidden by v3 typeof(answer) CHECK.
    source.prepare('UPDATE observations SET answer=? WHERE namespace=?').run(new Uint8Array([0, 255]), 'legacy-a');
    const beforeSource = snapshot(source), beforeTarget = snapshot(target);
    const originalPrepare = target.prepare.bind(target);
    let priorRowsInserted = false;
    target.prepare = ((sql: string) => {
      if (sql.startsWith('INSERT INTO main."observations"')) {
        priorRowsInserted = Number(originalPrepare('SELECT count(*) AS count FROM anchors').get()!.count) > 0;
      }
      return originalPrepare(sql);
    }) as typeof target.prepare;
    fails(() => copyLearningSchemaV2ToV3(source, target, { recordedAt }), 'ANSWER_CLEARING_MIGRATION_COPY_FAILED');
    assert.equal(priorRowsInserted, true); assert.equal(snapshot(source), beforeSource); assert.equal(snapshot(target), beforeTarget);
    assert.deepEqual(inspectAnswerClearingSchemaV3(target), { kind: 'empty' });
    assert.equal(source.isTransaction, false); assert.equal(target.isTransaction, false);
    assert.ok(source.isOpen && target.isOpen);
  } finally { source.close(); target.close(); }
});

test('source snapshot remains in a read transaction when target commit occurs', () => {
  const source = sourceFixture(), target = memory();
  try {
    const originalExec = target.exec.bind(target);
    let observedCommit = false;
    target.exec = ((sql: string) => {
      if (sql === 'COMMIT') { observedCommit = true; assert.equal(source.isTransaction, true); }
      originalExec(sql);
    }) as typeof target.exec;
    copyLearningSchemaV2ToV3(source, target, { recordedAt });
    assert.equal(observedCommit, true); assert.equal(source.isTransaction, false);
  } finally { source.close(); target.close(); }
});

test('source cleanup failure reports no success after target commit and requires the caller to discard that unpublished target', () => {
  const source = sourceFixture(), target = memory();
  try {
    const before = snapshot(source), originalExec = source.exec.bind(source);
    source.exec = ((sql: string) => {
      if (sql === 'COMMIT') throw new Error('synthetic source cleanup failure');
      originalExec(sql);
    }) as typeof source.exec;
    fails(() => copyLearningSchemaV2ToV3(source, target, { recordedAt }), 'ANSWER_CLEARING_MIGRATION_COPY_FAILED');
    assert.equal(snapshot(source), before); assert.equal(source.isTransaction, false); assert.equal(target.isTransaction, false);
    assert.equal(inspectAnswerClearingSchemaV3(target).kind, 'current-v3');
    assert.equal(target.prepare('SELECT count(*) AS n FROM observations').get()!.n, 2);
    // The target is not published by this primitive; restoreInstance removes its whole stage on this error.
  } finally { source.close(); target.close(); }
});
