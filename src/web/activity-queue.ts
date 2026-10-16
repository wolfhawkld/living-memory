import { parseActivityAppendRequest, type ActivityAppendRequest, type ActivityAppendResult, type ActivitySettings } from '../shared/activity';
import { PendingCoordinationError, withPendingStorageLock, withPendingSyncLock } from './pending-coordination';

export const ACTIVITY_QUEUE_MAX_ITEMS = 100;
export const ACTIVITY_QUEUE_MAX_BYTES = 512 * 1024;
export const ACTIVITY_QUEUE_MAX_ATTEMPTS = 3;

export interface ActivityQueueScope { accountId: string; sourceId: string; instanceId?: string }
export interface ActivityQueueContext extends ActivityQueueScope {
  authenticated: boolean;
  mode: 'real' | 'example' | 'forecast';
  locked?: boolean;
  /** Only settings obtained from the server belong here. No client default. */
  settings?: ActivitySettings;
}
export interface ActivityQueueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
export type ActivityFailureKind = 'disabled' | 'epoch-changed' | 'deleted' | 'conflict' | 'retryable' | 'auth-required' | 'source-changed';
export interface ActivityQueueFailure { kind: ActivityFailureKind; code: string }
export type ActivityQueueNotSavedReason = 'inactive' | 'settings-unavailable' | 'disabled' | 'epoch-changed'
  | 'invalid-request' | 'conflict' | 'full' | 'storage-unavailable' | 'storage-corrupt' | 'coordination-unavailable' | 'context-changed';
export type ActivityEnqueueResult = { status: 'queued' | 'already-queued'; eventId: string }
  | { status: 'not-saved'; reason: ActivityQueueNotSavedReason };
export interface ActivityQueueRow {
  request: ActivityAppendRequest;
  attempts: number;
  nextAttemptAt: number;
  state: 'pending' | 'conflict' | 'exhausted';
  lastError?: string;
}
interface QueueRecord {
  version: 1;
  scope: ActivityQueueScope;
  settings: ActivitySettings;
  rows: ActivityQueueRow[];
}
export interface ActivityQueueSnapshot {
  status: 'available' | 'unavailable';
  reason?: ActivityQueueNotSavedReason;
  rows: readonly ActivityQueueRow[];
}
export interface ActivityFlushItem { eventId: string; status: ActivityAppendResult['status'] | ActivityFailureKind | 'exhausted' }
export interface ActivityFlushResult {
  status: 'done' | 'inactive' | 'busy' | 'context-changed' | 'unavailable';
  items: ActivityFlushItem[];
  reason?: ActivityQueueNotSavedReason;
}
export interface ActivityQueueOptions {
  storage: ActivityQueueStorage;
  transport: { append(request: ActivityAppendRequest, scope: ActivityQueueScope): Promise<ActivityAppendResult> };
  now?: () => number;
  classifyError?: (error: unknown) => ActivityQueueFailure;
  withStorageLock?: <T>(scope: string, action: () => T) => Promise<T>;
  withSyncLock?: <T>(scope: string, action: () => Promise<T>, busy: () => T) => Promise<T>;
}

class QueueError extends Error {
  constructor(readonly reason: ActivityQueueNotSavedReason) { super(reason); }
}
export function activityQueueStorageKey(scope: ActivityQueueScope): string {
  const base = `living-memory.activity.queue.v1.${encodeURIComponent(JSON.stringify([scope.accountId, scope.sourceId]))}`;
  return (scope.instanceId ?? 'legacy') === 'legacy' ? base : `${base}:instance:${encodeURIComponent(scope.instanceId!)}`;
}
function scopeOf(context: ActivityQueueScope): ActivityQueueScope {
  return { accountId: context.accountId, sourceId: context.sourceId, ...((context.instanceId ?? 'legacy') === 'legacy' ? {} : { instanceId: context.instanceId }) };
}
function scopeEquals(a: ActivityQueueScope, b: ActivityQueueScope): boolean {
  return a.accountId === b.accountId && a.sourceId === b.sourceId && (a.instanceId ?? 'legacy') === (b.instanceId ?? 'legacy');
}
function validSettings(value: unknown): value is ActivitySettings {
  const settings = value as ActivitySettings | null;
  return Boolean(settings && typeof settings.enabled === 'boolean' && Number.isSafeInteger(settings.epoch)
    && settings.epoch >= 0 && Number.isSafeInteger(settings.revision) && settings.revision >= 0);
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function classifyActivityQueueError(error: unknown): ActivityQueueFailure {
  const candidate = error as { code?: unknown; status?: unknown } | null;
  const code = typeof candidate?.code === 'string' ? candidate.code : 'ACTIVITY_TRANSPORT_ERROR';
  const kinds: Record<string, ActivityFailureKind> = {
    ACTIVITY_DISABLED: 'disabled', ACTIVITY_EPOCH_CHANGED: 'epoch-changed', ACTIVITY_DELETED: 'deleted',
    ACTIVITY_CONFLICT: 'conflict', INVALID_ACTIVITY: 'conflict', INVALID_ACTIVITY_REFERENCE: 'conflict',
    ACTIVITY_CHANNEL_FORBIDDEN: 'conflict', CHANNEL_FORBIDDEN: 'conflict', ACTIVITY_SETTINGS_CHANGED: 'conflict',
    TOKEN_REQUIRED: 'auth-required', SOURCE_MISMATCH: 'source-changed', INSTANCE_MISMATCH: 'source-changed',
  };
  return { kind: kinds[code] ?? (candidate?.status === 401 || candidate?.status === 403 ? 'auth-required' : candidate?.status === 409 ? 'conflict' : 'retryable'), code };
}
function storageReason(error: unknown): ActivityQueueNotSavedReason {
  return error instanceof QueueError ? error.reason : error instanceof PendingCoordinationError ? 'coordination-unavailable' : 'storage-unavailable';
}
function cloneRequest(request: unknown): ActivityAppendRequest {
  try { return parseActivityAppendRequest(request); } catch { throw new QueueError('invalid-request'); }
}
function readRecord(storage: ActivityQueueStorage, scope: ActivityQueueScope, settings: ActivitySettings): QueueRecord {
  let raw: string | null;
  try { raw = storage.getItem(activityQueueStorageKey(scope)); } catch { throw new QueueError('storage-unavailable'); }
  if (raw === null) return { version: 1, scope, settings: { ...settings }, rows: [] };
  try {
    if (new TextEncoder().encode(raw).length > ACTIVITY_QUEUE_MAX_BYTES) throw new Error();
    const value = JSON.parse(raw) as QueueRecord;
    if (value.version !== 1 || !scopeEquals(value.scope, scope) || !validSettings(value.settings)
      || !Array.isArray(value.rows) || value.rows.length > ACTIVITY_QUEUE_MAX_ITEMS) throw new Error();
    const ids = new Set<string>();
    value.rows = value.rows.map((row) => {
      const request = cloneRequest(row.request);
      if (request.epoch !== value.settings.epoch || !Number.isInteger(row.attempts) || row.attempts < 0
        || row.attempts > ACTIVITY_QUEUE_MAX_ATTEMPTS || !Number.isFinite(row.nextAttemptAt)
        || !['pending', 'conflict', 'exhausted'].includes(row.state) || ids.has(request.event.eventId)
        || (row.lastError !== undefined && typeof row.lastError !== 'string')) throw new Error();
      ids.add(request.event.eventId);
      return { request, attempts: row.attempts, nextAttemptAt: row.nextAttemptAt, state: row.state,
        ...(row.lastError ? { lastError: row.lastError } : {}) };
    });
    return value;
  } catch { throw new QueueError('storage-corrupt'); }
}
function saveRecord(storage: ActivityQueueStorage, record: QueueRecord): void {
  const raw = JSON.stringify(record);
  if (record.rows.length > ACTIVITY_QUEUE_MAX_ITEMS || new TextEncoder().encode(raw).length > ACTIVITY_QUEUE_MAX_BYTES) throw new QueueError('full');
  try { storage.setItem(activityQueueStorageKey(record.scope), raw); } catch (error) {
    throw new QueueError((error as { name?: string })?.name === 'QuotaExceededError' ? 'full' : 'storage-unavailable');
  }
}

/** Separate metadata queue gated by server-confirmed settings. Query text is opt-in.
 * It never reads or counts learning writes. */
export function createActivityQueue(options: ActivityQueueOptions) {
  const storageLock = options.withStorageLock ?? withPendingStorageLock;
  const syncLock = options.withSyncLock ?? withPendingSyncLock;
  const now = options.now ?? Date.now;
  const classify = options.classifyError ?? classifyActivityQueueError;
  let context: ActivityQueueContext | null = null;
  let generation = 0;
  function active(): ActivityQueueContext | null {
    return context?.authenticated && context.mode === 'real' && context.accountId.trim() && context.sourceId.trim() ? context : null;
  }
  function gate(): ActivityQueueNotSavedReason | null {
    const current = active();
    return !current || current.locked ? 'inactive' : !current.settings ? 'settings-unavailable' : !current.settings.enabled ? 'disabled' : null;
  }
  function lockScope(scope: ActivityQueueScope): string { return `activity:${activityQueueStorageKey(scope)}`; }
  function currentRecord(captured: ActivityQueueContext): QueueRecord {
    const settings = captured.settings!;
    const record = readRecord(options.storage, scopeOf(captured), settings);
    if (record.settings.epoch > settings.epoch || record.settings.revision > settings.revision) throw new QueueError('epoch-changed');
    const advanced = record.settings.epoch < settings.epoch || record.settings.revision < settings.revision;
    if (record.settings.epoch < settings.epoch) record.rows = [];
    record.settings = { enabled: settings.enabled, epoch: settings.epoch, revision: settings.revision };
    if (advanced) saveRecord(options.storage, record);
    return record;
  }
  return {
    setContext(next: ActivityQueueContext | null): void {
      generation += 1;
      context = next ? { ...next, ...(next.settings && validSettings(next.settings) ? { settings: { ...next.settings } } : { settings: undefined }) } : null;
    },
    /** Apply a server-confirmed setting/epoch. Never invent epochs locally. */
    async applySettings(settings: ActivitySettings): Promise<{ applied: boolean; reason?: ActivityQueueNotSavedReason }> {
      const captured = active();
      if (!captured) return { applied: false, reason: 'inactive' };
      if (!validSettings(settings)) return { applied: false, reason: 'settings-unavailable' };
      if (captured.settings && (captured.settings.epoch > settings.epoch || captured.settings.revision > settings.revision)) {
        return { applied: false, reason: 'epoch-changed' };
      }
      // Consent changes gate this page immediately, even if persistent storage fails.
      generation += 1;
      context = { ...captured, settings: { enabled: settings.enabled, epoch: settings.epoch, revision: settings.revision } };
      const capturedGeneration = generation;
      try {
        return await storageLock(lockScope(captured), () => {
          if (generation !== capturedGeneration) return { applied: false, reason: 'context-changed' as const };
          const record = readRecord(options.storage, scopeOf(captured), settings);
          if (record.settings.epoch > settings.epoch || record.settings.revision > settings.revision) {
            context = { ...context!, settings: undefined };
            return { applied: false, reason: 'epoch-changed' as const };
          }
          if (!settings.enabled || record.settings.epoch !== settings.epoch) record.rows = [];
          record.settings = { enabled: settings.enabled, epoch: settings.epoch, revision: settings.revision };
          saveRecord(options.storage, record);
          return { applied: true };
        });
      } catch (error) { return { applied: false, reason: storageReason(error) }; }
    },
    async enqueue(input: ActivityAppendRequest): Promise<ActivityEnqueueResult> {
      const blocked = gate();
      if (blocked) return { status: 'not-saved', reason: blocked };
      const captured = context!;
      const capturedGeneration = generation;
      let request: ActivityAppendRequest;
      try { request = cloneRequest(input); } catch { return { status: 'not-saved', reason: 'invalid-request' }; }
      if (request.epoch !== captured.settings!.epoch) return { status: 'not-saved', reason: 'epoch-changed' };
      try {
        return await storageLock(lockScope(captured), () => {
          if (generation !== capturedGeneration) return { status: 'not-saved', reason: 'context-changed' } as const;
          const record = currentRecord(captured);
          const existing = record.rows.find((row) => row.request.event.eventId === request.event.eventId
            || (row.request.event.operationId === request.event.operationId && row.request.event.stepKey === request.event.stepKey));
          if (existing) return stable(existing.request) === stable(request)
            ? { status: 'already-queued', eventId: request.event.eventId } as const
            : { status: 'not-saved', reason: 'conflict' } as const;
          record.rows.push({ request, attempts: 0, nextAttemptAt: 0, state: 'pending' });
          saveRecord(options.storage, record);
          return { status: 'queued', eventId: request.event.eventId } as const;
        });
      } catch (error) { return { status: 'not-saved', reason: storageReason(error) }; }
    },
    /** Call only after the server confirms this operation was deleted. */
    async clearOperation(operationId: string): Promise<{ cleared: boolean; reason?: ActivityQueueNotSavedReason }> {
      const captured = active();
      const capturedGeneration = generation;
      if (!captured?.settings) return { cleared: false, reason: 'settings-unavailable' };
      try {
        return await storageLock(lockScope(captured), () => {
          if (capturedGeneration !== generation) return { cleared: false, reason: 'context-changed' as const };
          const record = currentRecord(captured);
          record.rows = record.rows.filter((row) => row.request.event.operationId !== operationId);
          saveRecord(options.storage, record);
          generation += 1;
          return { cleared: true };
        });
      } catch (error) { return { cleared: false, reason: storageReason(error) }; }
    },
    async snapshot(): Promise<ActivityQueueSnapshot> {
      const captured = active();
      const capturedGeneration = generation;
      if (!captured?.settings) return { status: 'unavailable', reason: 'settings-unavailable', rows: [] };
      try {
        return await storageLock(lockScope(captured), () => {
          if (generation !== capturedGeneration) return { status: 'unavailable', reason: 'context-changed', rows: [] } as const;
          const record = currentRecord(captured);
          return { status: 'available', rows: record.rows } as const;
        });
      } catch (error) { return { status: 'unavailable', reason: storageReason(error), rows: [] }; }
    },
    /** Explicit user retry of exhausted transient failures; never reset conflicts. */
    async retryPending(): Promise<{ reset: number; reason?: ActivityQueueNotSavedReason }> {
      const blocked = gate();
      if (blocked) return { reset: 0, reason: blocked };
      const captured = context!;
      const capturedGeneration = generation;
      try {
        return await storageLock(lockScope(captured), () => {
          if (generation !== capturedGeneration) return { reset: 0, reason: 'context-changed' as const };
          const record = currentRecord(captured);
          let reset = 0;
          for (const row of record.rows) if (row.state === 'exhausted') {
            row.state = 'pending'; row.attempts = 0; row.nextAttemptAt = 0;
            delete row.lastError;
            reset += 1;
          }
          if (reset) saveRecord(options.storage, record);
          return { reset };
        });
      } catch (error) { return { reset: 0, reason: storageReason(error) }; }
    },
    /** At most ten requests per explicit trigger, with three attempts per row. */
    async flush(): Promise<ActivityFlushResult> {
      const blocked = gate();
      if (blocked) return { status: 'inactive', items: [], reason: blocked };
      const captured = context!;
      const capturedGeneration = generation;
      const items: ActivityFlushItem[] = [];
      try {
        return await syncLock<ActivityFlushResult>(lockScope(captured), async () => {
          for (let sent = 0; sent < 10; sent += 1) {
            if (generation !== capturedGeneration) return { status: 'context-changed', items };
            const row = await storageLock(lockScope(captured), () => {
              if (generation !== capturedGeneration) throw new QueueError('context-changed');
              return currentRecord(captured).rows.find((entry) => entry.state === 'pending' && entry.attempts < ACTIVITY_QUEUE_MAX_ATTEMPTS && entry.nextAttemptAt <= now());
            });
            if (!row) break;
            if (generation !== capturedGeneration) return { status: 'context-changed', items };
            let result: ActivityAppendResult | ActivityQueueFailure;
            try {
              result = await options.transport.append(cloneRequest(row.request), scopeOf(captured));
              if (!['accepted', 'duplicate'].includes(result.status) || result.eventId !== row.request.event.eventId
                || result.epoch !== row.request.epoch) result = { kind: 'conflict', code: 'ACTIVITY_RECEIPT_MISMATCH' };
            }
            catch (error) { result = classify(error); }
            if (generation !== capturedGeneration) return { status: 'context-changed', items };
            const outcome = 'status' in result ? result.status : result.kind;
            let reportOutcome: ActivityFlushItem['status'] = outcome;
            await storageLock(lockScope(captured), () => {
              if (generation !== capturedGeneration) throw new QueueError('context-changed');
              const record = currentRecord(captured);
              const stored = record.rows.find((entry) => entry.request.event.eventId === row.request.event.eventId);
              if (!stored || stable(stored.request) !== stable(row.request)) return;
              if (outcome === 'accepted' || outcome === 'duplicate') record.rows = record.rows.filter((entry) => entry !== stored);
              else if (outcome === 'deleted') record.rows = record.rows.filter((entry) => entry.request.event.operationId !== stored.request.event.operationId);
              else if (outcome === 'disabled' || outcome === 'epoch-changed') record.rows = [];
              else if (outcome === 'conflict') { stored.state = 'conflict'; stored.lastError = (result as ActivityQueueFailure).code; }
              else if (outcome === 'retryable') {
                stored.attempts += 1;
                stored.lastError = (result as ActivityQueueFailure).code;
                stored.nextAttemptAt = now() + Math.min(60_000, 1000 * 2 ** (stored.attempts - 1));
                if (stored.attempts >= ACTIVITY_QUEUE_MAX_ATTEMPTS) { stored.state = 'exhausted'; reportOutcome = 'exhausted'; }
              }
              saveRecord(options.storage, record);
            });
            items.push({ eventId: row.request.event.eventId, status: reportOutcome });
            if (['disabled', 'epoch-changed', 'auth-required', 'source-changed'].includes(outcome)) {
              context = { ...captured, settings: undefined };
              generation += 1;
              break;
            }
          }
          return { status: 'done', items };
        }, () => ({ status: 'busy', items: [] }));
      } catch (error) { return { status: error instanceof QueueError && error.reason === 'context-changed' ? 'context-changed' : 'unavailable', items, reason: storageReason(error) }; }
    },
  };
}
