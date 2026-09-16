import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  AnchorEvent,
  Concept,
  ExportData,
  Layout,
  MemoryState,
  ModelConfig,
  Observation,
  ObservationRequest,
  RecallRating,
  ReviewRequest,
} from '../shared/types.js';
import { DAY_MS, MODEL_VERSION } from '../shared/types.js';
import { decayAt, isValidInstant, projectMemory } from '../core/time-model.js';

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

function safeSqliteMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (/UNIQUE|constraint/i.test(message)) return '数据已存在或与已有事件冲突。';
  return '本地学习记录暂时无法保存，请稍后重试。';
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
    `);
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

  private findEvent(eventId: string): { kind: 'anchor' | 'observation'; payload: string } | null {
    const anchor = this.db.prepare('SELECT request_payload FROM anchors WHERE namespace = ? AND event_id = ?').get(this.namespace, eventId) as { request_payload: string } | undefined;
    if (anchor) return { kind: 'anchor', payload: anchor.request_payload };
    const observation = this.db.prepare('SELECT request_payload FROM observations WHERE namespace = ? AND event_id = ?').get(this.namespace, eventId) as { request_payload: string } | undefined;
    return observation ? { kind: 'observation', payload: observation.request_payload } : null;
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
    const request = {
      eventId: input.eventId,
      conceptId: input.conceptId,
      sourceRevision: input.sourceRevision,
      observedAt: normalizeDate(input.observedAt, 'INVALID_OBSERVED_AT'),
      configRevision: input.configRevision,
      anchorEventId: input.anchorEventId,
      answer: input.answer,
      rating: input.rating,
      exposure,
      observedExposure: input.observedExposure,
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
    const observedAt = request.observedAt;
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
        answer, rating, exposure, observed_exposure, request_payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
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
        requestPayload,
      );
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* preserve original error */ }
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

  getAnchors(): AnchorEvent[] {
    const rows = this.db.prepare(`SELECT event_id, concept_id, source_revision, occurred_at, recorded_at, kind
      FROM anchors WHERE namespace = ? ORDER BY occurred_at ASC, recorded_at ASC, event_id ASC`).all(this.namespace) as Array<{ event_id: string; concept_id: string; source_revision: string; occurred_at: string; recorded_at: string; kind: 'review' | 'estimated' }>;
    return rows.map((row) => ({ eventId: row.event_id, conceptId: row.concept_id, sourceRevision: row.source_revision, occurredAt: row.occurred_at, recordedAt: row.recorded_at, kind: row.kind }));
  }

  getObservations(): Observation[] {
    const rows = this.db.prepare(`SELECT event_id, concept_id, source_revision, observed_at, recorded_at,
      config_revision, half_life_days, anchor_event_id, elapsed_days, decay, answer, rating, exposure, observed_exposure
      FROM observations WHERE namespace = ? ORDER BY observed_at ASC, recorded_at ASC, event_id ASC`).all(this.namespace) as Array<{
        event_id: string; concept_id: string; source_revision: string; observed_at: string; recorded_at: string;
        config_revision: number; half_life_days: number; anchor_event_id: string | null; elapsed_days: number | null; decay: number | null;
        answer: string; rating: RecallRating; exposure: 'unexposed' | 'exposed' | 'unknown'; observed_exposure: number;
      }>;
    return rows.map((row) => ({
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
    }));
  }

  countObservations(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM observations WHERE namespace = ?').get(this.namespace) as { count: number };
    return row.count;
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
      states[concept.id] = projectMemory(concept, anchor, config, normalizedAsOf);
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
  return {
    eventId: requireString(record, 'eventId'),
    conceptId: requireString(record, 'conceptId'),
    sourceRevision: requireString(record, 'sourceRevision'),
    observedAt: requireString(record, 'observedAt'),
    configRevision,
    anchorEventId: anchorValue as string | null,
    answer: typeof record.answer === 'string' ? record.answer : '',
    rating: rating as RecallRating,
    exposure: exposure as 'unexposed' | 'exposed' | 'unknown',
    observedExposure: record.observedExposure,
  };
}
