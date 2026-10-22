import type { DatabaseSync } from 'node:sqlite';
import type { Concept, ExportDataV2 } from '../shared/types.js';
import type { ExportDataV3 } from '../shared/answer-clearing-export.js';
import { AnswerClearingImportError } from '../shared/answer-clearing-export.js';
import type { ImportCommitRequest, ImportOptions, ImportPreview, ImportReceipt } from '../shared/import-data.js';
import { buildAnswerClearingImportPlan, type PreparedAnswerClearingImport } from './answer-clearing-import.js';
import { LearningImportRepository } from './learning-import-repository.js';
import { LearningSnapshotRepository } from './learning-snapshot-repository.js';
import { AnswerClearingStore, AnswerClearingStoreError } from './answer-clearing-store.js';
import { StoreError } from './store-error.js';
import { SAFE_IMPORT_CREDENTIAL, buildSafeImportReplayDescriptor, parseSafeImportReceiptEnvelope,
  encodeSafeImportReceiptEnvelope, safeImportReplayEqual } from './answer-clearing-replay-contract.js';

const failed = (code: string, status = 409) => new StoreError(code, code, status);
function plainRecord(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw failed('IMPORT_INVALID_DATA', 400);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== 'string' || !keys.includes(key) || !descriptor.enumerable || !('value' in descriptor)) throw failed('IMPORT_INVALID_DATA', 400);
  }
  return value as Record<string, unknown>;
}
function importOptions(value: unknown): ImportOptions {
  const options = plainRecord(value, ['restoreLayout', 'restoreReviewPlan']);
  if (typeof options.restoreLayout !== 'boolean' || typeof options.restoreReviewPlan !== 'boolean') throw failed('IMPORT_INVALID_DATA', 400);
  return { restoreLayout: options.restoreLayout, restoreReviewPlan: options.restoreReviewPlan };
}
function hasNewRecords(plan: PreparedAnswerClearingImport): boolean {
  return [plan.newAnchors, plan.newObservations, plan.newObservationRevisions, plan.newRetentions,
    plan.newApplications, plan.newCorrections, plan.newRelationReviews, plan.newPracticeCards,
    plan.newPracticeAttempts, plan.newConfigs].some(records => records.length !== 0);
}

/**
 * Explicit schema 3 import on an already initialized caller-owned connection.
 * Owns commit transactions; never opens/closes a connection, migrates a database or enables the product runtime.
 */
export class AnswerClearingImportCoordinator {
  private readonly db: DatabaseSync;
  private readonly namespace: string;
  private readonly snapshots: LearningSnapshotRepository<3>;
  private readonly writer: LearningImportRepository<3>;
  private readonly privacy: AnswerClearingStore;
  constructor(options: { db: DatabaseSync; namespace: string; now?: () => Date }) {
    this.db = options.db;
    this.namespace = options.namespace;
    this.privacy = new AnswerClearingStore(options);
    this.snapshots = new LearningSnapshotRepository({ ...options, schemaVersion: 3 });
    this.writer = new LearningImportRepository({ ...options, schemaVersion: 3 });
  }

  exportData(source: ExportDataV2['source'], concepts: Concept[]): ExportDataV3 {
    try { return this.snapshots.exportData(source, concepts); }
    catch (error) { throw this.safeError(error); }
  }

  private prepare(data: unknown, options: ImportOptions, source: ExportDataV2['source'], concepts: Concept[]) {
    const current = this.snapshots.exportData(source, concepts);
    const prepared = buildAnswerClearingImportPlan({ data, options, current, concepts,
      sourceId: this.namespace, now: current.exportedAt, acceptedPaths: this.snapshots.getIdentityAcceptedPaths() });
    return { current, prepared };
  }

  previewImport(data: unknown, options: ImportOptions, source: ExportDataV2['source'], concepts: Concept[]): ImportPreview {
    try {
      const normalizedOptions = importOptions(options);
      return this.snapshots.readSnapshot(() => this.prepare(data, normalizedOptions, source, concepts).prepared.preview);
    } catch (error) { throw this.safeError(error); }
  }

  commitImport(request: ImportCommitRequest, source: ExportDataV2['source'], concepts: Concept[],
    beforeWrite: (backup: ExportDataV3) => string): ImportReceipt {
    let ownsTransaction = false;
    try {
      const envelope = plainRecord(request, ['importId', 'data', 'options', 'previewToken', 'confirmed']);
      const importId = envelope.importId;
      if (typeof importId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(importId)) throw failed('INVALID_EVENT_ID', 400);
      if (envelope.confirmed !== true) throw failed('IMPORT_NOT_CONFIRMED', 400);
      this.db.exec('BEGIN IMMEDIATE'); ownsTransaction = true;
      // Always before reading a stored operation envelope, comparing data or taking any duplicate shortcut.
      this.privacy.assertOperationReplayAllowed('import', importId);
      const existing = this.db.prepare(`SELECT request_hash=? AS safe, receipt_json
        FROM main.import_receipts WHERE namespace=? AND import_id=?`)
        .get(SAFE_IMPORT_CREDENTIAL, this.namespace, importId) as { safe: number; receipt_json: string } | undefined;
      if (existing && existing.safe !== 1) throw failed('IMPORT_LEGACY_OPERATION');
      const options = importOptions(envelope.options);
      const { current, prepared } = this.prepare(envelope.data, options, source, concepts);
      if (existing) {
        if (!prepared.preview.canImport || hasNewRecords(prepared)) throw failed('IMPORT_CONFLICT');
        const replay = buildSafeImportReplayDescriptor(prepared, options);
        let parsed: unknown;
        try { parsed = JSON.parse(existing.receipt_json); } catch { throw failed('IMPORT_RECEIPT_CORRUPT', 503); }
        const saved = parseSafeImportReceiptEnvelope(parsed, { namespace: this.namespace, importId });
        // Replanning compares every original incoming event with current rows, including intact answers.
        // The manifest additionally freezes recordedAt, which event identity deliberately ignores.
        if (!safeImportReplayEqual(saved.replay, replay)) throw failed('IMPORT_CONFLICT');
        this.db.exec('COMMIT'); ownsTransaction = false;
        return { ...saved.receipt, status: 'duplicate' };
      }
      if (prepared.preview.token !== envelope.previewToken) throw failed('IMPORT_STALE');
      if (!prepared.preview.canImport) throw failed('IMPORT_REJECTED');
      const replay = buildSafeImportReplayDescriptor(prepared, options);
      const backupId = beforeWrite(current);
      if (typeof backupId !== 'string' || !backupId.trim()) throw failed('IMPORT_BACKUP_FAILED', 503);
      // Imported markers only belong to absent observations. Retire legacy answer-derived credentials
      // atomically with those first markers; existing safe operations have lost no answer and may remain.
      if (prepared.newObservations.some(event => event.answer === null)) this.privacy.retireLegacyReplayCredentials();
      this.writer.applyPreparedImport(prepared, options);
      const receipt: ImportReceipt = { status: 'accepted', importId, sourceId: this.namespace,
        importedAt: current.exportedAt, counts: prepared.preview.counts, backupId };
      this.db.prepare('INSERT INTO main.import_receipts(namespace,import_id,request_hash,receipt_json) VALUES (?,?,?,?)')
        .run(this.namespace, importId, SAFE_IMPORT_CREDENTIAL, encodeSafeImportReceiptEnvelope(receipt, replay));
      this.db.exec('COMMIT'); ownsTransaction = false;
      return receipt;
    } catch (error) {
      if (ownsTransaction) { try { this.db.exec('ROLLBACK'); } catch { /* retain the fixed error */ } }
      throw this.safeError(error);
    }
  }

  private safeError(error: unknown): Error {
    if (error instanceof AnswerClearingImportError || error instanceof AnswerClearingStoreError) return error;
    // Do not leak driver messages, callback exceptions or caller-provided event text through errors.
    if (error instanceof StoreError) return failed(error.code, error.status);
    return failed('IMPORT_FAILED', 503);
  }
}
