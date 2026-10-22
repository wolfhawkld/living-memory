import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { initializeAnswerClearingSchemaV3, inspectAnswerClearingSchemaV3, AnswerClearingSchemaError,
  type AnswerClearingSchemaErrorCode } from '../src/server/answer-clearing-schema.js';
import { initializeLearningSchemaV2 } from '../src/server/learning-schema.js';

const recordedAt = '2026-10-22T00:00:00.000Z';
function memory(): DatabaseSync { const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON'); return db; }
function current(): DatabaseSync {
  const db = memory(); db.exec('BEGIN IMMEDIATE');
  assert.deepEqual(initializeAnswerClearingSchemaV3(db, { recordedAt }), { status: 'initialized', schemaVersion: 3 });
  assert.equal(db.isTransaction, true); db.exec('COMMIT'); return db;
}
function fails(action: () => unknown, code: AnswerClearingSchemaErrorCode = 'ANSWER_CLEARING_SCHEMA_INVALID'): void {
  assert.throws(action, error => error instanceof AnswerClearingSchemaError && error.code === code && error.message === code);
}
function snapshot(db: DatabaseSync): string {
  return JSON.stringify({ schema: db.prepare('SELECT * FROM sqlite_master ORDER BY name').all(),
    version: db.prepare('PRAGMA user_version').get(),
    metadata: db.prepare("SELECT name FROM sqlite_master WHERE name='learning_schema_metadata'").get()
      ? db.prepare('SELECT * FROM learning_schema_metadata').all() : null,
    changes: db.prepare('SELECT total_changes() AS changes').get() });
}
function insertObservation(db: DatabaseSync, answer: string | null, payload: string | null, clearedAt: string | null): void {
  db.prepare(`INSERT INTO observations(namespace,event_id,concept_id,source_revision,observed_at,recorded_at,
    config_revision,half_life_days,answer,rating,exposure,observed_exposure,request_payload,answer_cleared_at)
    VALUES('n','e','c','r',?,?,1,7,?,'clear','unexposed',0,?,?)`).run(recordedAt, recordedAt, answer, payload, clearedAt);
}

test('v3 initializer requires a caller-owned transaction and leaves empty database untouched', () => {
  const db = memory();
  try {
    assert.deepEqual(inspectAnswerClearingSchemaV3(db), { kind: 'empty' });
    const before = snapshot(db);
    fails(() => initializeAnswerClearingSchemaV3(db, { recordedAt }), 'ANSWER_CLEARING_SCHEMA_TRANSACTION_REQUIRED');
    assert.equal(snapshot(db), before);
    db.exec('BEGIN'); initializeAnswerClearingSchemaV3(db, { recordedAt }); db.exec('ROLLBACK');
    assert.deepEqual(inspectAnswerClearingSchemaV3(db), { kind: 'empty' });
  } finally { db.close(); }
});

test('v3 initialization creates every table/index and canonical metadata; repeated initialization is read-only', () => {
  const db = memory();
  try {
    db.exec('BEGIN'); initializeAnswerClearingSchemaV3(db, { recordedAt: '2026-10-22T08:00:00+08:00' }); db.exec('COMMIT');
    assert.deepEqual(inspectAnswerClearingSchemaV3(db), { kind: 'current-v3', schemaVersion: 3, minimumReaderVersion: 3 });
    assert.equal(db.prepare('SELECT recorded_at FROM learning_schema_metadata').get()!.recorded_at, recordedAt);
    const before = snapshot(db);
    assert.deepEqual(initializeAnswerClearingSchemaV3(db, { recordedAt: 'invalid' }), { status: 'already-current', schemaVersion: 3 });
    assert.equal(snapshot(db), before);
  } finally { db.close(); }
});

test('v2, partial, foreign and future databases are refused without writes', () => {
  for (const setup of [
    (db: DatabaseSync) => { initializeLearningSchemaV2(db, { recordedAt }); },
    (db: DatabaseSync) => { db.exec('CREATE TABLE observations(answer TEXT)'); },
    (db: DatabaseSync) => { db.exec('CREATE TABLE unrelated(secret TEXT)'); },
    (db: DatabaseSync) => { db.exec('PRAGMA user_version=4'); },
  ]) {
    const db = memory();
    try {
      setup(db); db.exec('BEGIN'); const before = snapshot(db);
      assert.throws(() => initializeAnswerClearingSchemaV3(db, { recordedAt }), AnswerClearingSchemaError);
      assert.equal(snapshot(db), before); assert.equal(db.isTransaction, true); db.exec('ROLLBACK');
    } finally { db.close(); }
  }
});

test('initializer validates time and foreign-key enforcement before any DDL', () => {
  for (const time of ['invalid', '9999-12-31T23:00:00-02:00', '0000-01-01T00:00:00+02:00']) {
    const db = memory();
    try { db.exec('BEGIN'); const before = snapshot(db); fails(() => initializeAnswerClearingSchemaV3(db, { recordedAt: time }));
      assert.equal(snapshot(db), before); db.exec('ROLLBACK'); } finally { db.close(); }
  }
  const db = memory();
  try {
    db.exec('PRAGMA foreign_keys=OFF'); db.exec('BEGIN'); const before = snapshot(db);
    fails(() => initializeAnswerClearingSchemaV3(db, { recordedAt }), 'ANSWER_CLEARING_SCHEMA_TRANSACTION_REQUIRED');
    assert.equal(snapshot(db), before); db.exec('ROLLBACK');
  } finally { db.close(); }
});

test('inspector rejects missing/changed indexes, unknown objects and weakened CHECK definitions without writes', () => {
  for (const mutation of [
    'DROP INDEX observations_by_concept',
    'DROP INDEX observations_by_concept; CREATE INDEX observations_by_concept ON observations(event_id)',
    'CREATE VIEW leaked_answer AS SELECT answer FROM observations',
    "CREATE TRIGGER leaked_answer AFTER INSERT ON observations BEGIN SELECT 1; END",
    'CREATE TEMP TABLE shadow(answer TEXT)',
    `PRAGMA writable_schema=ON; UPDATE sqlite_master SET sql=replace(sql,'typeof(answer)=''text''','answer IS NOT NULL') WHERE name='observations'; PRAGMA writable_schema=OFF`,
    `PRAGMA writable_schema=ON; UPDATE sqlite_master SET sql=replace(sql,'''clear'', ''partial'', ''blank''','''clear'', ''partial'', ''OTHER''') WHERE name='observations'; PRAGMA writable_schema=OFF`,
  ]) {
    const db = current();
    try { db.exec(mutation); const before = snapshot(db); fails(() => inspectAnswerClearingSchemaV3(db));
      assert.equal(snapshot(db), before); } finally { db.close(); }
  }
});

test('metadata rows and future reader markers are checked without repairs', () => {
  for (const mutation of [
    'DELETE FROM learning_schema_metadata',
    "UPDATE learning_schema_metadata SET recorded_at='2026-10-22T08:00:00+08:00'",
    'PRAGMA ignore_check_constraints=ON; UPDATE learning_schema_metadata SET minimum_reader_version=4',
    'PRAGMA user_version=0',
  ]) {
    const db = current();
    try { db.exec(mutation); const before = snapshot(db); assert.throws(() => inspectAnswerClearingSchemaV3(db), AnswerClearingSchemaError);
      assert.equal(snapshot(db), before); } finally { db.close(); }
  }
});

test('observation CHECK permits only paired intact/cleared states, including actual text storage', () => {
  for (const [answer, payload, time, accepted] of [
    ['', '{}', null, true], [null, null, recordedAt, true],
    [null, '{}', null, false], ['private', null, null, false],
    ['private', '{}', recordedAt, false], [null, '{}', recordedAt, false],
  ] as const) {
    const db = current();
    try {
      if (accepted) { insertObservation(db, answer, payload, time); inspectAnswerClearingSchemaV3(db); }
      else assert.throws(() => insertObservation(db, answer, payload, time));
    } finally { db.close(); }
  }
  const db = current();
  try {
    insertObservation(db, 'private', '{}', null);
    assert.throws(() => db.exec("UPDATE observations SET answer=x'00'"));
    assert.throws(() => db.exec("UPDATE observations SET request_payload=x'00'"));
  } finally { db.close(); }
});

test('inspector detects bypassed data CHECKs and malformed or premature clearing timestamps', () => {
  for (const mutation of [
    "UPDATE observations SET answer=NULL",
    "UPDATE observations SET answer=NULL,request_payload=NULL,answer_cleared_at='invalid'",
    "UPDATE observations SET answer=NULL,request_payload=NULL,answer_cleared_at='2026-10-21T23:59:59.999Z'",
    "UPDATE observations SET answer=NULL,request_payload=NULL,answer_cleared_at='2026-10-22T08:00:00+08:00'",
  ]) {
    const db = current();
    try { insertObservation(db, 'private', '{}', null); db.exec('PRAGMA ignore_check_constraints=ON'); db.exec(mutation);
      const before = snapshot(db); fails(() => inspectAnswerClearingSchemaV3(db)); assert.equal(snapshot(db), before); }
    finally { db.close(); }
  }
});

test('inspector checks foreign-key integrity even when connection enforcement is disabled', () => {
  const db = current();
  try {
    db.exec('PRAGMA foreign_keys=OFF');
    db.exec("INSERT INTO practice_card_sources(namespace,card_event_id,card_id,concept_id,source_revision) VALUES('n','missing','card','c','r')");
    const before = snapshot(db); fails(() => inspectAnswerClearingSchemaV3(db)); assert.equal(snapshot(db), before);
  } finally { db.close(); }
});
