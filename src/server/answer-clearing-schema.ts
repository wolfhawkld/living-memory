import type { DatabaseSync } from 'node:sqlite';
import { isValidInstant } from '../core/time-model.js';
import { LEGACY_INDEX_SQL, LEGACY_TABLE_SQL, REVISION_INDEX_SQL, REVISION_TABLE_SQL } from './learning-schema-baseline.js';

export type AnswerClearingSchemaErrorCode = 'ANSWER_CLEARING_SCHEMA_INVALID'
  | 'ANSWER_CLEARING_SCHEMA_UNSUPPORTED_VERSION' | 'ANSWER_CLEARING_SCHEMA_TRANSACTION_REQUIRED'
  | 'ANSWER_CLEARING_SCHEMA_INITIALIZATION_FAILED';
export class AnswerClearingSchemaError extends Error {
  constructor(readonly code: AnswerClearingSchemaErrorCode) { super(code); this.name = 'AnswerClearingSchemaError'; }
}
export type AnswerClearingSchemaInspection = { kind: 'empty' }
  | { kind: 'current-v3'; schemaVersion: 3; minimumReaderVersion: 3 };
export interface AnswerClearingSchemaInitializationResult {
  status: 'initialized' | 'already-current'; schemaVersion: 3;
}

const METADATA_SQL = `CREATE TABLE learning_schema_metadata (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  schema_version INTEGER NOT NULL CHECK(schema_version=3),
  minimum_reader_version INTEGER NOT NULL CHECK(minimum_reader_version=3),
  recorded_at TEXT NOT NULL
)`;
const OBSERVATIONS_SQL = LEGACY_TABLE_SQL.observations
  .replace('answer TEXT NOT NULL,', 'answer TEXT,')
  .replace('request_payload TEXT NOT NULL,', `request_payload TEXT,
        answer_cleared_at TEXT,
        CHECK((answer_cleared_at IS NULL AND typeof(answer)='text' AND typeof(request_payload)='text')
          OR (typeof(answer_cleared_at)='text' AND answer IS NULL AND request_payload IS NULL)),`);
const TABLES = { ...LEGACY_TABLE_SQL, observations: OBSERVATIONS_SQL,
  observation_revisions: REVISION_TABLE_SQL, learning_schema_metadata: METADATA_SQL };
const INDEXES = { ...LEGACY_INDEX_SQL, ...REVISION_INDEX_SQL };
function invalid(): never { throw new AnswerClearingSchemaError('ANSWER_CLEARING_SCHEMA_INVALID'); }

/** Exact known DDL, with whitespace/case/identifier quoting normalized, literals preserved. */
function signature(sql: string): string {
  const tokens: string[] = [];
  let offset = 0;
  while (offset < sql.length) {
    const rest = sql.slice(offset);
    const space = /^\s+/.exec(rest);
    if (space) { offset += space[0].length; continue; }
    const literal = /^'(?:[^']|'')*'/.exec(rest);
    if (literal) { tokens.push(literal[0]); offset += literal[0].length; continue; }
    const quoted = /^(?:"([A-Za-z_][A-Za-z0-9_]*)"|`([A-Za-z_][A-Za-z0-9_]*)`|\[([A-Za-z_][A-Za-z0-9_]*)\])/.exec(rest);
    if (quoted) { tokens.push((quoted[1] ?? quoted[2] ?? quoted[3]).toLowerCase()); offset += quoted[0].length; continue; }
    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
    if (word) { tokens.push(word[0].toLowerCase()); offset += word[0].length; continue; }
    const number = /^\d+(?:\.\d+)?/.exec(rest);
    if (number) { tokens.push(number[0]); offset += number[0].length; continue; }
    if (!'(),=<>+-.*;'.includes(rest[0]) || rest.startsWith('--') || rest.startsWith('/*')) invalid();
    tokens.push(rest[0]); offset++;
  }
  if (tokens.at(-1) === ';') tokens.pop();
  const position = tokens[1] === 'unique' ? 3 : 2;
  if (tokens.slice(position, position + 3).join(' ') === 'if not exists') tokens.splice(position, 3);
  return JSON.stringify(tokens);
}
function canonicalInstant(value: unknown): value is string {
  return typeof value === 'string' && isValidInstant(value) && new Date(value).toISOString() === value;
}
interface SchemaObject { type: string; name: string; tbl_name: string; sql: string | null }

/** Strict read-only inspection of the independent v3 format; never migrates or repairs. */
export function inspectAnswerClearingSchemaV3(db: DatabaseSync): AnswerClearingSchemaInspection {
  try {
    if (db.prepare('SELECT name FROM sqlite_temp_master').all().length) invalid();
    const version = Number(db.prepare('PRAGMA main.user_version').get()!.user_version);
    if (version !== 0 && version !== 3) throw new AnswerClearingSchemaError('ANSWER_CLEARING_SCHEMA_UNSUPPORTED_VERSION');
    const all = db.prepare('SELECT type,name,tbl_name,sql FROM main.sqlite_master ORDER BY type,name').all() as unknown as SchemaObject[];
    if (version === 0 && all.length === 0) return { kind: 'empty' };
    if (version !== 3) invalid();
    const objects = all.filter(object => {
      if (!object.name.startsWith('sqlite_')) return true;
      if (object.type !== 'index' || !object.name.startsWith('sqlite_autoindex_') || object.sql !== null
        || !Object.hasOwn(TABLES, object.tbl_name)) invalid();
      return false;
    });
    if (objects.length !== Object.keys(TABLES).length + Object.keys(INDEXES).length) invalid();
    for (const object of objects) {
      const expected = object.type === 'table' ? TABLES : object.type === 'index' ? INDEXES : invalid();
      if (!Object.hasOwn(expected, object.name) || !object.sql
        || signature(object.sql) !== signature(expected[object.name as keyof typeof expected])) invalid();
    }
    const rows = db.prepare('SELECT singleton,schema_version,minimum_reader_version,recorded_at FROM main.learning_schema_metadata').all();
    if (rows.some(row => Number(row.schema_version) > 3 || Number(row.minimum_reader_version) > 3)) {
      throw new AnswerClearingSchemaError('ANSWER_CLEARING_SCHEMA_UNSUPPORTED_VERSION');
    }
    if (rows.length !== 1 || rows[0].singleton !== 1 || rows[0].schema_version !== 3
      || rows[0].minimum_reader_version !== 3 || !canonicalInstant(rows[0].recorded_at)) invalid();
    if (db.prepare('PRAGMA main.foreign_key_check').all().length) invalid();
    // CHECK constraints can be bypassed by external writers; validate stored states too.
    if (db.prepare(`SELECT 1 FROM main.observations WHERE NOT (
      (answer_cleared_at IS NULL AND typeof(answer)='text' AND typeof(request_payload)='text') OR
      (typeof(answer_cleared_at)='text' AND answer IS NULL AND request_payload IS NULL)) LIMIT 1`).get()) invalid();
    for (const row of db.prepare('SELECT recorded_at,answer_cleared_at FROM main.observations WHERE answer_cleared_at IS NOT NULL').all()) {
      if (!canonicalInstant(row.answer_cleared_at) || typeof row.recorded_at !== 'string'
        || !isValidInstant(row.recorded_at) || Date.parse(row.answer_cleared_at) < Date.parse(row.recorded_at)) invalid();
    }
    return { kind: 'current-v3', schemaVersion: 3, minimumReaderVersion: 3 };
  } catch (error) {
    if (error instanceof AnswerClearingSchemaError) throw error;
    throw new AnswerClearingSchemaError('ANSWER_CLEARING_SCHEMA_INVALID');
  }
}

/** Caller must own the transaction and roll it back on failure. No commits, migrations or backups. */
export function initializeAnswerClearingSchemaV3(db: DatabaseSync, options: { recordedAt: string }): AnswerClearingSchemaInitializationResult {
  const initial = inspectAnswerClearingSchemaV3(db);
  if (initial.kind === 'current-v3') return { status: 'already-current', schemaVersion: 3 };
  if (!db.isTransaction || db.prepare('PRAGMA foreign_keys').get()!.foreign_keys !== 1) {
    throw new AnswerClearingSchemaError('ANSWER_CLEARING_SCHEMA_TRANSACTION_REQUIRED');
  }
  const recordedAt = options?.recordedAt;
  if (typeof recordedAt !== 'string' || !isValidInstant(recordedAt)) invalid();
  const normalized = new Date(recordedAt).toISOString();
  if (!canonicalInstant(normalized)) invalid();
  try {
    for (const sql of Object.values(TABLES)) db.exec(sql);
    for (const sql of Object.values(INDEXES)) db.exec(sql);
    db.prepare('INSERT INTO learning_schema_metadata(singleton,schema_version,minimum_reader_version,recorded_at) VALUES(1,3,3,?)').run(normalized);
    db.exec('PRAGMA main.user_version=3');
    if (inspectAnswerClearingSchemaV3(db).kind !== 'current-v3') invalid();
    return { status: 'initialized', schemaVersion: 3 };
  } catch (error) {
    if (error instanceof AnswerClearingSchemaError) throw error;
    throw new AnswerClearingSchemaError('ANSWER_CLEARING_SCHEMA_INITIALIZATION_FAILED');
  }
}
