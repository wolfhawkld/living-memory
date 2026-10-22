import type { DatabaseSync } from 'node:sqlite';
import type { AnchorEvent, ApplicationRecord, Concept, Layout, ModelConfig, Observation, RetentionEvent, ReviewRequest } from '../shared/types.js';
import { MODEL_VERSION } from '../shared/types.js';
import type { CorrectionEvent, CorrectionStatus } from '../shared/corrections.js';
import type { PracticeAttempt, PracticeCardEvent } from '../shared/practice.js';
import type { ImportOptions } from '../shared/import-data.js';
import { parseObservationRevisionRequest, type ObservationRevision } from '../shared/observation-revisions.js';
import { parseRelationReviewRequest as parseSharedRelationReviewRequest, validateRelationReviewBasis, relationReviewMatches, type RelationReviewEvent, type RelationReviewRequest, type RelationReviewStatus } from '../shared/relation-reviews.js';
import { parseRelationSuggestion } from '../shared/relation-suggestions.js';
import { isValidInstant } from '../core/time-model.js';
import type { PreparedConfig, PreparedImport } from './import-plan.js';
import { inspectLearningSchema, LearningSchemaError } from './learning-schema.js';
import { StoreError } from './store-error.js';
import { parsePracticeAttemptRequest, parsePracticeCardRequest } from './practice-validation.js';
import { canonicalJson, parseDate, normalizeDate, finiteNumber, normalizeObservationEvidenceMode, practiceCardFromRow, assertPracticeScenarioContract, correctionRequestPayload, correctionFromRow, relationReviewRequestPayload, relationReviewFromRow } from './store-codecs.js';

type PracticeEventKind = 'practice-card' | 'practice-attempt';
const CORRECTION_STATUSES = ['resolved', 'dismissed', 'open'] as const;
const EVENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
function isOneOf<T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === 'string' && values.includes(value);
}
function iso(value: Date): string { return value.toISOString(); }
function parseRelationReviewRequest(value: unknown): RelationReviewRequest {
  try { return parseSharedRelationReviewRequest(value); }
  catch (error) { throw new StoreError('INVALID_BODY', error instanceof Error ? error.message : '关系复核请求无效。'); }
}

export interface LearningImportRepositoryOptions {
  db: DatabaseSync;
  namespace: string;
  now?: () => Date;
}

/** Legacy v2 import SQL on a caller-owned connection and transaction. */
export class LearningImportRepository {
  private readonly db: DatabaseSync;
  private readonly namespace: string;
  private readonly now: () => Date;

  constructor(options: LearningImportRepositoryOptions) {
    try {
      if (inspectLearningSchema(options.db).kind !== 'current-v2') {
        throw new StoreError('LEARNING_SCHEMA_UNSUPPORTED_VERSION', '导入仓库仅支持已初始化的 v2 学习数据库。', 503);
      }
    } catch (error) {
      if (error instanceof LearningSchemaError) throw new StoreError(error.code, error.message, 503);
      throw error;
    }
    this.db = options.db;
    this.namespace = options.namespace;
    this.now = options.now ?? (() => new Date());
  }

  private requireTransaction(): void {
    if (!this.db.isTransaction) throw new StoreError('IMPORT_TRANSACTION_REQUIRED', '导入写入需要调用方持有事务。', 503);
  }

  /** The caller must replan under BEGIN IMMEDIATE and handle commit/rollback. */
  applyPreparedImport(prepared: PreparedImport, options: ImportOptions): void {
    this.requireTransaction();
    const validObservation = (event: Observation): boolean => !!event && typeof event.answer === 'string'
      && !Object.prototype.hasOwnProperty.call(event, 'answerClearing');
    if (!prepared || prepared.normalized?.schemaVersion !== 2 || prepared.preview?.canImport !== true
        || prepared.preview.sourceId !== this.namespace
        || !Array.isArray(prepared.normalized.observations) || !Array.isArray(prepared.newObservations)
        || !prepared.normalized.observations.every(validObservation) || !prepared.newObservations.every(validObservation)) {
      throw new StoreError('IMPORT_INVALID_DATA', '导入计划与当前 v2 知识空间不兼容。');
    }
    for (const config of prepared.newConfigs) this.insertImportedConfig(config);
    this.mergeImportedConcepts(prepared.metadataConcepts);
    for (const anchor of prepared.newAnchors) {
      const requestForAnchor = prepared.anchorRequests[anchor.eventId] ?? {
        eventId: anchor.eventId,
        conceptId: anchor.conceptId,
        sourceRevision: anchor.sourceRevision,
        kind: anchor.kind,
        occurredAt: anchor.occurredAt,
      };
      this.insertImportedAnchor(anchor, requestForAnchor);
    }
    for (const observation of prepared.newObservations) this.insertImportedObservation(observation);
    for (const revision of prepared.newObservationRevisions) this.insertImportedObservationRevision(revision);
    for (const retention of prepared.newRetentions) this.insertImportedRetention(retention);
    for (const application of prepared.newApplications) this.insertImportedApplication(application);
    for (const review of prepared.newRelationReviews) this.insertImportedRelationReview(review);
    for (const correction of prepared.newCorrections) this.insertImportedCorrection(correction);
    // Practice history remains separate from Observation-based aggregates.
    for (const card of prepared.newPracticeCards) this.insertImportedPracticeCard(card);
    for (const attempt of prepared.newPracticeAttempts) this.insertImportedPracticeAttempt(attempt);
    if (options.restoreLayout && prepared.mergedLayout) this.writeImportedLayout(prepared.mergedLayout);
    if (options.restoreReviewPlan && prepared.mergedReviewPlan) this.writeImportedReviewPlan(prepared.mergedReviewPlan);
  }

  findEvent(eventId: string): { kind: 'anchor' | 'observation' | 'retention' | 'application' | 'correction' | 'relation-review' | 'observation-revision' | PracticeEventKind; payload: string } | null {
    const revision = this.db.prepare('SELECT request_payload FROM main.observation_revisions WHERE namespace = ? AND event_id = ?').get(this.namespace, eventId) as { request_payload: string } | undefined;
    if (revision) return { kind: 'observation-revision', payload: revision.request_payload };
    const anchor = this.db.prepare('SELECT request_payload FROM main.anchors WHERE namespace = ? AND event_id = ?').get(this.namespace, eventId) as { request_payload: string } | undefined;
    if (anchor) return { kind: 'anchor', payload: anchor.request_payload };
    const observation = this.db.prepare('SELECT request_payload FROM main.observations WHERE namespace = ? AND event_id = ?').get(this.namespace, eventId) as { request_payload: string } | undefined;
    if (observation) return { kind: 'observation', payload: observation.request_payload };
    const retention = this.db.prepare('SELECT request_payload FROM main.retentions WHERE namespace = ? AND event_id = ?').get(this.namespace, eventId) as { request_payload: string } | undefined;
    if (retention) return { kind: 'retention', payload: retention.request_payload };
    const application = this.db.prepare('SELECT request_payload FROM main.applications WHERE namespace = ? AND event_id = ?').get(this.namespace, eventId) as { request_payload: string } | undefined;
    if (application) return { kind: 'application', payload: application.request_payload };
    const correction = this.db.prepare('SELECT request_payload FROM main.corrections WHERE namespace = ? AND event_id = ?').get(this.namespace, eventId) as { request_payload: string } | undefined;
    if (correction) return { kind: 'correction', payload: correction.request_payload };
    const relationReview = this.db.prepare('SELECT request_payload FROM main.relation_reviews WHERE namespace = ? AND event_id = ?').get(this.namespace, eventId) as { request_payload: string } | undefined;
    if (relationReview) return { kind: 'relation-review', payload: relationReview.request_payload };
    const card = this.db.prepare('SELECT request_payload FROM main.practice_cards WHERE namespace = ? AND event_id = ?').get(this.namespace, eventId) as { request_payload: string } | undefined;
    if (card) return { kind: 'practice-card', payload: card.request_payload };
    const attempt = this.db.prepare('SELECT request_payload FROM main.practice_attempts WHERE namespace = ? AND event_id = ?').get(this.namespace, eventId) as { request_payload: string } | undefined;
    return attempt ? { kind: 'practice-attempt', payload: attempt.request_payload } : null;
  }

  getConfigAt(revision: number): ModelConfig | null {
    const row = this.db.prepare('SELECT model_version, revision, half_life_days FROM main.config_history WHERE namespace = ? AND revision = ?').get(this.namespace, revision) as { model_version: string; revision: number; half_life_days: number } | undefined;
    return row ? { modelVersion: MODEL_VERSION, halfLifeDays: row.half_life_days, revision: row.revision } : null;
  }

  getRetention(conceptId: string, asOf?: string): RetentionEvent | null {
    const constraint = asOf ? ' AND occurred_at <= ?' : '';
    const parameters = asOf ? [this.namespace, conceptId, normalizeDate(asOf)] : [this.namespace, conceptId];
    const row = this.db.prepare(`SELECT event_id, concept_id, source_revision, occurred_at, recorded_at,
      active, previous_event_id
      FROM main.retentions WHERE namespace = ? AND concept_id = ?${constraint}
      ORDER BY rowid DESC LIMIT 1`).get(...parameters) as {
        event_id: string; concept_id: string; source_revision: string; occurred_at: string; recorded_at: string;
        active: number; previous_event_id: string | null;
      } | undefined;
    return row ? {
      eventId: row.event_id,
      conceptId: row.concept_id,
      sourceRevision: row.source_revision,
      occurredAt: row.occurred_at,
      recordedAt: row.recorded_at,
      active: Boolean(row.active),
      previousEventId: row.previous_event_id,
    } : null;
  }

  latestPracticeCardRow(cardId: string): {
    event_id: string;
    card_id: string;
    previous_event_id: string | null;
    occurred_at: string;
    recorded_at: string;
    kind: 'detail' | 'comparison' | 'scenario';
    title: string;
    prompt: string;
    reference_answer: string;
    reference_notes: string;
    sources_json: string;
    source_checked: number;
    scenario_json: string | null;
    paused: number;
  } | undefined {
    return this.db.prepare(`SELECT event_id, card_id, previous_event_id, occurred_at, recorded_at,
      kind, title, prompt, reference_answer, reference_notes, sources_json, source_checked, scenario_json, paused
      FROM main.practice_cards WHERE namespace = ? AND card_id = ?
      ORDER BY rowid DESC LIMIT 1`).get(this.namespace, cardId) as {
        event_id: string;
        card_id: string;
        previous_event_id: string | null;
        occurred_at: string;
        recorded_at: string;
        kind: 'detail' | 'comparison' | 'scenario';
        title: string;
        prompt: string;
        reference_answer: string;
        reference_notes: string;
        sources_json: string;
        source_checked: number;
        scenario_json: string | null;
        paused: number;
      } | undefined;
  }

  correctionTail(applicationEventId: string): CorrectionEvent | null {
    const rows = this.db.prepare(`
      SELECT c.event_id, c.application_event_id, c.concept_id, c.source_revision,
        c.occurred_at, c.recorded_at, c.previous_event_id, c.status, c.note
      FROM main.corrections AS c
      WHERE c.namespace = ? AND c.application_event_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM main.corrections AS child
          WHERE child.namespace = c.namespace
            AND child.application_event_id = c.application_event_id
            AND child.previous_event_id = c.event_id
        )
    `).all(this.namespace, applicationEventId) as Array<{
      event_id: string;
      application_event_id: string;
      concept_id: string;
      source_revision: string;
      occurred_at: string;
      recorded_at: string;
      previous_event_id: string | null;
      status: CorrectionStatus;
      note: string;
    }>;
    if (rows.length > 1) {
      throw new StoreError('CORRECTION_CONFLICT', '修正历史链出现多个当前尾节点，无法安全追加。', 409);
    }
    return rows.length === 1 ? correctionFromRow(rows[0]) : null;
  }

  relationReviewTail(applicationEventId: string): RelationReviewEvent | null {
    const rows = this.db.prepare(`
      SELECT c.event_id, c.application_event_id, c.concept_id, c.basis_json,
        c.occurred_at, c.recorded_at, c.previous_event_id, c.status, c.note
      FROM main.relation_reviews AS c
      WHERE c.namespace = ? AND c.application_event_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM main.relation_reviews AS child
          WHERE child.namespace = c.namespace
            AND child.application_event_id = c.application_event_id
            AND child.previous_event_id = c.event_id
        )
    `).all(this.namespace, applicationEventId) as Array<{
      event_id: string;
      application_event_id: string;
      concept_id: string;
      basis_json: string;
      occurred_at: string;
      recorded_at: string;
      previous_event_id: string | null;
      status: RelationReviewStatus;
      note: string;
    }>;
    if (rows.length > 1) {
      throw new StoreError('RELATION_REVIEW_CONFLICT', '关系复核历史链出现多个当前尾节点，无法安全追加。', 409);
    }
    return rows.length === 1 ? relationReviewFromRow(rows[0]) : null;
  }

  private ensureEventId(eventId: string): void {
    if (!EVENT_ID_PATTERN.test(eventId)) throw new StoreError('INVALID_EVENT_ID', 'eventId 只能包含字母、数字、点、下划线、冒号或短横线，长度不超过 128。');
  }

  private importEventConflict(eventId: string): never {
    throw new StoreError('IMPORT_CONFLICT', `导入事件 ${eventId} 与当前知识空间中的记录不一致。`, 409);
  }

  private eventAlreadyImported(eventId: string, kind: 'anchor' | 'observation' | 'retention' | 'application' | 'correction' | 'relation-review' | PracticeEventKind, requestPayload: string): boolean {
    const existing = this.findEvent(eventId);
    if (!existing) return false;
    if (existing.kind !== kind || existing.payload !== requestPayload) this.importEventConflict(eventId);
    return true;
  }

  private insertImportedConfig(config: PreparedConfig): void {
    if (!Number.isSafeInteger(config.revision) || config.revision < 1
        || !finiteNumber(config.halfLifeDays) || typeof config.modelVersion !== 'string'
        || !isValidInstant(config.recordedAt)) {
      throw new StoreError('IMPORT_INVALID_DATA', '导入配置历史包含无效字段。');
    }
    const existing = this.db.prepare(`SELECT model_version, half_life_days, recorded_at
      FROM main.config_history WHERE namespace = ? AND revision = ?`).get(this.namespace, config.revision) as {
        model_version: string; half_life_days: number; recorded_at: string;
      } | undefined;
    if (existing) {
      if (existing.model_version !== config.modelVersion || existing.half_life_days !== config.halfLifeDays) {
        throw new StoreError('IMPORT_CONFLICT', `配置 revision ${config.revision} 与当前知识空间内容不一致。`, 409);
      }
      return;
    }
    this.db.prepare(`INSERT INTO main.config_history(namespace, revision, model_version, half_life_days, recorded_at)
      VALUES (?, ?, ?, ?, ?)`).run(this.namespace, config.revision, config.modelVersion, config.halfLifeDays, config.recordedAt);
  }

  private insertImportedAnchor(event: AnchorEvent, request: ReviewRequest): void {
    this.ensureEventId(event.eventId);
    if (request.eventId !== event.eventId || request.conceptId !== event.conceptId
        || request.sourceRevision !== event.sourceRevision || request.kind !== event.kind
        || (request.kind === 'estimated' && request.occurredAt === undefined)) {
      throw new StoreError('IMPORT_INVALID_DATA', `anchor ${event.eventId} 的原始请求与事件不一致。`);
    }
    const requestPayload = canonicalJson(request);
    if (this.eventAlreadyImported(event.eventId, 'anchor', requestPayload)) return;
    if (!isValidInstant(event.occurredAt) || !isValidInstant(event.recordedAt)) {
      throw new StoreError('IMPORT_INVALID_DATA', `anchor ${event.eventId} 的时间字段无效。`);
    }
    this.db.prepare(`INSERT INTO main.anchors(namespace, event_id, concept_id, source_revision, occurred_at, recorded_at, kind, request_payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      this.namespace, event.eventId, event.conceptId, event.sourceRevision,
      event.occurredAt, event.recordedAt, event.kind, requestPayload,
    );
  }

  private observationRequestPayload(event: Observation): string {
    const request = {
      eventId: event.eventId,
      conceptId: event.conceptId,
      sourceRevision: event.sourceRevision,
      observedAt: event.observedAt,
      configRevision: event.configRevision,
      anchorEventId: event.anchorEventId,
      answer: event.answer,
      rating: event.rating,
      exposure: event.exposure,
      observedExposure: event.observedExposure,
      ...(event.learning ? { learning: event.learning } : {}),
      ...(event.evidenceMode !== undefined ? { evidenceMode: normalizeObservationEvidenceMode(event.evidenceMode, event.answer) } : {}),
    };
    return canonicalJson(request);
  }

  private insertImportedObservationRevision(event: ObservationRevision): void {
    // Already replanned under this transaction's write lock. Preserve imported receipts.
    const { conceptId: _concept, sourceRevision: _source, recordedAt: _receipt, ...fields } = event;
    const request = parseObservationRevisionRequest(fields);
    if (this.findEvent(event.eventId)) this.importEventConflict(event.eventId);
    this.db.prepare(`INSERT INTO main.observation_revisions(namespace,event_id,observation_event_id,previous_event_id,concept_id,source_revision,
      occurred_at,recorded_at,action,reason,note,assessment_json,request_payload) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      this.namespace, event.eventId, event.observationEventId, event.previousEventId, event.conceptId, event.sourceRevision,
      event.occurredAt, event.recordedAt, event.action, event.reason, event.note ?? null,
      event.action === 'revise' ? JSON.stringify(event.assessment) : null, JSON.stringify(request));
  }

  private insertImportedObservation(event: Observation): void {
    this.ensureEventId(event.eventId);
    const requestPayload = this.observationRequestPayload(event);
    if (this.eventAlreadyImported(event.eventId, 'observation', requestPayload)) return;
    if (!isValidInstant(event.observedAt) || !isValidInstant(event.recordedAt)
        || !Number.isSafeInteger(event.configRevision) || !finiteNumber(event.halfLifeDays)
        || (event.elapsedDays !== null && !finiteNumber(event.elapsedDays))
        || (event.decay !== null && !finiteNumber(event.decay))) {
      throw new StoreError('IMPORT_INVALID_DATA', `observation ${event.eventId} 的字段无效。`);
    }
    if (!this.getConfigAt(event.configRevision)) {
      throw new StoreError('IMPORT_CONFLICT', `observation ${event.eventId} 引用的配置 revision 不存在。`, 409);
    }
    this.db.prepare(`INSERT INTO main.observations(
      namespace, event_id, concept_id, source_revision, observed_at, recorded_at,
      config_revision, half_life_days, anchor_event_id, elapsed_days, decay,
      answer, rating, exposure, observed_exposure, learning_json, evidence_mode, request_payload
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      this.namespace,
      event.eventId,
      event.conceptId,
      event.sourceRevision,
      event.observedAt,
      event.recordedAt,
      event.configRevision,
      event.halfLifeDays,
      event.anchorEventId,
      event.elapsedDays,
      event.decay,
      event.answer,
      event.rating,
      event.exposure,
      event.observedExposure ? 1 : 0,
      event.learning ? canonicalJson(event.learning) : null,
      event.evidenceMode ?? null,
      requestPayload,
    );
  }

  private insertImportedRetention(event: RetentionEvent): void {
    this.ensureEventId(event.eventId);
    const requestPayload = canonicalJson({
      eventId: event.eventId,
      conceptId: event.conceptId,
      sourceRevision: event.sourceRevision,
      occurredAt: event.occurredAt,
      active: event.active,
      previousEventId: event.previousEventId,
    });
    if (this.eventAlreadyImported(event.eventId, 'retention', requestPayload)) return;
    if (!isValidInstant(event.occurredAt) || !isValidInstant(event.recordedAt)) {
      throw new StoreError('IMPORT_INVALID_DATA', `retention ${event.eventId} 的时间字段无效。`);
    }
    const currentPreviousEventId = this.getRetention(event.conceptId)?.eventId ?? null;
    if (event.previousEventId !== currentPreviousEventId) {
      throw new StoreError('IMPORT_CONFLICT', `retention ${event.eventId} 的链式前置记录不匹配。`, 409);
    }
    this.db.prepare(`INSERT INTO main.retentions(
      namespace, event_id, concept_id, source_revision, occurred_at, recorded_at,
      active, previous_event_id, request_payload
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      this.namespace,
      event.eventId,
      event.conceptId,
      event.sourceRevision,
      event.occurredAt,
      event.recordedAt,
      event.active ? 1 : 0,
      event.previousEventId,
      requestPayload,
    );
  }

  private insertImportedApplication(event: ApplicationRecord): void {
    this.ensureEventId(event.eventId);
    const requestPayload = canonicalJson({
      eventId: event.eventId,
      conceptId: event.conceptId,
      sourceRevision: event.sourceRevision,
      occurredAt: event.occurredAt,
      kind: event.kind,
      context: event.context,
      content: event.content,
      outcome: event.outcome,
      assistance: event.assistance,
      result: event.result,
      limitations: event.limitations,
      insight: event.insight,
      correction: event.correction,
      references: event.references,
      ...(event.relationSuggestion === undefined ? {} : { relationSuggestion: parseRelationSuggestion(event.relationSuggestion, event) }),
    });
    if (this.eventAlreadyImported(event.eventId, 'application', requestPayload)) return;
    if (!isValidInstant(event.occurredAt) || !isValidInstant(event.recordedAt)) {
      throw new StoreError('IMPORT_INVALID_DATA', `application ${event.eventId} 的时间字段无效。`);
    }
    this.db.prepare(`INSERT INTO main.applications(
      namespace, event_id, concept_id, source_revision, occurred_at, recorded_at,
      kind, context, content, outcome, assistance, result, limitations,
      insight, correction, references_text, relation_suggestion_json, request_payload
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      this.namespace,
      event.eventId,
      event.conceptId,
      event.sourceRevision,
      event.occurredAt,
      event.recordedAt,
      event.kind,
      event.context,
      event.content,
      event.outcome,
      event.assistance,
      event.result,
      event.limitations,
      event.insight,
      event.correction,
      event.references,
      event.relationSuggestion ? canonicalJson(event.relationSuggestion) : null,
      requestPayload,
    );
  }

  private insertImportedCorrection(event: CorrectionEvent): void {
    this.ensureEventId(event.eventId);
    this.ensureEventId(event.applicationEventId);
    if (event.previousEventId !== null) this.ensureEventId(event.previousEventId);
    const requestPayload = correctionRequestPayload({
      eventId: event.eventId,
      applicationEventId: event.applicationEventId,
      conceptId: event.conceptId,
      sourceRevision: event.sourceRevision,
      occurredAt: event.occurredAt,
      previousEventId: event.previousEventId,
      status: event.status,
      note: event.note,
    });
    if (this.eventAlreadyImported(event.eventId, 'correction', requestPayload)) return;
    if (!isValidInstant(event.occurredAt) || !isValidInstant(event.recordedAt)
        || !isOneOf(CORRECTION_STATUSES, event.status)
        || typeof event.note !== 'string' || event.note.length > 4000) {
      throw new StoreError('IMPORT_INVALID_DATA', `correction ${event.eventId} 的字段无效。`);
    }
    const occurredAtMs = parseDate(event.occurredAt);
    const recordedAtMs = parseDate(event.recordedAt);
    if (recordedAtMs < occurredAtMs) {
      throw new StoreError('IMPORT_INVALID_DATA', `correction ${event.eventId} 的 recordedAt 早于 occurredAt。`);
    }
    const parent = this.db.prepare(`SELECT concept_id, source_revision, occurred_at, correction
      FROM main.applications WHERE namespace = ? AND event_id = ?`).get(this.namespace, event.applicationEventId) as {
        concept_id: string;
        source_revision: string;
        occurred_at: string;
        correction: string;
      } | undefined;
    if (!parent) throw new StoreError('IMPORT_CONFLICT', `correction ${event.eventId} 引用的应用记录不存在。`, 409);
    if (parent.concept_id !== event.conceptId) {
      throw new StoreError('IMPORT_CONFLICT', `correction ${event.eventId} 的 conceptId 与应用记录不一致。`, 409);
    }
    if (!parent.correction.trim()) {
      throw new StoreError('IMPORT_INVALID_DATA', `correction ${event.eventId} 引用的应用记录没有 correction 内容。`);
    }
    if (event.status === 'resolved' && event.sourceRevision === parent.source_revision) {
      throw new StoreError('IMPORT_CONFLICT', `correction ${event.eventId} 的 resolved sourceRevision 未发生变化。`, 409);
    }
    const tail = this.correctionTail(event.applicationEventId);
    if (event.previousEventId !== (tail?.eventId ?? null)) {
      throw new StoreError('IMPORT_CONFLICT', `correction ${event.eventId} 的链式前置记录不匹配。`, 409);
    }
    const lowerBound = tail ? parseDate(tail.occurredAt) : parseDate(parent.occurred_at);
    if (occurredAtMs < lowerBound) {
      throw new StoreError('IMPORT_INVALID_DATA', `correction ${event.eventId} 的 occurredAt 早于父记录或前置修正。`);
    }
    this.db.prepare(`INSERT INTO main.corrections(
      namespace, event_id, application_event_id, concept_id, source_revision,
      occurred_at, recorded_at, previous_event_id, status, note, request_payload
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      this.namespace,
      event.eventId,
      event.applicationEventId,
      event.conceptId,
      event.sourceRevision,
      event.occurredAt,
      event.recordedAt,
      event.previousEventId,
      event.status,
      event.note,
      requestPayload,
    );
  }

  private insertImportedRelationReview(event: RelationReviewEvent): void {
    const request = parseRelationReviewRequest({ eventId: event.eventId, applicationEventId: event.applicationEventId, conceptId: event.conceptId, occurredAt: event.occurredAt, previousEventId: event.previousEventId, status: event.status, note: event.note, basis: event.basis });
    const payload = relationReviewRequestPayload(request);
    if (this.eventAlreadyImported(event.eventId, 'relation-review', payload)) return;
    if (!isValidInstant(event.recordedAt) || parseDate(event.recordedAt) < parseDate(request.occurredAt)) throw new StoreError('IMPORT_INVALID_DATA', '关系复核记录时间无效。');
    const parent = this.db.prepare(`SELECT concept_id, source_revision, occurred_at, relation_suggestion_json
      FROM main.applications WHERE namespace = ? AND event_id = ?`).get(this.namespace, request.applicationEventId) as {
        concept_id: string; source_revision: string; occurred_at: string; relation_suggestion_json: string | null;
      } | undefined;
    if (!parent || parent.concept_id !== request.conceptId) throw new StoreError('IMPORT_CONFLICT', '关系复核父记录不存在或主概念不一致。', 409);
    if (!parent.relation_suggestion_json) throw new StoreError('IMPORT_INVALID_DATA', '关系复核父记录没有关系建议。');
    const suggestion = parseRelationSuggestion(JSON.parse(parent.relation_suggestion_json), { conceptId: parent.concept_id, sourceRevision: parent.source_revision });
    try { validateRelationReviewBasis(suggestion, request.basis); } catch (error) { throw new StoreError('IMPORT_INVALID_DATA', error instanceof Error ? error.message : '关系复核依据无效。'); }
    if (request.status === 'resolved' && !relationReviewMatches(suggestion, request.basis)) throw new StoreError('IMPORT_CONFLICT', '已采纳关系复核的历史依据不匹配。', 409);
    const tail = this.relationReviewTail(request.applicationEventId);
    if (request.previousEventId !== (tail?.eventId ?? null)) throw new StoreError('IMPORT_CONFLICT', '关系复核前置记录不匹配。', 409);
    if (parseDate(request.occurredAt) < parseDate(tail?.occurredAt ?? parent.occurred_at)) throw new StoreError('IMPORT_INVALID_DATA', '关系复核早于父记录或前置复核。');
    this.db.prepare(`INSERT INTO main.relation_reviews(namespace, event_id, application_event_id, concept_id, basis_json, occurred_at, recorded_at, previous_event_id, status, note, request_payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(this.namespace, request.eventId, request.applicationEventId, request.conceptId, canonicalJson(request.basis), request.occurredAt, event.recordedAt, request.previousEventId, request.status, request.note, payload);
  }

  private mergeImportedConcepts(concepts: Array<Pick<Concept, 'id' | 'title' | 'source'>>): void {
    for (const concept of concepts) {
      if (typeof concept.id !== 'string' || !concept.id.trim()
          || typeof concept.title !== 'string' || !concept.source
          || typeof concept.source.path !== 'string' || typeof concept.source.revision !== 'string') {
        throw new StoreError('IMPORT_INVALID_DATA', '导入概念 manifest 包含无效字段。');
      }
      this.db.prepare(`INSERT INTO main.imported_concepts(namespace, concept_id, title, source_path, source_revision)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(namespace, concept_id) DO UPDATE SET
          title = excluded.title,
          source_path = excluded.source_path,
          source_revision = excluded.source_revision`).run(
        this.namespace, concept.id, concept.title, concept.source.path, concept.source.revision,
      );
    }
  }

  private writeImportedLayout(layout: Layout): void {
    this.db.prepare(`INSERT INTO main.layouts(namespace, layout_json, recorded_at) VALUES (?, ?, ?)
      ON CONFLICT(namespace) DO UPDATE SET layout_json = excluded.layout_json, recorded_at = excluded.recorded_at`).run(
      this.namespace, canonicalJson(layout), iso(this.now()),
    );
  }

  private writeImportedReviewPlan(plan: import('../shared/review-plan.js').ReviewPlan): void {
    this.db.prepare(`INSERT INTO main.review_plans(namespace, revision, daily_budget, concepts_json, recorded_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(namespace) DO UPDATE SET
        revision = excluded.revision,
        daily_budget = excluded.daily_budget,
        concepts_json = excluded.concepts_json,
        recorded_at = excluded.recorded_at`).run(
      this.namespace,
      plan.revision,
      plan.dailyBudget,
      canonicalJson(plan.concepts),
      iso(this.now()),
    );
  }

  insertImportedPracticeCard(event: PracticeCardEvent): void {
    this.requireTransaction();
    const request = parsePracticeCardRequest(event);
    this.ensureEventId(request.eventId);
    const recordedAt = normalizeDate(event.recordedAt, 'IMPORT_INVALID_DATA');
    if (parseDate(recordedAt) < parseDate(request.occurredAt)) {
      throw new StoreError('IMPORT_INVALID_DATA', `practice card ${event.eventId} 的 recordedAt 早于 occurredAt。`);
    }
    const requestPayload = canonicalJson(request);
    if (this.eventAlreadyImported(event.eventId, 'practice-card', requestPayload)) return;
    const tail = this.latestPracticeCardRow(request.cardId);
    if (request.previousEventId === null) {
      if (tail) throw new StoreError('IMPORT_CONFLICT', `practice card ${event.eventId} 的 cardId 已有尾记录。`, 409);
    } else if (!tail || tail.event_id !== request.previousEventId) {
      throw new StoreError('IMPORT_CONFLICT', `practice card ${event.eventId} 的链式前置记录不匹配。`, 409);
    } else if (parseDate(request.occurredAt) < parseDate(tail.occurred_at)) {
      throw new StoreError('IMPORT_INVALID_DATA', `practice card ${event.eventId} 的 occurredAt 早于前置记录。`);
    }
    this.db.prepare(`INSERT INTO main.practice_cards(
      namespace, event_id, card_id, previous_event_id, occurred_at, recorded_at,
      kind, title, prompt, reference_answer, reference_notes, sources_json,
      source_checked, scenario_json, paused, request_payload
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      this.namespace,
      request.eventId,
      request.cardId,
      request.previousEventId,
      request.occurredAt,
      recordedAt,
      request.kind,
      request.title,
      request.prompt,
      request.referenceAnswer,
      request.referenceNotes,
      canonicalJson(request.sources),
      1,
      request.scenario ? canonicalJson(request.scenario) : null,
      request.paused ? 1 : 0,
      requestPayload,
    );
    for (const source of request.sources) {
      this.db.prepare(`INSERT INTO main.practice_card_sources(
        namespace, card_event_id, card_id, concept_id, source_revision
      ) VALUES (?, ?, ?, ?, ?)`).run(
        this.namespace, request.eventId, request.cardId, source.conceptId, source.sourceRevision,
      );
    }
  }

  insertImportedPracticeAttempt(event: PracticeAttempt): void {
    this.requireTransaction();
    const request = parsePracticeAttemptRequest(event);
    this.ensureEventId(request.eventId);
    const recordedAt = normalizeDate(event.recordedAt, 'IMPORT_INVALID_DATA');
    if (parseDate(recordedAt) < parseDate(request.answeredAt)) {
      throw new StoreError('IMPORT_INVALID_DATA', `practice attempt ${event.eventId} 的 recordedAt 早于 answeredAt。`);
    }
    const requestPayload = canonicalJson(request);
    if (this.eventAlreadyImported(event.eventId, 'practice-attempt', requestPayload)) return;
    const cardRow = this.db.prepare(`SELECT event_id, card_id, previous_event_id, occurred_at, recorded_at,
      kind, title, prompt, reference_answer, reference_notes, sources_json, source_checked, scenario_json, paused
      FROM main.practice_cards WHERE namespace = ? AND event_id = ?`).get(this.namespace, request.cardEventId) as {
        event_id: string;
        card_id: string;
        previous_event_id: string | null;
        occurred_at: string;
        recorded_at: string;
        kind: 'detail' | 'comparison' | 'scenario';
        title: string;
        prompt: string;
        reference_answer: string;
        reference_notes: string;
        sources_json: string;
        source_checked: number;
        scenario_json: string | null;
        paused: number;
      } | undefined;
    if (!cardRow) throw new StoreError('IMPORT_CONFLICT', `practice attempt ${event.eventId} 引用的练习卡版本不存在。`, 409);
    if (cardRow.card_id !== request.cardId) throw new StoreError('IMPORT_INVALID_DATA', `practice attempt ${event.eventId} 的 cardId 与卡片版本不一致。`);
    if (parseDate(request.answeredAt) < parseDate(cardRow.occurred_at)) {
      throw new StoreError('IMPORT_INVALID_DATA', `practice attempt ${event.eventId} 的 answeredAt 早于卡片发生时间。`);
    }
    const card = practiceCardFromRow(cardRow);
    assertPracticeScenarioContract(card, request, recordedAt);
    this.db.prepare(`INSERT INTO main.practice_attempts(
      namespace, event_id, card_id, card_event_id, answered_at, recorded_at,
      answer, confidence, confidence_at, exposure, observed_exposure, cue, outcome,
      check_notes, scenario_json, request_payload
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      this.namespace,
      request.eventId,
      request.cardId,
      request.cardEventId,
      request.answeredAt,
      recordedAt,
      request.answer,
      request.confidence,
      request.confidenceAt,
      request.exposure,
      request.observedExposure ? 1 : 0,
      request.cue,
      request.outcome,
      request.checkNotes,
      request.scenario ? canonicalJson(request.scenario) : null,
      requestPayload,
    );
  }
}
