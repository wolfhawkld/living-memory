import { parseAnswerClearingMarker, parseAnswerClearingRequest, type AnswerClearingMarker } from '../shared/answer-clearing';
import { briefReviewCheckpointKey, parseBriefReviewCheckpoint, scrubBriefReviewCheckpoint, serializeBriefReviewCheckpoint, type BriefReviewCheckpointStorage } from './brief-review-checkpoint';
import { instanceStorageKey } from './instance-storage';
import { withPendingStorageLock } from './pending-coordination';

export interface AnswerPrivacyScope { sourceId: string; instanceId: string }
export interface AnswerPrivacyRecord {
  observationEventId: string;
  status: 'pending' | 'cleared';
  clearedAt?: string;
  cleanup: 'pending' | 'complete';
  error?: string;
}
export interface AnswerPrivacyCleanupResult { complete: boolean; pendingRemoved: number; checkpointCleared: boolean; errors: string[] }
export interface AnswerPrivacyChannel {
  getSnapshot(): readonly AnswerPrivacyRecord[];
  getMarker(id: string): AnswerClearingMarker | null;
  isBlocked(id: string): boolean;
  subscribe(listener: () => void): () => void;
  begin(id: string): Promise<void>;
  cancelUnsent(id: string): Promise<void>;
  confirm(marker: AnswerClearingMarker): Promise<AnswerPrivacyCleanupResult>;
  retryCleanup(id: string): Promise<AnswerPrivacyCleanupResult>;
  reconcile(): void;
  dispose(): void;
}
const PREFIX = 'living-memory.answer-privacy.v1';
function resourcePath(path: string): string { return path.split(/[?#]/, 1)[0].replace(/\/+$/, '').toLowerCase(); }
export function isOriginalObservationPath(path: string): boolean { return resourcePath(path) === '/observations'; }
export function isAnswerClearingPath(path: string): boolean { return /^\/observations\/[^/]+\/answer-clearing$/.test(resourcePath(path)); }
export function answerPrivacyStorageKey(scope: AnswerPrivacyScope): string {
  return instanceStorageKey(`${PREFIX}.${encodeURIComponent(scope.sourceId.trim())}`, scope.instanceId);
}
export function answerPrivacyLockKey(scope: AnswerPrivacyScope): string {
  return scope.instanceId === 'legacy' ? scope.sourceId.trim() : `${scope.sourceId.trim()}.instance.${encodeURIComponent(scope.instanceId)}`;
}
function pendingKey(scope: AnswerPrivacyScope): string {
  return instanceStorageKey(`living-memory.pending-writes.v1.${encodeURIComponent(scope.sourceId.trim())}`, scope.instanceId);
}
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function parseRecords(raw: string | null): AnswerPrivacyRecord[] {
  if (raw === null) return [];
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value)) throw new Error('原答隐私标记不可读取，请保留页面后重试。');
  const ids = new Set<string>();
  return value.map(item => {
    if (!object(item) || !['pending','cleared'].includes(String(item.status)) || !['pending','complete'].includes(String(item.cleanup))
      || Object.keys(item).some(key => !['observationEventId','status','clearedAt','cleanup'].includes(key))) throw new Error('原答隐私标记无效。');
    const { observationEventId } = parseAnswerClearingRequest({ observationEventId: item.observationEventId });
    if (ids.has(observationEventId)) throw new Error('原答隐私标记重复。');
    ids.add(observationEventId);
    if (item.status === 'cleared') {
      const marker = parseAnswerClearingMarker({ observationEventId, clearedAt: item.clearedAt });
      return { ...marker, status: 'cleared', cleanup: item.cleanup } as AnswerPrivacyRecord;
    }
    if (item.clearedAt !== undefined || item.cleanup !== 'pending') throw new Error('原答隐私标记无效。');
    return { observationEventId, status: 'pending', cleanup: 'pending' };
  });
}
function diskRecords(records: readonly AnswerPrivacyRecord[]): string {
  return JSON.stringify(records.map(({ error: _error, ...record }) => record));
}
function markerOf(record: AnswerPrivacyRecord | undefined): AnswerClearingMarker | null {
  return record?.status === 'cleared' && record.clearedAt ? { observationEventId: record.observationEventId, clearedAt: record.clearedAt } : null;
}
/** Factory injection is for isolated tests; production callers share the singleton below. */
export function createAnswerPrivacyChannel(scope: AnswerPrivacyScope, options: {
  storage?: BriefReviewCheckpointStorage;
  lock?: <T>(action: () => T) => Promise<T>;
  host?: Window | null;
} = {}): AnswerPrivacyChannel {
  const host = options.host === undefined ? (typeof window === 'undefined' ? null : window) : options.host;
  const storage = () => options.storage ?? host?.localStorage;
  const key = answerPrivacyStorageKey(scope);
  const lock = options.lock ?? (<T>(action: () => T) => withPendingStorageLock(answerPrivacyLockKey(scope), action));
  let records: readonly AnswerPrivacyRecord[] = [];
  let storageFailure = false;
  const listeners = new Set<() => void>();
  let broadcast: BroadcastChannel | null = null;
  const publish = (next: readonly AnswerPrivacyRecord[]) => {
    if (JSON.stringify(next) === JSON.stringify(records)) return;
    records = next; listeners.forEach(listener => listener());
  };
  const read = () => {
    const target = storage(); if (!target) throw new Error('浏览器本地存储不可用。');
    return parseRecords(target.getItem(key));
  };
  const merge = (disk: readonly AnswerPrivacyRecord[]) => {
    const next = new Map(disk.map(record => [record.observationEventId, record]));
    for (const record of records) {
      const previous = next.get(record.observationEventId);
      if (record.status === 'cleared') {
        if (previous?.status === 'cleared' && previous.clearedAt !== record.clearedAt) throw new Error('原答首次清除时间冲突。');
        next.set(record.observationEventId, { ...record, ...(previous?.status === 'cleared' ? { cleanup: previous.cleanup } : {}) });
      }
    }
    return [...next.values()];
  };
  const notify = () => {
    try { broadcast?.postMessage({ sourceId: scope.sourceId, instanceId: scope.instanceId }); } catch { /* storage events and focus reconciliation remain available */ }
    try { host?.dispatchEvent(new CustomEvent('lm-answer-privacy-changed', { detail: scope })); } catch { /* no answers in notifications */ }
  };
  const reconcile = () => {
    try {
      const next = merge(read());
      const recovered = storageFailure; storageFailure = false;
      if (recovered) { records = [...next]; listeners.forEach(listener => listener()); }
      else publish(next);
    } catch {
      if (!storageFailure) { storageFailure = true; records = [...records]; listeners.forEach(listener => listener()); }
    }
  };
  const persist = (next: readonly AnswerPrivacyRecord[]) => {
    const target = storage(); if (!target) throw new Error('浏览器本地存储不可用。');
    target.setItem(key, diskRecords(next)); storageFailure = false; publish(next); notify();
  };
  function cleanup(id: string): Omit<AnswerPrivacyCleanupResult, 'complete'> {
    const target = storage()!; let pendingRemoved = 0, checkpointCleared = false; const errors: string[] = [];
    try {
      const raw = target.getItem(pendingKey(scope));
      if (raw !== null) {
        const entries: unknown = JSON.parse(raw);
        if (!Array.isArray(entries)) throw new Error('待同步格式无效');
        const remaining = entries.filter(entry => {
          if (!object(entry)) { errors.push('待同步队列含无法识别的记录，已保留。'); return true; }
          if (typeof entry.path !== 'string') { errors.push('待同步队列含无法识别的记录，已保留。'); return true; }
          if (!isOriginalObservationPath(entry.path)) return true;
          const payloadId = object(entry.payload) ? entry.payload.eventId : undefined;
          if (entry.eventId === id || payloadId === id) {
            if (entry.method !== 'POST' || entry.eventId !== id || payloadId !== id) {
              errors.push('待同步观察标识不一致，已保留并阻止发送。'); return true;
            }
            pendingRemoved++; return false;
          }
          if (typeof entry.eventId !== 'string' || typeof payloadId !== 'string') errors.push('待同步队列含无法识别的观察，已保留。');
          return true;
        });
        if (pendingRemoved) target.setItem(pendingKey(scope), JSON.stringify(remaining));
      }
    } catch { pendingRemoved = 0; errors.push('待同步副本尚未完成本机清理。'); }
    try {
      const checkpointKey = instanceStorageKey(briefReviewCheckpointKey(scope.sourceId), scope.instanceId);
      const raw = target.getItem(checkpointKey);
      if (raw !== null) {
        const before = parseBriefReviewCheckpoint(raw, scope.sourceId);
        if (!before) throw new Error('断点格式无效');
        const after = scrubBriefReviewCheckpoint(before, id);
        if (after !== before) { target.setItem(checkpointKey, serializeBriefReviewCheckpoint(scope.sourceId, after)); checkpointCleared = true; }
      }
    } catch { errors.push('复习断点副本尚未完成本机清理。'); }
    try { host?.dispatchEvent(new CustomEvent('lm-pending-changed', { detail: scope })); } catch { /* no payload */ }
    return { pendingRemoved, checkpointCleared, errors };
  }
  const confirm = async (input: AnswerClearingMarker): Promise<AnswerPrivacyCleanupResult> => {
    const marker = parseAnswerClearingMarker(input);
    const previous = records.find(record => record.observationEventId === marker.observationEventId);
    if (previous?.status === 'cleared' && previous.clearedAt !== marker.clearedAt) throw new Error('原答首次清除时间冲突。');
    // Hide controlled in-memory copies before any fallible browser write.
    publish([...records.filter(record => record.observationEventId !== marker.observationEventId), { ...marker, status: 'cleared', cleanup: 'pending' }]);
    try {
      return await lock(() => {
        const next = merge(read()).filter(record => record.observationEventId !== marker.observationEventId);
        const pending: AnswerPrivacyRecord = { ...marker, status: 'cleared', cleanup: 'pending' };
        persist([...next, pending]); // durable tombstone always precedes original-copy deletion
        const result = cleanup(marker.observationEventId);
        const complete = result.errors.length === 0;
        persist([...next, { ...pending, cleanup: complete ? 'complete' : 'pending', ...(complete ? {} : { error: result.errors.join(' ') }) }]);
        return { complete, ...result };
      });
    } catch {
      const error = '服务端已清除；本机副本清理尚未完成，请重试本机清理。';
      publish(records.map(record => record.observationEventId === marker.observationEventId ? { ...record, cleanup: 'pending', error } : record));
      return { complete: false, pendingRemoved: 0, checkpointCleared: false, errors: [error] };
    }
  };
  const storageChanged = (event: Event) => {
    const storageEvent = event as StorageEvent;
    if (event.type === 'storage' && storageEvent.key !== null && storageEvent.key !== key) return;
    if (event.type === 'lm-answer-privacy-changed') {
      const detail = (event as CustomEvent<AnswerPrivacyScope>).detail;
      if (detail?.sourceId !== scope.sourceId || detail?.instanceId !== scope.instanceId) return;
    }
    reconcile();
  };
  for (const event of ['storage','focus','pageshow','lm-answer-privacy-changed']) host?.addEventListener(event, storageChanged);
  const visible = () => { if (!host?.document?.hidden) reconcile(); };
  host?.document?.addEventListener('visibilitychange', visible);
  const Broadcast = (host as (Window & typeof globalThis) | null)?.BroadcastChannel;
  if (Broadcast) {
    try { const channel = new Broadcast(`${PREFIX}:${key}`); channel.onmessage = reconcile; broadcast = channel; } catch { /* storage fallback */ }
  }
  if (host || options.storage) reconcile();
  return {
    getSnapshot: () => records,
    getMarker: id => markerOf(records.find(record => record.observationEventId === id)),
    isBlocked: id => storageFailure || records.some(record => record.observationEventId === id),
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    begin: async id => {
      const { observationEventId } = parseAnswerClearingRequest({ observationEventId: id });
      await lock(() => {
        const next = merge(read());
        if (!next.some(record => record.observationEventId === observationEventId)) persist([...next, { observationEventId, status: 'pending', cleanup: 'pending' }]);
        else publish(next);
      });
    },
    cancelUnsent: async id => { await lock(() => { const next = merge(read()); persist(next.filter(record => record.observationEventId !== id || record.status === 'cleared')); }); },
    confirm,
    retryCleanup: async id => {
      reconcile(); const marker = markerOf(records.find(record => record.observationEventId === id));
      if (!marker) return { complete: false, pendingRemoved: 0, checkpointCleared: false, errors: ['清除结果尚未确认，请先核对服务端状态。'] };
      return confirm(marker);
    },
    reconcile,
    dispose: () => {
      for (const event of ['storage','focus','pageshow','lm-answer-privacy-changed']) host?.removeEventListener(event, storageChanged);
      host?.document?.removeEventListener('visibilitychange', visible); broadcast?.close(); broadcast = null; listeners.clear();
    },
  };
}
const channels = new Map<string, AnswerPrivacyChannel>();
export function getAnswerPrivacyChannel(scope: AnswerPrivacyScope): AnswerPrivacyChannel {
  const key = JSON.stringify([scope.sourceId, scope.instanceId]);
  let channel = channels.get(key);
  if (!channel) {
    // A consumer releases its subscribe handle; disposing a shared channel must
    // not disable another mounted consumer or forget a confirmed privacy fact.
    channel = { ...createAnswerPrivacyChannel(scope), dispose: () => {} };
    channels.set(key, channel);
  }
  return channel;
}
