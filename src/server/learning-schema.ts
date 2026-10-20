import type { DatabaseSync } from 'node:sqlite';
import { isValidInstant } from '../core/time-model.js';
import { createObservationRevisionTables } from './observation-revision-store.js';
import { LEGACY_INDEX_SQL, LEGACY_TABLE_SQL, REVISION_INDEX_SQL, REVISION_TABLE_SQL } from './learning-schema-baseline.js';

export const LEARNING_SCHEMA_VERSION = 2;
export type LearningSchemaErrorCode = 'LEARNING_SCHEMA_UNSUPPORTED_VERSION' | 'LEARNING_SCHEMA_UNSUPPORTED_LEGACY'
  | 'LEARNING_SCHEMA_INVALID' | 'LEARNING_SCHEMA_TRANSACTION_REQUIRED' | 'LEARNING_SCHEMA_MIGRATION_FAILED';
export class LearningSchemaError extends Error {
  constructor(readonly code: LearningSchemaErrorCode) { super(code); this.name = 'LearningSchemaError'; }
}
export type MissingLearningColumn = 'observations.learning_json' | 'observations.evidence_mode'
  | 'applications.relation_suggestion_json' | 'practice_attempts.scenario_json';
export type LearningSchemaInspection = { kind: 'empty' }
  | { kind: 'legacy-v1'; schemaVersion: 1; normalization: {
    missingActivity: boolean; missingColumns: MissingLearningColumn[]; preScenarioPractice: boolean;
  } }
  | { kind: 'current-v2'; schemaVersion: 2; minimumReaderVersion: 2 };
export interface LearningSchemaMigrationResult { status: 'initialized' | 'migrated' | 'already-current'; schemaVersion: 2 }

const METADATA = 'learning_schema_metadata';
const METADATA_SQL = `CREATE TABLE learning_schema_metadata (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  schema_version INTEGER NOT NULL CHECK(schema_version=2),
  minimum_reader_version INTEGER NOT NULL CHECK(minimum_reader_version=2),
  recorded_at TEXT NOT NULL
)`;
const ACTIVITY_TABLES = ['activity_settings', 'activity_events', 'activity_deliveries', 'activity_deletions'];
const OPTIONAL_COLUMNS: MissingLearningColumn[] = ['observations.learning_json', 'observations.evidence_mode',
  'applications.relation_suggestion_json', 'practice_attempts.scenario_json'];
const invalid = () => new LearningSchemaError('LEARNING_SCHEMA_INVALID');
function sqlName(name: string): string { return `"${name.replaceAll('"', '""')}"`; }

/** Tokenize known SQLite DDL without changing CHECK/default string literals. */
function tokens(sql: string): string[] {
  const result: string[] = [];
  let offset = 0;
  while (offset < sql.length) {
    const char = sql[offset];
    if (/\s/.test(char)) { offset++; continue; }
    if (sql.startsWith('--', offset) || sql.startsWith('/*', offset)) throw invalid();
    if (char === "'" || char === '"' || char === '`' || char === '[') {
      const end = char === '[' ? ']' : char;
      const start = offset++;
      let closed = false;
      while (offset < sql.length) {
        if (sql[offset++] !== end) continue;
        if (sql[offset] === end && char !== '[') { offset++; continue; }
        closed = true; break;
      }
      if (!closed) throw invalid();
      const quoted = sql.slice(start, offset);
      if (char === "'") result.push(quoted);
      else {
        const identifier = quoted.slice(1, -1);
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) throw invalid();
        result.push(identifier.toLowerCase());
      }
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(offset));
    if (word) { result.push(word[0].toLowerCase()); offset += word[0].length; continue; }
    if (/[0-9]/.test(char)) {
      const number = /^\d+(?:\.\d+)?/.exec(sql.slice(offset))![0];
      result.push(number); offset += number.length; continue;
    }
    if (!'(),=<>+-.*;'.includes(char)) throw invalid();
    result.push(char); offset++;
  }
  if (result.at(-1) === ';') result.pop();
  return result;
}
function omitIfNotExists(value: string[]): string[] {
  const position = value.indexOf('if');
  if (position >= 0 && position <= 3 && value[position + 1] === 'not' && value[position + 2] === 'exists') {
    return [...value.slice(0, position), ...value.slice(position + 3)];
  }
  return value;
}
interface TableDefinition { name: string; definitions: string[][]; suffix: string[] }
function tableDefinition(sql: string): TableDefinition {
  const value = omitIfNotExists(tokens(sql));
  if (value[0] !== 'create' || value[1] !== 'table' || value[3] !== '(') throw invalid();
  const definitions: string[][] = [];
  let depth = 1, start = 4, index = start;
  for (; index < value.length; index++) {
    if (value[index] === '(') depth++;
    if (value[index] === ')') depth--;
    if (depth < 0) throw invalid();
    if (depth === 0 || (depth === 1 && value[index] === ',')) {
      if (index === start) throw invalid();
      definitions.push(value.slice(start, index)); start = index + 1;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) throw invalid();
  return { name: value[2], definitions, suffix: value.slice(index + 1) };
}
function tableSignature(table: TableDefinition): string {
  // Column ordinal differences from supported ALTER ADD COLUMN do not change
  // named-field storage semantics; constraint column order remains untouched.
  return JSON.stringify([table.name, table.definitions.map(value => JSON.stringify(value)).sort(), table.suffix]);
}
function signature(sql: string): string { return tableSignature(tableDefinition(sql)); }
function indexSignature(sql: string): string { return JSON.stringify(omitIfNotExists(tokens(sql))); }
function hasColumn(table: TableDefinition, name: string): boolean {
  return table.definitions.some(value => value[0] === name);
}
interface SchemaObject { type: string; name: string; tbl_name: string; sql: string | null }

/** Read structure and the non-private version marker only. Never opens, writes or repairs a database. */
export function inspectLearningSchema(db: DatabaseSync): LearningSchemaInspection {
  try {
    const version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
    if (version !== 0 && version !== 2) throw new LearningSchemaError('LEARNING_SCHEMA_UNSUPPORTED_VERSION');
    const all = db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all() as unknown as SchemaObject[];
    if (!all.length && version === 0) return { kind: 'empty' };
    const objects = all.filter(value => !value.name.startsWith('sqlite_'));
    const tables = new Map(objects.filter(value => value.type === 'table').map(value => [value.name, value]));
    const indexes = new Map(objects.filter(value => value.type === 'index').map(value => [value.name, value]));
    if (objects.some(value => value.type !== 'table' && value.type !== 'index')) throw invalid();
    const hasMetadata = tables.has(METADATA);
    if (hasMetadata) {
      const rows = db.prepare(`SELECT singleton,schema_version,minimum_reader_version,recorded_at FROM ${METADATA}`).all();
      if (rows.some(value => Number(value.schema_version) > 2 || Number(value.minimum_reader_version) > 2)) {
        throw new LearningSchemaError('LEARNING_SCHEMA_UNSUPPORTED_VERSION');
      }
      if (rows.length !== 1 || rows[0].singleton !== 1 || rows[0].schema_version !== 2 || rows[0].minimum_reader_version !== 2
        || typeof rows[0].recorded_at !== 'string' || !isValidInstant(rows[0].recorded_at)
        || new Date(rows[0].recorded_at).toISOString() !== rows[0].recorded_at) throw invalid();
    }
    const hasRevisionObjects = tables.has('observation_revisions')
      || [...indexes.keys()].some(name => name.startsWith('observation_revisions_'));
    if ((version === 2) !== hasMetadata || (version === 2) !== hasRevisionObjects) throw invalid();
    if (version === 0 && tables.size === 5
      && ['namespaces', 'config_history', 'anchors', 'observations', 'layouts'].every(name => tables.has(name))) {
      throw new LearningSchemaError('LEARNING_SCHEMA_UNSUPPORTED_LEGACY');
    }
    const activityCount = ACTIVITY_TABLES.filter(name => tables.has(name)).length;
    if (activityCount !== 0 && activityCount !== 4) throw invalid();
    const missingActivity = activityCount === 0;
    if (version === 2 && missingActivity) throw invalid();
    const expectedTables = { ...LEGACY_TABLE_SQL, ...(version === 2 ? { observation_revisions: REVISION_TABLE_SQL, [METADATA]: METADATA_SQL } : {}) };
    for (const name of [...tables.keys()]) if (!Object.hasOwn(expectedTables, name)) throw invalid();
    const missingColumns: MissingLearningColumn[] = [];
    let preScenarioPractice = false;
    for (const [name, sql] of Object.entries(expectedTables)) {
      if (missingActivity && ACTIVITY_TABLES.includes(name)) continue;
      const object = tables.get(name);
      if (!object?.sql) throw invalid();
      const actual = tableDefinition(object.sql);
      let expected = tableDefinition(sql);
      for (const column of OPTIONAL_COLUMNS) {
        const [owner, field] = column.split('.');
        if (owner !== name || hasColumn(actual, field)) continue;
        if (version === 2) throw invalid();
        missingColumns.push(column);
        expected = { ...expected, definitions: expected.definitions.filter(value => value[0] !== field) };
      }
      if (name === 'practice_cards' && !hasColumn(actual, 'scenario_json')) {
        if (version === 2) throw invalid();
        expected = tableDefinition(sql.replace("'detail', 'comparison', 'scenario'", "'detail', 'comparison'"));
        expected.definitions = expected.definitions.filter(value => value[0] !== 'scenario_json');
        preScenarioPractice = true;
      }
      if (tableSignature(actual) !== tableSignature(expected)) throw invalid();
    }
    const expectedIndexes = { ...LEGACY_INDEX_SQL, ...(version === 2 ? REVISION_INDEX_SQL : {}) };
    if (missingActivity) delete expectedIndexes.activity_events_page;
    if (indexes.size !== Object.keys(expectedIndexes).length) throw invalid();
    for (const [name, sql] of Object.entries(expectedIndexes)) {
      const actual = indexes.get(name);
      if (!actual?.sql || indexSignature(actual.sql) !== indexSignature(sql)) throw invalid();
    }
    return version === 2 ? { kind: 'current-v2', schemaVersion: 2, minimumReaderVersion: 2 }
      : { kind: 'legacy-v1', schemaVersion: 1, normalization: { missingActivity, missingColumns: missingColumns.sort(), preScenarioPractice } };
  } catch (error) {
    if (error instanceof LearningSchemaError) throw error;
    throw invalid();
  }
}

function normalizeRecordedAt(recordedAt: string): string {
  if (typeof recordedAt !== 'string' || !isValidInstant(recordedAt)) throw invalid();
  return new Date(recordedAt).toISOString();
}
function foreignKeys(db: DatabaseSync): number { return Number(db.prepare('PRAGMA foreign_keys').get()!.foreign_keys); }
function execute(db: DatabaseSync, statements: Readonly<Record<string, string>>): void {
  for (const sql of Object.values(statements)) db.exec(sql);
}
function rebuildPractice(db: DatabaseSync): void {
  for (const name of ['practice_cards_by_card', 'practice_attempts_by_card', 'practice_sources_by_concept']) db.exec(`DROP INDEX ${name}`);
  db.exec('ALTER TABLE practice_card_sources RENAME TO practice_card_sources_legacy');
  db.exec('ALTER TABLE practice_cards RENAME TO practice_cards_legacy');
  db.exec(LEGACY_TABLE_SQL.practice_cards);
  db.exec(`INSERT INTO practice_cards(rowid,namespace,event_id,card_id,previous_event_id,occurred_at,recorded_at,kind,title,
    prompt,reference_answer,reference_notes,sources_json,source_checked,scenario_json,paused,request_payload)
    SELECT rowid,namespace,event_id,card_id,previous_event_id,occurred_at,recorded_at,kind,title,
    prompt,reference_answer,reference_notes,sources_json,source_checked,NULL,paused,request_payload
    FROM practice_cards_legacy ORDER BY rowid`);
  db.exec(LEGACY_TABLE_SQL.practice_card_sources);
  db.exec(`INSERT INTO practice_card_sources(rowid,namespace,card_event_id,card_id,concept_id,source_revision)
    SELECT rowid,namespace,card_event_id,card_id,concept_id,source_revision FROM practice_card_sources_legacy ORDER BY rowid`);
  db.exec('DROP TABLE practice_card_sources_legacy');
  db.exec('DROP TABLE practice_cards_legacy');
  for (const name of ['practice_cards_by_card', 'practice_attempts_by_card', 'practice_sources_by_concept']) db.exec(LEGACY_INDEX_SQL[name]);
}

/**
 * Migration primitives for a verified new restore stage or disposable fixtures.
 * The caller owns offline verification, backup and the connection lifetime.
 * Existing service startup does not invoke either primitive yet.
 */
function transitionSchema(db: DatabaseSync, mode: 'initialize' | 'migrate', recordedAt: string): LearningSchemaMigrationResult {
  const receipt = normalizeRecordedAt(recordedAt);
  let ownsTransaction = false, disabledForeignKeys = false;
  try {
    if (foreignKeys(db) !== 1) throw new LearningSchemaError('LEARNING_SCHEMA_TRANSACTION_REQUIRED');
    const initial = inspectLearningSchema(db);
    if (initial.kind === 'current-v2') return { status: 'already-current', schemaVersion: 2 };
    if ((mode === 'initialize' && initial.kind !== 'empty') || (mode === 'migrate' && initial.kind !== 'legacy-v1')) throw invalid();
    if (initial.kind === 'legacy-v1' && initial.normalization.preScenarioPractice) {
      disabledForeignKeys = true;
      db.exec('PRAGMA foreign_keys=OFF');
      if (foreignKeys(db) !== 0) throw new LearningSchemaError('LEARNING_SCHEMA_TRANSACTION_REQUIRED');
    }
    try { db.exec('BEGIN IMMEDIATE'); ownsTransaction = true; }
    catch { throw new LearningSchemaError('LEARNING_SCHEMA_TRANSACTION_REQUIRED'); }
    const current = inspectLearningSchema(db);
    if (current.kind === 'current-v2') {
      db.exec('COMMIT'); ownsTransaction = false;
      return { status: 'already-current', schemaVersion: 2 };
    }
    if (mode === 'initialize') {
      if (current.kind !== 'empty') throw invalid();
      execute(db, LEGACY_TABLE_SQL); execute(db, LEGACY_INDEX_SQL);
    } else {
      if (current.kind !== 'legacy-v1') throw invalid();
      if (current.normalization.preScenarioPractice) {
        if (foreignKeys(db) !== 0) throw new LearningSchemaError('LEARNING_SCHEMA_TRANSACTION_REQUIRED');
        rebuildPractice(db);
      }
      for (const column of current.normalization.missingColumns) {
        const [table, field] = column.split('.');
        db.exec(`ALTER TABLE ${sqlName(table)} ADD COLUMN ${sqlName(field)} TEXT`);
      }
      if (current.normalization.missingActivity) {
        for (const name of ACTIVITY_TABLES) db.exec(LEGACY_TABLE_SQL[name]);
        db.exec(LEGACY_INDEX_SQL.activity_events_page);
      }
    }
    createObservationRevisionTables(db);
    db.exec(METADATA_SQL);
    db.prepare('INSERT INTO learning_schema_metadata(singleton,schema_version,minimum_reader_version,recorded_at) VALUES(1,2,2,?)').run(receipt);
    db.exec('PRAGMA user_version=2');
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw invalid();
    if (inspectLearningSchema(db).kind !== 'current-v2') throw invalid();
    db.exec('COMMIT'); ownsTransaction = false;
    return { status: mode === 'initialize' ? 'initialized' : 'migrated', schemaVersion: 2 };
  } catch (error) {
    if (ownsTransaction) { try { db.exec('ROLLBACK'); } catch { /* Preserve the fixed original failure. */ } }
    if (error instanceof LearningSchemaError) throw error;
    throw new LearningSchemaError('LEARNING_SCHEMA_MIGRATION_FAILED');
  } finally {
    if (disabledForeignKeys) {
      try { db.exec('PRAGMA foreign_keys=ON'); if (foreignKeys(db) !== 1) throw invalid(); }
      catch { throw new LearningSchemaError('LEARNING_SCHEMA_MIGRATION_FAILED'); }
    }
  }
}
export function initializeLearningSchemaV2(db: DatabaseSync, options: { recordedAt: string }): LearningSchemaMigrationResult {
  return transitionSchema(db, 'initialize', options.recordedAt);
}
export function migrateLearningSchemaV1ToV2(db: DatabaseSync, options: { recordedAt: string }): LearningSchemaMigrationResult {
  return transitionSchema(db, 'migrate', options.recordedAt);
}
