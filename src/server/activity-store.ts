import type { DatabaseSync } from 'node:sqlite';
import { parseActivityAppendRequest, ActivityValidationError, type ActivitySettings, type ActivitySettingsUpdate,
  type ActivityClearRequest, type ActivityClearOperationRequest, type ActivityAppendRequest, type ActivityAppendResult,
  type ActivityChannel, type ActivityReference, type ActivityReferenceInspection, type ActivityRecordedBy,
  type ActivityRecord, type ActivityDeliveryRecord, type ActivityListOptions, type ActivityPage, type ActivityExport } from '../shared/activity.js';
import { isValidInstant } from '../core/time-model.js';

export interface ActivityAppendContext {
  principalId: string;
  sessionKind: string;
  deliveryChannel: ActivityChannel;
  allowedOriginChannels: readonly ActivityChannel[];
  inspectReference: (reference: ActivityReference) => ActivityReferenceInspection;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
}
interface EventRow {
  epoch: number; event_id: string; operation_id: string; step_key: string; event_json: string;
  received_at: string; recorded_by: string; reference_inspections: string;
}

export class ActivityError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message); this.name = 'ActivityError'; this.code = code; this.status = status;
  }
}

export interface ActivityStoreOptions {
  db: DatabaseSync;
  namespace: string;
  now?: () => Date;
}

/** Owns no database connection and never writes learning-domain tables. */
export class ActivityStore {
  private readonly db: DatabaseSync;
  private readonly namespace: string;
  private readonly now: () => Date;
  constructor(options: ActivityStoreOptions) {
    this.db = options.db;
    this.namespace = options.namespace;
    this.now = options.now ?? (() => new Date());
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS activity_settings (
        namespace TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL,
        epoch INTEGER NOT NULL,
        revision INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS activity_events (
        namespace TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        event_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        step_key TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        kind TEXT NOT NULL,
        channel TEXT NOT NULL,
        event_json TEXT NOT NULL,
        recorded_by TEXT NOT NULL,
        reference_inspections TEXT NOT NULL,
        PRIMARY KEY(namespace, event_id),
        UNIQUE(namespace, epoch, operation_id, step_key)
      );
      CREATE INDEX IF NOT EXISTS activity_events_page ON activity_events(namespace, occurred_at DESC, event_id DESC);
      CREATE TABLE IF NOT EXISTS activity_deliveries (
        namespace TEXT NOT NULL,
        delivery_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        received_at TEXT NOT NULL,
        recorded_by TEXT NOT NULL,
        PRIMARY KEY(namespace, delivery_id)
      );
      CREATE TABLE IF NOT EXISTS activity_deletions (
        namespace TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        operation_id TEXT NOT NULL,
        deleted_at TEXT NOT NULL,
        PRIMARY KEY(namespace, epoch, operation_id)
      );
    `);
  }

  getSettings(): ActivitySettings {
    const row = this.db.prepare('SELECT enabled, epoch, revision FROM activity_settings WHERE namespace = ?').get(this.namespace) as
      { enabled: number; epoch: number; revision: number } | undefined;
    return row ? { enabled: row.enabled === 1, epoch: row.epoch, revision: row.revision }
      : { enabled: true, epoch: 0, revision: 0 };
  }

  private transaction<T>(action: () => T): T {
    this.db.exec('SAVEPOINT activity_write');
    try {
      const result = action();
      this.db.exec('RELEASE SAVEPOINT activity_write');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK TO SAVEPOINT activity_write'); this.db.exec('RELEASE SAVEPOINT activity_write'); } catch { /* preserve the original failure */ }
      throw error;
    }
  }

  private saveSettings(settings: ActivitySettings): void {
    this.db.prepare(`INSERT INTO activity_settings(namespace,enabled,epoch,revision) VALUES(?,?,?,?)
      ON CONFLICT(namespace) DO UPDATE SET enabled=excluded.enabled,epoch=excluded.epoch,revision=excluded.revision`)
      .run(this.namespace, Number(settings.enabled), settings.epoch, settings.revision);
  }

  updateSettings(input: ActivitySettingsUpdate): ActivitySettings {
    if (!input || typeof input.enabled !== 'boolean' || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0
      || Object.keys(input).some((key) => !['enabled', 'expectedRevision'].includes(key))) {
      throw new ActivityError('INVALID_ACTIVITY', '活动设置格式无效。');
    }
    return this.transaction(() => {
      const current = this.getSettings();
      if (input.expectedRevision !== current.revision) throw new ActivityError('ACTIVITY_SETTINGS_CHANGED', '活动设置已变化，请重新加载。', 409);
      if (input.enabled === current.enabled) return current;
      const settings = { enabled: input.enabled, epoch: current.epoch + (input.enabled ? 0 : 1), revision: current.revision + 1 };
      this.saveSettings(settings);
      return settings;
    });
  }

  private requireEpoch(epoch: number): ActivitySettings {
    if (!Number.isSafeInteger(epoch) || epoch < 0) throw new ActivityError('INVALID_ACTIVITY', '活动记录世代无效。');
    const settings = this.getSettings();
    if (epoch !== settings.epoch) throw new ActivityError('ACTIVITY_EPOCH_CHANGED', '活动记录设置已变化，旧操作不再写入。', 409);
    return settings;
  }

  clearAll(input: ActivityClearRequest): { settings: ActivitySettings; deletedEvents: number; deletedDeliveries: number } {
    if (!input || Object.keys(input).some((key) => key !== 'expectedEpoch')) throw new ActivityError('INVALID_ACTIVITY', '清除请求格式无效。');
    return this.transaction(() => {
      const current = this.requireEpoch(input.expectedEpoch);
      const deletedDeliveries = Number(this.db.prepare('DELETE FROM activity_deliveries WHERE namespace = ?').run(this.namespace).changes);
      const deletedEvents = Number(this.db.prepare('DELETE FROM activity_events WHERE namespace = ?').run(this.namespace).changes);
      this.db.prepare('DELETE FROM activity_deletions WHERE namespace = ?').run(this.namespace);
      const settings = { ...current, epoch: current.epoch + 1, revision: current.revision + 1 };
      this.saveSettings(settings);
      return { settings, deletedEvents, deletedDeliveries };
    });
  }

  clearOperation(input: ActivityClearOperationRequest): { settings: ActivitySettings; deletedEvents: number; deletedDeliveries: number } {
    if (!input || Object.keys(input).some((key) => !['expectedEpoch', 'operationId'].includes(key))
      || typeof input.operationId !== 'string' || !input.operationId.trim() || input.operationId.length > 200 || /[\u0000-\u001f\u007f]/.test(input.operationId)) {
      throw new ActivityError('INVALID_ACTIVITY', '操作清除请求格式无效。');
    }
    return this.transaction(() => {
      const settings = this.requireEpoch(input.expectedEpoch);
      const deletedDeliveries = Number(this.db.prepare(`DELETE FROM activity_deliveries WHERE namespace=? AND event_id IN
        (SELECT event_id FROM activity_events WHERE namespace=? AND operation_id=?)`).run(this.namespace, this.namespace, input.operationId).changes);
      const deletedEvents = Number(this.db.prepare('DELETE FROM activity_events WHERE namespace=? AND operation_id=?').run(this.namespace, input.operationId).changes);
      this.db.prepare('INSERT OR IGNORE INTO activity_deletions(namespace,epoch,operation_id,deleted_at) VALUES(?,?,?,?)')
        .run(this.namespace, settings.epoch, input.operationId, this.now().toISOString());
      return { settings, deletedEvents, deletedDeliveries };
    });
  }

  append(context: ActivityAppendContext, input: unknown): ActivityAppendResult {
    let request: ActivityAppendRequest;
    try { request = parseActivityAppendRequest(input); }
    catch (error) {
      if (error instanceof ActivityValidationError) throw new ActivityError('INVALID_ACTIVITY', error.message);
      throw error;
    }
    if (!context || typeof context.principalId !== 'string' || !context.principalId.trim()
      || typeof context.sessionKind !== 'string' || !context.sessionKind.trim()
      || typeof context.inspectReference !== 'function') throw new ActivityError('INVALID_ACTIVITY', '活动记录缺少可信接收上下文。');
    if (request.delivery.channel !== context.deliveryChannel) throw new ActivityError('ACTIVITY_CHANNEL_FORBIDDEN', '活动投递渠道与当前会话不一致。', 403);
    const { event, delivery, epoch } = request;
    const eventJson = canonical(event);
    return this.transaction(() => {
      const settings = this.requireEpoch(epoch);
      if (!settings.enabled) throw new ActivityError('ACTIVITY_DISABLED', '活动追踪已停用。', 409);
      if (this.db.prepare('SELECT 1 FROM activity_deletions WHERE namespace=? AND epoch=? AND operation_id=?').get(this.namespace, epoch, event.operationId)) {
        throw new ActivityError('ACTIVITY_DELETED', '该操作记录已清除，旧请求不会重新保存。', 410);
      }
      const existing = this.db.prepare(`SELECT * FROM activity_events WHERE namespace=? AND
        (event_id=? OR (epoch=? AND operation_id=? AND step_key=?))`).all(this.namespace, event.eventId, epoch, event.operationId, event.stepKey) as unknown as EventRow[];
      if (existing.length && (existing.length !== 1 || existing[0].event_id !== event.eventId || existing[0].epoch !== epoch
        || existing[0].event_json !== eventJson)) throw new ActivityError('ACTIVITY_CONFLICT', '活动事件标识或操作步骤已绑定不同内容。', 409);
      const oldDelivery = this.db.prepare('SELECT event_id,channel FROM activity_deliveries WHERE namespace=? AND delivery_id=?').get(this.namespace, delivery.deliveryId) as
        { event_id: string; channel: string } | undefined;
      if (oldDelivery && (oldDelivery.event_id !== event.eventId || oldDelivery.channel !== delivery.channel)) {
        throw new ActivityError('ACTIVITY_CONFLICT', '活动投递标识已绑定其他事件或渠道。', 409);
      }
      const receivedAt = this.now().toISOString();
      const recordedBy: ActivityRecordedBy = { principalId: context.principalId, sessionKind: context.sessionKind };
      if (!existing.length) {
        if (!context.allowedOriginChannels?.includes(event.channel)) throw new ActivityError('ACTIVITY_CHANNEL_FORBIDDEN', '当前会话不能创建该来源渠道的活动。', 403);
        const inspections = event.refs.map((reference) => {
          const result = context.inspectReference(reference);
          if (!result || Object.keys(result).some((key) => key !== 'status')
            || (result.status !== 'current' && result.status !== 'historical-or-unresolved')) throw new ActivityError('INVALID_ACTIVITY_REFERENCE', '活动引用核验结果无效。');
          return { status: result.status };
        });
        // The callback is synchronous, but a caller sharing the connection can
        // still change settings. Recheck before any actual insertion.
        const checked = this.requireEpoch(epoch);
        if (!checked.enabled) throw new ActivityError('ACTIVITY_DISABLED', '活动追踪已停用。', 409);
        if (this.db.prepare('SELECT 1 FROM activity_deletions WHERE namespace=? AND epoch=? AND operation_id=?').get(this.namespace, epoch, event.operationId)) {
          throw new ActivityError('ACTIVITY_DELETED', '该操作记录已清除。', 410);
        }
        this.db.prepare(`INSERT INTO activity_events(namespace,epoch,event_id,operation_id,step_key,occurred_at,received_at,kind,channel,event_json,recorded_by,reference_inspections)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(this.namespace, epoch, event.eventId, event.operationId, event.stepKey, new Date(event.occurredAt).toISOString(), receivedAt, event.kind, event.channel,
          eventJson, canonical(recordedBy), canonical(inspections));
      }
      if (!oldDelivery) this.db.prepare('INSERT INTO activity_deliveries(namespace,delivery_id,event_id,channel,received_at,recorded_by) VALUES(?,?,?,?,?,?)')
        .run(this.namespace, delivery.deliveryId, event.eventId, delivery.channel, receivedAt, canonical(recordedBy));
      return { status: existing.length ? 'duplicate' : 'accepted', epoch, eventId: event.eventId, receivedAt: existing[0]?.received_at ?? receivedAt };
    });
  }

  private record(row: EventRow): ActivityRecord {
    return { event: JSON.parse(row.event_json), epoch: row.epoch, receivedAt: row.received_at,
      recordedBy: JSON.parse(row.recorded_by), referenceInspections: JSON.parse(row.reference_inspections) };
  }

  list(options: ActivityListOptions = {}): ActivityPage {
    const allowed = ['conceptId', 'operationId', 'kind', 'channel', 'from', 'to', 'limit', 'cursor'];
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some((key) => !allowed.includes(key))) {
      throw new ActivityError('INVALID_ACTIVITY', '活动查询参数无效。');
    }
    for (const key of ['conceptId', 'operationId'] as const) {
      const value = options[key];
      if (value !== undefined && (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value))) throw new ActivityError('INVALID_ACTIVITY', '活动查询标识无效。');
    }
    if (options.kind !== undefined && !['query.submitted', 'query.selected', 'reader.opened', 'content.visible', 'content.delivery', 'workflow.reported'].includes(options.kind)) throw new ActivityError('INVALID_ACTIVITY', '活动查询类型无效。');
    if (options.channel !== undefined && !['web', 'cli', 'progressive-kg', 'feishu'].includes(options.channel)) throw new ActivityError('INVALID_ACTIVITY', '活动查询通道无效。');
    for (const key of ['from', 'to'] as const) if (options[key] !== undefined && (typeof options[key] !== 'string' || !isValidInstant(options[key]!))) throw new ActivityError('INVALID_ACTIVITY', '活动查询时间无效。');
    const from = options.from === undefined ? undefined : new Date(options.from).toISOString();
    const to = options.to === undefined ? undefined : new Date(options.to).toISOString();
    if (from !== undefined && to !== undefined && from > to) throw new ActivityError('INVALID_ACTIVITY', '活动查询时间范围无效。');
    const limit = options.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ActivityError('INVALID_ACTIVITY', '活动分页大小应为1至100。');
    const filterKey = canonical([options.conceptId ?? null, options.operationId ?? null, options.kind ?? null, options.channel ?? null, from ?? null, to ?? null]);
    const where = ['namespace=?']; const parameters: (string | number)[] = [this.namespace];
    const condition = (sql: string, value: string | number | undefined) => { if (value !== undefined) { where.push(sql); parameters.push(value); } };
    condition('operation_id=?', options.operationId); condition('kind=?', options.kind); condition('channel=?', options.channel);
    condition('occurred_at>=?', from); condition('occurred_at<=?', to);
    condition("EXISTS (SELECT 1 FROM json_each(activity_events.event_json,'$.refs') AS ref WHERE json_extract(ref.value,'$.conceptId')=?)", options.conceptId);
    if (options.cursor !== undefined) {
      try {
        if (typeof options.cursor !== 'string' || !/^[A-Za-z0-9_-]{1,4096}$/.test(options.cursor)) throw new Error('bad cursor');
        const cursor = JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
        if (!cursor || Array.isArray(cursor) || Object.keys(cursor).sort().join(',') !== 'at,epoch,eventId,filterKey,namespace'
          || cursor.namespace !== this.namespace || cursor.epoch !== this.getSettings().epoch || cursor.filterKey !== filterKey
          || typeof cursor.at !== 'string' || !isValidInstant(cursor.at) || new Date(cursor.at).toISOString() !== cursor.at
          || typeof cursor.eventId !== 'string' || !cursor.eventId.trim() || cursor.eventId.length > 200 || /[\u0000-\u001f\u007f]/.test(cursor.eventId)) throw new Error('bad cursor');
        where.push('(occurred_at<? OR (occurred_at=? AND event_id<?))'); parameters.push(cursor.at, cursor.at, cursor.eventId);
      } catch { throw new ActivityError('INVALID_ACTIVITY', '活动分页游标无效，请重新加载。'); }
    }
    const rows = this.db.prepare(`SELECT * FROM activity_events WHERE ${where.join(' AND ')} ORDER BY occurred_at DESC,event_id DESC LIMIT ?`)
      .all(...parameters, limit + 1) as unknown as (EventRow & { occurred_at: string })[];
    const page = rows.slice(0, limit); const last = page.at(-1);
    return { items: page.map((row) => this.record(row)), nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify({
      namespace: this.namespace, epoch: this.getSettings().epoch, filterKey, at: last.occurred_at, eventId: last.event_id,
    })).toString('base64url') : null };
  }

  export(): ActivityExport {
    const rows = this.db.prepare('SELECT * FROM activity_events WHERE namespace=? ORDER BY occurred_at DESC,event_id DESC').all(this.namespace) as unknown as EventRow[];
    const deliveries = this.db.prepare('SELECT delivery_id,event_id,channel,received_at,recorded_by FROM activity_deliveries WHERE namespace=? ORDER BY received_at,delivery_id')
      .all(this.namespace).map((row): ActivityDeliveryRecord => ({ deliveryId: String(row.delivery_id), eventId: String(row.event_id),
        channel: row.channel as ActivityChannel, receivedAt: String(row.received_at), recordedBy: JSON.parse(String(row.recorded_by)) }));
    return { format: 'living-memory-activity', version: 1, exportedAt: this.now().toISOString(), sourceId: this.namespace,
      settings: this.getSettings(), events: rows.map((row) => this.record(row)), deliveries };
  }
}
