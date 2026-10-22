import { createHash } from 'node:crypto';
import { ActivityStore } from './activity-store.js';
import { LearningSnapshotRepository } from './learning-snapshot-repository.js';
import { LearningImportRepository } from './learning-import-repository.js';
import {
  asRecord, isOneOf, normalizeLearningEvidence, parseStoredLearning, practiceAttemptFromRow, parseReviewPlanRow,
  canonicalJson, parseDate, normalizeDate, finiteNumber, normalizeObservationEvidenceMode,
  parseStoredPracticeScenario, assertPracticeScenarioContract, practiceCardFromRow,
  correctionRequestPayload, correctionFromRow, relationReviewRequestPayload, relationReviewFromRow,
} from './store-codecs.js';
import { StoreError } from './store-error.js';
export { StoreError } from './store-error.js';
import { inspectLearningSchema, initializeLearningSchemaV2 } from './learning-schema.js';
import { ObservationRevisionStore, ObservationRevisionStoreError } from './observation-revision-store.js';
import { projectObservationAssessments } from '../core/observation-revisions.js';
import type { ObservationRevision } from '../shared/observation-revisions.js';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  AnchorEvent,
  ApplicationRecord,
  ApplicationRecordRequest,
  Concept,
  ConceptHistory,
  ConceptHistoryEntry,
  ConfigWriteReceipt,
  ExportData,
  ExportDataV2,
  LearningEvidence,
  Layout,
  MemoryState,
  ModelConfig,
  Observation,
  ObservationRequest,
  RecallRating,
  RetentionEvent,
  RetentionRequest,
  ReviewRequest,
} from '../shared/types.js';
import type {
  IdentityBinding,
  IdentityConcept,
  IdentityLinkCommit,
  IdentityLinkPreview,
  IdentityLinkRequest,
  IdentityStatus,
} from '../shared/identity.js';
import type {
  CorrectionEvent,
  CorrectionHistory,
  CorrectionRequest,
  CorrectionStatus,
} from '../shared/corrections.js';
import type {
  PracticeAttempt,
  PracticeAttemptRequest,
  PracticeCardEvent,
  PracticeCardRequest,
  PracticeData,
  PracticeScenarioAttempt,
  PracticeSource,
} from '../shared/practice.js';
import {
  DEFAULT_IMPORT_OPTIONS,
  type ImportCommitRequest,
  type ImportCounts,
  type ImportOptions,
  type ImportPreview,
  type ImportReceipt,
} from '../shared/import-data.js';
import {
  DEFAULT_DAILY_REVIEW_BUDGET,
  MAX_DAILY_REVIEW_BUDGET,
  MIN_DAILY_REVIEW_BUDGET,
  reviewDayKey,
  type ConceptReviewPreference,
  type ReviewPlan,
  type ReviewPlanUpdate,
} from '../shared/review-plan.js';
import { DAY_MS, MODEL_VERSION } from '../shared/types.js';
import { decayAt, isValidInstant, projectMemory } from '../core/time-model.js';
import { summarizeLearning } from '../core/learning-evidence.js';
import { buildLearningOverview } from '../core/learning-overview.js';
import type { GraphLink } from '../shared/types.js';
import { buildLearningProgress } from '../core/learning-progress.js';
import { buildScenarioPromptPage, type ScenarioPromptCursor } from '../core/scenario-prompts.js';
import { buildImportPlan, type PreparedImport } from './import-plan.js';
import { parsePracticeAttemptRequest, parsePracticeCardRequest } from './practice-validation.js';
import { parseRelationReviewRequest as parseSharedRelationReviewRequest, validateRelationReviewBasis, relationReviewMatches, type RelationReviewRequest, type RelationReviewEvent, type RelationReviewHistory, type RelationReviewStatus } from '../shared/relation-reviews.js';
import { parseRelationSuggestion } from '../shared/relation-suggestions.js';

const DEFAULT_HALF_LIFE_DAYS = 7;
const IDENTITY_DEFAULT_PREFERENCE: ConceptReviewPreference = { focus: false, deferUntil: null };

export interface StoreOptions {
  dataDir?: string;
  dbPath?: string;
  namespace: string;
  now?: () => Date;
}

export interface StoredObservation extends Observation {
  requestPayload?: string;
}

export interface StoredAnchor extends AnchorEvent {
  requestPayload?: string;
}

export type StoreWriteResult = { status: 'accepted' | 'duplicate'; eventId: string };

type PracticeEventKind = 'practice-card' | 'practice-attempt';

interface ConceptHistoryCursor {
  namespace: string;
  conceptId: string;
  eventAt: string;
  recordedAt: string;
  eventId: string;
}

/** Read-only startup gate; call before source registration or credential rotation. */
export function assertLearningDatabaseReady(dbPath: string): void {
  if (!existsSync(dbPath)) return;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const schema = inspectLearningSchema(db);
    if (schema.kind === 'legacy-v1') throw new StoreError('LEARNING_SCHEMA_UPGRADE_REQUIRED', '请先离线备份并恢复到新目录，完成学习数据库升级。', 503);
  } finally { db.close(); }
}

function sameCanonicalJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function iso(value: Date): string {
  return value.toISOString();
}

function computeDecay(anchorAt: string | null, halfLifeDays: number, asOf: string): { elapsedDays: number | null; decay: number | null } {
  if (!anchorAt) return { elapsedDays: null, decay: null };
  const elapsedDays = (parseDate(asOf) - parseDate(anchorAt)) / DAY_MS;
  return { elapsedDays, decay: decayAt(elapsedDays, halfLifeDays) };
}


function normalizeImportOptions(value: unknown): ImportOptions {
  if (value === undefined) return { ...DEFAULT_IMPORT_OPTIONS };
  const record = asRecord(value);
  if (typeof record.restoreLayout !== 'boolean' || typeof record.restoreReviewPlan !== 'boolean') {
    throw new StoreError('INVALID_BODY', '导入 options 必须包含 restoreLayout 和 restoreReviewPlan 布尔值。');
  }
  return {
    restoreLayout: record.restoreLayout,
    restoreReviewPlan: record.restoreReviewPlan,
  };
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || !value.trim()) throw new StoreError('INVALID_BODY', `缺少有效字段：${key}。`);
  return value.trim();
}

function requireFinite(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (!finiteNumber(value)) throw new StoreError('INVALID_BODY', `字段 ${key} 必须是有限数字。`);
  return value;
}



const APPLICATION_KINDS = ['application', 'summary'] as const;
const APPLICATION_OUTCOMES = ['success', 'partial', 'failure', 'unverified'] as const;
const APPLICATION_ASSISTANCE = ['independent', 'resources', 'people-or-ai', 'mixed', 'unknown'] as const;
const CORRECTION_STATUSES = ['resolved', 'dismissed', 'open'] as const;
const EVENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;


function correctionText(record: Record<string, unknown>): string {
  const value = record.note;
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > 4000) {
    throw new StoreError('INVALID_BODY', '字段 note 必须是不超过 4000 个字符的字符串。');
  }
  return value;
}

function correctionEventId(value: string, label: string): string {
  if (!EVENT_ID_PATTERN.test(value)) {
    throw new StoreError('INVALID_EVENT_ID', `${label} 格式无效。`);
  }
  return value;
}

function normalizeCorrectionRequest(value: unknown): CorrectionRequest {
  const record = asRecord(value);
  const eventId = correctionEventId(requireString(record, 'eventId'), 'eventId');
  const applicationEventId = correctionEventId(requireString(record, 'applicationEventId'), 'applicationEventId');
  const previousRaw = record.previousEventId;
  if (previousRaw !== null && (typeof previousRaw !== 'string' || !previousRaw.trim())) {
    throw new StoreError('INVALID_BODY', 'previousEventId 必须是非空事件 ID 或 null。');
  }
  const previousEventId = previousRaw === null
    ? null
    : correctionEventId((previousRaw as string).trim(), 'previousEventId');
  const status = requireString(record, 'status');
  if (!isOneOf(CORRECTION_STATUSES, status)) {
    throw new StoreError('INVALID_BODY', 'status 必须是 resolved、dismissed 或 open。');
  }
  return {
    eventId,
    applicationEventId,
    conceptId: requireString(record, 'conceptId'),
    sourceRevision: requireString(record, 'sourceRevision'),
    occurredAt: normalizeDate(requireString(record, 'occurredAt'), 'INVALID_OCCURRED_AT'),
    previousEventId,
    status,
    note: correctionText(record),
  };
}

function applicationText(record: Record<string, unknown>, key: string, limit: number, required: boolean): string {
  const value = record[key];
  if (value === undefined && !required) return '';
  if (typeof value !== 'string') throw new StoreError('INVALID_BODY', `字段 ${key} 必须是字符串。`);
  if (value.length > limit) throw new StoreError('INVALID_BODY', `字段 ${key} 不能超过 ${limit} 个字符。`);
  if (required && !value.trim()) throw new StoreError('INVALID_BODY', `字段 ${key} 不能为空。`);
  return value;
}

function normalizeApplicationRequest(value: unknown): ApplicationRecordRequest {
  const record = asRecord(value);
  const kind = requireString(record, 'kind');
  if (!isOneOf(APPLICATION_KINDS, kind)) throw new StoreError('INVALID_BODY', 'kind 必须是 application 或 summary。');
  const outcome = requireString(record, 'outcome');
  if (!isOneOf(APPLICATION_OUTCOMES, outcome)) throw new StoreError('INVALID_BODY', 'outcome 必须是 success、partial、failure 或 unverified。');
  const assistance = requireString(record, 'assistance');
  if (!isOneOf(APPLICATION_ASSISTANCE, assistance)) throw new StoreError('INVALID_BODY', 'assistance 必须是 independent、resources、people-or-ai、mixed 或 unknown。');
  const context = applicationText(record, 'context', 4000, kind === 'application');
  const parent = { conceptId: requireString(record, 'conceptId'), sourceRevision: requireString(record, 'sourceRevision') };
  let relationSuggestion: ApplicationRecordRequest['relationSuggestion'];
  if (record.relationSuggestion !== undefined) {
    try { relationSuggestion = parseRelationSuggestion(record.relationSuggestion, parent); }
    catch (error) { throw new StoreError('INVALID_BODY', error instanceof Error ? error.message : '关系建议无效。'); }
  }
  return {
    eventId: requireString(record, 'eventId'),
    conceptId: requireString(record, 'conceptId'),
    sourceRevision: requireString(record, 'sourceRevision'),
    occurredAt: normalizeDate(requireString(record, 'occurredAt'), 'INVALID_OCCURRED_AT'),
    kind,
    context,
    content: applicationText(record, 'content', 12000, true),
    outcome,
    assistance,
    result: applicationText(record, 'result', 4000, false),
    limitations: applicationText(record, 'limitations', 4000, false),
    insight: applicationText(record, 'insight', 4000, false),
    correction: applicationText(record, 'correction', 4000, false),
    references: applicationText(record, 'references', 4000, false),
    ...(relationSuggestion === undefined ? {} : { relationSuggestion }),
  };
}

/**
 * Validate and normalize optional evidence attached to an observation. Keeping
 * this at the request boundary means old observations can remain NULL in the
 * additive JSON column, while every new record has one deterministic shape for
 * idempotency and export.
 */



function safeSqliteMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (/UNIQUE|constraint/i.test(message)) return '数据已存在或与已有事件冲突。';
  return '本地学习记录暂时无法保存，请稍后重试。';
}

function identityId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 512) {
    throw new StoreError('INVALID_IDENTITY', `${label} 必须是长度不超过 512 的非空字符串。`);
  }
  return value.trim();
}

function identityPath(value: unknown, label: string, nullable = false): string | null {
  if (value === null && nullable) return null;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 4096) {
    throw new StoreError('INVALID_IDENTITY', `${label} 必须是长度不超过 4096 的非空路径。`);
  }
  return value.trim();
}

function isDefaultReviewPreference(value: ConceptReviewPreference | null): boolean {
  return value === null || (value.focus === IDENTITY_DEFAULT_PREFERENCE.focus && value.deferUntil === IDENTITY_DEFAULT_PREFERENCE.deferUntil);
}

function emptyIdentityConcept(conceptId: string, title = ''): IdentityConcept {
  return {
    conceptId,
    title,
    path: null,
    sourceRevision: null,
    counts: { anchors: 0, observations: 0, retentions: 0, applications: 0 },
    hasLayout: false,
    preference: null,
  };
}

function validateReviewBudget(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < MIN_DAILY_REVIEW_BUDGET || (value as number) > MAX_DAILY_REVIEW_BUDGET) {
    throw new StoreError('INVALID_REVIEW_BUDGET', `dailyBudget 必须是 ${MIN_DAILY_REVIEW_BUDGET} 到 ${MAX_DAILY_REVIEW_BUDGET} 的整数。`);
  }
  return value as number;
}

function normalizeReviewPlanConcept(value: unknown, now: Date): { conceptId: string; preference: ConceptReviewPreference } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new StoreError('INVALID_BODY', 'concept 必须是对象。');
  }
  const record = value as Record<string, unknown>;
  const conceptId = record.conceptId;
  const sourceRevision = record.sourceRevision;
  if (typeof conceptId !== 'string' || !conceptId.trim() || conceptId.length > 512
      || typeof sourceRevision !== 'string' || !sourceRevision.trim() || sourceRevision.length > 512) {
    throw new StoreError('INVALID_BODY', 'conceptId 和 sourceRevision 必须是有效字符串。');
  }
  if (typeof record.focus !== 'boolean') {
    throw new StoreError('INVALID_BODY', 'focus 必须是布尔值。');
  }
  const rawDeferUntil = record.deferUntil;
  if (rawDeferUntil !== null && typeof rawDeferUntil !== 'string') {
    throw new StoreError('INVALID_DEFER_UNTIL', 'deferUntil 必须是 null 或有效的未来 ISO 8601 时间。');
  }
  let deferUntil: string | null = null;
  if (typeof rawDeferUntil === 'string') {
    if (!isValidInstant(rawDeferUntil)) {
      throw new StoreError('INVALID_DEFER_UNTIL', 'deferUntil 必须是 null 或有效的未来 ISO 8601 时间。');
    }
    const deferMs = parseDate(rawDeferUntil, 'INVALID_DEFER_UNTIL');
    const nowMs = now.getTime();
    if (deferMs <= nowMs || deferMs > nowMs + 366 * DAY_MS) {
      throw new StoreError('INVALID_DEFER_UNTIL', 'deferUntil 必须是未来 366 天以内的时间。');
    }
    deferUntil = new Date(deferMs).toISOString();
  }
  return { conceptId: conceptId.trim(), preference: { focus: record.focus, deferUntil } };
}

function invalidHistoryCursor(): never {
  throw new StoreError('INVALID_HISTORY_CURSOR', '历史分页游标无效，请重新读取历史。');
}

function encodeHistoryCursor(cursor: ConceptHistoryCursor): string {
  return Buffer.from(JSON.stringify({
    version: 1,
    namespace: cursor.namespace,
    conceptId: cursor.conceptId,
    eventAt: cursor.eventAt,
    recordedAt: cursor.recordedAt,
    eventId: cursor.eventId,
  }), 'utf8').toString('base64url');
}

function decodeHistoryCursor(value: string): ConceptHistoryCursor {
  if (!/^[A-Za-z0-9_-]{1,2048}$/.test(value)) invalidHistoryCursor();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    invalidHistoryCursor();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) invalidHistoryCursor();
  const record = parsed as Record<string, unknown>;
  if (record.version !== 1) invalidHistoryCursor();
  const namespace = record.namespace;
  const conceptId = record.conceptId;
  const eventId = record.eventId;
  const eventAt = record.eventAt;
  const recordedAt = record.recordedAt;
  if (typeof namespace !== 'string' || !namespace.trim()
      || typeof conceptId !== 'string' || !conceptId.trim()
      || typeof eventId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(eventId)
      || typeof eventAt !== 'string' || !isValidInstant(eventAt)
      || typeof recordedAt !== 'string' || !isValidInstant(recordedAt)) {
    invalidHistoryCursor();
  }
  return {
    namespace,
    conceptId,
    eventAt: new Date(Date.parse(eventAt)).toISOString(),
    recordedAt: new Date(Date.parse(recordedAt)).toISOString(),
    eventId,
  };
}

interface ScenarioPromptStoreCursor extends ScenarioPromptCursor {
  namespace: string;
}

function invalidScenarioPromptCursor(): never {
  throw new StoreError('INVALID_SCENARIO_PROMPTS_CURSOR', '场景回访分页游标无效，请重新读取场景。');
}

function encodeScenarioPromptCursor(cursor: ScenarioPromptStoreCursor): string {
  return Buffer.from(JSON.stringify({
    version: 1,
    namespace: cursor.namespace,
    observedAt: cursor.observedAt,
    recordedAt: cursor.recordedAt,
    eventId: cursor.eventId,
  }), 'utf8').toString('base64url');
}

function decodeScenarioPromptCursor(value: string): ScenarioPromptStoreCursor {
  if (!/^[A-Za-z0-9_-]{1,2048}$/.test(value)) invalidScenarioPromptCursor();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    invalidScenarioPromptCursor();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) invalidScenarioPromptCursor();
  const record = parsed as Record<string, unknown>;
  if (record.version !== 1
      || typeof record.namespace !== 'string' || !record.namespace.trim()
      || typeof record.eventId !== 'string' || !EVENT_ID_PATTERN.test(record.eventId)
      || typeof record.observedAt !== 'string' || !isValidInstant(record.observedAt)
      || typeof record.recordedAt !== 'string' || !isValidInstant(record.recordedAt)) {
    invalidScenarioPromptCursor();
  }
  return {
    namespace: record.namespace,
    observedAt: new Date(Date.parse(record.observedAt as string)).toISOString(),
    recordedAt: new Date(Date.parse(record.recordedAt as string)).toISOString(),
    eventId: record.eventId,
  };
}

export class Store {
  readonly namespace: string;
  readonly dbPath: string;
  readonly activity: ActivityStore;
  readonly observationRevisions: ObservationRevisionStore;
  private readonly now: () => Date;
  private readonly db: DatabaseSync;
  private readonly snapshotRepository: LearningSnapshotRepository<2>;
  private readonly importRepository: LearningImportRepository;
  private readSequence = 0;

  constructor(options: StoreOptions) {
    this.namespace = options.namespace;
    this.now = options.now ?? (() => new Date());
    this.dbPath = options.dbPath ?? join(options.dataDir ?? 'data/local', 'living-memory.sqlite');
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    try {
      const schema = inspectLearningSchema(this.db);
      if (schema.kind === 'legacy-v1') throw new StoreError('LEARNING_SCHEMA_UPGRADE_REQUIRED', '请先离线备份并恢复到新目录，完成学习数据库升级。', 503);
      if (schema.kind === 'empty') initializeLearningSchemaV2(this.db, { recordedAt: iso(this.now()) });
      this.initialize();
      this.snapshotRepository = new LearningSnapshotRepository({ db: this.db, namespace: this.namespace, now: this.now });
      this.importRepository = new LearningImportRepository({ db: this.db, namespace: this.namespace, now: this.now });
      this.activity = new ActivityStore({ db: this.db, namespace: this.namespace, now: this.now });
      this.observationRevisions = new ObservationRevisionStore({ db: this.db, namespace: this.namespace, now: this.now,
        getObservation: (_namespace, eventId) => this.getObservationsStrict().find(event => event.eventId === eventId) ?? null,
        findOtherEvent: (_namespace, eventId) => {
          const event = this.findEvent(eventId);
          return event && event.kind !== 'observation-revision' ? { kind: event.kind, requestPayload: event.payload } : null;
        } });
    } catch (error) { this.db.close(); throw error; }
  }

  close(): void {
    this.db.close();
  }

  private readSnapshot<T>(read: () => T): T {
    const name = `lm_store_read_${++this.readSequence}`;
    this.db.exec(`SAVEPOINT ${name}`);
    try {
      const result = read();
      this.db.exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      try { this.db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); } catch { /* keep safe original error */ }
      throw error;
    }
  }

  private initialize(): void {
    let ownsTxn = false;
    try {
      this.db.exec('BEGIN IMMEDIATE'); ownsTxn = true;
      const createdAt = iso(this.now());
      this.db.prepare('INSERT OR IGNORE INTO namespaces(namespace, created_at) VALUES (?, ?)').run(this.namespace, createdAt);
      const existing = this.db.prepare('SELECT revision FROM config_history WHERE namespace = ? ORDER BY revision DESC LIMIT 1').get(this.namespace) as { revision?: number } | undefined;
      if (!existing) {
        this.db.prepare('INSERT INTO config_history(namespace, revision, model_version, half_life_days, recorded_at) VALUES (?, 1, ?, ?, ?)').run(this.namespace, MODEL_VERSION, DEFAULT_HALF_LIFE_DAYS, createdAt);
      }
      this.db.exec('COMMIT'); ownsTxn = false;
    } catch (error) {
      if (ownsTxn) { try { this.db.exec('ROLLBACK'); } catch { /* preserve cause */ } }
      throw error;
    }
  }

  getConfig(): ModelConfig {
    return this.snapshotRepository.getConfig();
  }

  getConfigAt(revision: number): ModelConfig | null {
    return this.importRepository.getConfigAt(revision);
  }

  getConfigHistory(): ModelConfig[] {
    return this.snapshotRepository.getConfigHistory();
  }

  updateConfig(halfLifeDays: number, expectedRevision: number): ConfigWriteReceipt {
    if (!finiteNumber(halfLifeDays) || halfLifeDays <= 0 || halfLifeDays > 3650) {
      throw new StoreError('INVALID_HALF_LIFE', 'halfLifeDays 必须大于 0 且不超过 3650。');
    }
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || expectedRevision >= Number.MAX_SAFE_INTEGER) {
      throw new StoreError('INVALID_REVISION', 'revision 必须是可安全递增的正整数。');
    }
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const current = this.getConfig();
      if (expectedRevision !== current.revision) {
        // A config request describes one exact transition: expected -> expected+1.
        // Matching today's H alone would silently accept a genuinely stale edit.
        // Use stored model versions rather than the current-model projection.
        const applied = this.db.prepare(`SELECT next.revision, next.model_version, next.half_life_days
          FROM config_history AS next JOIN config_history AS base
            ON base.namespace = next.namespace AND base.revision = next.revision - 1
          WHERE next.namespace = ? AND base.revision = ?
            AND base.model_version = ? AND next.model_version = ?`).get(
          this.namespace, expectedRevision, MODEL_VERSION, MODEL_VERSION,
        ) as { revision: number; model_version: string; half_life_days: number } | undefined;
        if (expectedRevision < current.revision && applied?.half_life_days === halfLifeDays) {
          this.db.exec('COMMIT');
          return { modelVersion: MODEL_VERSION, halfLifeDays, revision: applied.revision,
            status: 'duplicate', currentConfig: current };
        }
        throw new StoreError('CONFIG_CONFLICT', '配置版本已变化，且没有匹配的原始参数修改。请核对当前设置后重新提交。', 409);
      }
      const next = current.revision + 1;
      const recordedAt = iso(this.now());
      this.db.prepare('INSERT INTO config_history(namespace, revision, model_version, half_life_days, recorded_at) VALUES (?, ?, ?, ?, ?)').run(this.namespace, next, MODEL_VERSION, halfLifeDays, recordedAt);
      this.db.exec('COMMIT');
      const config: ModelConfig = { modelVersion: MODEL_VERSION, halfLifeDays, revision: next };
      return { ...config, status: 'accepted', currentConfig: config };
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* preserve original error */ }
      if (error instanceof StoreError) throw error;
      throw new StoreError('WRITE_FAILED', safeSqliteMessage(error), 503);
    }
  }

  private findEvent(eventId: string): { kind: 'anchor' | 'observation' | 'retention' | 'application' | 'correction' | 'relation-review' | 'observation-revision' | PracticeEventKind; payload: string } | null {
    return this.importRepository.findEvent(eventId);
  }

  hasEvent(eventId: string): boolean {
    return this.findEvent(eventId) !== null;
  }

  private ensureEventId(eventId: string): void {
    if (!EVENT_ID_PATTERN.test(eventId)) throw new StoreError('INVALID_EVENT_ID', 'eventId 只能包含字母、数字、点、下划线、冒号或短横线，长度不超过 128。');
  }

  addReview(input: ReviewRequest): StoreWriteResult {
    this.ensureEventId(input.eventId);
    const providedOccurredAt = input.occurredAt === undefined
      ? undefined
      : normalizeDate(input.occurredAt, 'INVALID_OCCURRED_AT');
    const request = {
      eventId: input.eventId,
      conceptId: input.conceptId,
      sourceRevision: input.sourceRevision,
      kind: input.kind,
      ...(providedOccurredAt ? { occurredAt: providedOccurredAt } : {}),
    };
    const requestPayload = canonicalJson(request);
    const existing = this.findEvent(input.eventId);
    if (existing) {
      if (existing.kind !== 'anchor' || existing.payload !== requestPayload) throw new StoreError('EVENT_CONFLICT', 'eventId 已被其他事件使用，不能覆盖已有记录。', 409);
      return { status: 'duplicate', eventId: input.eventId };
    }
    const now = this.now();
    const nowMs = now.getTime();
    if (input.kind === 'estimated' && !providedOccurredAt) {
      throw new StoreError('INVALID_OCCURRED_AT', 'estimated 事件必须提供 occurredAt。');
    }
    const occurredAt = providedOccurredAt ?? iso(now);
    if (parseDate(occurredAt) > nowMs) throw new StoreError('FUTURE_EVENT', '发生时间不能晚于服务当前时间。');
    const recordedAt = iso(now);
    let ownsTxn = false;
    try {
      this.db.exec('BEGIN IMMEDIATE'); ownsTxn = true;
      const concurrent = this.findEvent(input.eventId);
      if (concurrent) {
        if (concurrent.kind !== 'anchor' || concurrent.payload !== requestPayload) throw new StoreError('EVENT_CONFLICT', 'eventId 已被其他事件使用。', 409);
        this.db.exec('COMMIT'); ownsTxn = false;
        return { status: 'duplicate', eventId: input.eventId };
      }
      this.db.prepare(`INSERT INTO anchors(namespace, event_id, concept_id, source_revision, occurred_at, recorded_at, kind, request_payload)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(this.namespace, input.eventId, input.conceptId, input.sourceRevision, occurredAt, recordedAt, input.kind, requestPayload);
      this.db.exec('COMMIT'); ownsTxn = false;
    } catch (error) {
      if (ownsTxn) { try { this.db.exec('ROLLBACK'); } catch { /* preserve original error */ } }
      if (error instanceof StoreError) throw error;
      throw new StoreError('WRITE_FAILED', safeSqliteMessage(error), 503);
    }
    return { status: 'accepted', eventId: input.eventId };
  }

  addObservation(input: ObservationRequest, expectedAnchorEventId: string | null): StoreWriteResult {
    this.ensureEventId(input.eventId);
    const exposure = input.observedExposure ? 'exposed' : input.exposure;
    const observedAt = normalizeDate(input.observedAt, 'INVALID_OBSERVED_AT');
    const learning = normalizeLearningEvidence(input.learning, observedAt);
    const evidenceMode = normalizeObservationEvidenceMode(input.evidenceMode, input.answer);
    const request = {
      eventId: input.eventId,
      conceptId: input.conceptId,
      sourceRevision: input.sourceRevision,
      observedAt,
      configRevision: input.configRevision,
      anchorEventId: input.anchorEventId,
      answer: input.answer,
      rating: input.rating,
      exposure,
      observedExposure: input.observedExposure,
      ...(learning ? { learning } : {}),
      ...(evidenceMode ? { evidenceMode } : {}),
    };
    const requestPayload = canonicalJson(request);
    const existing = this.findEvent(input.eventId);
    if (existing) {
      if (existing.kind !== 'observation' || existing.payload !== requestPayload) throw new StoreError('EVENT_CONFLICT', 'eventId 已被其他事件使用，不能覆盖已有记录。', 409);
      return { status: 'duplicate', eventId: input.eventId };
    }
    if (input.anchorEventId !== expectedAnchorEventId) {
      throw new StoreError('ANCHOR_CONFLICT', '回忆观察对应的时间起点已变化，请重新读取快照后重试。', 409);
    }
    const config = this.getConfigAt(input.configRevision);
    if (!config) throw new StoreError('CONFIG_REVISION_UNKNOWN', '提交时使用的模型配置版本不存在，请重新读取快照。', 409);
    const nowMs = this.now().getTime();
    if (parseDate(observedAt) > nowMs) throw new StoreError('FUTURE_OBSERVATION', '观察时间不能晚于服务当前时间。');
    const anchor = expectedAnchorEventId ? this.getAnchorById(expectedAnchorEventId) : null;
    if (expectedAnchorEventId && !anchor) {
      throw new StoreError('ANCHOR_CONFLICT', '回忆观察引用的时间起点不存在，请重新读取快照后重试。', 409);
    }
    if (anchor && (anchor.conceptId !== input.conceptId || anchor.sourceRevision !== input.sourceRevision)) {
      throw new StoreError('ANCHOR_CONFLICT', '回忆观察引用的时间起点与概念版本不匹配，请先确认当前来源。', 409);
    }
    if (anchor && parseDate(anchor.occurredAt) > parseDate(observedAt)) {
      throw new StoreError('ANCHOR_CONFLICT', '回忆观察时间早于引用的时间起点，请重新读取快照后重试。', 409);
    }
    const computed = computeDecay(anchor?.occurredAt ?? null, config.halfLifeDays, observedAt);
    const recordedAt = iso(this.now());
    let ownsTxn = false;
    try {
      this.db.exec('BEGIN IMMEDIATE'); ownsTxn = true;
      const concurrent = this.findEvent(input.eventId);
      if (concurrent) {
        if (concurrent.kind !== 'observation' || concurrent.payload !== requestPayload) throw new StoreError('EVENT_CONFLICT', 'eventId 已被其他事件使用。', 409);
        this.db.exec('COMMIT'); ownsTxn = false;
        return { status: 'duplicate', eventId: input.eventId };
      }
      this.db.prepare(`INSERT INTO observations(
        namespace, event_id, concept_id, source_revision, observed_at, recorded_at,
        config_revision, half_life_days, anchor_event_id, elapsed_days, decay,
        answer, rating, exposure, observed_exposure, learning_json, evidence_mode, request_payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        this.namespace,
        input.eventId,
        input.conceptId,
        input.sourceRevision,
        observedAt,
        recordedAt,
        config.revision,
        config.halfLifeDays,
        expectedAnchorEventId,
        computed.elapsedDays,
        computed.decay,
        input.answer,
        input.rating,
        exposure,
        input.observedExposure ? 1 : 0,
        learning ? canonicalJson(learning) : null,
        evidenceMode ?? null,
        requestPayload,
      );
      this.db.exec('COMMIT'); ownsTxn = false;
    } catch (error) {
      if (ownsTxn) { try { this.db.exec('ROLLBACK'); } catch { /* preserve original error */ } }
      if (error instanceof StoreError) throw error;
      throw new StoreError('WRITE_FAILED', safeSqliteMessage(error), 503);
    }
    return { status: 'accepted', eventId: input.eventId };
  }

  addRetention(input: RetentionRequest, expectedPreviousEventId: string | null): StoreWriteResult {
    this.ensureEventId(input.eventId);
    const occurredAt = normalizeDate(input.occurredAt, 'INVALID_OCCURRED_AT');
    const previousEventId = input.previousEventId === null ? null : input.previousEventId;
    if (previousEventId !== null) this.ensureEventId(previousEventId);
    const request = {
      eventId: input.eventId,
      conceptId: input.conceptId,
      sourceRevision: input.sourceRevision,
      occurredAt,
      active: input.active,
      previousEventId,
    };
    const requestPayload = canonicalJson(request);
    const existing = this.findEvent(input.eventId);
    if (existing) {
      if (existing.kind !== 'retention' || existing.payload !== requestPayload) throw new StoreError('EVENT_CONFLICT', 'eventId 已被其他事件使用，不能覆盖已有记录。', 409);
      return { status: 'duplicate', eventId: input.eventId };
    }
    const now = this.now();
    if (parseDate(occurredAt) > now.getTime()) throw new StoreError('FUTURE_EVENT', '发生时间不能晚于服务当前时间。');
    const recordedAt = iso(now);
    let ownsTxn = false;
    try {
      this.db.exec('BEGIN IMMEDIATE'); ownsTxn = true;
      const concurrent = this.findEvent(input.eventId);
      if (concurrent) {
        if (concurrent.kind !== 'retention' || concurrent.payload !== requestPayload) throw new StoreError('EVENT_CONFLICT', 'eventId 已被其他事件使用。', 409);
        this.db.exec('COMMIT'); ownsTxn = false;
        return { status: 'duplicate', eventId: input.eventId };
      }
      const currentPreviousEventId = this.getRetention(input.conceptId)?.eventId ?? null;
      if (expectedPreviousEventId !== currentPreviousEventId || previousEventId !== currentPreviousEventId) {
        throw new StoreError('RETENTION_CONFLICT', '长期保持状态已变化，请刷新节点后重试。', 409);
      }
      this.db.prepare(`INSERT INTO retentions(
        namespace, event_id, concept_id, source_revision, occurred_at, recorded_at,
        active, previous_event_id, request_payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        this.namespace,
        input.eventId,
        input.conceptId,
        input.sourceRevision,
        occurredAt,
        recordedAt,
        input.active ? 1 : 0,
        previousEventId,
        requestPayload,
      );
      this.db.exec('COMMIT'); ownsTxn = false;
    } catch (error) {
      if (ownsTxn) { try { this.db.exec('ROLLBACK'); } catch { /* preserve original error */ } }
      if (error instanceof StoreError) throw error;
      throw new StoreError('WRITE_FAILED', safeSqliteMessage(error), 503);
    }
    return { status: 'accepted', eventId: input.eventId };
  }

  /**
   * Persist private evidence that a concept was applied or summarized. These
   * records deliberately live outside anchors and observations: recording a
   * use case must not advance the time-decay anchor or inflate recall counts.
   */
  addApplication(input: ApplicationRecordRequest): StoreWriteResult {
    const request = normalizeApplicationRequest(input);
    this.ensureEventId(request.eventId);
    const requestPayload = canonicalJson(request);
    const existing = this.findEvent(request.eventId);
    if (existing) {
      if (existing.kind !== 'application' || existing.payload !== requestPayload) {
        throw new StoreError('EVENT_CONFLICT', 'eventId 已被其他事件使用，不能覆盖已有记录。', 409);
      }
      return { status: 'duplicate', eventId: request.eventId };
    }
    const now = this.now();
    if (parseDate(request.occurredAt) > now.getTime()) {
      throw new StoreError('FUTURE_EVENT', '发生时间不能晚于服务当前时间。');
    }
    const recordedAt = iso(now);
    let ownsTxn = false;
    try {
      this.db.exec('BEGIN IMMEDIATE'); ownsTxn = true;
      const concurrent = this.findEvent(request.eventId);
      if (concurrent) {
        if (concurrent.kind !== 'application' || concurrent.payload !== requestPayload) throw new StoreError('EVENT_CONFLICT', 'eventId 已被其他事件使用。', 409);
        this.db.exec('COMMIT'); ownsTxn = false;
        return { status: 'duplicate', eventId: request.eventId };
      }
      this.db.prepare(`INSERT INTO applications(
        namespace, event_id, concept_id, source_revision, occurred_at, recorded_at,
        kind, context, content, outcome, assistance, result, limitations,
        insight, correction, references_text, relation_suggestion_json, request_payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        this.namespace,
        request.eventId,
        request.conceptId,
        request.sourceRevision,
        request.occurredAt,
        recordedAt,
        request.kind,
        request.context,
        request.content,
        request.outcome,
        request.assistance,
        request.result,
        request.limitations,
        request.insight,
        request.correction,
        request.references,
        request.relationSuggestion ? canonicalJson(request.relationSuggestion) : null,
        requestPayload,
      );
      this.db.exec('COMMIT'); ownsTxn = false;
    } catch (error) {
      if (ownsTxn) { try { this.db.exec('ROLLBACK'); } catch { /* preserve original error */ } }
      if (error instanceof StoreError) throw error;
      throw new StoreError('WRITE_FAILED', safeSqliteMessage(error), 503);
    }
    return { status: 'accepted', eventId: request.eventId };
  }

  private practiceConceptMap(concepts: Concept[]): Map<string, Concept> {
    if (!Array.isArray(concepts)) throw new StoreError('PRACTICE_SOURCE_MISSING', '当前知识源概念列表无效。', 409);
    const result = new Map<string, Concept>();
    for (const concept of concepts) {
      if (!concept || typeof concept.id !== 'string' || !concept.id.trim()
          || !concept.source || typeof concept.source.revision !== 'string') continue;
      if (result.has(concept.id) && result.get(concept.id)?.source.revision !== concept.source.revision) {
        throw new StoreError('PRACTICE_SOURCE_CONFLICT', `当前知识源包含重复且版本不同的概念 ${concept.id}。`, 409);
      }
      result.set(concept.id, concept);
    }
    return result;
  }

  private assertPracticeSourcesCurrent(sources: PracticeSource[], concepts: Concept[]): void {
    const current = this.practiceConceptMap(concepts);
    for (const source of sources) {
      const concept = current.get(source.conceptId);
      if (!concept) {
        throw new StoreError('PRACTICE_SOURCE_MISSING', `练习卡引用的概念 ${source.conceptId} 已不在当前知识源中。`, 409);
      }
      if (concept.source.revision !== source.sourceRevision) {
        throw new StoreError('PRACTICE_CARD_CONFLICT', `练习卡引用的概念 ${source.conceptId} 来源版本已变化，请重新核对后保存。`, 409);
      }
    }
  }

  private assertPracticeScenarioContract(
    card: PracticeCardEvent,
    attempt: PracticeAttemptRequest,
    recordedAt: string,
  ): void {
    return assertPracticeScenarioContract(card, attempt, recordedAt);
  }

  private practiceCardFromRow(row: {
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
  }): PracticeCardEvent {
    return practiceCardFromRow(row);
  }

  private practiceAttemptFromRow(row: {
    event_id: string;
    card_id: string;
    card_event_id: string;
    answered_at: string;
    recorded_at: string;
    answer: string;
    confidence: number | null;
    confidence_at: string | null;
    exposure: 'unexposed' | 'exposed' | 'unknown';
    observed_exposure: number;
    cue: 'independent' | 'hinted' | 'lookup' | 'unknown';
    outcome: 'success' | 'partial' | 'failure' | 'unverified';
    check_notes: string;
    scenario_json: string | null;
  }): PracticeAttempt {
    return practiceAttemptFromRow(row);
  }

  private latestPracticeCardRow(cardId: string): {
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
    return this.importRepository.latestPracticeCardRow(cardId);
  }

  /** Return the latest append-only revision of one private practice card. */
  getPracticeCard(cardId: string): PracticeCardEvent | null {
    if (typeof cardId !== 'string' || !cardId.trim()) return null;
    const row = this.latestPracticeCardRow(cardId.trim());
    return row ? this.practiceCardFromRow(row) : null;
  }

  /** Return private practice history without projecting it into recall evidence. */
  getPracticeData(): PracticeData {
    return this.snapshotRepository.getPracticeData();
  }

  addPracticeCard(input: PracticeCardRequest, concepts: Concept[]): StoreWriteResult {
    const request = parsePracticeCardRequest(input);
    this.ensureEventId(request.eventId);
    const requestPayload = canonicalJson(request);
    const existing = this.findEvent(request.eventId);
    if (existing) {
      if (existing.kind !== 'practice-card' || existing.payload !== requestPayload) {
        throw new StoreError('EVENT_CONFLICT', 'eventId 已被其他事件使用，不能覆盖已有记录。', 409);
      }
      return { status: 'duplicate', eventId: request.eventId };
    }
    this.assertPracticeSourcesCurrent(request.sources, concepts);
    const now = this.now();
    if (parseDate(request.occurredAt) > now.getTime()) {
      throw new StoreError('FUTURE_PRACTICE_CARD', '练习卡发生时间不能晚于服务当前时间。');
    }
    const recordedAt = iso(now);
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const concurrent = this.findEvent(request.eventId);
      if (concurrent) {
        if (concurrent.kind !== 'practice-card' || concurrent.payload !== requestPayload) {
          throw new StoreError('EVENT_CONFLICT', 'eventId 已被其他事件使用，不能覆盖已有记录。', 409);
        }
        this.db.exec('COMMIT');
        return { status: 'duplicate', eventId: request.eventId };
      }
      const tail = this.latestPracticeCardRow(request.cardId);
      if (request.previousEventId === null) {
        if (tail) throw new StoreError('PRACTICE_CARD_CONFLICT', '练习卡已存在当前尾记录，不能从头创建分叉。', 409);
      } else {
        if (!tail || tail.event_id !== request.previousEventId) {
          throw new StoreError('PRACTICE_CARD_CONFLICT', '练习卡版本已变化，请以当前尾记录为前置版本重试。', 409);
        }
        if (parseDate(request.occurredAt) < parseDate(tail.occurred_at)) {
          throw new StoreError('PRACTICE_CARD_CONFLICT', '新练习卡时间不能早于当前尾记录。', 409);
        }
      }
      const sourcesJson = canonicalJson(request.sources);
      this.db.prepare(`INSERT INTO practice_cards(
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
        sourcesJson,
        1,
        request.scenario ? canonicalJson(request.scenario) : null,
        request.paused ? 1 : 0,
        requestPayload,
      );
      for (const source of request.sources) {
        this.db.prepare(`INSERT INTO practice_card_sources(
          namespace, card_event_id, card_id, concept_id, source_revision
        ) VALUES (?, ?, ?, ?, ?)`).run(
          this.namespace, request.eventId, request.cardId, source.conceptId, source.sourceRevision,
        );
      }
      this.db.exec('COMMIT');
      return { status: 'accepted', eventId: request.eventId };
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* preserve original error */ }
      if (error instanceof StoreError) throw error;
      throw new StoreError('WRITE_FAILED', safeSqliteMessage(error), 503);
    }
  }

  addPracticeAttempt(input: PracticeAttemptRequest, concepts: Concept[]): StoreWriteResult {
    const request = parsePracticeAttemptRequest(input);
    this.ensureEventId(request.eventId);
    const requestPayload = canonicalJson(request);
    const existing = this.findEvent(request.eventId);
    if (existing) {
      if (existing.kind !== 'practice-attempt' || existing.payload !== requestPayload) {
        throw new StoreError('EVENT_CONFLICT', 'eventId 已被其他事件使用，不能覆盖已有记录。', 409);
      }
      return { status: 'duplicate', eventId: request.eventId };
    }
    const now = this.now();
    if (parseDate(request.answeredAt) > now.getTime()) {
      throw new StoreError('FUTURE_PRACTICE_ATTEMPT', '答题时间不能晚于服务当前时间。');
    }
    const recordedAt = iso(now);
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const concurrent = this.findEvent(request.eventId);
      if (concurrent) {
        if (concurrent.kind !== 'practice-attempt' || concurrent.payload !== requestPayload) {
          throw new StoreError('EVENT_CONFLICT', 'eventId 已被其他事件使用，不能覆盖已有记录。', 409);
        }
        this.db.exec('COMMIT');
        return { status: 'duplicate', eventId: request.eventId };
      }
      const tailRow = this.latestPracticeCardRow(request.cardId);
      if (!tailRow) throw new StoreError('PRACTICE_CARD_NOT_FOUND', '找不到练习卡，请先读取当前练习卡。', 404);
      if (tailRow.event_id !== request.cardEventId) {
        throw new StoreError('PRACTICE_CARD_CONFLICT', '练习卡版本已变化，请重新读取当前卡片后作答。', 409);
      }
      const card = this.practiceCardFromRow(tailRow);
      if (card.paused) throw new StoreError('PRACTICE_CARD_PAUSED', '练习卡已暂停，不能新增答题记录。', 409);
      this.assertPracticeSourcesCurrent(card.sources, concepts);
      if (parseDate(request.answeredAt) < parseDate(card.occurredAt)) {
        throw new StoreError('PRACTICE_ATTEMPT_TIME', '答题时间不能早于引用练习卡的发生时间。');
      }
      this.assertPracticeScenarioContract(card, request, recordedAt);
      this.db.prepare(`INSERT INTO practice_attempts(
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
      this.db.exec('COMMIT');
      return { status: 'accepted', eventId: request.eventId };
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* preserve original error */ }
      if (error instanceof StoreError) throw error;
      throw new StoreError('WRITE_FAILED', safeSqliteMessage(error), 503);
    }
  }

  /**
   * Restore one card revision inside the caller's existing import transaction.
   * The helper deliberately does not open a nested transaction.
   */
  insertImportedPracticeCard(event: PracticeCardEvent): void {
    return this.importRepository.insertImportedPracticeCard(event);
  }

  /** Restore an answer inside the caller's existing import transaction. */
  insertImportedPracticeAttempt(event: PracticeAttempt): void {
    return this.importRepository.insertImportedPracticeAttempt(event);
  }

  getAnchorById(eventId: string): StoredAnchor | null {
    const row = this.db.prepare(`SELECT event_id, concept_id, source_revision, occurred_at, recorded_at, kind, request_payload
      FROM anchors WHERE namespace = ? AND event_id = ?`).get(this.namespace, eventId) as {
        event_id: string; concept_id: string; source_revision: string; occurred_at: string; recorded_at: string; kind: 'review' | 'estimated'; request_payload: string;
      } | undefined;
    return row ? {
      eventId: row.event_id,
      conceptId: row.concept_id,
      sourceRevision: row.source_revision,
      occurredAt: row.occurred_at,
      recordedAt: row.recorded_at,
      kind: row.kind,
      requestPayload: row.request_payload,
    } : null;
  }

  /** Return the latest real anchor, or the latest anchor at/before asOf for historical observation checks. */
  getAnchor(conceptId: string, asOf?: string): AnchorEvent | null {
    const constraint = asOf ? ' AND occurred_at <= ?' : '';
    const parameters = asOf ? [this.namespace, conceptId, normalizeDate(asOf)] : [this.namespace, conceptId];
    const row = this.db.prepare(`SELECT event_id, concept_id, source_revision, occurred_at, recorded_at, kind, request_payload
      FROM anchors WHERE namespace = ? AND concept_id = ?${constraint}
      ORDER BY occurred_at DESC, recorded_at DESC, event_id DESC LIMIT 1`).get(...parameters) as {
        event_id: string; concept_id: string; source_revision: string; occurred_at: string; recorded_at: string; kind: 'review' | 'estimated'; request_payload: string;
      } | undefined;
    return row ? {
      eventId: row.event_id,
      conceptId: row.concept_id,
      sourceRevision: row.source_revision,
      occurredAt: row.occurred_at,
      recordedAt: row.recorded_at,
      kind: row.kind,
    } : null;
  }

  /** Return the latest retention toggle for a concept, including an inactive clear. */
  getRetention(conceptId: string, asOf?: string): RetentionEvent | null {
    return this.importRepository.getRetention(conceptId, asOf);
  }

  getAnchors(): AnchorEvent[] {
    return this.snapshotRepository.getAnchors();
  }

  /** Preserve the original review request shape for portable retries. In
   * particular, an omitted occurredAt must remain omitted because it is part
   * of the canonical idempotency payload even though the stored anchor always
   * has a concrete occurredAt. */
  private getAnchorRequests(): ReviewRequest[] {
    return this.snapshotRepository.getAnchorRequests();
  }

  private getConfigRecordedAt(): Record<string, string> {
    return this.snapshotRepository.getConfigRecordedAt();
  }

  private getImportedConcepts(): Array<Pick<Concept, 'id' | 'title' | 'source'>> {
    return this.snapshotRepository.getImportedConcepts();
  }

  private getIdentityCatalog(): Array<{ id: string; title: string; path: string | null; revision: string | null }> {
    return this.snapshotRepository.getIdentityCatalog();
  }

  getIdentityBindings(): IdentityBinding[] {
    return this.snapshotRepository.getIdentityBindings();
  }

  getIdentityAcceptedPaths(): Record<string, string[]> {
    return this.snapshotRepository.getIdentityAcceptedPaths();
  }

  getObservations(conceptId?: string, sourceRevision?: string, strict = false): Observation[] {
    return this.snapshotRepository.getObservations(conceptId, sourceRevision, strict);
  }

  /** Strict rows for revision parents, effective statistics and complete V2 backups. */
  private getObservationsStrict(conceptId?: string): Observation[] {
    return this.snapshotRepository.getObservationsStrict(conceptId);
  }

  getLearningOverview(sourceId: string, concepts: Concept[], links: GraphLink[], asOf: string) {
    return this.readSnapshot(() => {
      const raw = this.getObservationsStrict();
      const projection = projectObservationAssessments(raw, this.observationRevisions.getRevisions(), asOf);
      const observationAssessments = {
        raw: raw.length, effective: projection.effective.length,
        withdrawn: projection.states.filter(item => item.status === 'withdrawn').length,
        unresolved: projection.states.filter(item => item.status === 'unresolved').length,
        notYetRecorded: projection.states.filter(item => item.status === 'not-yet-recorded').length,
        revisionCount: this.observationRevisions.getRevisionCount(),
      };
      return { ...buildLearningOverview({ sourceId, asOf, concepts, states: this.getStates(concepts, asOf),
        observations: projection.effective.map(item => item.observation), applications: this.getApplications(),
        corrections: this.getCorrections(), relationData: { links, reviews: this.getRelationReviews() }, anchors: this.getAnchors() }),
        observationAssessments };
    });
  }

  getEffectiveObservations(asOf: string, conceptId?: string): Observation[] {
    return this.readSnapshot(() => this.getObservationProjection(asOf, conceptId).effective.map(item => item.observation));
  }

  private getObservationProjection(asOf: string, conceptId?: string) {
    // Ownership comes from the immutable parent. A damaged revision's claimed
    // concept must never make a bad chain disappear and revive the raw score.
    const observations = this.getObservationsStrict();
    const projection = projectObservationAssessments(observations, this.observationRevisions.getRevisions(), asOf);
    if (conceptId === undefined) return projection;
    const parents = new Set(observations.filter(event => event.conceptId === conceptId).map(event => event.eventId));
    return { ...projection,
      effective: projection.effective.filter(item => parents.has(item.observationEventId)),
      states: projection.states.filter(item => parents.has(item.observationEventId)),
      issues: projection.issues.filter(item => item.observationEventId !== null && parents.has(item.observationEventId)) };

  }

  /**
   * Return previously recorded scenario prompts for the current source index.
   * The source revision is intentionally not part of this filter: an old
   * scenario may be useful for practising the current version of a concept.
   */
  getScenarioPrompts(conceptIds: ReadonlySet<string>, limit: number, rawCursor?: string): {
    items: Array<{ eventId: string; scenario: string; observedAt: string }>;
    total: number;
    nextCursor: string | null;
  } {
    const cursor = rawCursor === undefined ? undefined : decodeScenarioPromptCursor(rawCursor);
    if (cursor && cursor.namespace !== this.namespace) invalidScenarioPromptCursor();
    const page = buildScenarioPromptPage(this.getObservations(), conceptIds, limit, cursor);
    const nextCursor = page.hasMore && page.last
      ? encodeScenarioPromptCursor({ namespace: this.namespace, ...page.last })
      : null;
    return { items: page.items, total: page.total, nextCursor };
  }

  getRetentions(): RetentionEvent[] {
    return this.snapshotRepository.getRetentions();
  }

  getApplications(conceptId?: string, sourceRevision?: string): ApplicationRecord[] {
    return this.snapshotRepository.getApplications(conceptId, sourceRevision);
  }

  private correctionRequestPayload(request: CorrectionRequest): string {
    return correctionRequestPayload(request);
  }

  private correctionFromRow(row: {
    event_id: string;
    application_event_id: string;
    concept_id: string;
    source_revision: string;
    occurred_at: string;
    recorded_at: string;
    previous_event_id: string | null;
    status: CorrectionStatus;
    note: string;
  }): CorrectionEvent {
    return correctionFromRow(row);
  }

  private correctionTail(applicationEventId: string): CorrectionEvent | null {
    return this.importRepository.correctionTail(applicationEventId);
  }

  getCorrections(conceptId?: string, applicationEventId?: string): CorrectionEvent[] {
    return this.snapshotRepository.getCorrections(conceptId, applicationEventId);
  }

  getCorrectionHistory(applicationEventId: string, limit = 50): CorrectionHistory {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new StoreError('INVALID_HISTORY_LIMIT', '修正历史 limit 必须是正整数。');
    }
    const boundedLimit = Math.min(limit, 50);
    const totalRow = this.db.prepare(`SELECT COUNT(*) AS count
      FROM corrections WHERE namespace = ? AND application_event_id = ?`).get(this.namespace, applicationEventId) as { count: number };
    const latest = this.correctionTail(applicationEventId);
    const events: CorrectionEvent[] = [];
    const visited = new Set<string>();
    let current = latest;
    while (current && events.length < boundedLimit && !visited.has(current.eventId)) {
      visited.add(current.eventId);
      events.push(current);
      if (!current.previousEventId) {
        current = null;
        continue;
      }
      const previous = this.db.prepare(`SELECT event_id, application_event_id, concept_id, source_revision,
        occurred_at, recorded_at, previous_event_id, status, note
        FROM corrections
        WHERE namespace = ? AND application_event_id = ? AND event_id = ?`).get(
        this.namespace, applicationEventId, current.previousEventId,
      ) as {
        event_id: string;
        application_event_id: string;
        concept_id: string;
        source_revision: string;
        occurred_at: string;
        recorded_at: string;
        previous_event_id: string | null;
        status: CorrectionStatus;
        note: string;
      } | undefined;
      current = previous ? this.correctionFromRow(previous) : null;
    }
    return { latest, events, total: totalRow.count };
  }

  /** Append one immutable human decision to an application's correction chain. */
  addCorrection(input: CorrectionRequest): StoreWriteResult {
    const request = normalizeCorrectionRequest(input);
    this.ensureEventId(request.eventId);
    const requestPayload = this.correctionRequestPayload(request);
    const existing = this.findEvent(request.eventId);
    if (existing) {
      if (existing.kind !== 'correction' || existing.payload !== requestPayload) {
        throw new StoreError('EVENT_CONFLICT', 'eventId 已被其他事件使用，不能覆盖已有记录。', 409);
      }
      return { status: 'duplicate', eventId: request.eventId };
    }

    const now = this.now();
    const nowMs = now.getTime();
    if (parseDate(request.occurredAt) > nowMs) throw new StoreError('FUTURE_EVENT', '发生时间不能晚于服务当前时间。');
    const recordedAt = iso(now);
    try {
      this.db.exec('BEGIN IMMEDIATE');
      // Re-check under the write lock. A concurrent writer may have claimed
      // this event ID after the optimistic duplicate check above.
      const concurrent = this.findEvent(request.eventId);
      if (concurrent) {
        if (concurrent.kind !== 'correction' || concurrent.payload !== requestPayload) {
          throw new StoreError('EVENT_CONFLICT', 'eventId 已被其他事件使用，不能覆盖已有记录。', 409);
        }
        this.db.exec('COMMIT');
        return { status: 'duplicate', eventId: request.eventId };
      }

      const parent = this.db.prepare(`SELECT concept_id, source_revision, occurred_at, correction
        FROM applications WHERE namespace = ? AND event_id = ?`).get(this.namespace, request.applicationEventId) as {
          concept_id: string;
          source_revision: string;
          occurred_at: string;
          correction: string;
        } | undefined;
      if (!parent) throw new StoreError('APPLICATION_NOT_FOUND', '找不到同一知识空间中的应用记录。', 409);
      if (parent.concept_id !== request.conceptId) {
        throw new StoreError('CORRECTION_CONFLICT', '修正记录的 conceptId 与应用记录不一致。', 409);
      }
      if (!parent.correction.trim()) {
        throw new StoreError('INVALID_BODY', '应用记录必须包含非空 correction 才能提交人工复核。');
      }
      if (request.status === 'resolved' && request.sourceRevision === parent.source_revision) {
        throw new StoreError('CORRECTION_SOURCE_UNCHANGED', 'resolved 修正必须针对应用记录之后的新资料版本。', 409);
      }
      const tail = this.correctionTail(request.applicationEventId);
      const currentPreviousEventId = tail?.eventId ?? null;
      if (request.previousEventId !== currentPreviousEventId) {
        throw new StoreError('CORRECTION_CONFLICT', '修正历史已变化，请重新读取当前尾节点后重试。', 409);
      }
      const lowerBound = tail ? parseDate(tail.occurredAt) : parseDate(parent.occurred_at);
      const occurredAtMs = parseDate(request.occurredAt);
      if (occurredAtMs < lowerBound) {
        throw new StoreError('CORRECTION_CONFLICT', '修正发生时间不能早于应用记录或上一条修正。', 409);
      }
      this.db.prepare(`INSERT INTO corrections(
        namespace, event_id, application_event_id, concept_id, source_revision,
        occurred_at, recorded_at, previous_event_id, status, note, request_payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        this.namespace,
        request.eventId,
        request.applicationEventId,
        request.conceptId,
        request.sourceRevision,
        request.occurredAt,
        recordedAt,
        request.previousEventId,
        request.status,
        request.note,
        requestPayload,
      );
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* preserve original error */ }
      if (error instanceof StoreError) throw error;
      throw new StoreError('WRITE_FAILED', safeSqliteMessage(error), 503);
    }
    return { status: 'accepted', eventId: request.eventId };
  }

  private relationReviewRequestPayload(request: RelationReviewRequest): string {
    return relationReviewRequestPayload(request);
  }

  private relationReviewFromRow(row: {
    event_id: string;
    application_event_id: string;
    concept_id: string;
    basis_json: string;
    occurred_at: string;
    recorded_at: string;
    previous_event_id: string | null;
    status: RelationReviewStatus;
    note: string;
  }): RelationReviewEvent {
    return relationReviewFromRow(row);
  }

  private relationReviewTail(applicationEventId: string): RelationReviewEvent | null {
    return this.importRepository.relationReviewTail(applicationEventId);
  }

  getRelationReviews(conceptId?: string, applicationEventId?: string): RelationReviewEvent[] {
    return this.snapshotRepository.getRelationReviews(conceptId, applicationEventId);
  }

  getRelationReviewHistory(applicationEventId: string, limit = 50): RelationReviewHistory {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new StoreError('INVALID_HISTORY_LIMIT', '关系复核历史 limit 必须是正整数。');
    }
    const boundedLimit = Math.min(limit, 50);
    const totalRow = this.db.prepare(`SELECT COUNT(*) AS count
      FROM relation_reviews WHERE namespace = ? AND application_event_id = ?`).get(this.namespace, applicationEventId) as { count: number };
    const latest = this.relationReviewTail(applicationEventId);
    const events: RelationReviewEvent[] = [];
    const visited = new Set<string>();
    let current = latest;
    while (current && events.length < boundedLimit && !visited.has(current.eventId)) {
      visited.add(current.eventId);
      events.push(current);
      if (!current.previousEventId) {
        current = null;
        continue;
      }
      const previous = this.db.prepare(`SELECT event_id, application_event_id, concept_id, basis_json,
        occurred_at, recorded_at, previous_event_id, status, note
        FROM relation_reviews
        WHERE namespace = ? AND application_event_id = ? AND event_id = ?`).get(
        this.namespace, applicationEventId, current.previousEventId,
      ) as {
        event_id: string;
        application_event_id: string;
        concept_id: string;
        basis_json: string;
        occurred_at: string;
        recorded_at: string;
        previous_event_id: string | null;
        status: RelationReviewStatus;
        note: string;
      } | undefined;
      current = previous ? this.relationReviewFromRow(previous) : null;
    }
    return { latest, events, total: totalRow.count };
  }

  /** Append an independent immutable human relation-review decision. */
  addRelationReview(input: RelationReviewRequest): StoreWriteResult {
    const request = parseRelationReviewRequest(input);
    this.ensureEventId(request.eventId);
    const requestPayload = this.relationReviewRequestPayload(request);
    const existing = this.findEvent(request.eventId);
    if (existing) {
      if (existing.kind !== 'relation-review' || existing.payload !== requestPayload) {
        throw new StoreError('EVENT_CONFLICT', 'eventId 已被其他事件使用，不能覆盖已有记录。', 409);
      }
      return { status: 'duplicate', eventId: request.eventId };
    }

    const now = this.now();
    const nowMs = now.getTime();
    if (parseDate(request.occurredAt) > nowMs) throw new StoreError('FUTURE_EVENT', '发生时间不能晚于服务当前时间。');
    const recordedAt = iso(now);
    try {
      this.db.exec('BEGIN IMMEDIATE');
      // Re-check under the write lock. A concurrent writer may have claimed
      // this event ID after the optimistic duplicate check above.
      const concurrent = this.findEvent(request.eventId);
      if (concurrent) {
        if (concurrent.kind !== 'relation-review' || concurrent.payload !== requestPayload) {
          throw new StoreError('EVENT_CONFLICT', 'eventId 已被其他事件使用，不能覆盖已有记录。', 409);
        }
        this.db.exec('COMMIT');
        return { status: 'duplicate', eventId: request.eventId };
      }

      const parent = this.db.prepare(`SELECT concept_id, source_revision, occurred_at, relation_suggestion_json
        FROM applications WHERE namespace = ? AND event_id = ?`).get(this.namespace, request.applicationEventId) as {
          concept_id: string; source_revision: string; occurred_at: string; relation_suggestion_json: string | null;
        } | undefined;
      if (!parent) throw new StoreError('APPLICATION_NOT_FOUND', '找不到同一知识空间中的应用记录。', 409);
      if (parent.concept_id !== request.conceptId) throw new StoreError('RELATION_REVIEW_CONFLICT', '关系复核主概念与应用记录不一致。', 409);
      if (!parent.relation_suggestion_json) throw new StoreError('INVALID_BODY', '应用记录没有关系建议。');
      const suggestion = parseRelationSuggestion(JSON.parse(parent.relation_suggestion_json), { conceptId: parent.concept_id, sourceRevision: parent.source_revision });
      try { validateRelationReviewBasis(suggestion, request.basis); } catch (error) { throw new StoreError('INVALID_BODY', error instanceof Error ? error.message : '关系复核依据无效。'); }
      if (request.status === 'resolved' && !relationReviewMatches(suggestion, request.basis)) throw new StoreError('RELATION_REVIEW_NOT_MATCHED', '当前关系核对依据不符合建议，不能确认已采纳。', 409);
      const tail = this.relationReviewTail(request.applicationEventId);
      const currentPreviousEventId = tail?.eventId ?? null;
      if (request.previousEventId !== currentPreviousEventId) {
        throw new StoreError('RELATION_REVIEW_CONFLICT', '关系复核历史已变化，请重新读取当前尾节点后重试。', 409);
      }
      const lowerBound = tail ? parseDate(tail.occurredAt) : parseDate(parent.occurred_at);
      const occurredAtMs = parseDate(request.occurredAt);
      if (occurredAtMs < lowerBound) {
        throw new StoreError('RELATION_REVIEW_CONFLICT', '关系复核发生时间不能早于应用记录或上一条关系复核。', 409);
      }
      this.db.prepare(`INSERT INTO relation_reviews(
        namespace, event_id, application_event_id, concept_id, basis_json,
        occurred_at, recorded_at, previous_event_id, status, note, request_payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        this.namespace,
        request.eventId,
        request.applicationEventId,
        request.conceptId,
        canonicalJson(request.basis),
        request.occurredAt,
        recordedAt,
        request.previousEventId,
        request.status,
        request.note,
        requestPayload,
      );
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* preserve original error */ }
      if (error instanceof StoreError) throw error;
      throw new StoreError('WRITE_FAILED', safeSqliteMessage(error), 503);
    }
    return { status: 'accepted', eventId: request.eventId };
  }

  countObservations(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM observations WHERE namespace = ?').get(this.namespace) as { count: number };
    return row.count;
  }

  getConceptHistory(
    concept: Concept,
    asOf: string,
    limit: number,
    rawCursor?: string,
    applicationEventId?: string,
  ): ConceptHistory {
    return this.readSnapshot(() => this.readConceptHistory(concept, asOf, limit, rawCursor, applicationEventId));
  }

  private readConceptHistory(
    concept: Concept,
    asOf: string,
    limit: number,
    rawCursor?: string,
    applicationEventId?: string,
  ): ConceptHistory {
    const normalizedAsOf = normalizeDate(asOf, 'INVALID_HISTORY_AS_OF');
    const cursor = rawCursor === undefined ? null : decodeHistoryCursor(rawCursor);
    if (cursor && (cursor.namespace !== this.namespace || cursor.conceptId !== concept.id)) invalidHistoryCursor();
    if (applicationEventId !== undefined && !EVENT_ID_PATTERN.test(applicationEventId)) {
      throw new StoreError('INVALID_EVENT_ID', 'applicationEventId 格式无效。');
    }
    if (cursor && applicationEventId !== undefined) {
      throw new StoreError('INVALID_HISTORY_CURSOR', '聚焦单条应用历史时不能同时使用分页游标。');
    }

    type HistoryRow = {
      event_type: 'anchor' | 'observation' | 'retention' | 'application';
      event_id: string;
      concept_id: string;
      source_revision: string;
      event_at: string;
      recorded_at: string;
      kind: 'review' | 'estimated' | null;
      application_kind: 'application' | 'summary' | null;
      context: string | null;
      content: string | null;
      outcome: 'success' | 'partial' | 'failure' | 'unverified' | null;
      assistance: 'independent' | 'resources' | 'people-or-ai' | 'mixed' | 'unknown' | null;
      result: string | null;
      limitations: string | null;
      insight: string | null;
      correction: string | null;
      references_text: string | null;
      relation_suggestion_json: string | null;
      active: number | null;
      previous_event_id: string | null;
      config_revision: number | null;
      half_life_days: number | null;
      anchor_event_id: string | null;
      elapsed_days: number | null;
      decay: number | null;
      answer: string | null;
      rating: RecallRating | null;
      exposure: 'unexposed' | 'exposed' | 'unknown' | null;
      observed_exposure: number | null;
      learning_json: string | null;
      evidence_mode: Observation['evidenceMode'] | null;
    };

    const historyPredicates: string[] = [];
    if (applicationEventId !== undefined) historyPredicates.push("event_type = 'application' AND event_id = ?");
    if (cursor) {
      historyPredicates.push(`(
        event_at < ?
        OR (event_at = ? AND recorded_at < ?)
        OR (event_at = ? AND recorded_at = ? AND event_id < ?)
      )`);
    }
    const historyFilter = historyPredicates.length > 0
      ? `WHERE ${historyPredicates.join(' AND ')}`
      : '';
    const queryParameters: Array<string | number> = [
      this.namespace, concept.id,
      this.namespace, concept.id,
      this.namespace, concept.id,
      this.namespace, concept.id,
    ];
    if (applicationEventId !== undefined) queryParameters.push(applicationEventId);
    if (cursor) {
      queryParameters.push(
        cursor.eventAt,
        cursor.eventAt,
        cursor.recordedAt,
        cursor.eventAt,
        cursor.recordedAt,
        cursor.eventId,
      );
    }
    queryParameters.push(limit + 1);
    const rows = this.db.prepare(`
      WITH history AS (
        SELECT 'anchor' AS event_type, event_id, concept_id, source_revision,
          occurred_at AS event_at, recorded_at, kind,
          NULL AS application_kind, NULL AS context, NULL AS content, NULL AS outcome,
          NULL AS assistance, NULL AS result, NULL AS limitations, NULL AS insight,
          NULL AS correction, NULL AS references_text, NULL AS relation_suggestion_json,
          NULL AS active, NULL AS previous_event_id,
          NULL AS config_revision, NULL AS half_life_days, NULL AS anchor_event_id,
          NULL AS elapsed_days, NULL AS decay, NULL AS answer, NULL AS rating,
          NULL AS exposure, NULL AS observed_exposure, NULL AS learning_json, NULL AS evidence_mode
        FROM anchors
        WHERE namespace = ? AND concept_id = ?
        UNION ALL
        SELECT 'observation' AS event_type, event_id, concept_id, source_revision,
          observed_at AS event_at, recorded_at, NULL AS kind,
          NULL AS application_kind, NULL AS context, NULL AS content, NULL AS outcome,
          NULL AS assistance, NULL AS result, NULL AS limitations, NULL AS insight,
          NULL AS correction, NULL AS references_text, NULL AS relation_suggestion_json,
          NULL AS active, NULL AS previous_event_id,
          config_revision, half_life_days, anchor_event_id,
          elapsed_days, decay, answer, rating, exposure, observed_exposure, learning_json, evidence_mode
        FROM observations
        WHERE namespace = ? AND concept_id = ?
        UNION ALL
        SELECT 'retention' AS event_type, event_id, concept_id, source_revision,
          occurred_at AS event_at, recorded_at, NULL AS kind,
          NULL AS application_kind, NULL AS context, NULL AS content, NULL AS outcome,
          NULL AS assistance, NULL AS result, NULL AS limitations, NULL AS insight,
          NULL AS correction, NULL AS references_text, NULL AS relation_suggestion_json,
          active, previous_event_id,
          NULL AS config_revision, NULL AS half_life_days, NULL AS anchor_event_id,
          NULL AS elapsed_days, NULL AS decay, NULL AS answer, NULL AS rating,
          NULL AS exposure, NULL AS observed_exposure, NULL AS learning_json, NULL AS evidence_mode
        FROM retentions
        WHERE namespace = ? AND concept_id = ?
        UNION ALL
        SELECT 'application' AS event_type, event_id, concept_id, source_revision,
          occurred_at AS event_at, recorded_at, NULL AS kind,
          kind AS application_kind, context, content, outcome, assistance, result,
          limitations, insight, correction, references_text, relation_suggestion_json,
          NULL AS active, NULL AS previous_event_id,
          NULL AS config_revision, NULL AS half_life_days, NULL AS anchor_event_id,
          NULL AS elapsed_days, NULL AS decay, NULL AS answer, NULL AS rating,
          NULL AS exposure, NULL AS observed_exposure, NULL AS learning_json, NULL AS evidence_mode
        FROM applications
        WHERE namespace = ? AND concept_id = ?
      )
      SELECT event_type, event_id, concept_id, source_revision, event_at, recorded_at,
        kind, application_kind, context, content, outcome, assistance, result, limitations,
        insight, correction, references_text, relation_suggestion_json, active, previous_event_id, config_revision,
        half_life_days, anchor_event_id, elapsed_days, decay, answer, rating, exposure,
        observed_exposure, learning_json, evidence_mode
      FROM history
      ${historyFilter}
      ORDER BY event_at DESC, recorded_at DESC, event_id DESC
      LIMIT ?
    `).all(...queryParameters) as HistoryRow[];

    const totalParameters: Array<string> = applicationEventId === undefined
      ? [
        this.namespace, concept.id,
        this.namespace, concept.id,
        this.namespace, concept.id,
        this.namespace, concept.id,
      ]
      : [this.namespace, concept.id, applicationEventId];
    const totalRow = this.db.prepare(applicationEventId === undefined
      ? `
        SELECT
          (SELECT COUNT(*) FROM anchors WHERE namespace = ? AND concept_id = ?)
          + (SELECT COUNT(*) FROM observations WHERE namespace = ? AND concept_id = ?)
          + (SELECT COUNT(*) FROM retentions WHERE namespace = ? AND concept_id = ?)
          + (SELECT COUNT(*) FROM applications WHERE namespace = ? AND concept_id = ?) AS total
      `
      : `
        SELECT COUNT(*) AS total
        FROM applications WHERE namespace = ? AND concept_id = ? AND event_id = ?
      `).get(...totalParameters) as { total: number };
    if (applicationEventId !== undefined && totalRow.total === 0) {
      throw new StoreError('APPLICATION_NOT_FOUND', '找不到同一知识空间和概念中的应用记录。', 404);
    }
    const correctionCountRow = this.db.prepare(`SELECT COUNT(*) AS count
      FROM corrections WHERE namespace = ? AND concept_id = ?`).get(this.namespace, concept.id) as { count: number };

    const hasNext = rows.length > limit;
    const page = hasNext ? rows.slice(0, limit) : rows;
    const entries: ConceptHistoryEntry[] = page.map((row) => {
      if (row.event_type === 'anchor') {
        return {
          type: 'anchor',
          event: {
            eventId: row.event_id,
            conceptId: row.concept_id,
            sourceRevision: row.source_revision,
            occurredAt: row.event_at,
            recordedAt: row.recorded_at,
            kind: row.kind as 'review' | 'estimated',
          },
        };
      }
      if (row.event_type === 'retention') {
        return {
          type: 'retention',
          event: {
            eventId: row.event_id,
            conceptId: row.concept_id,
            sourceRevision: row.source_revision,
            occurredAt: row.event_at,
            recordedAt: row.recorded_at,
            active: Boolean(row.active),
            previousEventId: row.previous_event_id,
          },
        };
      }
      if (row.event_type === 'application') {
        return {
          type: 'application',
          event: {
            eventId: row.event_id,
            conceptId: row.concept_id,
            sourceRevision: row.source_revision,
            occurredAt: row.event_at,
            recordedAt: row.recorded_at,
            kind: row.application_kind as 'application' | 'summary',
            context: row.context as string,
            content: row.content as string,
            outcome: row.outcome as 'success' | 'partial' | 'failure' | 'unverified',
            assistance: row.assistance as 'independent' | 'resources' | 'people-or-ai' | 'mixed' | 'unknown',
            result: row.result as string,
            limitations: row.limitations as string,
            insight: row.insight as string,
            correction: row.correction as string,
            references: row.references_text as string,
            ...(row.relation_suggestion_json === null ? {} : { relationSuggestion: parseRelationSuggestion(JSON.parse(row.relation_suggestion_json), { conceptId: row.concept_id, sourceRevision: row.source_revision }) }),
          },
        };
      }
      const learning = parseStoredLearning(row.learning_json);
      return {
        type: 'observation',
        event: {
          eventId: row.event_id,
          conceptId: row.concept_id,
          sourceRevision: row.source_revision,
          observedAt: row.event_at,
          recordedAt: row.recorded_at,
          configRevision: row.config_revision as number,
          halfLifeDays: row.half_life_days as number,
          anchorEventId: row.anchor_event_id,
          elapsedDays: row.elapsed_days,
          decay: row.decay,
          answer: row.answer as string,
          rating: row.rating as RecallRating,
          exposure: row.exposure as 'unexposed' | 'exposed' | 'unknown',
          observedExposure: Boolean(row.observed_exposure),
          ...(learning ? { learning } : {}),
          ...(row.evidence_mode !== null ? { evidenceMode: normalizeObservationEvidenceMode(row.evidence_mode, row.answer) } : {}),
        },
      };
    });
    const last = page.at(-1);
    const nextCursor = hasNext && last ? encodeHistoryCursor({
      namespace: this.namespace,
      conceptId: concept.id,
      eventAt: last.event_at,
      recordedAt: last.recorded_at,
      eventId: last.event_id,
    }) : null;
    const states = this.getStates([concept], normalizedAsOf);
    const state = states[concept.id];
    if (!state) throw new StoreError('HISTORY_STATE_FAILED', '无法生成概念当前状态。', 500);
    const corrections: Record<string, CorrectionHistory> = {};
    for (const entry of page) {
      if (entry.event_type === 'application') {
        corrections[entry.event_id] = this.getCorrectionHistory(entry.event_id);
      }
    }
    const assessmentProjection = this.getObservationProjection(normalizedAsOf, concept.id);
    const conceptObservations = assessmentProjection.effective.map(item => item.observation);
    return {
      sourceId: this.namespace,
      conceptId: concept.id,
      sourceRevision: concept.source.revision,
      asOf: normalizedAsOf,
      state,
      entries,
      total: totalRow.total,
      nextCursor,
      ...(applicationEventId === undefined ? {} : { focusedApplicationEventId: applicationEventId }),
      learning: summarizeLearning(conceptObservations.filter((event) => event.sourceRevision === concept.source.revision)),
      progress: buildLearningProgress({ conceptId: concept.id, sourceRevision: concept.source.revision,
        observations: conceptObservations, asOf: normalizedAsOf }),
      corrections,
      correctionCount: correctionCountRow.count,
      observationRevisionCount: this.observationRevisions.getRevisionCount(),
      observationAssessmentVersion: createHash('sha256').update(canonicalJson(assessmentProjection.states)).digest('hex'),
      observationAssessments: Object.fromEntries(assessmentProjection.states
        .filter(item => entries.some(entry => entry.type === 'observation' && entry.event.eventId === item.observationEventId))
        .map(({ audit: _audit, ...item }) => [item.observationEventId, item])),
    };
  }

  getStates(concepts: Concept[], asOf: string): Record<string, MemoryState> {
    const normalizedAsOf = normalizeDate(asOf);
    const config = this.getConfig();
    const states: Record<string, MemoryState> = {};
    for (const concept of concepts) {
      // Keep the newest real anchor even when asOf is a simulated time before it;
      // the shared projector will represent that as pending rather than inventing
      // an unknown state or clamping a negative delay to zero.
      const anchor = this.getAnchor(concept.id);
      const projected = projectMemory(concept, anchor, config, normalizedAsOf);
      const retention = this.getRetention(concept.id, normalizedAsOf);
      if (retention?.active) {
        states[concept.id] = {
          ...projected,
          status: 'retained',
          decay: null,
          elapsedDays: null,
          retention,
          reason: projected.reason
            ? `${projected.reason} 仍长期保持直到手动解除。`
            : '本人确认长期保持，仍长期保持直到手动解除；可手动恢复衰减。',
        };
      } else {
        states[concept.id] = { ...projected, retention };
      }
    }
    return states;
  }

  getLayout(): Layout {
    return this.snapshotRepository.getLayout();
  }

  /**
   * Read scheduling preferences without materializing a default row. Keeping
   * the default virtual makes a GET/export genuinely read-only and preserves
   * the same namespace isolation as the learning records.
   */
  getReviewPlan(): ReviewPlan {
    return this.snapshotRepository.getReviewPlan();
  }

  /**
   * Apply one review-plan field with optimistic CAS. A replay that has the
  * same value as the current plan is accepted even with an old revision;
  * changed stale writes fail without modifying learning state.
  */
  updateReviewPlan(input: ReviewPlanUpdate): ReviewPlan {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new StoreError('INVALID_BODY', '请求体必须是 JSON 对象。');
    }
    const revision = input?.revision;
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw new StoreError('INVALID_REVISION', 'revision 必须是非负整数。');
    }
    const hasBudget = Object.prototype.hasOwnProperty.call(input, 'dailyBudget');
    const hasConcept = Object.prototype.hasOwnProperty.call(input, 'concept');
    if (hasBudget === hasConcept) {
      throw new StoreError('INVALID_BODY', '请求必须且只能更新 dailyBudget 或 concept。');
    }
    const mutation = hasBudget
      ? { dailyBudget: validateReviewBudget((input as { dailyBudget: unknown }).dailyBudget) }
      : { concept: normalizeReviewPlanConcept((input as { concept: unknown }).concept, this.now()) };

    try {
      this.db.exec('BEGIN IMMEDIATE');
      const current = this.getReviewPlanInTransaction();
      const nextConcepts = { ...current.concepts };
      let nextBudget = current.dailyBudget;
      if ('dailyBudget' in mutation) {
        nextBudget = (mutation as { dailyBudget: number }).dailyBudget;
      } else {
        Object.defineProperty(nextConcepts, mutation.concept.conceptId, {
          value: mutation.concept.preference,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      const unchanged = nextBudget === current.dailyBudget
        && canonicalJson(nextConcepts) === canonicalJson(current.concepts);
      if (unchanged) {
        this.db.exec('COMMIT');
        return current;
      }
      if (revision !== current.revision) {
        throw new StoreError('REVIEW_PLAN_CONFLICT', '复习计划版本已变化，请读取当前 revision 后重试。', 409);
      }
      const next: ReviewPlan = {
        revision: current.revision + 1,
        dailyBudget: nextBudget,
        concepts: nextConcepts,
      };
      this.db.prepare(`INSERT INTO review_plans(namespace, revision, daily_budget, concepts_json, recorded_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(namespace) DO UPDATE SET
          revision = excluded.revision,
          daily_budget = excluded.daily_budget,
          concepts_json = excluded.concepts_json,
          recorded_at = excluded.recorded_at`).run(
        this.namespace,
        next.revision,
        next.dailyBudget,
        canonicalJson(next.concepts),
        iso(this.now()),
      );
      this.db.exec('COMMIT');
      return next;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* preserve original error */ }
      if (error instanceof StoreError) throw error;
      throw new StoreError('WRITE_FAILED', safeSqliteMessage(error), 503);
    }
  }

  /**
   * Return concepts with at least one accepted non-scenario observation on
   * the requested local calendar day. Legacy observations have no learning
   * task and therefore count as concept recall.
   */
  getCompletedConceptIds(asOf: string, timeZone: string): string[] {
    const normalizedAsOf = normalizeDate(asOf, 'INVALID_AS_OF');
    const asOfMs = parseDate(normalizedAsOf);
    const dayKey = reviewDayKey(normalizedAsOf, timeZone);
    const completed = new Set<string>();
    for (const observation of this.getObservations()) {
      const observedMs = parseDate(observation.observedAt, 'INVALID_OBSERVED_AT');
      const recordedMs = parseDate(observation.recordedAt, 'INVALID_RECORDED_AT');
      if (observedMs > asOfMs || recordedMs > asOfMs || reviewDayKey(observation.observedAt, timeZone) !== dayKey) continue;
      if (observation.learning?.task === 'scenario') continue;
      completed.add(observation.conceptId);
    }
    return [...completed].sort();
  }

  private getReviewPlanInTransaction(): ReviewPlan {
    const row = this.db.prepare(`SELECT revision, daily_budget, concepts_json
      FROM review_plans WHERE namespace = ?`).get(this.namespace) as {
        revision: number;
        daily_budget: number;
        concepts_json: string;
      } | undefined;
    return row ? this.parseReviewPlanRow(row) : {
      revision: 0,
      dailyBudget: DEFAULT_DAILY_REVIEW_BUDGET,
      concepts: {},
    };
  }

  private parseReviewPlanRow(row: { revision: number; daily_budget: number; concepts_json: string }): ReviewPlan {
    return parseReviewPlanRow(row);
  }

  setLayout(layout: Layout): Layout {
    const recordedAt = iso(this.now());
    const json = canonicalJson(layout);
    try {
      this.db.exec('BEGIN IMMEDIATE');
      this.db.prepare(`INSERT INTO layouts(namespace, layout_json, recorded_at) VALUES (?, ?, ?)
        ON CONFLICT(namespace) DO UPDATE SET layout_json = excluded.layout_json, recorded_at = excluded.recorded_at`).run(this.namespace, json, recordedAt);
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* preserve original error */ }
      throw new StoreError('WRITE_FAILED', safeSqliteMessage(error), 503);
    }
    return layout;
  }

  /** Remember the current, already identity-projected source metadata. */
  rememberConcepts(concepts: Concept[]): void {
    if (!Array.isArray(concepts)) throw new StoreError('INVALID_IDENTITY', 'concepts 必须是数组。');
    const seen = new Set<string>();
    const rows = concepts.map((concept) => {
      if (!concept || typeof concept !== 'object') throw new StoreError('INVALID_IDENTITY', 'concepts 包含无效概念。');
      const id = identityId(concept.id, 'concept.id');
      if (seen.has(id)) throw new StoreError('INVALID_IDENTITY', `concepts 中存在重复 ID：${id}。`);
      seen.add(id);
      const title = typeof concept.title === 'string' ? concept.title : '';
      const path = identityPath(concept.source?.path, 'concept.source.path');
      const revision = identityPath(concept.source?.revision, 'concept.source.revision');
      return { id, title, path, revision };
    });
    if (rows.length === 0) return;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      for (const row of rows) {
        this.db.prepare(`INSERT INTO identity_catalog(namespace, concept_id, title, source_path, source_revision)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(namespace, concept_id) DO UPDATE SET
            title = excluded.title,
            source_path = excluded.source_path,
            source_revision = excluded.source_revision`).run(
          this.namespace, row.id, row.title, row.path, row.revision,
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* preserve original error */ }
      if (error instanceof StoreError) throw error;
      throw new StoreError('WRITE_FAILED', safeSqliteMessage(error), 503);
    }
  }

  getIdentityStatus(concepts: Concept[]): IdentityStatus {
    if (!Array.isArray(concepts)) throw new StoreError('INVALID_IDENTITY', 'concepts 必须是数组。');
    const liveById = new Map<string, Concept>();
    for (const concept of concepts) {
      const id = identityId(concept?.id, 'concept.id');
      if (liveById.has(id)) throw new StoreError('INVALID_IDENTITY', `当前知识源存在重复概念 ID：${id}。`);
      liveById.set(id, concept);
    }

    const bindings = this.getIdentityBindings();
    const boundRawIds = new Set(bindings.map((binding) => binding.rawConceptId));
    const metadata = new Map<string, { title: string; path: string | null; revision: string | null }>();
    for (const concept of this.getImportedConcepts()) {
      metadata.set(concept.id, { title: concept.title, path: concept.source.path, revision: concept.source.revision });
    }
    // The identity catalog is the local source of truth for a remembered ID;
    // imported metadata remains a fallback for older/orphaned records.
    for (const concept of this.getIdentityCatalog()) {
      metadata.set(concept.id, { title: concept.title, path: concept.path, revision: concept.revision });
    }
    const latestBindingByConcept = new Map<string, IdentityBinding>();
    for (const binding of bindings) latestBindingByConcept.set(binding.conceptId, binding);
    for (const binding of latestBindingByConcept.values()) {
      if (!metadata.has(binding.conceptId)) {
        metadata.set(binding.conceptId, { title: '', path: binding.toPath, revision: binding.sourceRevision });
      }
    }

    type IdentityCountRow = {
      concept_id: string;
      anchors: number;
      observations: number;
      retentions: number;
      applications: number;
      practice_cards?: number;
      practice_attempts?: number;
    };
    const countRows = this.db.prepare(`
      SELECT concept_id,
        SUM(CASE WHEN event_kind = 'anchors' THEN event_count ELSE 0 END) AS anchors,
        SUM(CASE WHEN event_kind = 'observations' THEN event_count ELSE 0 END) AS observations,
        SUM(CASE WHEN event_kind = 'retentions' THEN event_count ELSE 0 END) AS retentions,
        SUM(CASE WHEN event_kind = 'applications' THEN event_count ELSE 0 END) AS applications,
        SUM(CASE WHEN event_kind = 'practice_cards' THEN event_count ELSE 0 END) AS practice_cards,
        SUM(CASE WHEN event_kind = 'practice_attempts' THEN event_count ELSE 0 END) AS practice_attempts
      FROM (
        SELECT concept_id, 'anchors' AS event_kind, COUNT(*) AS event_count
          FROM anchors WHERE namespace = ? GROUP BY concept_id
        UNION ALL
        SELECT concept_id, 'observations' AS event_kind, COUNT(*) AS event_count
          FROM observations WHERE namespace = ? GROUP BY concept_id
        UNION ALL
        SELECT concept_id, 'retentions' AS event_kind, COUNT(*) AS event_count
          FROM retentions WHERE namespace = ? GROUP BY concept_id
        UNION ALL
        SELECT concept_id, 'applications' AS event_kind, COUNT(*) AS event_count
          FROM applications WHERE namespace = ? GROUP BY concept_id
        UNION ALL
        SELECT concept_id, 'practice_cards' AS event_kind, COUNT(DISTINCT card_event_id) AS event_count
          FROM practice_card_sources WHERE namespace = ? GROUP BY concept_id
        UNION ALL
        SELECT sources.concept_id, 'practice_attempts' AS event_kind, COUNT(DISTINCT attempts.event_id) AS event_count
          FROM practice_card_sources AS sources
          JOIN practice_attempts AS attempts
            ON attempts.namespace = sources.namespace AND attempts.card_event_id = sources.card_event_id
          WHERE sources.namespace = ?
          GROUP BY sources.concept_id
      )
      GROUP BY concept_id`).all(
      this.namespace,
      this.namespace,
      this.namespace,
      this.namespace,
      this.namespace,
      this.namespace,
    ) as IdentityCountRow[];
    const counts = new Map<string, IdentityCountRow>();
    for (const row of countRows) counts.set(row.concept_id, row);

    const layout = this.getLayout();
    const plan = this.getReviewPlan();
    const references = new Set<string>([
      ...metadata.keys(),
      ...liveById.keys(),
      ...counts.keys(),
      ...Object.keys(layout),
      ...Object.keys(plan.concepts),
      ...bindings.map((binding) => binding.conceptId),
    ]);
    const identityConcept = (id: string, live?: Concept): IdentityConcept => {
      const row = counts.get(id);
      const source = live
        ? { title: live.title, path: live.source.path, revision: live.source.revision }
        : metadata.get(id) ?? { title: '', path: null, revision: null };
      const preference = Object.prototype.hasOwnProperty.call(plan.concepts, id) ? plan.concepts[id] : null;
      const identityCounts: IdentityConcept['counts'] = {
        anchors: row?.anchors ?? 0,
        observations: row?.observations ?? 0,
        retentions: row?.retentions ?? 0,
        applications: row?.applications ?? 0,
      };
      if ((row?.practice_cards ?? 0) > 0) identityCounts.practiceCards = row?.practice_cards;
      if ((row?.practice_attempts ?? 0) > 0) identityCounts.practiceAttempts = row?.practice_attempts;
      return {
        conceptId: id,
        title: source.title,
        path: source.path,
        sourceRevision: source.revision,
        counts: identityCounts,
        hasLayout: Object.prototype.hasOwnProperty.call(layout, id),
        preference,
      };
    };

    const targets = [...liveById.entries()]
      .map(([id, concept]) => identityConcept(id, concept))
      .sort((left, right) => left.conceptId.localeCompare(right.conceptId));
    const liveIds = new Set(liveById.keys());
    const orphans = [...references]
      .filter((id) => !liveIds.has(id) && !boundRawIds.has(id))
      .map((id) => identityConcept(id))
      .sort((left, right) => left.conceptId.localeCompare(right.conceptId));
    return { sourceId: this.namespace, orphans, targets, bindings };
  }

  private identityToken(source: ExportData['source'], concepts: Concept[], request: IdentityLinkRequest, status: IdentityStatus): string {
    const current = this.exportData(source, concepts);
    const currentWithoutTime = { ...current, exportedAt: '' };
    const live = concepts.map((concept) => ({ id: concept.id, path: concept.source.path, revision: concept.source.revision }))
      .sort((left, right) => left.id.localeCompare(right.id));
    return createHash('sha256').update(canonicalJson({
      request,
      current: currentWithoutTime,
      live,
      catalog: this.getIdentityCatalog(),
      status,
      bindings: status.bindings,
    }), 'utf8').digest('hex');
  }

  previewIdentityLink(
    request: IdentityLinkRequest,
    source: ExportData['source'],
    concepts: Concept[],
  ): IdentityLinkPreview {
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      throw new StoreError('INVALID_BODY', '身份关联请求必须是 JSON 对象。');
    }
    const fromConceptId = identityId(request.fromConceptId, 'fromConceptId');
    const toConceptId = identityId(request.toConceptId, 'toConceptId');
    const normalizedRequest = { fromConceptId, toConceptId };
    const status = this.getIdentityStatus(concepts);
    const from = status.orphans.find((item) => item.conceptId === fromConceptId) ?? emptyIdentityConcept(fromConceptId);
    const targetConcept = concepts.find((concept) => concept.id === toConceptId);
    const to = targetConcept
      ? status.targets.find((item) => item.conceptId === toConceptId) ?? emptyIdentityConcept(toConceptId, targetConcept.title)
      : emptyIdentityConcept(toConceptId);
    const issues: IdentityLinkPreview['issues'] = [];
    const error = (code: string, message: string): void => { issues.push({ severity: 'error', code, message }); };
    const warning = (code: string, message: string): void => { issues.push({ severity: 'warning', code, message }); };
    const bindingsByRaw = new Map(status.bindings.map((binding) => [binding.rawConceptId, binding]));
    const canonicalIds = new Set(status.bindings.map((binding) => binding.conceptId));

    if (!status.orphans.some((item) => item.conceptId === fromConceptId)) {
      error('IDENTITY_FROM_NOT_FOUND', `找不到待关联的失联概念 ${fromConceptId}。`);
    }
    if (bindingsByRaw.has(fromConceptId)) {
      error('IDENTITY_FROM_RAW_ALIAS', `概念 ${fromConceptId} 已是已登记路径别名，请从稳定概念 ID 发起下一次移动。`);
    }
    if (!targetConcept) error('IDENTITY_TARGET_NOT_FOUND', `找不到当前目标概念 ${toConceptId}。`);
    if (fromConceptId === toConceptId) error('IDENTITY_SAME_CONCEPT', '来源概念和目标概念必须不同。');
    if (bindingsByRaw.has(toConceptId)) error('IDENTITY_TARGET_RAW_ALIAS', `目标概念 ${toConceptId} 已是已登记路径别名。`);
    if (canonicalIds.has(toConceptId)) error('IDENTITY_TARGET_CANONICAL', `目标概念 ${toConceptId} 已是稳定身份，不能再次作为原始目标。`);
    if (targetConcept && (to.counts.anchors + to.counts.observations + to.counts.retentions + to.counts.applications
      + (to.counts.practiceCards ?? 0) + (to.counts.practiceAttempts ?? 0) > 0)) {
      error('IDENTITY_TARGET_HAS_HISTORY', `目标概念 ${toConceptId} 已有学习历史，不能合并两套身份。`);
    }
    if (targetConcept && !isDefaultReviewPreference(to.preference)) {
      error('IDENTITY_TARGET_HAS_PREFERENCE', `目标概念 ${toConceptId} 已有非默认复习安排，不能合并两套身份。`);
    }

    const revisionMatches = Boolean(from.sourceRevision && targetConcept && from.sourceRevision === targetConcept.source.revision);
    if (!revisionMatches && targetConcept) {
      warning('IDENTITY_SOURCE_REVISION_MISMATCH', '来源版本与当前目标版本不同；历史事件将保留原版本，当前起点可能保持待确认。');
    }
    const layoutAction: IdentityLinkPreview['layoutAction'] = from.hasLayout
      ? 'keep-original'
      : to.hasLayout ? 'adopt-target' : 'none';
    return {
      sourceId: this.namespace,
      token: this.identityToken(source, concepts, normalizedRequest, status),
      canLink: !issues.some((issue) => issue.severity === 'error'),
      from,
      to,
      revisionMatches,
      issues,
      layoutAction,
    };
  }

  commitIdentityLink(
    request: IdentityLinkCommit,
    source: ExportData['source'],
    concepts: Concept[],
    beforeWrite: (backup: ExportData) => string,
  ): import('../shared/identity.js').IdentityLinkReceipt {
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      throw new StoreError('INVALID_BODY', '身份关联提交请求必须是 JSON 对象。');
    }
    const operationId = identityId(request.operationId, 'operationId');
    this.ensureEventId(operationId);
    if (request.confirmed !== true) throw new StoreError('IDENTITY_NOT_CONFIRMED', '身份关联提交前必须确认预览结果。');
    const normalizedRequest: IdentityLinkCommit = {
      operationId,
      fromConceptId: identityId(request.fromConceptId, 'fromConceptId'),
      toConceptId: identityId(request.toConceptId, 'toConceptId'),
      previewToken: identityId(request.previewToken, 'previewToken'),
      confirmed: true,
    };
    const requestHash = createHash('sha256').update(canonicalJson(normalizedRequest), 'utf8').digest('hex');
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const existing = this.db.prepare(`SELECT request_hash, receipt_json
        FROM identity_bindings WHERE namespace = ? AND operation_id = ?`).get(this.namespace, operationId) as {
          request_hash: string; receipt_json: string;
        } | undefined;
      if (existing) {
        if (existing.request_hash !== requestHash) throw new StoreError('IDENTITY_CONFLICT', 'operationId 已被其他身份关联请求使用。', 409);
        let original: import('../shared/identity.js').IdentityLinkReceipt;
        try { original = JSON.parse(existing.receipt_json) as import('../shared/identity.js').IdentityLinkReceipt; } catch {
          throw new StoreError('IDENTITY_RECEIPT_CORRUPT', '身份关联收据数据无效，请检查本地数据。', 500);
        }
        this.db.exec('COMMIT');
        return { ...original, status: 'duplicate' };
      }

      const current = this.exportData(source, concepts);
      const preview = this.previewIdentityLink(normalizedRequest, source, concepts);
      if (preview.sourceId !== this.namespace || preview.token !== normalizedRequest.previewToken) {
        throw new StoreError('IDENTITY_STALE', '身份关联预览已过期，请重新生成预览。', 409);
      }
      if (!preview.canLink) throw new StoreError('IDENTITY_REJECTED', '身份关联预览包含必须先处理的问题。', 409);
      const backupId = beforeWrite(current);
      if (typeof backupId !== 'string' || !backupId.trim()) {
        throw new StoreError('IDENTITY_BACKUP_FAILED', '身份关联前备份未返回有效标识。', 503);
      }

      const confirmedAt = iso(this.now());
      const binding: IdentityBinding = {
        operationId,
        rawConceptId: preview.to.conceptId,
        conceptId: preview.from.conceptId,
        fromPath: preview.from.path,
        toPath: preview.to.path as string,
        sourceRevision: preview.to.sourceRevision as string,
        confirmedAt,
        backupId,
      };
      const receipt: import('../shared/identity.js').IdentityLinkReceipt = {
        status: 'accepted',
        operationId,
        sourceId: this.namespace,
        conceptId: binding.conceptId,
        linkedPath: binding.toPath,
        confirmedAt,
        backupId,
      };
      this.db.prepare(`INSERT INTO identity_bindings(
        namespace, operation_id, raw_concept_id, concept_id, from_path, to_path,
        source_revision, confirmed_at, backup_id, request_hash, receipt_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        this.namespace,
        binding.operationId,
        binding.rawConceptId,
        binding.conceptId,
        binding.fromPath,
        binding.toPath,
        binding.sourceRevision,
        binding.confirmedAt,
        binding.backupId,
        requestHash,
        canonicalJson(receipt),
      );
      this.db.prepare(`INSERT INTO identity_catalog(namespace, concept_id, title, source_path, source_revision)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(namespace, concept_id) DO UPDATE SET
          title = excluded.title,
          source_path = excluded.source_path,
          source_revision = excluded.source_revision`).run(
        this.namespace,
        binding.conceptId,
        preview.to.title,
        binding.toPath,
        binding.sourceRevision,
      );

      const layout = this.getLayout();
      const hadLayoutRow = this.db.prepare('SELECT 1 AS present FROM layouts WHERE namespace = ?').get(this.namespace) !== undefined;
      const oldPosition = Object.prototype.hasOwnProperty.call(layout, binding.conceptId) ? layout[binding.conceptId] : undefined;
      const targetPosition = Object.prototype.hasOwnProperty.call(layout, binding.rawConceptId) ? layout[binding.rawConceptId] : undefined;
      if (!oldPosition && targetPosition) layout[binding.conceptId] = { ...targetPosition };
      if (Object.prototype.hasOwnProperty.call(layout, binding.rawConceptId)) delete layout[binding.rawConceptId];
      const layoutChanged = !sameCanonicalJson(layout, this.getLayout());
      if (layoutChanged || hadLayoutRow && !Object.keys(layout).length) {
        this.db.prepare(`INSERT INTO layouts(namespace, layout_json, recorded_at) VALUES (?, ?, ?)
          ON CONFLICT(namespace) DO UPDATE SET layout_json = excluded.layout_json, recorded_at = excluded.recorded_at`).run(
          this.namespace, canonicalJson(layout), confirmedAt,
        );
      }

      this.db.exec('COMMIT');
      return receipt;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* preserve original error */ }
      if (error instanceof StoreError) throw error;
      throw new StoreError('IDENTITY_FAILED', safeSqliteMessage(error), 503);
    }
  }

  private buildPreparedImport(
    data: unknown,
    options: unknown,
    source: ExportData['source'],
    concepts: Concept[],
    current?: ExportData,
  ): PreparedImport {
    const currentExport = current ?? this.exportData(source, concepts);
    const importOptions = normalizeImportOptions(options);
    return buildImportPlan({
      data,
      options: importOptions,
      current: currentExport,
      concepts,
      sourceId: this.namespace,
      now: iso(this.now()),
      acceptedPaths: this.getIdentityAcceptedPaths(),
    });
  }

  previewImport(
    data: unknown,
    options: unknown,
    source: ExportData['source'],
    concepts: Concept[],
  ): ImportPreview {
    return this.buildPreparedImport(data, options, source, concepts).preview;
  }

  commitImport(
    request: ImportCommitRequest,
    source: ExportData['source'],
    concepts: Concept[],
    beforeWrite: (backup: ExportData) => string,
  ): ImportReceipt {
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      throw new StoreError('INVALID_BODY', '导入提交请求必须是 JSON 对象。');
    }
    this.ensureEventId(request.importId);
    if (request.confirmed !== true) throw new StoreError('IMPORT_NOT_CONFIRMED', '导入前必须确认预览结果。');
    const requestHash = createHash('sha256').update(canonicalJson(request), 'utf8').digest('hex');
    let ownsTxn = false;
    try {
      this.db.exec('BEGIN IMMEDIATE'); ownsTxn = true;
      const existing = this.db.prepare(`SELECT request_hash, receipt_json
        FROM import_receipts WHERE namespace = ? AND import_id = ?`).get(this.namespace, request.importId) as {
          request_hash: string; receipt_json: string;
        } | undefined;
      if (existing) {
        if (existing.request_hash !== requestHash) {
          throw new StoreError('IMPORT_CONFLICT', 'importId 已被其他导入请求使用。', 409);
        }
        let original: ImportReceipt;
        try { original = JSON.parse(existing.receipt_json) as ImportReceipt; } catch {
          throw new StoreError('IMPORT_RECEIPT_CORRUPT', '导入收据数据无效，请检查本地数据。', 500);
        }
        this.db.exec('COMMIT'); ownsTxn = false;
        return { ...original, status: 'duplicate' };
      }

      const current = this.exportData(source, concepts);
      const prepared = this.buildPreparedImport(request.data, request.options, source, concepts, current);
      if (prepared.preview.sourceId !== this.namespace || prepared.preview.token !== request.previewToken) {
        throw new StoreError('IMPORT_STALE', '导入预览已过期，请重新生成预览。', 409);
      }
      if (!prepared.preview.canImport) {
        throw new StoreError('IMPORT_REJECTED', '导入预览包含必须先处理的问题。', 409);
      }
      const backupId = beforeWrite(current);
      if (typeof backupId !== 'string' || !backupId.trim()) {
        throw new StoreError('IMPORT_BACKUP_FAILED', '导入前备份未返回有效标识。', 503);
      }

      this.importRepository.applyPreparedImport(prepared, normalizeImportOptions(request.options));

      const accepted: ImportReceipt = {
        status: 'accepted',
        importId: request.importId,
        sourceId: this.namespace,
        importedAt: iso(this.now()),
        counts: prepared.preview.counts,
        backupId,
      };
      this.db.prepare(`INSERT INTO import_receipts(namespace, import_id, request_hash, receipt_json)
        VALUES (?, ?, ?, ?)`).run(this.namespace, request.importId, requestHash, canonicalJson(accepted));
      this.db.exec('COMMIT'); ownsTxn = false;
      return accepted;
    } catch (error) {
      if (ownsTxn) { try { this.db.exec('ROLLBACK'); } catch { /* preserve original error */ } }
      if (error instanceof StoreError) throw error;
      throw new StoreError('IMPORT_FAILED', safeSqliteMessage(error), 503);
    }
  }

  exportData(source: ExportData['source'], concepts: Concept[]): ExportDataV2 {
    return this.snapshotRepository.exportData(source, concepts);
  }

}

export function parseReviewRequest(value: unknown): ReviewRequest {
  const record = asRecord(value);
  const kind = requireString(record, 'kind');
  if (kind !== 'review' && kind !== 'estimated') throw new StoreError('INVALID_BODY', 'kind 必须是 review 或 estimated。');
  const result: ReviewRequest = {
    eventId: requireString(record, 'eventId'),
    conceptId: requireString(record, 'conceptId'),
    sourceRevision: requireString(record, 'sourceRevision'),
    kind,
  };
  if (record.occurredAt !== undefined) result.occurredAt = requireString(record, 'occurredAt');
  if (kind === 'estimated' && result.occurredAt === undefined) throw new StoreError('INVALID_BODY', 'estimated 事件必须提供 occurredAt。');
  return result;
}

export function parseRetentionRequest(value: unknown): RetentionRequest {
  const record = asRecord(value);
  const previous = record.previousEventId;
  if (previous !== null && (typeof previous !== 'string' || !previous.trim())) {
    throw new StoreError('INVALID_BODY', 'previousEventId 必须是非空字符串或 null。');
  }
  if (typeof record.active !== 'boolean') throw new StoreError('INVALID_BODY', 'active 必须是布尔值。');
  return {
    eventId: requireString(record, 'eventId'),
    conceptId: requireString(record, 'conceptId'),
    sourceRevision: requireString(record, 'sourceRevision'),
    occurredAt: requireString(record, 'occurredAt'),
    active: record.active,
    previousEventId: previous === null ? null : (previous as string).trim(),
  };
}

export function parseApplicationRequest(value: unknown): ApplicationRecordRequest {
  return normalizeApplicationRequest(value);
}

export function parseCorrectionRequest(value: unknown): CorrectionRequest {
  return normalizeCorrectionRequest(value);
}

export function parseLearningEvidence(value: unknown, observedAt?: string): LearningEvidence | undefined {
  return normalizeLearningEvidence(value, observedAt);
}

export function parseObservationRequest(value: unknown): ObservationRequest {
  const record = asRecord(value);
  const rating = requireString(record, 'rating');
  const exposure = requireString(record, 'exposure');
  if (!['clear', 'partial', 'blank'].includes(rating)) throw new StoreError('INVALID_BODY', 'rating 必须是 clear、partial 或 blank。');
  if (!['unexposed', 'exposed', 'unknown'].includes(exposure)) throw new StoreError('INVALID_BODY', 'exposure 必须是 unexposed、exposed 或 unknown。');
  const configRevision = requireFinite(record, 'configRevision');
  if (!Number.isInteger(configRevision) || configRevision < 1) throw new StoreError('INVALID_BODY', 'configRevision 必须是正整数。');
  const anchorValue = record.anchorEventId;
  if (anchorValue !== null && typeof anchorValue !== 'string') throw new StoreError('INVALID_BODY', 'anchorEventId 必须是字符串或 null。');
  if (typeof record.observedExposure !== 'boolean') throw new StoreError('INVALID_BODY', 'observedExposure 必须是布尔值。');
  const observedAt = normalizeDate(requireString(record, 'observedAt'), 'INVALID_OBSERVED_AT');
  const learning = normalizeLearningEvidence(record.learning, observedAt);
  const evidenceMode = normalizeObservationEvidenceMode(record.evidenceMode, record.answer);
  return {
    eventId: requireString(record, 'eventId'),
    conceptId: requireString(record, 'conceptId'),
    sourceRevision: requireString(record, 'sourceRevision'),
    observedAt,
    configRevision,
    anchorEventId: anchorValue as string | null,
    answer: typeof record.answer === 'string' ? record.answer : '',
    rating: rating as RecallRating,
    exposure: exposure as 'unexposed' | 'exposed' | 'unknown',
    observedExposure: record.observedExposure,
    ...(learning ? { learning } : {}),
    ...(evidenceMode ? { evidenceMode } : {}),
  };
}

export function parseRelationReviewRequest(value: unknown): RelationReviewRequest {
  try { return parseSharedRelationReviewRequest(value); }
  catch (error) { throw new StoreError('INVALID_BODY', error instanceof Error ? error.message : '关系复核请求无效。'); }
}
