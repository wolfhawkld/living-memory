import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createObservationRevisionTables } from '../src/server/observation-revision-store.js';
import { initializeLearningSchemaV2, inspectLearningSchema, LearningSchemaError, migrateLearningSchemaV1ToV2,
  type LearningSchemaErrorCode } from '../src/server/learning-schema.js';
import { createLegacyLearningFixture, type LegacyLearningVariant } from './helpers/legacy-learning-schema.js';

const RECEIPT = '2026-10-18T08:00:00+08:00';
const CANONICAL_RECEIPT = '2026-10-18T00:00:00.000Z';
function memory(variant?: LegacyLearningVariant): DatabaseSync {
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON');
  if (variant) createLegacyLearningFixture(db, variant);
  return db;
}
function quote(value: string): string { return `"${value.replaceAll('"', '""')}"`; }
function snapshot(db: DatabaseSync): string {
  const objects = db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all();
  return JSON.stringify({ objects, version: db.prepare('PRAGMA user_version').get(),
    tables: objects.filter(value => value.type === 'table' && !String(value.name).startsWith('sqlite_'))
      .map(value => ({ name: value.name, rows: db.prepare(`SELECT rowid,* FROM ${quote(String(value.name))} ORDER BY rowid`).all() })) });
}
function fails(action: () => unknown, code: LearningSchemaErrorCode) {
  assert.throws(action, error => {
    assert.ok(error instanceof LearningSchemaError); assert.equal(error.code, code); assert.equal(error.message, code);
    assert.doesNotMatch(error.message, /PRIVATE|payload|answer|SQLite|constraint/); return true;
  });
}
function oldRows(db: DatabaseSync) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
    .map(value => String(value.name)).filter(value => !value.startsWith('sqlite_'));
  return tables.map(name => ({ name, rows: db.prepare(`SELECT rowid,* FROM ${quote(name)} ORDER BY rowid`).all() }));
}
function assertOriginalRows(db: DatabaseSync, before: ReturnType<typeof oldRows>) {
  for (const { name, rows } of before) {
    const after = db.prepare(`SELECT rowid,* FROM ${quote(name)} ORDER BY rowid`).all();
    assert.equal(after.length, rows.length, name);
    rows.forEach((row, index) => {
      for (const key of Object.keys(row)) assert.equal(after[index][key], row[key], `${name}.${key}`);
      for (const key of Object.keys(after[index])) if (!Object.hasOwn(row, key)) assert.equal(after[index][key], null, `${name}.${key}`);
    });
  }
}

test('inspection of a genuinely empty database is read-only and does not change connection pragmas', () => {
  const db = memory();
  try {
    db.exec('PRAGMA foreign_keys=OFF');
    const before = snapshot(db);
    assert.deepEqual(inspectLearningSchema(db), { kind: 'empty' });
    assert.equal(snapshot(db), before);
    assert.equal(db.prepare('PRAGMA foreign_keys').get()!.foreign_keys, 0);
  } finally { db.close(); }
});

test('complete known legacy variants are recognized without reading or exposing private evidence', () => {
  for (const variant of ['current', 'fresh', 'altered-column-order', 'pre-scenario', 'activity-none'] as const) {
    const db = memory(variant);
    try {
      const before = snapshot(db), inspection = inspectLearningSchema(db);
      assert.equal(inspection.kind, 'legacy-v1', variant);
      if (inspection.kind !== 'legacy-v1') assert.fail('expected complete legacy schema');
      assert.equal(inspection.normalization.missingActivity, variant === 'activity-none');
      assert.equal(inspection.normalization.preScenarioPractice, variant === 'pre-scenario');
      assert.deepEqual(inspection.normalization.missingColumns, variant === 'pre-scenario' ? ['practice_attempts.scenario_json'] : []);
      assert.doesNotMatch(JSON.stringify(inspection), /private|payload|answer|content/i);
      assert.equal(snapshot(db), before);
    } finally { db.close(); }
  }
});

test('known nullable column omissions work independently and in combination without relaxing other constraints', () => {
  const columns = [['observations', 'learning_json'], ['observations', 'evidence_mode'],
    ['applications', 'relation_suggestion_json'], ['practice_attempts', 'scenario_json']] as const;
  for (let mask = 1; mask < 16; mask++) {
    const db = memory('current');
    try {
      const missing: string[] = [];
      columns.forEach(([table, field], index) => {
        if (mask & (1 << index)) { db.exec(`ALTER TABLE ${table} DROP COLUMN ${field}`); missing.push(`${table}.${field}`); }
      });
      const before = oldRows(db), inspection = inspectLearningSchema(db);
      assert.equal(inspection.kind, 'legacy-v1');
      if (inspection.kind !== 'legacy-v1') assert.fail('expected supported missing-column variant');
      assert.deepEqual(inspection.normalization.missingColumns, missing.sort());
      assert.equal(migrateLearningSchemaV1ToV2(db, { recordedAt: RECEIPT }).status, 'migrated');
      assertOriginalRows(db, before);
      assert.equal(inspectLearningSchema(db).kind, 'current-v2');
    } finally { db.close(); }
  }
  const inconsistent = memory('current');
  try {
    inconsistent.exec('ALTER TABLE practice_cards DROP COLUMN scenario_json');
    const before = snapshot(inconsistent);
    fails(() => inspectLearningSchema(inconsistent), 'LEARNING_SCHEMA_INVALID');
    assert.equal(snapshot(inconsistent), before);
  } finally { inconsistent.close(); }
});

test('partial, ancient and altered constraints are rejected without auto-repairing any bytes', () => {
  for (const variant of ['activity-partial', 'ancient-five-table', 'bad-check', 'bad-pk', 'bad-fk', 'bad-index-direction', 'unknown-extra'] as const) {
    const db = memory(variant);
    try {
      const before = snapshot(db);
      const code = variant === 'ancient-five-table' ? 'LEARNING_SCHEMA_UNSUPPORTED_LEGACY' : 'LEARNING_SCHEMA_INVALID';
      fails(() => inspectLearningSchema(db), code);
      fails(() => migrateLearningSchemaV1ToV2(db, { recordedAt: RECEIPT }), code);
      assert.equal(snapshot(db), before);
    } finally { db.close(); }
  }
  const hidden = memory('current');
  try {
    hidden.exec('CREATE TABLE sqliteevil(secret TEXT)');
    fails(() => inspectLearningSchema(hidden), 'LEARNING_SCHEMA_INVALID');
  } finally { hidden.close(); }
});

test('empty initialization is atomic, creates strict version two, and preserves the first marker on repeat', () => {
  const db = memory();
  try {
    assert.deepEqual(initializeLearningSchemaV2(db, { recordedAt: RECEIPT }), { status: 'initialized', schemaVersion: 2 });
    assert.deepEqual(inspectLearningSchema(db), { kind: 'current-v2', schemaVersion: 2, minimumReaderVersion: 2 });
    assert.equal(db.prepare('SELECT recorded_at FROM learning_schema_metadata').get()!.recorded_at, CANONICAL_RECEIPT);
    assert.equal(db.prepare('SELECT count(*) AS n FROM namespaces').get()!.n, 0);
    const before = snapshot(db);
    assert.equal(initializeLearningSchemaV2(db, { recordedAt: '2027-01-01T00:00:00Z' }).status, 'already-current');
    assert.equal(migrateLearningSchemaV1ToV2(db, { recordedAt: '2027-01-02T00:00:00Z' }).status, 'already-current');
    assert.equal(snapshot(db), before);
  } finally { db.close(); }
});

test('every supported legacy normalization preserves raw rows, request bytes, practice order and child references', () => {
  for (const variant of ['current', 'altered-column-order', 'pre-scenario', 'activity-none'] as const) {
    const db = memory(variant);
    try {
      const before = oldRows(db);
      assert.deepEqual(migrateLearningSchemaV1ToV2(db, { recordedAt: RECEIPT }), { status: 'migrated', schemaVersion: 2 });
      assertOriginalRows(db, before);
      assert.equal(inspectLearningSchema(db).kind, 'current-v2');
      assert.equal(db.prepare('PRAGMA foreign_keys').get()!.foreign_keys, 1);
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      assert.equal(db.prepare('SELECT count(*) AS n FROM observation_revisions').get()!.n, 0);
      const after = snapshot(db);
      assert.equal(migrateLearningSchemaV1ToV2(db, { recordedAt: '2027-01-01T00:00:00Z' }).status, 'already-current');
      assert.equal(snapshot(db), after);
    } finally { db.close(); }
  }
});

test('version markers, ledger structure and nullable columns must agree; future declarations are unsupported', () => {
  const cases: Array<{ change(db: DatabaseSync): void; current?: boolean; code?: LearningSchemaErrorCode }> = [
    { change: db => db.exec('PRAGMA user_version=3'), code: 'LEARNING_SCHEMA_UNSUPPORTED_VERSION' },
    { change: db => db.exec('PRAGMA user_version=2') },
    { change: db => createObservationRevisionTables(db) },
    { current: true, change: db => db.exec('DROP TABLE learning_schema_metadata') },
    { current: true, change: db => db.exec('DROP INDEX observation_revisions_root') },
    { current: true, change: db => db.exec('ALTER TABLE observations DROP COLUMN learning_json') },
    { current: true, change: db => db.exec('PRAGMA user_version=0') },
    { current: true, change: db => db.exec("UPDATE learning_schema_metadata SET recorded_at='2026-10-18T08:00:00+08:00'") },
    { current: true, change: db => db.exec('PRAGMA ignore_check_constraints=ON; UPDATE learning_schema_metadata SET minimum_reader_version=3'), code: 'LEARNING_SCHEMA_UNSUPPORTED_VERSION' },
  ];
  for (const value of cases) {
    const db = memory('current');
    try {
      if (value.current) migrateLearningSchemaV1ToV2(db, { recordedAt: RECEIPT });
      value.change(db);
      const before = snapshot(db);
      fails(() => inspectLearningSchema(db), value.code ?? 'LEARNING_SCHEMA_INVALID');
      fails(() => migrateLearningSchemaV1ToV2(db, { recordedAt: RECEIPT }), value.code ?? 'LEARNING_SCHEMA_INVALID');
      assert.equal(snapshot(db), before);
    } finally { db.close(); }
  }
});

test('migration refuses caller transactions and leaves their writes and foreign-key setting intact', () => {
  for (const variant of ['current', 'pre-scenario'] as const) {
    const db = memory(variant);
    try {
      const before = snapshot(db);
      db.exec('BEGIN IMMEDIATE');
      db.prepare('INSERT INTO namespaces(namespace,created_at) VALUES(?,?)').run('outer-only', CANONICAL_RECEIPT);
      fails(() => migrateLearningSchemaV1ToV2(db, { recordedAt: RECEIPT }), 'LEARNING_SCHEMA_TRANSACTION_REQUIRED');
      assert.equal(db.prepare("SELECT count(*) AS n FROM namespaces WHERE namespace='outer-only'").get()!.n, 1);
      assert.equal(db.prepare('PRAGMA foreign_keys').get()!.foreign_keys, 1);
      db.exec('ROLLBACK'); assert.equal(snapshot(db), before);
    } finally { db.close(); }
  }
  const db = memory();
  try {
    db.exec('BEGIN IMMEDIATE');
    fails(() => initializeLearningSchemaV2(db, { recordedAt: RECEIPT }), 'LEARNING_SCHEMA_TRANSACTION_REQUIRED');
    db.exec('COMMIT');
    assert.equal(inspectLearningSchema(db).kind, 'empty');
  } finally { db.close(); }
});

test('an injected post-version failure rolls back original rows, rowids, all DDL and the version marker', () => {
  for (const variant of [undefined, 'current', 'pre-scenario'] as const) {
    const db = memory(variant);
    const originalExec = db.exec;
    try {
      const before = snapshot(db);
      let injected = false;
      db.exec = function(sql: string) {
        originalExec.call(db, sql);
        if (sql === 'PRAGMA user_version=2' && !injected) { injected = true; throw new Error('PRIVATE original answer'); }
      };
      const apply = () => variant ? migrateLearningSchemaV1ToV2(db, { recordedAt: RECEIPT }) : initializeLearningSchemaV2(db, { recordedAt: RECEIPT });
      fails(apply, 'LEARNING_SCHEMA_MIGRATION_FAILED');
      assert.equal(injected, true);
      assert.equal(snapshot(db), before);
      assert.equal(db.prepare('PRAGMA foreign_keys').get()!.foreign_keys, 1);
      db.exec = originalExec;
      assert.equal(apply().schemaVersion, 2);
    } finally { db.exec = originalExec; db.close(); }
  }
});

test('foreign-key damage blocks commit without repairing the old data or leaving a partial marker', () => {
  const db = memory('pre-scenario');
  try {
    db.exec("PRAGMA foreign_keys=OFF; UPDATE practice_card_sources SET card_event_id='missing' WHERE rowid=(SELECT min(rowid) FROM practice_card_sources); PRAGMA foreign_keys=ON");
    const before = snapshot(db);
    fails(() => migrateLearningSchemaV1ToV2(db, { recordedAt: RECEIPT }), 'LEARNING_SCHEMA_INVALID');
    assert.equal(snapshot(db), before);
    assert.equal(db.prepare('PRAGMA foreign_keys').get()!.foreign_keys, 1);
  } finally { db.close(); }
});

test('busy writers and read-only inspection preserve both connection and file state', () => {
  const directory = mkdtempSync(join(tmpdir(), 'lm-learning-schema-'));
  const path = join(directory, 'learning.sqlite');
  const db = new DatabaseSync(path), competitor = new DatabaseSync(path);
  let competingTransaction = false;
  try {
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0'); createLegacyLearningFixture(db);
    const bytes = readFileSync(path);
    const reader = new DatabaseSync(path, { readOnly: true });
    try { assert.equal(inspectLearningSchema(reader).kind, 'legacy-v1'); } finally { reader.close(); }
    assert.deepEqual(readFileSync(path), bytes);
    competitor.exec('BEGIN IMMEDIATE'); competingTransaction = true;
    competitor.prepare('INSERT INTO namespaces(namespace,created_at) VALUES(?,?)').run('competitor-only', CANONICAL_RECEIPT);
    fails(() => migrateLearningSchemaV1ToV2(db, { recordedAt: RECEIPT }), 'LEARNING_SCHEMA_TRANSACTION_REQUIRED');
    assert.equal(competitor.prepare("SELECT count(*) AS n FROM namespaces WHERE namespace='competitor-only'").get()!.n, 1);
    competitor.exec('ROLLBACK'); competingTransaction = false;
    assert.equal(migrateLearningSchemaV1ToV2(db, { recordedAt: RECEIPT }).status, 'migrated');
  } finally { if (competingTransaction) competitor.exec('ROLLBACK'); competitor.close(); db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('invalid receipt times and disabled foreign keys cannot initialize or migrate a database', () => {
  for (const variant of [undefined, 'current'] as const) {
    const db = memory(variant);
    try {
      const before = snapshot(db);
      const apply = (recordedAt: string) => variant ? migrateLearningSchemaV1ToV2(db, { recordedAt }) : initializeLearningSchemaV2(db, { recordedAt });
      for (const value of ['2026-10-18', '2026-02-30T00:00:00Z', 'PRIVATE']) fails(() => apply(value), 'LEARNING_SCHEMA_INVALID');
      db.exec('PRAGMA foreign_keys=OFF');
      fails(() => apply(RECEIPT), 'LEARNING_SCHEMA_TRANSACTION_REQUIRED');
      assert.equal(snapshot(db), before);
      assert.equal(db.prepare('PRAGMA foreign_keys').get()!.foreign_keys, 0);
    } finally { db.close(); }
  }
});
