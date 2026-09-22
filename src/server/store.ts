import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  AnchorEvent,
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
import { DAY_MS, MODEL_VERSION } from '../shared/types.js';
import { decayAt, isValidInstant, projectMemory } from '../core/time-model.js';
import { summarizeLearning } from '../core/learning-evidence.js';

const DEFAULT_HALF_LIFE_DAYS = 7;

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

function isOneOf<T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === 'string' && values.includes(value);
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
      CREATE TABLE IF NOT EXISTS layouts (
        namespace TEXT PRIMARY KEY,
        layout_json TEXT NOT NULL,
        recorded_at TEXT NOT NULL
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

  private findEvent(eventId: string): { kind: 'anchor' | 'observation' | 'retention'; payload: string } | null {
    const anchor = this.db.prepare('SELECT request_payload FROM anchors WHERE namespace = ? AND event_id = ?').get(this.namespace, eventId) as { request_payload: string } | undefined;
    if (anchor) return { kind: 'anchor', payload: anchor.request_payload };
    const observation = this.db.prepare('SELECT request_payload FROM observations WHERE namespace = ? AND event_id = ?').get(this.namespace, eventId) as { request_payload: string } | undefined;
    if (observation) return { kind: 'observation', payload: observation.request_payload };
    const retention = this.db.prepare('SELECT request_payload FROM retentions WHERE namespace = ? AND event_id = ?').get(this.namespace, eventId) as { request_payload: string } | undefined;
    return retention ? { kind: 'retention', payload: retention.request_payload } : null;
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

  countObservations(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM observations WHERE namespace = ?').get(this.namespace) as { count: number };
    return row.count;
  }

  getConceptHistory(concept: Concept, asOf: string, limit: number, rawCursor?: string): ConceptHistory {
    const normalizedAsOf = normalizeDate(asOf, 'INVALID_HISTORY_AS_OF');
    const cursor = rawCursor === undefined ? null : decodeHistoryCursor(rawCursor);
    if (cursor && (cursor.namespace !== this.namespace || cursor.conceptId !== concept.id)) invalidHistoryCursor();

    type HistoryRow = {
      event_type: 'anchor' | 'observation' | 'retention';
      event_id: string;
      concept_id: string;
      source_revision: string;
      event_at: string;
      recorded_at: string;
      kind: 'review' | 'estimated' | null;
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
          NULL AS active, NULL AS previous_event_id,
          NULL AS config_revision, NULL AS half_life_days, NULL AS anchor_event_id,
          NULL AS elapsed_days, NULL AS decay, NULL AS answer, NULL AS rating,
          NULL AS exposure, NULL AS observed_exposure, NULL AS learning_json
        FROM anchors
        WHERE namespace = ? AND concept_id = ?
        UNION ALL
        SELECT 'observation' AS event_type, event_id, concept_id, source_revision,
          observed_at AS event_at, recorded_at, NULL AS kind,
          NULL AS active, NULL AS previous_event_id,
          config_revision, half_life_days, anchor_event_id,
          elapsed_days, decay, answer, rating, exposure, observed_exposure, learning_json
        FROM observations
        WHERE namespace = ? AND concept_id = ?
        UNION ALL
        SELECT 'retention' AS event_type, event_id, concept_id, source_revision,
          occurred_at AS event_at, recorded_at, NULL AS kind,
          active, previous_event_id,
          NULL AS config_revision, NULL AS half_life_days, NULL AS anchor_event_id,
          NULL AS elapsed_days, NULL AS decay, NULL AS answer, NULL AS rating,
          NULL AS exposure, NULL AS observed_exposure, NULL AS learning_json
        FROM retentions
        WHERE namespace = ? AND concept_id = ?
      )
      SELECT event_type, event_id, concept_id, source_revision, event_at, recorded_at,
        kind, active, previous_event_id, config_revision, half_life_days, anchor_event_id, elapsed_days, decay,
        answer, rating, exposure, observed_exposure, learning_json
      FROM history
      ${keyset}
      ORDER BY event_at DESC, recorded_at DESC, event_id DESC
      LIMIT ?
    `).all(...queryParameters) as HistoryRow[];

    const totalRow = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM anchors WHERE namespace = ? AND concept_id = ?)
        + (SELECT COUNT(*) FROM observations WHERE namespace = ? AND concept_id = ?)
        + (SELECT COUNT(*) FROM retentions WHERE namespace = ? AND concept_id = ?) AS total
    `).get(this.namespace, concept.id, this.namespace, concept.id, this.namespace, concept.id) as { total: number };

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

  exportData(source: ExportData['source'], concepts: Concept[]): ExportData {
    return {
      schemaVersion: 1,
      exportedAt: iso(this.now()),
      source,
      concepts: concepts.map((concept) => ({ id: concept.id, title: concept.title, source: concept.source })),
      config: this.getConfig(),
      configHistory: this.getConfigHistory(),
      anchors: this.getAnchors(),
      observations: this.getObservations(),
      retentions: this.getRetentions(),
      layout: this.getLayout(),
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
