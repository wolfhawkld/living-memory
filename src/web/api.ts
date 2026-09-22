import type {
  ConceptHistory,
  Layout,
  ModelConfig,
  ObservationRequest,
  ReviewRequest,
  Snapshot,
  WriteReceipt,
} from '../shared/types';
import { createSessionRecovery, type LocalSession } from './session-recovery';
import { inspectLayout } from '../shared/layout';

export type SessionResponse = LocalSession;

export interface PendingWriteError {
  code: string;
  status: number;
  message: string;
  retryable: boolean;
  attemptedAt: string;
}

export interface PendingWrite {
  id: string;
  method: 'POST' | 'PUT';
  path: string;
  payload: unknown;
  eventId: string | null;
  conceptId: string | null;
  label: string;
  createdAt: string;
  lastError?: PendingWriteError;
}

export interface PendingSyncFailure extends Omit<PendingWriteError, 'attemptedAt'> {
  id: string;
  label: string;
}

export interface PendingSyncResult {
  sent: number;
  failed: number;
  failures: PendingSyncFailure[];
  repairs?: { id: string; skippedPositions: number }[];
}

export class ApiRequestError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;

  constructor(message: string, options: { code?: string; status?: number; retryable?: boolean } = {}) {
    super(message);
    this.name = 'ApiRequestError';
    this.code = options.code ?? 'API_ERROR';
    this.status = options.status ?? 0;
    this.retryable = options.retryable ?? false;
  }
}

const API_ROOT = '/api';
const PENDING_KEY_PREFIX = 'living-memory.pending-writes.v1';
const LAYOUT_RECOVERY_KEY_PREFIX = 'living-memory.layout-recovery.v1';

type SessionRecoveryEvent = { kind: 'recovered'; session: LocalSession }
  | { kind: 'source-mismatch'; sourceId?: string };
const sessionListeners = new Set<(event: SessionRecoveryEvent) => void>();
const notifySession = (event: SessionRecoveryEvent) => {
  for (const listener of sessionListeners) listener(event);
};

export function subscribeToSessionRecovery(listener: (event: SessionRecoveryEvent) => void): () => void {
  sessionListeners.add(listener);
  return () => { sessionListeners.delete(listener); };
}

async function getSession(): Promise<LocalSession> {
  const session = await requestJson<LocalSession>('/session', { cache: 'no-store' });
  if (!session || typeof session.writeToken !== 'string' || !session.writeToken.trim()
      || typeof session.sourceId !== 'string' || !session.sourceId.trim()) {
    throw new ApiRequestError('无法取得有效的本地会话，请重新连接。', { code: 'SESSION_INVALID' });
  }
  return session;
}

const sessionRecovery = createSessionRecovery({
  getSession,
  isExpired: (error) => error instanceof ApiRequestError && error.status === 401 && error.code === 'TOKEN_REQUIRED',
  onRecovered: (session) => notifySession({ kind: 'recovered', session }),
  onSourceMismatch: (sourceId) => notifySession({ kind: 'source-mismatch', sourceId }),
  sourceMismatchError: () => new ApiRequestError('知识源已变化，请完成当前输入后重新加载页面。', { code: 'SOURCE_MISMATCH', status: 409 }),
});

async function withSession<T>(writeToken: string, sourceId: string, send: (headers: Record<string, string>) => Promise<T>): Promise<T> {
  if (!sourceId?.trim()) throw new ApiRequestError('缺少当前知识源，未执行写入，请重新连接。', { code: 'SOURCE_REQUIRED' });
  try {
    return await sessionRecovery.run({ writeToken, sourceId }, (session) => send({
      'x-lm-token': session.writeToken,
      'x-lm-source-id': session.sourceId,
    }));
  } catch (error) {
    if (error instanceof ApiRequestError && error.code === 'SOURCE_MISMATCH') notifySession({ kind: 'source-mismatch' });
    throw error;
  }
}

function authenticatedJson<T>(path: string, init: RequestInit, writeToken: string, sourceId: string): Promise<T> {
  return withSession(writeToken, sourceId, (headers) => requestJson<T>(path, { ...init, headers }));
}

function pendingKey(sourceId: string | null | undefined): string | null {
  if (!sourceId?.trim()) return null;
  return `${PENDING_KEY_PREFIX}.${encodeURIComponent(sourceId.trim())}`;
}

function validPendingEntries(entries: unknown[]): PendingWrite[] {
  return entries.filter((item): item is PendingWrite => {
    if (!item || typeof item !== 'object') return false;
    const candidate = item as Record<string, unknown>;
    return (
      typeof candidate.id === 'string' &&
      (candidate.method === 'POST' || candidate.method === 'PUT') &&
      typeof candidate.path === 'string' &&
      typeof candidate.createdAt === 'string'
    );
  });
}

function parsePending(value: string | null): PendingWrite[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? validPendingEntries(parsed) : [];
  } catch {
    return [];
  }
}

export function getPendingWrites(sourceId: string | null | undefined): PendingWrite[] {
  if (typeof window === 'undefined') return [];
  const key = pendingKey(sourceId);
  if (!key) return [];
  try {
    return parsePending(window.localStorage.getItem(key));
  } catch {
    return [];
  }
}

function pendingEntriesForUpdate(key: string): unknown[] {
  // A failed read must never be treated as an empty queue during a write.
  // Preserve unrecognized entries as well as valid writes for later recovery.
  const raw = window.localStorage.getItem(key);
  const entries: unknown = raw === null ? [] : JSON.parse(raw);
  if (!Array.isArray(entries)) throw new Error('待同步存储格式无效，原数据已保留。');
  return entries;
}

function hasPendingId(entry: unknown, id: string): entry is { id: string } {
  return entry !== null && typeof entry === 'object' && 'id' in entry && entry.id === id;
}

export function queuePendingWrite(sourceId: string | null | undefined, write: Omit<PendingWrite, 'id' | 'createdAt'> & { id?: string }): PendingWrite | null {
  const pending: PendingWrite = {
    ...write,
    id: write.id ?? (typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `pending-${Date.now()}-${Math.random().toString(16).slice(2)}`),
    createdAt: new Date().toISOString(),
  };
  if (typeof window === 'undefined') return null;
  const key = pendingKey(sourceId);
  if (!key) return null;
  try {
    const next = pendingEntriesForUpdate(key).filter((item) => !hasPendingId(item, pending.id));
    next.push(pending);
    window.localStorage.setItem(key, JSON.stringify(next));
    window.dispatchEvent(new CustomEvent('lm-pending-changed'));
    return pending;
  } catch {
    return null;
  }
}

export function removePendingWrite(sourceId: string | null | undefined, id: string): boolean {
  if (typeof window === 'undefined') return false;
  const key = pendingKey(sourceId);
  if (!key) return false;
  try {
    const next = pendingEntriesForUpdate(key).filter((item) => !hasPendingId(item, id));
    window.localStorage.setItem(key, JSON.stringify(next));
    window.dispatchEvent(new CustomEvent('lm-pending-changed'));
    return true;
  } catch {
    // A server acknowledgment is not enough to claim the local queue is clear.
    return false;
  }
}

function savePendingError(sourceId: string, id: string, error: PendingWriteError): void {
  const key = pendingKey(sourceId);
  if (!key || typeof window === 'undefined') return;
  try {
    const next = pendingEntriesForUpdate(key).map((write) => hasPendingId(write, id) ? { ...write, lastError: error } : write);
    window.localStorage.setItem(key, JSON.stringify(next));
    window.dispatchEvent(new CustomEvent('lm-pending-changed'));
  } catch {
    // The caller still receives the error when browser storage is unavailable.
  }
}

function preparePendingLayout(write: PendingWrite, sourceId: string): { write: PendingWrite; skippedPositions: number } {
  if (write.method !== 'PUT' || write.path !== '/layout') return { write, skippedPositions: 0 };
  const inspected = inspectLayout(write.payload);
  // Only a recognizable layout with invalid positions can be repaired. Other
  // validation failures must remain visible, with the original request intact.
  if (!inspected || inspected.invalidIds.length === 0) return { write, skippedPositions: 0 };
  try {
    const key = `${LAYOUT_RECOVERY_KEY_PREFIX}.${encodeURIComponent(sourceId)}`;
    const backups = pendingEntriesForUpdate(key);
    let existing = false;
    for (const entry of backups) {
      if (entry !== null && typeof entry === 'object' && 'write' in entry && hasPendingId(entry.write, write.id)) {
        if (!('payload' in entry.write) || JSON.stringify(entry.write.payload) !== JSON.stringify(write.payload)) {
          throw new Error('Conflicting layout backup');
        }
        existing = true;
        break;
      }
    }
    if (!existing) {
      backups.push({ write, invalidIds: inspected.invalidIds, repairedAt: new Date().toISOString() });
      window.localStorage.setItem(key, JSON.stringify(backups));
    }
  } catch {
    throw new ApiRequestError('旧布局尚未备份，未执行修复同步。请允许此页面保存本地数据后重试。', {
      code: 'PENDING_LAYOUT_BACKUP_FAILED', retryable: true,
    });
  }
  // Keep the queued request unchanged until acknowledgment and successful
  // cleanup. PUT /layout merges positions; {} preserves the server's layout.
  return { write: { ...write, payload: inspected.layout }, skippedPositions: inspected.invalidIds.length };
}

export function clearPendingWrites(sourceId: string | null | undefined): void {
  if (typeof window === 'undefined') return;
  const key = pendingKey(sourceId);
  if (!key) return;
  try {
    window.localStorage.removeItem(key);
    window.dispatchEvent(new CustomEvent('lm-pending-changed'));
  } catch {
    // no-op
  }
}

async function parseError(response: Response): Promise<ApiRequestError> {
  let message = `请求失败（${response.status}）`;
  let code = 'HTTP_ERROR';
  try {
    const data: unknown = await response.json();
    if (data && typeof data === 'object' && 'error' in data) {
      const error = (data as { error?: { message?: unknown; code?: unknown } }).error;
      if (typeof error?.message === 'string') message = error.message;
      if (typeof error?.code === 'string') code = error.code;
    }
  } catch {
    // Some infrastructure errors return an empty body. The HTTP status remains useful.
  }
  return new ApiRequestError(message, {
    code,
    status: response.status,
    retryable: response.status === 408 || response.status === 425 || response.status >= 500,
  });
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_ROOT}${path}`, {
      credentials: 'same-origin',
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    });
  } catch {
    throw new ApiRequestError('本地服务暂时不可达，请检查服务是否正在运行。', {
      code: 'NETWORK_OFFLINE',
      retryable: true,
    });
  }
  if (!response.ok) throw await parseError(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

async function requestBlob(path: string, init: RequestInit = {}): Promise<Blob> {
  let response: Response;
  try {
    response = await fetch(`${API_ROOT}${path}`, {
      credentials: 'same-origin',
      ...init,
      headers: { Accept: 'application/json', ...init.headers },
    });
  } catch {
    throw new ApiRequestError('本地服务暂时不可达，请稍后重试。', { code: 'NETWORK_OFFLINE', retryable: true });
  }
  if (!response.ok) throw await parseError(response);
  return response.blob();
}

export async function writeJson<T>(path: string, payload: unknown, writeToken: string, sourceId: string): Promise<T> {
  return authenticatedJson<T>(path, {
    method: 'POST',
    body: JSON.stringify(payload),
  }, writeToken, sourceId);
}

export const api = {
  getSession,
  getConceptHistory: (conceptId: string, sourceId: string, options: { limit?: number; cursor?: string; signal?: AbortSignal } = {}) => {
    if (!sourceId.trim()) return Promise.reject(new ApiRequestError('缺少当前知识源，请重新连接。', { code: 'SOURCE_REQUIRED' }));
    const params = new URLSearchParams({ limit: String(options.limit ?? 20) });
    if (options.cursor) params.set('cursor', options.cursor);
    return requestJson<ConceptHistory>(`/concepts/${encodeURIComponent(conceptId)}/history?${params}`, {
      headers: { 'x-lm-source-id': sourceId }, cache: 'no-store', signal: options.signal,
    });
  },
  getSnapshot: (asOf?: string, sourceId?: string, scope?: 'all') => {
    const params = new URLSearchParams();
    if (asOf) params.set('asOf', asOf);
    if (scope) params.set('scope', scope);
    return requestJson<Snapshot>(`/snapshot${params.size ? `?${params}` : ''}`, sourceId ? { headers: { 'x-lm-source-id': sourceId } } : {});
  },
  postReview: (payload: ReviewRequest, writeToken: string, sourceId: string) =>
    writeJson<WriteReceipt>('/reviews', payload, writeToken, sourceId),
  postObservation: (payload: ObservationRequest, writeToken: string, sourceId: string) =>
    writeJson<WriteReceipt>('/observations', payload, writeToken, sourceId),
  putConfig: (payload: Pick<ModelConfig, 'halfLifeDays' | 'revision'>, writeToken: string, sourceId: string) =>
    authenticatedJson<ModelConfig>('/config', {
      method: 'PUT',
      body: JSON.stringify(payload),
    }, writeToken, sourceId),
  getLayout: (sourceId?: string) => requestJson<Layout>('/layout', sourceId ? { headers: { 'x-lm-source-id': sourceId } } : {}),
  putLayout: async (payload: Layout, writeToken: string, sourceId: string) => {
    const inspected = inspectLayout(payload);
    if (!inspected || inspected.invalidIds.length > 0) {
      throw new ApiRequestError('布局包含无效坐标，尚未保存。', { code: 'INVALID_LAYOUT' });
    }
    return authenticatedJson<Layout>('/layout', {
      method: 'PUT',
      body: JSON.stringify(payload),
    }, writeToken, sourceId);
  },
  refresh: (writeToken: string, sourceId: string) => writeJson<{ status: string }>('/refresh', {}, writeToken, sourceId),
  exportData: (writeToken: string, sourceId: string) => withSession(writeToken, sourceId, (headers) => requestBlob('/export', { headers })),
  sendPending: async (write: PendingWrite, writeToken: string, sourceId: string): Promise<void> => {
    const result = await authenticatedJson<WriteReceipt | ModelConfig | Layout>(write.path, {
      method: write.method,
      body: JSON.stringify(write.payload),
    }, writeToken, sourceId);
    if (!result) return;
  },
};

const pendingFlushes = new Map<string, Promise<PendingSyncResult>>();

async function sendPendingBatch(writeToken: string, sourceId: string): Promise<PendingSyncResult> {
  let sent = 0;
  const failures: PendingSyncFailure[] = [];
  const repairs: NonNullable<PendingSyncResult['repairs']> = [];
  let writes: PendingWrite[];
  try {
    writes = validPendingEntries(pendingEntriesForUpdate(pendingKey(sourceId)!));
  } catch {
    throw new ApiRequestError('无法读取浏览器中的待同步记录，原数据未改动。请允许此页面访问本地数据后重试。', {
      code: 'PENDING_STORAGE_UNAVAILABLE', retryable: true,
    });
  }
  for (const write of writes) {
    try {
      const prepared = preparePendingLayout(write, sourceId);
      await api.sendPending(prepared.write, writeToken, sourceId);
      if (!removePendingWrite(sourceId, write.id)) {
        throw new ApiRequestError('记录已写入服务，但浏览器未能清理待同步标记。请允许此页面保存本地数据后重试。', {
          code: 'PENDING_STORAGE_FAILED', retryable: true,
        });
      }
      sent += 1;
      if (prepared.skippedPositions > 0) repairs.push({ id: write.id, skippedPositions: prepared.skippedPositions });
    } catch (error) {
      const detail: PendingWriteError = {
        code: error instanceof ApiRequestError ? error.code : 'PENDING_SYNC_ERROR',
        status: error instanceof ApiRequestError ? error.status : 0,
        message: error instanceof Error ? error.message : '这条记录同步失败，请稍后重试。',
        retryable: error instanceof ApiRequestError && error.retryable,
        attemptedAt: new Date().toISOString(),
      };
      savePendingError(sourceId, write.id, detail);
      const { attemptedAt: _attemptedAt, ...failure } = detail;
      failures.push({ ...failure, id: write.id, label: typeof write.label === 'string' && write.label.trim() ? write.label : '待同步记录' });
      // Keep the original id, payload and timestamps, including on non-retryable
      // conflicts. Showing the rejection is safer than silently rewriting history.
    }
  }
  return { sent, failed: failures.length, failures, ...(repairs.length ? { repairs } : {}) };
}

export function flushPendingWrites(writeToken: string, sourceId: string | null | undefined): Promise<PendingSyncResult> {
  const source = sourceId?.trim();
  if (!source) return Promise.resolve({ sent: 0, failed: 0, failures: [] });
  const existing = pendingFlushes.get(source);
  if (existing) return existing;
  // Manual retry and an online event can arrive together. Share one batch per
  // source so a non-idempotent settings update is not sent twice by this page.
  const operation = Promise.resolve().then(() => sendPendingBatch(writeToken, source)).finally(() => {
    if (pendingFlushes.get(source) === operation) pendingFlushes.delete(source);
  });
  pendingFlushes.set(source, operation);
  return operation;
}
