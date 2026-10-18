import type { DatabaseSync } from 'node:sqlite';
import type { Observation } from '../shared/types.js';
import type { ObservationRevisionHistory } from '../shared/observation-revision-history.js';
import { ObservationRevisionError, parseObservationRevision, parseObservationRevisionRequest, observationRevisionRequestEqual,
  type ObservationRevision, type ObservationRevisionRequest } from '../shared/observation-revisions.js';
import { prepareObservationRevision, projectObservationAssessments } from '../core/observation-revisions.js';

const TABLE = `CREATE TABLE IF NOT EXISTS observation_revisions (
  namespace TEXT NOT NULL,
  event_id TEXT NOT NULL,
  observation_event_id TEXT NOT NULL,
  previous_event_id TEXT,
  concept_id TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('revise','withdraw','reinstate')),
  reason TEXT NOT NULL CHECK(reason IN ('input-error','rechecked-original','unreliable-evidence','other')),
  note TEXT,
  assessment_json TEXT,
  request_payload TEXT NOT NULL,
  PRIMARY KEY(namespace,event_id),
  UNIQUE(namespace,observation_event_id,event_id),
  FOREIGN KEY(namespace,observation_event_id) REFERENCES observations(namespace,event_id),
  FOREIGN KEY(namespace,observation_event_id,previous_event_id) REFERENCES observation_revisions(namespace,observation_event_id,event_id),
  CHECK((action='revise' AND assessment_json IS NOT NULL) OR (action IN ('withdraw','reinstate') AND assessment_json IS NULL))
)`;
const INDEXES = {
  observation_revisions_root: `CREATE UNIQUE INDEX IF NOT EXISTS observation_revisions_root ON observation_revisions(namespace,observation_event_id) WHERE previous_event_id IS NULL`,
  observation_revisions_successor: `CREATE UNIQUE INDEX IF NOT EXISTS observation_revisions_successor ON observation_revisions(namespace,observation_event_id,previous_event_id) WHERE previous_event_id IS NOT NULL`,
  observation_revisions_audit: `CREATE INDEX IF NOT EXISTS observation_revisions_audit ON observation_revisions(namespace,observation_event_id,recorded_at,event_id)`,
};
/** DDL only. The future migration caller owns authorization, backup and transaction. */
export function createObservationRevisionTables(db: DatabaseSync): void {
  db.exec([TABLE, ...Object.values(INDEXES)].join(';'));
}
export class ObservationRevisionStoreError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); this.name = 'ObservationRevisionStoreError'; }
}
export interface ObservationRevisionStoreOptions {
  db: DatabaseSync;
  namespace: string;
  now?: () => Date;
  /** Both callbacks must read this same db/namespace, never write or contact external resources. */
  getObservation(namespace: string, eventId: string): Observation | null;
  findOtherEvent(namespace: string, eventId: string): { kind: string; requestPayload: string } | null;
}
interface Row {
  event_id: string; observation_event_id: string; previous_event_id: string | null;
  concept_id: string; source_revision: string; occurred_at: string; recorded_at: string;
  action: string; reason: string; note: string | null; assessment_json: string | null; request_payload: string;
}
const invalid = () => new ObservationRevisionStoreError('OBSERVATION_REVISION_DATA_INVALID', 503);
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new ObservationRevisionStoreError('OBSERVATION_REVISION_INVALID_HISTORY_QUERY', 400);
  return value;
}
function normalizedSql(sql: string): string {
  // Only our own DDL is supported. Never normalize CHECK string literals.
  return sql.replace(/^(CREATE (?:UNIQUE )?(?:TABLE|INDEX)) IF NOT EXISTS\b/, '$1').trim();
}
function requestOf(event: ObservationRevision): ObservationRevisionRequest {
  const { conceptId: _concept, sourceRevision: _revision, recordedAt: _receipt, ...request } = event;
  return request;
}
function parseRow(row: Row): ObservationRevision {
  try {
    const event = parseObservationRevision({ eventId: row.event_id, observationEventId: row.observation_event_id,
      previousEventId: row.previous_event_id, conceptId: row.concept_id, sourceRevision: row.source_revision,
      occurredAt: row.occurred_at, recordedAt: row.recorded_at, action: row.action, reason: row.reason,
      ...(row.note === null ? {} : { note: row.note }),
      ...(row.assessment_json === null ? {} : { assessment: JSON.parse(row.assessment_json) }) });
    if (event.eventId !== row.event_id || event.observationEventId !== row.observation_event_id
      || event.previousEventId !== row.previous_event_id || event.conceptId !== row.concept_id
      || event.sourceRevision !== row.source_revision || event.occurredAt !== row.occurred_at || event.recordedAt !== row.recorded_at
      || !observationRevisionRequestEqual(requestOf(event), parseObservationRevisionRequest(JSON.parse(row.request_payload)))) throw invalid();
    return event;
  } catch { throw invalid(); }
}
interface Cursor { version: 1; namespace: string; parent: string; tail: string; total: number; beforeEventId: string }
function decodeCursor(raw: string): Cursor {
  try {
    if (typeof raw !== 'string' || !raw || raw.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error();
    const decoded = Buffer.from(raw, 'base64url');
    if (decoded.toString('base64url') !== raw) throw new Error();
    const value = JSON.parse(decoded.toString('utf8')) as Cursor;
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'beforeEventId,namespace,parent,tail,total,version'
      || value.version !== 1 || typeof value.namespace !== 'string' || !value.namespace
      || !Number.isSafeInteger(value.total) || value.total < 1) throw new Error();
    id(value.parent); id(value.tail); id(value.beforeEventId);
    return value;
  } catch { throw new ObservationRevisionStoreError('OBSERVATION_REVISION_INVALID_HISTORY_QUERY', 400); }
}
function historyOptions(input: { limit?: number; cursor?: string }): { limit: number; cursor: Cursor | null } {
  try {
    if (!input || typeof input !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(input))
      || Reflect.ownKeys(input).some(key => typeof key !== 'string' || !['limit', 'cursor'].includes(key))) throw new Error();
    for (const key of ['limit', 'cursor']) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (descriptor && (!descriptor.enumerable || !('value' in descriptor))) throw new Error();
    }
    const limit = input.limit === undefined ? 20 : input.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error();
    return { limit, cursor: input.cursor === undefined ? null : decodeCursor(input.cursor) };
  } catch { throw new ObservationRevisionStoreError('OBSERVATION_REVISION_INVALID_HISTORY_QUERY', 400); }
}
let savepointSequence = 0;
/** An unconnected ledger: it never opens/closes a database or migrates its schema. */
export class ObservationRevisionStore {
  private readonly db: DatabaseSync;
  private readonly namespace: string;
  private readonly now: () => Date;
  constructor(private readonly options: ObservationRevisionStoreOptions) {
    this.db = options.db; this.namespace = options.namespace; this.now = options.now ?? (() => new Date());
    if (typeof this.namespace !== 'string' || !this.namespace || this.namespace !== this.namespace.trim()
      || /[\u0000-\u001f\u007f]/.test(this.namespace) || Buffer.byteLength(this.namespace, 'utf8') > 256) {
      throw new ObservationRevisionStoreError('OBSERVATION_REVISION_INVALID_REQUEST', 400);
    }
    try {
      if (this.db.prepare('PRAGMA foreign_keys').get()!.foreign_keys !== 1) throw invalid();
      for (const [name, expected] of [['observation_revisions', TABLE], ...Object.entries(INDEXES)]) {
        const row = this.db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(name) as { sql: string } | undefined;
        if (!row || normalizedSql(row.sql) !== normalizedSql(expected)) throw invalid();
      }
      // Resolve parent foreign keys now, without writing or taking a transaction.
      this.db.prepare('SELECT namespace,event_id FROM observations LIMIT 0').all();
      if (this.db.prepare('PRAGMA foreign_key_check(observation_revisions)').all().length) throw invalid();
    } catch { throw new ObservationRevisionStoreError('OBSERVATION_REVISION_SCHEMA_UNAVAILABLE', 503); }
  }
  private parent(parentId: string): Observation {
    const observation = this.options.getObservation(this.namespace, parentId);
    if (!observation) throw new ObservationRevisionStoreError('OBSERVATION_REVISION_NOT_FOUND', 404);
    try {
      const detached = structuredClone(observation);
      if (detached.eventId !== parentId) throw invalid();
      return detached;
    } catch { throw invalid(); }
  }
  private rows(parentId?: string): ObservationRevision[] {
    const rows = this.db.prepare(`SELECT * FROM observation_revisions WHERE namespace=?${parentId === undefined ? '' : ' AND observation_event_id=?'} ORDER BY recorded_at,event_id`)
      .all(...(parentId === undefined ? [this.namespace] : [this.namespace, parentId])) as unknown as Row[];
    return rows.map(parseRow);
  }
  getRevisions(observationEventId?: string): ObservationRevision[] {
    if (observationEventId !== undefined) id(observationEventId);
    try { return this.rows(observationEventId); }
    catch (error) { if (error instanceof ObservationRevisionStoreError) throw error; throw invalid(); }
  }
  getRevisionCount(): number {
    try { return Number(this.db.prepare('SELECT count(*) AS count FROM observation_revisions WHERE namespace=?').get(this.namespace)!.count); }
    catch { throw invalid(); }
  }
  append(input: unknown): { status: 'accepted' | 'duplicate'; eventId: string; recordedAt: string } {
    let request: ObservationRevisionRequest;
    try { request = parseObservationRevisionRequest(input); }
    catch { throw new ObservationRevisionStoreError('OBSERVATION_REVISION_INVALID_REQUEST', 400); }
    let ownsTxn = false;
    try {
      this.db.exec('BEGIN IMMEDIATE'); ownsTxn = true;
      const row = this.db.prepare('SELECT * FROM observation_revisions WHERE namespace=? AND event_id=?').get(this.namespace, request.eventId) as unknown as Row | undefined;
      if (row) {
        const event = parseRow(row);
        if (!observationRevisionRequestEqual(requestOf(event), request)) throw new ObservationRevisionStoreError('OBSERVATION_REVISION_EVENT_CONFLICT', 409);
        this.db.exec('COMMIT'); ownsTxn = false;
        return { status: 'duplicate', eventId: event.eventId, recordedAt: event.recordedAt };
      }
      if (this.options.findOtherEvent(this.namespace, request.eventId)) throw new ObservationRevisionStoreError('OBSERVATION_REVISION_EVENT_CONFLICT', 409);
      const parent = this.parent(request.observationEventId);
      const revisions = this.rows(request.observationEventId);
      const recordedAt = this.now().toISOString();
      const prepared = prepareObservationRevision({ observation: parent, revisions, request, recordedAt });
      const event = prepared.event;
      this.db.prepare(`INSERT INTO observation_revisions(namespace,event_id,observation_event_id,previous_event_id,concept_id,source_revision,
        occurred_at,recorded_at,action,reason,note,assessment_json,request_payload) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        this.namespace, event.eventId, event.observationEventId, event.previousEventId, event.conceptId, event.sourceRevision,
        event.occurredAt, event.recordedAt, event.action, event.reason, event.note ?? null,
        event.action === 'revise' ? JSON.stringify(event.assessment) : null, JSON.stringify(request));
      this.db.exec('COMMIT'); ownsTxn = false;
      return { status: 'accepted', eventId: event.eventId, recordedAt: event.recordedAt };
    } catch (error) {
      if (ownsTxn) { try { this.db.exec('ROLLBACK'); } catch { /* never replace the original safe error */ } }
      if (error instanceof ObservationRevisionStoreError) throw error;
      if (error instanceof ObservationRevisionError) {
        if (['INVALID_PARENT', 'INVALID_CHAIN', 'INVALID_REVISION', 'UNATTRIBUTABLE_REVISION'].includes(error.code)) throw invalid();
        throw new ObservationRevisionStoreError(`OBSERVATION_REVISION_${error.code === 'INVALID_REVISION_TIME' ? 'INVALID_TIME' : error.code}`, error.code === 'INVALID_REVISION_TIME' || error.code === 'INVALID_REQUEST' ? 400 : 409);
      }
      throw new ObservationRevisionStoreError('OBSERVATION_REVISION_WRITE_FAILED', 503);
    }
  }
  readHistory(observationEventId: string, options: { limit?: number; cursor?: string } = {}): ObservationRevisionHistory {
    id(observationEventId);
    const { limit, cursor } = historyOptions(options);
    if (cursor && (cursor.namespace !== this.namespace || cursor.parent !== observationEventId)) throw new ObservationRevisionStoreError('OBSERVATION_REVISION_INVALID_HISTORY_QUERY', 400);
    const savepoint = `lm_observation_revision_read_${++savepointSequence}`;
    let ownsSavepoint = false;
    try {
      this.db.exec(`SAVEPOINT ${savepoint}`); ownsSavepoint = true;
      const observation = this.parent(observationEventId);
      const events = this.rows(observationEventId);
      const maxReceipt = events.reduce((max, event) => Math.max(max, Date.parse(event.recordedAt)), Date.parse(observation.recordedAt));
      const projection = projectObservationAssessments([observation], events, new Date(maxReceipt).toISOString());
      const state = projection.states[0];
      if (projection.issues.length || !state || (state.status !== 'active' && state.status !== 'withdrawn') || !state.currentAssessment) throw invalid();
      const tail = state.latestRevisionEventId;
      if (cursor && (cursor.tail !== tail || cursor.total !== events.length)) throw new ObservationRevisionStoreError('OBSERVATION_REVISION_HISTORY_CHANGED', 409);
      const byId = new Map(events.map(event => [event.eventId, event]));
      let position = tail;
      if (cursor) {
        const boundary = byId.get(cursor.beforeEventId);
        if (!boundary) throw new ObservationRevisionStoreError('OBSERVATION_REVISION_INVALID_HISTORY_QUERY', 400);
        position = boundary.previousEventId;
      }
      const page: ObservationRevision[] = [];
      while (position && page.length < limit) {
        const event = byId.get(position);
        if (!event) throw invalid();
        page.push(event); position = event.previousEventId;
      }
      const nextCursor = position ? Buffer.from(JSON.stringify({ version: 1, namespace: this.namespace, parent: observationEventId,
        tail, total: events.length, beforeEventId: page.at(-1)!.eventId })).toString('base64url') : null;
      const result: ObservationRevisionHistory = { observation, state: { status: state.status, currentAssessment: state.currentAssessment,
        latestRevisionEventId: tail, appliedRevisionCount: state.appliedRevisionCount }, events: page, total: events.length,
        observationRevisionCount: this.getRevisionCount(), nextCursor };
      this.db.exec(`RELEASE ${savepoint}`); ownsSavepoint = false;
      return result;
    } catch (error) {
      if (ownsSavepoint) { try { this.db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`); } catch { /* keep the safe original result */ } }
      if (error instanceof ObservationRevisionStoreError) throw error;
      if (error instanceof ObservationRevisionError || error instanceof RangeError) throw invalid();
      throw new ObservationRevisionStoreError('OBSERVATION_REVISION_WRITE_FAILED', 503);
    }
  }
}
