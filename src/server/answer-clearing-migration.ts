import type { DatabaseSync } from 'node:sqlite';
import { isValidInstant } from '../core/time-model.js';
import { initializeAnswerClearingSchemaV3, inspectAnswerClearingSchemaV3 } from './answer-clearing-schema.js';
import { LEGACY_TABLE_SQL } from './learning-schema-baseline.js';
import { inspectLearningSchema } from './learning-schema.js';

export type AnswerClearingMigrationErrorCode = 'ANSWER_CLEARING_MIGRATION_INVALID_SOURCE'
  | 'ANSWER_CLEARING_MIGRATION_INVALID_TARGET' | 'ANSWER_CLEARING_MIGRATION_TRANSACTION_REQUIRED'
  | 'ANSWER_CLEARING_MIGRATION_INVALID_RECORDED_AT' | 'ANSWER_CLEARING_MIGRATION_COPY_FAILED';
export class AnswerClearingMigrationError extends Error {
  constructor(readonly code: AnswerClearingMigrationErrorCode) {
    super(code); this.name = 'AnswerClearingMigrationError';
  }
}
export interface AnswerClearingMigrationResult { status: 'copied'; schemaVersion: 3 }

const TABLE_NAMES = [...Object.keys(LEGACY_TABLE_SQL), 'observation_revisions'];
function quote(name: string): string { return `"${name.replaceAll('"', '""')}"`; }
function fail(code: AnswerClearingMigrationErrorCode): never { throw new AnswerClearingMigrationError(code); }
function integrity(db: DatabaseSync): boolean {
  const rows = db.prepare('PRAGMA main.integrity_check').all();
  return rows.length === 1 && Object.values(rows[0])[0] === 'ok';
}
function requireSource(db: DatabaseSync): void {
  try {
    if (db.prepare('SELECT name FROM sqlite_temp_master').all().length
      || inspectLearningSchema(db).kind !== 'current-v2'
      || !integrity(db)
      || db.prepare('PRAGMA main.foreign_key_check').all().length) fail('ANSWER_CLEARING_MIGRATION_INVALID_SOURCE');
  } catch { fail('ANSWER_CLEARING_MIGRATION_INVALID_SOURCE'); }
}
function requireEmptyTarget(db: DatabaseSync): void {
  try {
    if (inspectAnswerClearingSchemaV3(db).kind !== 'empty') fail('ANSWER_CLEARING_MIGRATION_INVALID_TARGET');
  } catch { fail('ANSWER_CLEARING_MIGRATION_INVALID_TARGET'); }
}

/**
 * Copy a verified complete v2 snapshot into a new v3 database. No path handling,
 * in-place upgrades, backups or connection ownership. Only transactions started
 * here are ended here. The source read snapshot stays open through target commit.
 * On any error the caller must discard the unpublished target: pre-commit errors
 * roll it back to empty; a later source-transaction cleanup error may leave a
 * complete committed v3 database. The instance restore caller discards its stage.
 */
export function copyLearningSchemaV2ToV3(source: DatabaseSync, target: DatabaseSync,
  options: { recordedAt: string }): AnswerClearingMigrationResult {
  if (source === target) fail('ANSWER_CLEARING_MIGRATION_INVALID_TARGET');
  const recordedAt = options?.recordedAt;
  if (typeof recordedAt !== 'string' || !isValidInstant(recordedAt)
    || !isValidInstant(new Date(recordedAt).toISOString())) fail('ANSWER_CLEARING_MIGRATION_INVALID_RECORDED_AT');
  let sourceTransaction = false, targetTransaction = false;
  try {
    if (source.isTransaction || target.isTransaction
      || source.prepare('PRAGMA main.foreign_keys').get()!.foreign_keys !== 1
      || target.prepare('PRAGMA main.foreign_keys').get()!.foreign_keys !== 1) {
      fail('ANSWER_CLEARING_MIGRATION_TRANSACTION_REQUIRED');
    }
    source.exec('BEGIN'); sourceTransaction = true;
    requireSource(source);
    target.exec('BEGIN IMMEDIATE'); targetTransaction = true;
    requireEmptyTarget(target);
    target.exec('PRAGMA defer_foreign_keys=ON');
    initializeAnswerClearingSchemaV3(target, { recordedAt });
    for (const table of TABLE_NAMES) {
      // The newly initialized, strictly inspected target defines the canonical
      // named columns. v2 ALTER column order is deliberately irrelevant.
      const columns = target.prepare(`PRAGMA main.table_info(${quote(table)})`).all()
        .map(row => String(row.name)).filter(name => name !== 'answer_cleared_at');
      const names = columns.map(quote).join(',');
      const read = source.prepare(`SELECT rowid AS __copy_rowid,${names} FROM main.${quote(table)} ORDER BY rowid`);
      read.setReadBigInts(true);
      const clearingColumn = table === 'observations' ? ',answer_cleared_at' : '';
      const clearingValue = table === 'observations' ? ',NULL' : '';
      const write = target.prepare(`INSERT INTO main.${quote(table)}(rowid,${names}${clearingColumn})
        VALUES(${Array(columns.length + 1).fill('?').join(',')}${clearingValue})`);
      for (const row of read.iterate()) write.run(row.__copy_rowid, ...columns.map(name => row[name]));
    }
    if (inspectAnswerClearingSchemaV3(target).kind !== 'current-v3' || !integrity(target)) fail('ANSWER_CLEARING_MIGRATION_COPY_FAILED');
    target.exec('COMMIT'); targetTransaction = false;
    source.exec('COMMIT'); sourceTransaction = false;
    return { status: 'copied', schemaVersion: 3 };
  } catch (error) {
    if (targetTransaction) { try { target.exec('ROLLBACK'); } catch { /* Preserve the fixed failure. */ } }
    if (sourceTransaction) { try { source.exec('ROLLBACK'); } catch { /* Preserve the fixed failure. */ } }
    if (error instanceof AnswerClearingMigrationError) throw error;
    fail('ANSWER_CLEARING_MIGRATION_COPY_FAILED');
  }
}
