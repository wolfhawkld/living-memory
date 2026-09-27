import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  AnchorEvent,
  ApplicationRecord,
  ApplicationRecordRequest,
  Concept,
  ConceptHistory,
  ConceptHistoryEntry,
  ExportData,
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
  reviewDayKey,
  type ConceptReviewPreference,
  type ReviewPlan,
  type ReviewPlanUpdate,
} from '../shared/review-plan.js';
import { DAY_MS, MODEL_VERSION } from '../shared/types.js';
import { decayAt, isValidInstant, projectMemory } from '../core/time-model.js';
import { summarizeLearning } from '../core/learning-evidence.js';
import { buildImportPlan, type PreparedConfig, type PreparedImport } from './import-plan.js';

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

interface ConceptHistoryCursor {
  namespace: string;
  conceptId: string;
  eventAt: string;
  recordedAt: string;
  eventId: string;
}

export class StoreError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
    this.status = status;
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function sameCanonicalJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function iso(value: Date): string {
  return value.toISOString();
}

function parseDate(value: string, code = 'INVALID_DATE'): number {
  if (!isValidInstant(value)) throw new StoreError(code, '时间格式无效，请使用带时区的 ISO 8601 时间。');
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new StoreError(code, '时间格式无效，请使用 ISO 8601 时间。');
  return parsed;
}

function normalizeDate(value: string, code = 'INVALID_DATE'): string {
  return new Date(parseDate(value, code)).toISOString();
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function computeDecay(anchorAt: string | null, halfLifeDays: number, asOf: string): { elapsedDays: number | null; decay: number | null } {
  if (!anchorAt) return { elapsedDays: null, decay: null };
  const elapsedDays = (parseDate(asOf) - parseDate(anchorAt)) / DAY_MS;
  return { elapsedDays, decay: decayAt(elapsedDays, halfLifeDays) };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new StoreError('INVALID_BODY', '请求体必须是 JSON 对象。');
  return value as Record<string, unknown>;
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

const LEARNING_TASKS = ['concept', 'scenario'] as const;
const LEARNING_CUES = ['independent', 'hinted', 'lookup', 'unknown'] as const;
const LEARNING_OUTCOMES = ['success', 'partial', 'failure', 'unverified'] as const;
const LEARNING_BASES = ['self-check', 'application', 'unknown'] as const;
const APPLICATION_KINDS = ['application', 'summary'] as const;
const APPLICATION_OUTCOMES = ['success', 'partial', 'failure', 'unverified'] as const;
const APPLICATION_ASSISTANCE = ['independent', 'resources', 'people-or-ai', 'mixed', 'unknown'] as const;

function isOneOf<T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === 'string' && values.includes(value);
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
  };
}

/**
 * Validate and normalize optional evidence attached to an observation. Keeping
 * this at the request boundary means old observations can remain NULL in the
 * additive JSON column, while every new record has one deterministic shape for
 * idempotency and export.
 */
function normalizeLearningEvidence(value: unknown, observedAt?: string): LearningEvidence | undefined {
  if (value === undefined) return undefined;
  const record = asRecord(value);
  if (!isOneOf(LEARNING_TASKS, record.task)) {
    throw new StoreError('INVALID_LEARNING', 'learning.task 必须是 concept 或 scenario。');
  }
  if (!isOneOf(LEARNING_CUES, record.cue)) {
    throw new StoreError('INVALID_LEARNING', 'learning.cue 必须是 independent、hinted、lookup 或 unknown。');
  }
  if (!isOneOf(LEARNING_OUTCOMES, record.outcome)) {
    throw new StoreError('INVALID_LEARNING', 'learning.outcome 必须是 success、partial、failure 或 unverified。');
  }
  if (!isOneOf(LEARNING_BASES, record.basis)) {
    throw new StoreError('INVALID_LEARNING', 'learning.basis 必须是 self-check、application 或 unknown。');
  }

  const confidence = record.confidence;
  if (confidence !== null && (!finiteNumber(confidence) || !Number.isInteger(confidence) || confidence < 0 || confidence > 100)) {
    throw new StoreError('INVALID_LEARNING', 'learning.confidence 必须是 0 到 100 的整数或 null。');
  }
  const rawConfidenceAt = record.confidenceAt;
  if (confidence === null) {
    if (rawConfidenceAt !== null) throw new StoreError('INVALID_LEARNING', 'confidenceAt 必须在 confidence 有值时提供，否则必须为 null。');
  } else if (typeof rawConfidenceAt !== 'string' || !rawConfidenceAt.trim()) {
    throw new StoreError('INVALID_LEARNING', 'confidenceAt 必须在 confidence 有值时提供。');
  }

  const confidenceAt = rawConfidenceAt === null
    ? null
    : normalizeDate(rawConfidenceAt as string, 'INVALID_CONFIDENCE_AT');
  if (confidenceAt && observedAt && parseDate(confidenceAt) > parseDate(observedAt, 'INVALID_OBSERVED_AT')) {
    throw new StoreError('INVALID_LEARNING', 'confidenceAt 不能晚于 observedAt。');
  }

  let scenario: string | undefined;
  if (record.task === 'scenario') {
    if (typeof record.scenario !== 'string' || !record.scenario.trim() || record.scenario.trim().length > 4000) {
      throw new StoreError('INVALID_LEARNING', 'scenario 任务必须包含不超过 4000 个字符的场景描述。');
    }
    scenario = record.scenario.trim();
  } else if (record.scenario !== undefined) {
    throw new StoreError('INVALID_LEARNING', 'concept 任务不能携带 scenario。');
  }

  let applicability: string | undefined;
  if (record.applicability !== undefined) {
    if (typeof record.applicability !== 'string' || !record.applicability.trim() || record.applicability.trim().length > 4000) {
      throw new StoreError('INVALID_LEARNING', 'applicability 必须是不超过 4000 个字符的非空说明。');
    }
    applicability = record.applicability.trim();
  }

  if (record.outcome !== 'unverified' && record.basis === 'unknown') {
    throw new StoreError('INVALID_LEARNING', '已验证的 learning.outcome 必须提供非 unknown 的 basis。');
  }

  return {
    task: record.task,
    ...(scenario !== undefined ? { scenario } : {}),
    ...(applicability !== undefined ? { applicability } : {}),
    confidence: confidence as number | null,
    confidenceAt,
    cue: record.cue,
    outcome: record.outcome,
    basis: record.basis,
  };
}

function parseStoredLearning(value: string | null): LearningEvidence | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return normalizeLearningEvidence(parsed);
  } catch {
    // A corrupt optional evidence blob must not make the complete history
    // unreadable. The original observation remains available without it.
    return undefined;
  }
}

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
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > MAX_DAILY_REVIEW_BUDGET) {
    throw new StoreError('INVALID_REVIEW_BUDGET', `dailyBudget 必须是 1 到 ${MAX_DAILY_REVIEW_BUDGET} 的整数。`);
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

export class Store {
  readonly namespace: string;
  readonly dbPath: string;
  private readonly now: () => Date;
  private readonly db: DatabaseSync;

  constructor(options: StoreOptions) {
    this.namespace = options.namespace;
    this.now = options.now ?? (() => new Date());
    this.dbPath = options.dbPath ?? join(options.dataDir ?? 'data/local', 'living-memory.sqlite');
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    this.initialize();
  }

  close(): void {
    this.db.close();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS namespaces (
        namespace TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS config_history (
        namespace TEXT NOT NULL,
        revision INTEGER NOT NULL,
        model_version TEXT NOT NULL,
        half_life_days REAL NOT NULL,
        recorded_at TEXT NOT NULL,
        PRIMARY KEY(namespace, revision)
      );
      CREATE TABLE IF NOT EXISTS anchors (
        namespace TEXT NOT NULL,
        event_id TEXT NOT NULL,
        concept_id TEXT NOT NULL,
        source_revision TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('review', 'estimated')),
        request_payload TEXT NOT NULL,
        PRIMARY KEY(namespace, event_id)
      );
      CREATE TABLE IF NOT EXISTS observations (
        namespace TEXT NOT NULL,
        event_id TEXT NOT NULL,
        concept_id TEXT NOT NULL,
        source_revision TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        config_revision INTEGER NOT NULL,
        half_life_days REAL NOT NULL,
        anchor_event_id TEXT,
        elapsed_days REAL,
        decay REAL,
        answer TEXT NOT NULL,
        rating TEXT NOT NULL CHECK(rating IN ('clear', 'partial', 'blank')),
        exposure TEXT NOT NULL CHECK(exposure IN ('unexposed', 'exposed', 'unknown')),
        observed_exposure INTEGER NOT NULL CHECK(observed_exposure IN (0, 1)),
        learning_json TEXT,
        request_payload TEXT NOT NULL,
        PRIMARY KEY(namespace, event_id)
      );
      CREATE TABLE IF NOT EXISTS retentions (
        namespace TEXT NOT NULL,
        event_id TEXT NOT NULL,
        concept_id TEXT NOT NULL,
        source_revision TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        active INTEGER NOT NULL CHECK(active IN (0, 1)),
        previous_event_id TEXT,
        request_payload TEXT NOT NULL,
        PRIMARY KEY(namespace, event_id)
      );
      CREATE TABLE IF NOT EXISTS applications (
        namespace TEXT NOT NULL,
        event_id TEXT NOT NULL,
        concept_id TEXT NOT NULL,
        source_revision TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('application', 'summary')),
        context TEXT NOT NULL,
        content TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK(outcome IN ('success', 'partial', 'failure', 'unverified')),
        assistance TEXT NOT NULL CHECK(assistance IN ('independent', 'resources', 'people-or-ai', 'mixed', 'unknown')),
        result TEXT NOT NULL,
        limitations TEXT NOT NULL,
        insight TEXT NOT NULL,
        correction TEXT NOT NULL,
        references_text TEXT NOT NULL,
        request_payload TEXT NOT NULL,
        PRIMARY KEY(namespace, event_id)
      );
      CREATE TABLE IF NOT EXISTS layouts (
        namespace TEXT PRIMARY KEY,
        layout_json TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS review_plans (
        namespace TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        daily_budget INTEGER NOT NULL,
        concepts_json TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS imported_concepts (
        namespace TEXT NOT NULL,
        concept_id TEXT NOT NULL,
        title TEXT NOT NULL,
        source_path TEXT NOT NULL,
        source_revision TEXT NOT NULL,
        PRIMARY KEY(namespace, concept_id)
      );
      CREATE TABLE IF NOT EXISTS identity_catalog (
        namespace TEXT NOT NULL,
        concept_id TEXT NOT NULL,
        title TEXT NOT NULL,
        source_path TEXT,
        source_revision TEXT,
        PRIMARY KEY(namespace, concept_id)
      );
      CREATE TABLE IF NOT EXISTS identity_bindings (
        namespace TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        raw_concept_id TEXT NOT NULL,
        concept_id TEXT NOT NULL,
        from_path TEXT,
        to_path TEXT NOT NULL,
        source_revision TEXT NOT NULL,
        confirmed_at TEXT NOT NULL,
        backup_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        receipt_json TEXT NOT NULL,
        PRIMARY KEY(namespace, operation_id),
        UNIQUE(namespace, raw_concept_id)
      );
      CREATE TABLE IF NOT EXISTS import_receipts (
        namespace TEXT NOT NULL,
        import_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        receipt_json TEXT NOT NULL,
        PRIMARY KEY(namespace, import_id)
      );
      CREATE INDEX IF NOT EXISTS anchors_by_concept_time
        ON anchors(namespace, concept_id, occurred_at, recorded_at);
      CREATE INDEX IF NOT EXISTS observations_by_concept
        ON observations(namespace, concept_id, observed_at);
      CREATE INDEX IF NOT EXISTS anchors_by_concept_history
        ON anchors(namespace, concept_id, occurred_at DESC, recorded_at DESC, event_id DESC);
      CREATE INDEX IF NOT EXISTS observations_by_concept_history
        ON observations(namespace, concept_id, observed_at DESC, recorded_at DESC, event_id DESC);
      CREATE INDEX IF NOT EXISTS retentions_by_concept_history
        ON retentions(namespace, concept_id, occurred_at DESC, recorded_at DESC, event_id DESC);
      CREATE INDEX IF NOT EXISTS applications_by_concept_history
        ON applications(namespace, concept_id, occurred_at DESC, recorded_at DESC, event_id DESC);
      CREATE INDEX IF NOT EXISTS identity_bindings_by_concept
        ON identity_bindings(namespace, concept_id, confirmed_at, operation_id);
    `);
    // CREATE TABLE IF NOT EXISTS does not update an existing SQLite table.
    // Keep the evidence column additive so databases created by older builds
    // remain readable without rewriting historical observations.
    const observationColumns = this.db.prepare('PRAGMA table_info(observations)').all() as Array<{ name: string }>;
    if (!observationColumns.some((column) => column.name === 'learning_json')) {
      this.db.exec('ALTER TABLE observations ADD COLUMN learning_json TEXT');
    }
    const createdAt = iso(this.now());
    this.db.prepare('INSERT OR IGNORE INTO namespaces(namespace, created_at) VALUES (?, ?)').run(this.namespace, createdAt);
    const existing = this.db.prepare('SELECT revision FROM config_history WHERE namespace = ? ORDER BY revision DESC LIMIT 1').get(this.namespace) as { revision?: number } | undefined;
    if (!existing) {
      this.db.prepare('INSERT INTO config_history(namespace, revision, model_version, half_life_days, recorded_at) VALUES (?, 1, ?, ?, ?)').run(this.namespace, MODEL_VERSION, DEFAULT_HALF_LIFE_DAYS, createdAt);
    }
  }

  getConfig(): ModelConfig {
    const row = this.db.prepare('SELECT model_version, revision, half_life_days FROM config_history WHERE namespace = ? ORDER BY revision DESC LIMIT 1').get(this.namespace) as { model_version: string; revision: number; half_life_days: number };
    return { modelVersion: MODEL_VERSION, halfLifeDays: row.half_life_days, revision: row.revision };
  }

  getConfigAt(revision: number): ModelConfig | null {
    const row = this.db.prepare('SELECT model_version, revision, half_life_days FROM config_history WHERE namespace = ? AND revision = ?').get(this.namespace, revision) as { model_version: string; revision: number; half_life_days: number } | undefined;
    return row ? { modelVersion: MODEL_VERSION, halfLifeDays: row.half_life_days, revision: row.revision } : null;
  }

  getConfigHistory(): ModelConfig[] {
    const rows = this.db.prepare('SELECT revision, half_life_days FROM config_history WHERE namespace = ? ORDER BY revision ASC').all(this.namespace) as Array<{ revision: number; half_life_days: number }>;
    return rows.map((row) => ({ modelVersion: MODEL_VERSION, halfLifeDays: row.half_life_days, revision: row.revision }));
  }

  updateConfig(halfLifeDays: number, expectedRevision: number): ModelConfig {
    if (!finiteNumber(halfLifeDays) || halfLifeDays <= 0 || halfLifeDays > 3650) {
      throw new StoreError('INVALID_HALF_LIFE', 'halfLifeDays 必须大于 0 且不超过 3650。');
    }
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
      throw new StoreError('INVALID_REVISION', 'revision 必须是正整数。');
    }
    const current = this.getConfig();
    if (expectedRevision !== current.revision) {
      throw new StoreError('CONFIG_CONFLICT', '配置版本已变化，请读取当前 revision 后重试。', 409);
    }
    const next = current.revision + 1;
    const recordedAt = iso(this.now());
    try {
      this.db.exec('BEGIN IMMEDIATE');
      this.db.prepare('INSERT INTO config_history(namespace, revision, model_version, half_life_days, recorded_at) VALUES (?, ?, ?, ?, ?)').run(this.namespace, next, MODEL_VERSION, halfLifeDays, recordedAt);
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* preserve original error */ }
      if (error instanceof StoreError) throw error;
      throw new StoreError('WRITE_FAILED', safeSqliteMessage(error), 503);
    }
    return { modelVersion: MODEL_VERSION, halfLifeDays, revision: next };
  }

  private findEvent(eventId: string): { kind: 'anchor' | 'observation' | 'retention' | 'application'; payload: string } | null {
    const anchor = this.db.prepare('SELECT request_payload FROM anchors WHERE namespace = ? AND event_id = ?').get(this.namespace, eventId) as { request_payload: string } | undefined;
    if (anchor) return { kind: 'anchor', payload: anchor.request_payload };
    const observation = this.db.prepare('SELECT request_payload FROM observations WHERE namespace = ? AND event_id = ?').get(this.namespace, eventId) as { request_payload: string } | undefined;
    if (observation) return { kind: 'observation', payload: observation.request_payload };
    const retention = this.db.prepare('SELECT request_payload FROM retentions WHERE namespace = ? AND event_id = ?').get(this.namespace, eventId) as { request_payload: string } | undefined;
    if (retention) return { kind: 'retention', payload: retention.request_payload };
    const application = this.db.prepare('SELECT request_payload FROM applications WHERE namespace = ? AND event_id = ?').get(this.namespace, eventId) as { request_payload: string } | undefined;
    return application ? { kind: 'application', payload: application.request_payload } : null;
  }

  hasEvent(eventId: string): boolean {
    return this.findEvent(eventId) !== null;
  }

  private ensureEventId(eventId: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(eventId)) throw new StoreError('INVALID_EVENT_ID', 'eventId 只能包含字母、数字、点、下划线、冒号或短横线，长度不超过 128。');
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
    try {
      this.db.exec('BEGIN IMMEDIATE');
      this.db.prepare(`INSERT INTO anchors(namespace, event_id, concept_id, source_revision, occurred_at, recorded_at, kind, request_payload)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(this.namespace, input.eventId, input.conceptId, input.sourceRevision, occurredAt, recordedAt, input.kind, requestPayload);
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* preserve original error */ }
      throw new StoreError('WRITE_FAILED', safeSqliteMessage(error), 503);
    }
    return { status: 'accepted', eventId: input.eventId };
  }

  addObservation(input: ObservationRequest, expectedAnchorEventId: string | null): StoreWriteResult {
    this.ensureEventId(input.eventId);
    const exposure = input.observedExposure ? 'exposed' : input.exposure;
    const observedAt = normalizeDate(input.observedAt, 'INVALID_OBSERVED_AT');
    const learning = normalizeLearningEvidence(input.learning, observedAt);
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
    try {
      this.db.exec('BEGIN IMMEDIATE');
      this.db.prepare(`INSERT INTO observations(
        namespace, event_id, concept_id, source_revision, observed_at, recorded_at,
        config_revision, half_life_days, anchor_event_id, elapsed_days, decay,
        answer, rating, exposure, observed_exposure, learning_json, request_payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
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
        requestPayload,
      );
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* preserve original error */ }
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
    try {
      this.db.exec('BEGIN IMMEDIATE');
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
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* preserve original error */ }
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
    try {
      this.db.exec('BEGIN IMMEDIATE');
      this.db.prepare(`INSERT INTO applications(
        namespace, event_id, concept_id, source_revision, occurred_at, recorded_at,
        kind, context, content, outcome, assistance, result, limitations,
        insight, correction, references_text, request_payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
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
        requestPayload,
      );
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* preserve original error */ }
      throw new StoreError('WRITE_FAILED', safeSqliteMessage(error), 503);
    }
    return { status: 'accepted', eventId: request.eventId };
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
    const constraint = asOf ? ' AND occurred_at <= ?' : '';
    const parameters = asOf ? [this.namespace, conceptId, normalizeDate(asOf)] : [this.namespace, conceptId];
    const row = this.db.prepare(`SELECT event_id, concept_id, source_revision, occurred_at, recorded_at,
      active, previous_event_id
      FROM retentions WHERE namespace = ? AND concept_id = ?${constraint}
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

  getAnchors(): AnchorEvent[] {
    const rows = this.db.prepare(`SELECT event_id, concept_id, source_revision, occurred_at, recorded_at, kind
      FROM anchors WHERE namespace = ? ORDER BY occurred_at ASC, recorded_at ASC, event_id ASC`).all(this.namespace) as Array<{ event_id: string; concept_id: string; source_revision: string; occurred_at: string; recorded_at: string; kind: 'review' | 'estimated' }>;
    return rows.map((row) => ({ eventId: row.event_id, conceptId: row.concept_id, sourceRevision: row.source_revision, occurredAt: row.occurred_at, recordedAt: row.recorded_at, kind: row.kind }));
  }

  /** Preserve the original review request shape for portable retries. In
   * particular, an omitted occurredAt must remain omitted because it is part
   * of the canonical idempotency payload even though the stored anchor always
   * has a concrete occurredAt. */
  private getAnchorRequests(): ReviewRequest[] {
    const rows = this.db.prepare(`SELECT event_id, concept_id, source_revision, occurred_at, kind, request_payload
      FROM anchors WHERE namespace = ? ORDER BY occurred_at ASC, recorded_at ASC, event_id ASC`).all(this.namespace) as Array<{
        event_id: string; concept_id: string; source_revision: string; occurred_at: string;
        kind: 'review' | 'estimated'; request_payload: string;
      }>;
    return rows.map((row) => {
      try {
        const parsed = JSON.parse(row.request_payload) as Record<string, unknown>;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            && parsed.eventId === row.event_id
            && parsed.conceptId === row.concept_id
            && parsed.sourceRevision === row.source_revision
            && (parsed.kind === 'review' || parsed.kind === 'estimated')
            && (parsed.occurredAt === undefined || typeof parsed.occurredAt === 'string')) {
          return parsed as unknown as ReviewRequest;
        }
      } catch {
        // Fall through to a conservative legacy reconstruction below.
      }
      return {
        eventId: row.event_id,
        conceptId: row.concept_id,
        sourceRevision: row.source_revision,
        kind: row.kind,
        occurredAt: row.occurred_at,
      };
    });
  }

  private getConfigRecordedAt(): Record<string, string> {
    const rows = this.db.prepare(`SELECT revision, recorded_at
      FROM config_history WHERE namespace = ? ORDER BY revision ASC`).all(this.namespace) as Array<{ revision: number; recorded_at: string }>;
    const result: Record<string, string> = {};
    for (const row of rows) result[String(row.revision)] = row.recorded_at;
    return result;
  }

  private getImportedConcepts(): Array<Pick<Concept, 'id' | 'title' | 'source'>> {
    const rows = this.db.prepare(`SELECT concept_id, title, source_path, source_revision
      FROM imported_concepts WHERE namespace = ? ORDER BY concept_id ASC`).all(this.namespace) as Array<{
        concept_id: string; title: string; source_path: string; source_revision: string;
      }>;
    return rows.map((row) => ({
      id: row.concept_id,
      title: row.title,
      source: { path: row.source_path, revision: row.source_revision },
    }));
  }

  private getIdentityCatalog(): Array<{ id: string; title: string; path: string | null; revision: string | null }> {
    const rows = this.db.prepare(`SELECT concept_id, title, source_path, source_revision
      FROM identity_catalog WHERE namespace = ? ORDER BY concept_id ASC`).all(this.namespace) as Array<{
        concept_id: string; title: string; source_path: string | null; source_revision: string | null;
      }>;
    return rows.map((row) => ({
      id: row.concept_id,
      title: row.title,
      path: row.source_path,
      revision: row.source_revision,
    }));
  }

  getIdentityBindings(): IdentityBinding[] {
    const rows = this.db.prepare(`SELECT operation_id, raw_concept_id, concept_id, from_path,
      to_path, source_revision, confirmed_at, backup_id
      FROM identity_bindings WHERE namespace = ? ORDER BY confirmed_at ASC, operation_id ASC`).all(this.namespace) as Array<{
        operation_id: string; raw_concept_id: string; concept_id: string; from_path: string | null;
        to_path: string; source_revision: string; confirmed_at: string; backup_id: string;
      }>;
    return rows.map((row) => ({
      operationId: row.operation_id,
      rawConceptId: row.raw_concept_id,
      conceptId: row.concept_id,
      fromPath: row.from_path,
      toPath: row.to_path,
      sourceRevision: row.source_revision,
      confirmedAt: row.confirmed_at,
      backupId: row.backup_id,
    }));
  }

  getIdentityAcceptedPaths(): Record<string, string[]> {
    const paths: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
    for (const binding of this.getIdentityBindings()) {
      const values = paths[binding.conceptId] ?? [];
      if (binding.fromPath && !values.includes(binding.fromPath)) values.push(binding.fromPath);
      if (!values.includes(binding.toPath)) values.push(binding.toPath);
      paths[binding.conceptId] = values;
    }
    for (const conceptId of Object.keys(paths)) paths[conceptId].sort();
    return paths;
  }

  getObservations(conceptId?: string, sourceRevision?: string): Observation[] {
    let query = `SELECT event_id, concept_id, source_revision, observed_at, recorded_at,
      config_revision, half_life_days, anchor_event_id, elapsed_days, decay, answer, rating, exposure, observed_exposure, learning_json
      FROM observations WHERE namespace = ?`;
    const parameters: string[] = [this.namespace];
    if (conceptId !== undefined) {
      query += ' AND concept_id = ?';
      parameters.push(conceptId);
    }
    if (sourceRevision !== undefined) {
      query += ' AND source_revision = ?';
      parameters.push(sourceRevision);
    }
    query += ' ORDER BY observed_at ASC, recorded_at ASC, event_id ASC';
    const rows = this.db.prepare(query).all(...parameters) as Array<{
        event_id: string; concept_id: string; source_revision: string; observed_at: string; recorded_at: string;
        config_revision: number; half_life_days: number; anchor_event_id: string | null; elapsed_days: number | null; decay: number | null;
        answer: string; rating: RecallRating; exposure: 'unexposed' | 'exposed' | 'unknown'; observed_exposure: number; learning_json: string | null;
      }>;
    return rows.map((row) => {
      const learning = parseStoredLearning(row.learning_json);
      return {
        eventId: row.event_id,
        conceptId: row.concept_id,
        sourceRevision: row.source_revision,
        observedAt: row.observed_at,
        recordedAt: row.recorded_at,
        configRevision: row.config_revision,
        halfLifeDays: row.half_life_days,
        anchorEventId: row.anchor_event_id,
        elapsedDays: row.elapsed_days,
        decay: row.decay,
        answer: row.answer,
        rating: row.rating,
        exposure: row.exposure,
        observedExposure: Boolean(row.observed_exposure),
        ...(learning ? { learning } : {}),
      };
    });
  }

  getRetentions(): RetentionEvent[] {
    const rows = this.db.prepare(`SELECT event_id, concept_id, source_revision, occurred_at, recorded_at,
      active, previous_event_id
      FROM retentions WHERE namespace = ? ORDER BY occurred_at ASC, recorded_at ASC, event_id ASC`).all(this.namespace) as Array<{
        event_id: string; concept_id: string; source_revision: string; occurred_at: string; recorded_at: string;
        active: number; previous_event_id: string | null;
      }>;
    return rows.map((row) => ({
      eventId: row.event_id,
      conceptId: row.concept_id,
      sourceRevision: row.source_revision,
      occurredAt: row.occurred_at,
      recordedAt: row.recorded_at,
      active: Boolean(row.active),
      previousEventId: row.previous_event_id,
    }));
  }

  getApplications(conceptId?: string, sourceRevision?: string): ApplicationRecord[] {
    let query = `SELECT event_id, concept_id, source_revision, occurred_at, recorded_at,
      kind, context, content, outcome, assistance, result, limitations, insight,
      correction, references_text
      FROM applications WHERE namespace = ?`;
    const parameters: string[] = [this.namespace];
    if (conceptId !== undefined) {
      query += ' AND concept_id = ?';
      parameters.push(conceptId);
    }
    if (sourceRevision !== undefined) {
      query += ' AND source_revision = ?';
      parameters.push(sourceRevision);
    }
    query += ' ORDER BY occurred_at ASC, recorded_at ASC, event_id ASC';
    const rows = this.db.prepare(query).all(...parameters) as Array<{
      event_id: string; concept_id: string; source_revision: string; occurred_at: string; recorded_at: string;
      kind: 'application' | 'summary'; context: string; content: string;
      outcome: 'success' | 'partial' | 'failure' | 'unverified';
      assistance: 'independent' | 'resources' | 'people-or-ai' | 'mixed' | 'unknown';
      result: string; limitations: string; insight: string; correction: string; references_text: string;
    }>;
    return rows.map((row) => ({
      eventId: row.event_id,
      conceptId: row.concept_id,
      sourceRevision: row.source_revision,
      occurredAt: row.occurred_at,
      recordedAt: row.recorded_at,
      kind: row.kind,
      context: row.context,
      content: row.content,
      outcome: row.outcome,
      assistance: row.assistance,
      result: row.result,
      limitations: row.limitations,
      insight: row.insight,
      correction: row.correction,
      references: row.references_text,
    }));
  }

  countObservations(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM observations WHERE namespace = ?').get(this.namespace) as { count: number };
    return row.count;
  }

  getConceptHistory(concept: Concept, asOf: string, limit: number, rawCursor?: string): ConceptHistory {
    const normalizedAsOf = normalizeDate(asOf, 'INVALID_HISTORY_AS_OF');
    const cursor = rawCursor === undefined ? null : decodeHistoryCursor(rawCursor);
    if (cursor && (cursor.namespace !== this.namespace || cursor.conceptId !== concept.id)) invalidHistoryCursor();

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
    };

    const keyset = cursor ? `
      WHERE event_at < ?
         OR (event_at = ? AND recorded_at < ?)
         OR (event_at = ? AND recorded_at = ? AND event_id < ?)` : '';
    const queryParameters: Array<string | number> = [
      this.namespace, concept.id,
      this.namespace, concept.id,
      this.namespace, concept.id,
      this.namespace, concept.id,
    ];
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
          NULL AS correction, NULL AS references_text,
          NULL AS active, NULL AS previous_event_id,
          NULL AS config_revision, NULL AS half_life_days, NULL AS anchor_event_id,
          NULL AS elapsed_days, NULL AS decay, NULL AS answer, NULL AS rating,
          NULL AS exposure, NULL AS observed_exposure, NULL AS learning_json
        FROM anchors
        WHERE namespace = ? AND concept_id = ?
        UNION ALL
        SELECT 'observation' AS event_type, event_id, concept_id, source_revision,
          observed_at AS event_at, recorded_at, NULL AS kind,
          NULL AS application_kind, NULL AS context, NULL AS content, NULL AS outcome,
          NULL AS assistance, NULL AS result, NULL AS limitations, NULL AS insight,
          NULL AS correction, NULL AS references_text,
          NULL AS active, NULL AS previous_event_id,
          config_revision, half_life_days, anchor_event_id,
          elapsed_days, decay, answer, rating, exposure, observed_exposure, learning_json
        FROM observations
        WHERE namespace = ? AND concept_id = ?
        UNION ALL
        SELECT 'retention' AS event_type, event_id, concept_id, source_revision,
          occurred_at AS event_at, recorded_at, NULL AS kind,
          NULL AS application_kind, NULL AS context, NULL AS content, NULL AS outcome,
          NULL AS assistance, NULL AS result, NULL AS limitations, NULL AS insight,
          NULL AS correction, NULL AS references_text,
          active, previous_event_id,
          NULL AS config_revision, NULL AS half_life_days, NULL AS anchor_event_id,
          NULL AS elapsed_days, NULL AS decay, NULL AS answer, NULL AS rating,
          NULL AS exposure, NULL AS observed_exposure, NULL AS learning_json
        FROM retentions
        WHERE namespace = ? AND concept_id = ?
        UNION ALL
        SELECT 'application' AS event_type, event_id, concept_id, source_revision,
          occurred_at AS event_at, recorded_at, NULL AS kind,
          kind AS application_kind, context, content, outcome, assistance, result,
          limitations, insight, correction, references_text,
          NULL AS active, NULL AS previous_event_id,
          NULL AS config_revision, NULL AS half_life_days, NULL AS anchor_event_id,
          NULL AS elapsed_days, NULL AS decay, NULL AS answer, NULL AS rating,
          NULL AS exposure, NULL AS observed_exposure, NULL AS learning_json
        FROM applications
        WHERE namespace = ? AND concept_id = ?
      )
      SELECT event_type, event_id, concept_id, source_revision, event_at, recorded_at,
        kind, application_kind, context, content, outcome, assistance, result, limitations,
        insight, correction, references_text, active, previous_event_id, config_revision,
        half_life_days, anchor_event_id, elapsed_days, decay, answer, rating, exposure,
        observed_exposure, learning_json
      FROM history
      ${keyset}
      ORDER BY event_at DESC, recorded_at DESC, event_id DESC
      LIMIT ?
    `).all(...queryParameters) as HistoryRow[];

    const totalRow = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM anchors WHERE namespace = ? AND concept_id = ?)
        + (SELECT COUNT(*) FROM observations WHERE namespace = ? AND concept_id = ?)
        + (SELECT COUNT(*) FROM retentions WHERE namespace = ? AND concept_id = ?)
        + (SELECT COUNT(*) FROM applications WHERE namespace = ? AND concept_id = ?) AS total
    `).get(this.namespace, concept.id, this.namespace, concept.id, this.namespace, concept.id, this.namespace, concept.id) as { total: number };

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
    return {
      sourceId: this.namespace,
      conceptId: concept.id,
      sourceRevision: concept.source.revision,
      asOf: normalizedAsOf,
      state,
      entries,
      total: totalRow.total,
      nextCursor,
      learning: summarizeLearning(this.getObservations(concept.id, concept.source.revision)),
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
    const row = this.db.prepare('SELECT layout_json FROM layouts WHERE namespace = ?').get(this.namespace) as { layout_json: string } | undefined;
    if (!row) return {};
    try {
      const parsed = JSON.parse(row.layout_json) as Layout;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  /**
   * Read scheduling preferences without materializing a default row. Keeping
   * the default virtual makes a GET/export genuinely read-only and preserves
   * the same namespace isolation as the learning records.
   */
  getReviewPlan(): ReviewPlan {
    const row = this.db.prepare(`SELECT revision, daily_budget, concepts_json
      FROM review_plans WHERE namespace = ?`).get(this.namespace) as {
        revision: number;
        daily_budget: number;
        concepts_json: string;
      } | undefined;
    if (!row) return { revision: 0, dailyBudget: DEFAULT_DAILY_REVIEW_BUDGET, concepts: {} };
    return this.parseReviewPlanRow(row);
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
    if (!Number.isSafeInteger(row.revision) || row.revision < 0
        || !Number.isSafeInteger(row.daily_budget) || row.daily_budget < 1 || row.daily_budget > MAX_DAILY_REVIEW_BUDGET) {
      throw new StoreError('REVIEW_PLAN_CORRUPT', '复习计划数据无效，请修复本地数据后重试。', 500);
    }
    let parsed: unknown;
    try { parsed = JSON.parse(row.concepts_json); } catch {
      throw new StoreError('REVIEW_PLAN_CORRUPT', '复习计划数据无效，请修复本地数据后重试。', 500);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new StoreError('REVIEW_PLAN_CORRUPT', '复习计划数据无效，请修复本地数据后重试。', 500);
    }
    const concepts: Record<string, ConceptReviewPreference> = {};
    for (const [conceptId, raw] of Object.entries(parsed as Record<string, unknown>)) {
      if (!conceptId.trim() || !raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new StoreError('REVIEW_PLAN_CORRUPT', '复习计划数据无效，请修复本地数据后重试。', 500);
      }
      const preference = raw as Record<string, unknown>;
      if (typeof preference.focus !== 'boolean') {
        throw new StoreError('REVIEW_PLAN_CORRUPT', '复习计划数据无效，请修复本地数据后重试。', 500);
      }
      const deferUntil = preference.deferUntil;
      if (deferUntil !== null && (typeof deferUntil !== 'string' || !isValidInstant(deferUntil))) {
        throw new StoreError('REVIEW_PLAN_CORRUPT', '复习计划数据无效，请修复本地数据后重试。', 500);
      }
      Object.defineProperty(concepts, conceptId, {
        value: {
          focus: preference.focus,
          deferUntil: deferUntil === null ? null : new Date(parseDate(deferUntil)).toISOString(),
        },
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return { revision: row.revision, dailyBudget: row.daily_budget, concepts };
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

    type IdentityCountRow = { concept_id: string; anchors: number; observations: number; retentions: number; applications: number };
    const countRows = this.db.prepare(`
      SELECT concept_id,
        SUM(CASE WHEN event_kind = 'anchors' THEN event_count ELSE 0 END) AS anchors,
        SUM(CASE WHEN event_kind = 'observations' THEN event_count ELSE 0 END) AS observations,
        SUM(CASE WHEN event_kind = 'retentions' THEN event_count ELSE 0 END) AS retentions,
        SUM(CASE WHEN event_kind = 'applications' THEN event_count ELSE 0 END) AS applications
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
      )
      GROUP BY concept_id`).all(this.namespace, this.namespace, this.namespace, this.namespace) as IdentityCountRow[];
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
      return {
        conceptId: id,
        title: source.title,
        path: source.path,
        sourceRevision: source.revision,
        counts: {
          anchors: row?.anchors ?? 0,
          observations: row?.observations ?? 0,
          retentions: row?.retentions ?? 0,
          applications: row?.applications ?? 0,
        },
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
    if (targetConcept && (to.counts.anchors + to.counts.observations + to.counts.retentions + to.counts.applications > 0)) {
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

  private importEventConflict(eventId: string): never {
    throw new StoreError('IMPORT_CONFLICT', `导入事件 ${eventId} 与当前知识空间中的记录不一致。`, 409);
  }

  private eventAlreadyImported(eventId: string, kind: 'anchor' | 'observation' | 'retention' | 'application', requestPayload: string): boolean {
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
      FROM config_history WHERE namespace = ? AND revision = ?`).get(this.namespace, config.revision) as {
        model_version: string; half_life_days: number; recorded_at: string;
      } | undefined;
    if (existing) {
      if (existing.model_version !== config.modelVersion || existing.half_life_days !== config.halfLifeDays) {
        throw new StoreError('IMPORT_CONFLICT', `配置 revision ${config.revision} 与当前知识空间内容不一致。`, 409);
      }
      return;
    }
    this.db.prepare(`INSERT INTO config_history(namespace, revision, model_version, half_life_days, recorded_at)
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
    this.db.prepare(`INSERT INTO anchors(namespace, event_id, concept_id, source_revision, occurred_at, recorded_at, kind, request_payload)
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
    };
    return canonicalJson(request);
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
    this.db.prepare(`INSERT INTO observations(
      namespace, event_id, concept_id, source_revision, observed_at, recorded_at,
      config_revision, half_life_days, anchor_event_id, elapsed_days, decay,
      answer, rating, exposure, observed_exposure, learning_json, request_payload
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
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
    this.db.prepare(`INSERT INTO retentions(
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
    });
    if (this.eventAlreadyImported(event.eventId, 'application', requestPayload)) return;
    if (!isValidInstant(event.occurredAt) || !isValidInstant(event.recordedAt)) {
      throw new StoreError('IMPORT_INVALID_DATA', `application ${event.eventId} 的时间字段无效。`);
    }
    this.db.prepare(`INSERT INTO applications(
      namespace, event_id, concept_id, source_revision, occurred_at, recorded_at,
      kind, context, content, outcome, assistance, result, limitations,
      insight, correction, references_text, request_payload
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
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
      requestPayload,
    );
  }

  private mergeImportedConcepts(concepts: Array<Pick<Concept, 'id' | 'title' | 'source'>>): void {
    for (const concept of concepts) {
      if (typeof concept.id !== 'string' || !concept.id.trim()
          || typeof concept.title !== 'string' || !concept.source
          || typeof concept.source.path !== 'string' || typeof concept.source.revision !== 'string') {
        throw new StoreError('IMPORT_INVALID_DATA', '导入概念 manifest 包含无效字段。');
      }
      this.db.prepare(`INSERT INTO imported_concepts(namespace, concept_id, title, source_path, source_revision)
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
    this.db.prepare(`INSERT INTO layouts(namespace, layout_json, recorded_at) VALUES (?, ?, ?)
      ON CONFLICT(namespace) DO UPDATE SET layout_json = excluded.layout_json, recorded_at = excluded.recorded_at`).run(
      this.namespace, canonicalJson(layout), iso(this.now()),
    );
  }

  private writeImportedReviewPlan(plan: import('../shared/review-plan.js').ReviewPlan): void {
    this.db.prepare(`INSERT INTO review_plans(namespace, revision, daily_budget, concepts_json, recorded_at)
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
    try {
      this.db.exec('BEGIN IMMEDIATE');
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
        this.db.exec('COMMIT');
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
      for (const retention of prepared.newRetentions) this.insertImportedRetention(retention);
      for (const application of prepared.newApplications) this.insertImportedApplication(application);
      if (request.options?.restoreLayout && prepared.mergedLayout) this.writeImportedLayout(prepared.mergedLayout);
      if (request.options?.restoreReviewPlan && prepared.mergedReviewPlan) this.writeImportedReviewPlan(prepared.mergedReviewPlan);

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
      this.db.exec('COMMIT');
      return accepted;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* preserve original error */ }
      if (error instanceof StoreError) throw error;
      throw new StoreError('IMPORT_FAILED', safeSqliteMessage(error), 503);
    }
  }

  exportData(source: ExportData['source'], concepts: Concept[]): ExportData {
    const bindings = this.getIdentityBindings();
    const boundRawIds = new Set(bindings.map((binding) => binding.rawConceptId));
    const liveConcepts = concepts
      .filter((concept) => !boundRawIds.has(concept.id))
      .map((concept) => ({ id: concept.id, title: concept.title, source: concept.source }));
    const catalogConcepts = this.getIdentityCatalog()
      .filter((concept) => concept.path !== null && concept.revision !== null && !boundRawIds.has(concept.id))
      .map((concept) => ({
        id: concept.id,
        title: concept.title,
        source: { path: concept.path as string, revision: concept.revision as string },
      }));
    const mergedConcepts = new Map(this.getImportedConcepts()
      .filter((concept) => !boundRawIds.has(concept.id))
      .map((concept) => [concept.id, concept]));
    // The remembered catalog supplements imported metadata, while the current
    // knowledge index remains authoritative for a live stable ID.
    for (const concept of catalogConcepts) mergedConcepts.set(concept.id, concept);
    // The current knowledge index is authoritative when an imported orphan
    // has since become live again with the same stable concept ID.
    for (const concept of liveConcepts) mergedConcepts.set(concept.id, concept);
    return {
      schemaVersion: 1,
      exportedAt: iso(this.now()),
      source,
      concepts: [...mergedConcepts.values()].sort((left, right) => left.id.localeCompare(right.id)),
      identityBindings: bindings,
      config: this.getConfig(),
      configHistory: this.getConfigHistory(),
      anchors: this.getAnchors(),
      observations: this.getObservations(),
      retentions: this.getRetentions(),
      applications: this.getApplications(),
      reviewPlan: this.getReviewPlan(),
      layout: this.getLayout(),
      restoreMetadata: {
        sourceId: this.namespace,
        anchorRequests: this.getAnchorRequests(),
        configRecordedAt: this.getConfigRecordedAt(),
      },
    };
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
  };
}
