import type { DatabaseSync } from 'node:sqlite';
import { isAnswerCleared, planAnswerClearing } from '../core/answer-clearing.js';
import { AnswerClearingError, parseAnswerClearingMarker, parseAnswerClearingRequest,
  type AnswerClearingReceipt, type PrivacyObservation } from '../shared/answer-clearing.js';
import type { LearningEvidence } from '../shared/types.js';
import { inspectAnswerClearingSchemaV3 } from './answer-clearing-schema.js';

export class AnswerClearingStoreError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); this.name = 'AnswerClearingStoreError'; }
}
export interface AnswerClearingStoreOptions {
  db: DatabaseSync;
  namespace: string;
  now?: () => Date;
}
const failure = (suffix: string, status = 503) => new AnswerClearingStoreError(`ANSWER_CLEARING_${suffix}`, status);
const invalid = () => failure('DATA_INVALID');
const LEARNING_FIELDS = ['task', 'scenario', 'scenarioRevisit', 'applicability', 'confidence', 'confidenceAt', 'cue', 'outcome', 'basis'];
const SELECT = `SELECT event_id,concept_id,source_revision,observed_at,recorded_at,config_revision,
  half_life_days,anchor_event_id,elapsed_days,decay,answer,rating,exposure,observed_exposure,
  learning_json,evidence_mode,request_payload,answer_cleared_at FROM main.observations WHERE namespace=? AND event_id=?`;

function target(value: unknown): string {
  try { return parseAnswerClearingRequest({ observationEventId: value }).observationEventId; }
  catch { throw failure('INVALID_REQUEST', 400); }
}
function learning(value: unknown): LearningEvidence {
  if (typeof value !== 'string') throw invalid();
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalid();
  // JSON may contain future/SQL helper fields. Only the domain fields leave this boundary.
  return Object.freeze(Object.fromEntries(LEARNING_FIELDS.filter(key => Object.hasOwn(parsed, key))
    .map(key => [key, (parsed as Record<string, unknown>)[key]]))) as unknown as LearningEvidence;
}
function observation(row: Record<string, unknown>): PrivacyObservation {
  try {
    if (row.observed_exposure !== 0 && row.observed_exposure !== 1) throw invalid();
    const cleared = row.answer_cleared_at !== null;
    if (cleared ? row.answer !== null || row.request_payload !== null
      : typeof row.answer !== 'string' || typeof row.request_payload !== 'string') throw invalid();
    const marker = cleared ? parseAnswerClearingMarker({ observationEventId: row.event_id, clearedAt: row.answer_cleared_at }) : null;
    if (marker && marker.clearedAt !== row.answer_cleared_at) throw invalid();
    const value = {
      eventId: row.event_id, conceptId: row.concept_id, sourceRevision: row.source_revision,
      observedAt: row.observed_at, recordedAt: row.recorded_at, configRevision: row.config_revision,
      halfLifeDays: row.half_life_days, anchorEventId: row.anchor_event_id, elapsedDays: row.elapsed_days, decay: row.decay,
      answer: row.answer, rating: row.rating, exposure: row.exposure, observedExposure: row.observed_exposure === 1,
      ...(row.evidence_mode !== null ? { evidenceMode: row.evidence_mode } : {}),
      ...(row.learning_json !== null ? { learning: learning(row.learning_json) } : {}),
      ...(marker ? { answerClearing: marker } : {}),
    } as PrivacyObservation;
    // Validate every domain value, including the null/marker pair, before returning the selected fields.
    isAnswerCleared(value);
    return Object.freeze(value);
  } catch { throw invalid(); }
}

/**
 * ACLEAR-02A only: a caller-owned, verified schema 3 connection. No runtime, migration,
 * API, import or existing Store calls this module yet. It never opens or closes a database.
 */
export class AnswerClearingStore {
  private readonly db: DatabaseSync;
  private readonly namespace: string;
  private readonly now: () => Date;
  constructor(options: AnswerClearingStoreOptions) {
    this.db = options.db; this.namespace = options.namespace; this.now = options.now ?? (() => new Date());
    if (typeof this.namespace !== 'string' || !this.namespace || this.namespace !== this.namespace.trim()
      || /[\u0000-\u001f\u007f]/.test(this.namespace) || Buffer.byteLength(this.namespace, 'utf8') > 256) {
      throw failure('INVALID_NAMESPACE', 400);
    }
    try {
      if (this.db.prepare('PRAGMA foreign_keys').get()!.foreign_keys !== 1
        || inspectAnswerClearingSchemaV3(this.db).kind !== 'current-v3') throw invalid();
    } catch { throw failure('SCHEMA_UNAVAILABLE'); }
  }
  private read(eventId: string): PrivacyObservation | null {
    const row = this.db.prepare(SELECT).get(this.namespace, eventId);
    return row ? observation(row) : null;
  }
  /** One SQL snapshot for the answer and its marker, without request_payload or historical cutoffs. */
  readObservation(observationEventId: string): PrivacyObservation | null {
    const eventId = target(observationEventId);
    try { return this.read(eventId); }
    catch (error) { if (error instanceof AnswerClearingStoreError) throw error; throw invalid(); }
  }
  clear(input: unknown): AnswerClearingReceipt {
    let eventId: string;
    try { eventId = parseAnswerClearingRequest(input).observationEventId; }
    catch { throw failure('INVALID_REQUEST', 400); }
    let ownsTransaction = false;
    try {
      this.db.exec('BEGIN IMMEDIATE'); ownsTransaction = true;
      const parent = this.read(eventId);
      if (!parent) throw failure('NOT_FOUND', 404);
      let receipt: AnswerClearingReceipt;
      if (parent.answer === null) {
        // A successful retry is independent of the current clock and keeps the first fact.
        receipt = Object.freeze({ status: 'duplicate', ...parent.answerClearing });
      } else {
        let clearedAt: string;
        try { clearedAt = this.now().toISOString(); }
        catch { throw failure('INVALID_CLEARED_AT', 400); }
        const planned = planAnswerClearing(parent, { observationEventId: eventId }, clearedAt);
        receipt = planned.receipt;
        // Drop the entire replay credential, including any unknown mechanical copies of the answer.
        const result = this.db.prepare(`UPDATE main.observations SET answer=NULL,request_payload=NULL,answer_cleared_at=?
          WHERE namespace=? AND event_id=? AND answer_cleared_at IS NULL`).run(receipt.clearedAt, this.namespace, eventId);
        if (result.changes !== 1) throw invalid();
      }
      this.db.exec('COMMIT'); ownsTransaction = false;
      return receipt;
    } catch (error) {
      if (ownsTransaction) { try { this.db.exec('ROLLBACK'); } catch { /* Keep the fixed, non-private error. */ } }
      if (error instanceof AnswerClearingStoreError) throw error;
      if (error instanceof AnswerClearingError) {
        if (error.code === 'INVALID_CLEARED_AT') throw failure('INVALID_CLEARED_AT', 400);
        if (error.code === 'NO_SAVED_ANSWER') throw failure('NO_SAVED_ANSWER', 409);
        throw invalid();
      }
      throw failure('WRITE_FAILED');
    }
  }
  /**
   * Necessary guard for a future writer, on this same connection and inside its transaction.
   * Not a payload equality, global event-ID conflict, or complete import/replay implementation.
   */
  assertReplayAllowed(observationEventId: string): void {
    const eventId = target(observationEventId);
    try {
      if (!this.db.isTransaction) throw failure('TRANSACTION_REQUIRED');
      const parent = this.read(eventId);
      if (parent?.answer === null) throw new AnswerClearingStoreError('ANSWER_CLEARED', 409);
    } catch (error) { if (error instanceof AnswerClearingStoreError) throw error; throw invalid(); }
  }
}
