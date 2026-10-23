import { existsSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_HALF_LIFE_DAYS, MODEL_VERSION } from '../shared/types.js';
import { isValidInstant } from '../core/time-model.js';
import { inspectAnswerClearingSchemaV3 } from './answer-clearing-schema.js';
import { LEGACY_TABLE_SQL } from './learning-schema-baseline.js';
import { StoreError } from './store-error.js';

export interface EnsureLearningNamespaceV3Options {
  dbPath: string;
  namespace: string;
  now?: () => Date;
}
export interface LearningNamespaceV3Preparation {
  status: 'created' | 'already-ready';
  namespace: string;
}

const NAMESPACE_TABLES = [...Object.keys(LEGACY_TABLE_SQL), 'observation_revisions'];
function failure(code: string, status = 503): StoreError { return new StoreError(code, code, status); }
function namespace(value: unknown): string {
  if (typeof value !== 'string' || !value || value !== value.trim()
    || /[\u0000-\u001f\u007f]/.test(value) || Buffer.byteLength(value, 'utf8') > 256) {
    throw failure('LEARNING_NAMESPACE_INVALID', 400);
  }
  return value;
}
function existingFile(dbPath: string): void {
  try {
    if (typeof dbPath !== 'string' || !dbPath || !existsSync(dbPath) || !statSync(dbPath).isFile()) throw new Error();
  } catch { throw failure('LEARNING_SCHEMA_UNSUPPORTED_VERSION'); }
}
function assertSchema(db: DatabaseSync): void {
  try {
    if (inspectAnswerClearingSchemaV3(db).kind !== 'current-v3') throw new Error();
  } catch { throw failure('LEARNING_SCHEMA_UNSUPPORTED_VERSION'); }
}

/** Read-only gate before source/account setup. Never creates a file, schema or namespace. */
export function assertLearningDatabaseV3Ready(dbPath: string): void {
  existingFile(dbPath);
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec('PRAGMA busy_timeout=5000');
    assertSchema(db);
  } catch (error) {
    if (error instanceof StoreError) throw error;
    throw failure('LEARNING_SCHEMA_UNSUPPORTED_VERSION');
  } finally { db?.close(); }
}

/**
 * Prepare only a genuinely new namespace in an existing complete v3 database.
 * Owns its connection and transaction; never repairs existing namespace data or
 * changes the strict Store<3> constructor's responsibilities.
 */
export function ensureLearningNamespaceV3(options: EnsureLearningNamespaceV3Options): LearningNamespaceV3Preparation {
  const target = namespace(options.namespace);
  assertLearningDatabaseV3Ready(options.dbPath);
  let db: DatabaseSync | undefined;
  let ownsTransaction = false;
  try {
    db = new DatabaseSync(options.dbPath);
    db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON');
    db.exec('BEGIN IMMEDIATE'); ownsTransaction = true;
    // Repeat both structure and namespace checks under the write lock.
    assertSchema(db);
    const present = db.prepare('SELECT created_at FROM main.namespaces WHERE namespace=?').get(target);
    const configs = db.prepare('SELECT revision,model_version,half_life_days,recorded_at FROM main.config_history WHERE namespace=?').all(target);
    if (present) {
      if (typeof present.created_at !== 'string' || !isValidInstant(present.created_at) || !configs.length
        || configs.some(config => !Number.isSafeInteger(config.revision) || (config.revision as number) <= 0
          || config.model_version !== MODEL_VERSION || typeof config.half_life_days !== 'number'
          || !Number.isFinite(config.half_life_days) || config.half_life_days <= 0 || config.half_life_days > 3650
          || typeof config.recorded_at !== 'string' || !isValidInstant(config.recorded_at))) {
        throw failure('LEARNING_NAMESPACE_UNAVAILABLE');
      }
      db.exec('COMMIT'); ownsTransaction = false;
      return { status: 'already-ready', namespace: target };
    }
    // Names are a closed schema whitelist, never caller-supplied SQL. Orphaned
    // configuration, learning, identity and activity rows are not a new space.
    for (const table of NAMESPACE_TABLES) {
      if (db.prepare(`SELECT 1 AS present FROM main."${table}" WHERE namespace=? LIMIT 1`).get(target)) {
        throw failure('LEARNING_NAMESPACE_UNAVAILABLE');
      }
    }
    const now = (options.now ?? (() => new Date()))();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw failure('LEARNING_NAMESPACE_TIME_INVALID');
    const createdAt = now.toISOString();
    if (!isValidInstant(createdAt)) throw failure('LEARNING_NAMESPACE_TIME_INVALID');
    db.prepare('INSERT INTO main.namespaces(namespace,created_at) VALUES (?,?)').run(target, createdAt);
    db.prepare('INSERT INTO main.config_history(namespace,revision,model_version,half_life_days,recorded_at) VALUES (?,1,?,?,?)')
      .run(target, MODEL_VERSION, DEFAULT_HALF_LIFE_DAYS, createdAt);
    db.exec('COMMIT'); ownsTransaction = false;
    return { status: 'created', namespace: target };
  } catch (error) {
    if (ownsTransaction) { try { db!.exec('ROLLBACK'); } catch { /* preserve the fixed failure */ } }
    if (error instanceof StoreError) throw error;
    throw failure('LEARNING_NAMESPACE_PREPARE_FAILED');
  } finally { db?.close(); }
}
