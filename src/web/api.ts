import type {
  ApplicationRecordRequest,
  ConceptHistory,
  ConfigWriteReceipt,
  Layout,
  ModelConfig,
  ObservationRequest,
  ReviewRequest,
  RetentionRequest,
  Snapshot,
  WriteReceipt,
} from '../shared/types';
import { createSessionRecovery, type LocalSession } from './session-recovery';
import { inspectLayout } from '../shared/layout';
import type { AccountUser } from '../shared/accounts';
import type { LearningOverview } from '../shared/learning-overview';
import type { ScenarioPrompts } from '../shared/scenario-prompts';
import type { PracticeCardRequest, PracticeAttemptRequest, PracticeCardsResponse, PracticeHistoryResponse } from '../shared/practice';
import type { CorrectionRequest } from '../shared/corrections';
import type { ReviewPlanResponse, ReviewPlanUpdate } from '../shared/review-plan';
import type { IdentityStatus, IdentityLinkRequest, IdentityLinkPreview, IdentityLinkCommit, IdentityLinkReceipt } from '../shared/identity';
import type { ImportPreviewRequest, ImportPreview, ImportCommitRequest, ImportReceipt } from '../shared/import-data';
import { PendingCoordinationError, withPendingStorageLock, withPendingSyncLock } from './pending-coordination';
import { BULK_REQUEST_TIMEOUT_MS, RequestDeadlineError, withRequestDeadline } from './request-deadline';

export type SessionResponse = LocalSession & { user?: AccountUser };

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
  /** Another page is synchronizing this knowledge space. */
  busy?: boolean;
  /** Previously applied config transitions acknowledged without changing H. */
  duplicateConfigs?: number;
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
const CORRECTION_RECOVERY_KEY_PREFIX = 'living-memory.correction-recovery.v1';

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

async function getSession(): Promise<SessionResponse> {
  const session = await requestJson<SessionResponse>('/session', { cache: 'no-store' });
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

function correctionRecoveryKey(sourceId: string): string {
  return `${CORRECTION_RECOVERY_KEY_PREFIX}.${encodeURIComponent(sourceId.trim())}`;
}

/** Observe this space only. Browser storage events reach other tabs; the custom
 * event reaches the page that performed the mutation. Neither carries answers. */
export function subscribePendingWrites(sourceId: string, changed: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const key = pendingKey(sourceId);
  if (!key) return () => {};
  const local = (event: Event) => {
    if ((event as CustomEvent<{ sourceId?: string }>).detail?.sourceId === sourceId.trim()) changed();
  };
  const remote = (event: StorageEvent) => {
    if (event.key !== null && event.key !== key) return;
    try { if (event.storageArea && event.storageArea !== window.localStorage) return; } catch { /* Still notify when storage access is denied. */ }
    changed();
  };
  window.addEventListener('lm-pending-changed', local);
  window.addEventListener('storage', remote);
  return () => {
    window.removeEventListener('lm-pending-changed', local);
    window.removeEventListener('storage', remote);
  };
}

function notifyPendingChanged(sourceId: string): void {
  window.dispatchEvent(new CustomEvent('lm-pending-changed', { detail: { sourceId: sourceId.trim() } }));
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

function samePendingRequest(left: PendingWrite, right: PendingWrite): boolean {
  return JSON.stringify([left.method, left.path, left.payload, left.eventId, left.conceptId])
    === JSON.stringify([right.method, right.path, right.payload, right.eventId, right.conceptId]);
}

function samePendingSnapshot(entry: unknown, expected: PendingWrite): entry is PendingWrite {
  return hasPendingId(entry, expected.id) && (entry as PendingWrite).createdAt === expected.createdAt
    && samePendingRequest(entry as PendingWrite, expected);
}

function samePendingError(left: PendingWriteError | undefined, right: PendingWriteError | undefined): boolean {
  if (!left || !right) return left === right;
  return left.code === right.code && left.status === right.status && left.message === right.message
    && left.retryable === right.retryable && left.attemptedAt === right.attemptedAt;
}

function sameCorrectionArchiveSnapshot(entry: unknown, expected: PendingWrite): entry is PendingWrite {
  return samePendingSnapshot(entry, expected)
    && (entry as PendingWrite).label === expected.label
    && samePendingError((entry as PendingWrite).lastError, expected.lastError);
}

/** Only deterministic correction rejections may leave the pending queue. */
export function canArchiveCorrectionWrite(write: PendingWrite): boolean {
  return write.method === 'POST' && write.path === '/corrections'
    && (write.lastError?.code === 'SOURCE_REVISION_MISMATCH' || write.lastError?.code === 'CORRECTION_CONFLICT');
}

function isCorrectionRecoveryEntry(entry: unknown, expected: PendingWrite): boolean {
  if (!entry || typeof entry !== 'object' || !('write' in entry) || !('archivedAt' in entry)) return false;
  const archivedAt = (entry as { archivedAt?: unknown }).archivedAt;
  return typeof archivedAt === 'string' && archivedAt.length > 0
    && sameCorrectionArchiveSnapshot((entry as { write?: unknown }).write, expected);
}

/**
 * Preserve a deterministic correction rejection before removing it from the
 * retry queue. The sync lock is acquired first so an in-flight sender cannot
 * race the storage snapshot; the storage lock then protects the archive and
 * exact queue deletion as one short critical section.
 */
export async function archivePendingCorrection(sourceId: string | null | undefined, expected: PendingWrite): Promise<boolean> {
  const source = sourceId?.trim();
  if (typeof window === 'undefined' || !source || !canArchiveCorrectionWrite(expected)) return false;
  const queueStorageKey = pendingKey(source);
  if (!queueStorageKey) return false;
  const recoveryStorageKey = correctionRecoveryKey(source);
  try {
    return await withPendingSyncLock<boolean>(source,
      () => withPendingStorageLock(source, () => {
        const queue = pendingEntriesForUpdate(queueStorageKey);
        const index = queue.findIndex(entry => sameCorrectionArchiveSnapshot(entry, expected));
        if (index < 0) return false;
        const current = queue[index] as PendingWrite;
        if (!canArchiveCorrectionWrite(current)) return false;

        const backups = pendingEntriesForUpdate(recoveryStorageKey);
        if (!backups.some(entry => isCorrectionRecoveryEntry(entry, current))) {
          backups.push({ write: current, archivedAt: new Date().toISOString() });
          // Do this before touching the pending queue. A failed archive write
          // leaves the original request available for another recovery attempt.
          window.localStorage.setItem(recoveryStorageKey, JSON.stringify(backups));
        }

        const nextQueue = queue.slice();
        nextQueue.splice(index, 1);
        window.localStorage.setItem(queueStorageKey, JSON.stringify(nextQueue));
        notifyPendingChanged(source);
        return true;
      }),
      () => false,
    );
  } catch {
    // Storage reads/writes and unavailable coordination are fail-closed: the
    // request remains in the pending queue until the archive can be verified.
    return false;
  }
}

export async function queuePendingWrite(sourceId: string | null | undefined, write: Omit<PendingWrite, 'id' | 'createdAt'> & { id?: string }): Promise<PendingWrite | null> {
  const pending: PendingWrite = {
    ...write,
    id: write.id ?? (typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `pending-${Date.now()}-${Math.random().toString(16).slice(2)}`),
    createdAt: new Date().toISOString(),
  };
  if (typeof window === 'undefined') return null;
  const key = pendingKey(sourceId);
  if (!key) return null;
  try {
    // Freeze caller-owned content before waiting for another page's short lock.
    const frozen = JSON.parse(JSON.stringify(pending)) as PendingWrite;
    return await withPendingStorageLock(sourceId!, () => {
      const next = pendingEntriesForUpdate(key);
      const previous = next.filter(item => hasPendingId(item, frozen.id));
      if (previous.length) {
        // An ID describes an immutable request. Keep its first timestamp and
        // error metadata, and never replace content underneath an active send.
        return previous.length === 1 && validPendingEntries(previous).length === 1
          && samePendingRequest(previous[0] as PendingWrite, frozen) ? previous[0] as PendingWrite : null;
      }
      next.push(frozen);
      window.localStorage.setItem(key, JSON.stringify(next));
      notifyPendingChanged(sourceId!);
      return frozen;
    });
  } catch {
    return null;
  }
}

export async function removePendingWrite(sourceId: string | null | undefined, id: string, expected?: PendingWrite): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  const key = pendingKey(sourceId);
  if (!key) return false;
  try {
    return await withPendingStorageLock(sourceId!, () => {
      const entries = pendingEntriesForUpdate(key);
      if (expected && entries.some(item => hasPendingId(item, id) && !samePendingSnapshot(item, expected))) return false;
      const next = entries.filter(item => !hasPendingId(item, id));
      window.localStorage.setItem(key, JSON.stringify(next));
      notifyPendingChanged(sourceId!);
      return true;
    });
  } catch {
    // A server acknowledgment is not enough to claim the local queue is clear.
    return false;
  }
}

async function savePendingError(sourceId: string, expected: PendingWrite, error: PendingWriteError): Promise<void> {
  const key = pendingKey(sourceId);
  if (!key || typeof window === 'undefined') return;
  try {
    await withPendingStorageLock(sourceId, () => {
      const entries = pendingEntriesForUpdate(key);
      if (!entries.some(write => samePendingSnapshot(write, expected))) return;
      const next = entries.map(write => samePendingSnapshot(write, expected) ? { ...write, lastError: error } : write);
      window.localStorage.setItem(key, JSON.stringify(next));
      notifyPendingChanged(sourceId);
    });
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

export async function clearPendingWrites(sourceId: string | null | undefined): Promise<void> {
  if (typeof window === 'undefined') return;
  const key = pendingKey(sourceId);
  if (!key) return;
  try {
    await withPendingStorageLock(sourceId!, () => {
      window.localStorage.removeItem(key);
      notifyPendingChanged(sourceId!);
    });
  } catch {
    // no-op
  }
}

async function parseError(response: Response, signal: AbortSignal): Promise<ApiRequestError> {
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
  signal.throwIfAborted();
  if ((code === 'AUTH_REQUIRED' || code === 'SOURCE_MISMATCH') && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('lm-auth-required'));
  }
  return new ApiRequestError(message, {
    code,
    status: response.status,
    retryable: response.status === 408 || response.status === 425 || response.status >= 500,
  });
}

async function requestBody<T>(path: string, init: RequestInit, consume: (response: Response) => Promise<T>, bulk = false): Promise<T> {
  try {
    return await withRequestDeadline(async signal => {
      let response: Response;
      try {
        response = await fetch(`${API_ROOT}${path}`, {
          credentials: 'same-origin',
          ...init,
          signal,
          headers: {
            Accept: 'application/json',
            ...(init.body ? { 'Content-Type': 'application/json' } : {}),
            ...init.headers,
          },
        });
      } catch {
        signal.throwIfAborted();
        throw new ApiRequestError('本地服务暂时不可达，请检查服务是否正在运行。', {
          code: 'NETWORK_OFFLINE', retryable: true,
        });
      }
      signal.throwIfAborted();
      if (!response.ok) throw await parseError(response, signal);
      const result = await consume(response);
      signal.throwIfAborted();
      return result;
    }, { signal: init.signal, ...(bulk ? { timeoutMs: BULK_REQUEST_TIMEOUT_MS } : {}) });
  } catch (error) {
    // Explicit view cancellation remains a cancellation, even if a caller used
    // a custom error as its abort reason.
    if (init.signal?.aborted && error === init.signal.reason) throw error;
    if (error instanceof RequestDeadlineError) {
      const preview = path === '/import/preview' || path === '/identities/preview';
      const writing = !preview && !['GET', 'HEAD'].includes((init.method ?? 'GET').toUpperCase());
      throw new ApiRequestError(writing
        ? '请求等待超时，保存结果尚未确认。请保留原记录，恢复连接后重试。'
        : '请求等待超时，请检查本地服务后重试。', { code: 'REQUEST_TIMEOUT', retryable: true });
    }
    throw error;
  }
}

function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  return requestBody(path, init, async response => response.status === 204 ? undefined as T : await response.json() as T,
    path === '/import/preview' || path === '/import/commit');
}

function requestBlob(path: string, init: RequestInit = {}): Promise<Blob> {
  return requestBody(path, init, response => response.blob(), true);
}

export async function writeJson<T>(path: string, payload: unknown, writeToken: string, sourceId: string): Promise<T> {
  return authenticatedJson<T>(path, {
    method: 'POST',
    body: JSON.stringify(payload),
  }, writeToken, sourceId);
}

export const api = {
  getIdentityStatus: (sourceId: string) => requestJson<IdentityStatus>('/identities', {
    cache: 'no-store', headers: { 'x-lm-source-id': sourceId },
  }),
  previewIdentityLink: (request: IdentityLinkRequest, token: string, sourceId: string) =>
    writeJson<IdentityLinkPreview>('/identities/preview', request, token, sourceId),
  commitIdentityLink: (request: IdentityLinkCommit, token: string, sourceId: string) =>
    writeJson<IdentityLinkReceipt>('/identities/commit', request, token, sourceId),
  previewImport: (payload: ImportPreviewRequest, writeToken: string, sourceId: string) =>
    writeJson<ImportPreview>('/import/preview', payload, writeToken, sourceId),
  commitImport: (payload: ImportCommitRequest, writeToken: string, sourceId: string) =>
    writeJson<ImportReceipt>('/import/commit', payload, writeToken, sourceId),
  getReviewPlan: (sourceId: string, timeZone: string, signal?: AbortSignal) => {
    if (!sourceId.trim()) return Promise.reject(new ApiRequestError('缺少当前知识源。', { code: 'SOURCE_REQUIRED' }));
    return requestJson<ReviewPlanResponse>(`/review-plan?timeZone=${encodeURIComponent(timeZone)}`, {
      cache: 'no-store', headers: { 'x-lm-source-id': sourceId }, signal,
    });
  },
  putReviewPlan: (payload: ReviewPlanUpdate, writeToken: string, sourceId: string, timeZone: string) =>
    authenticatedJson<ReviewPlanResponse>(`/review-plan?timeZone=${encodeURIComponent(timeZone)}`, {
      method: 'PUT', body: JSON.stringify(payload),
    }, writeToken, sourceId),
  getSession,
  getLearningOverview: (sourceId: string, signal?: AbortSignal) => {
    if (!sourceId.trim()) return Promise.reject(new ApiRequestError('缺少当前知识源，请重新连接。', { code: 'SOURCE_REQUIRED' }));
    return requestJson<LearningOverview>('/learning-overview', {
      headers: { 'x-lm-source-id': sourceId }, cache: 'no-store', signal,
    });
  },
  getScenarioPrompts: (sourceId: string, options: { limit?: number; cursor?: string; signal?: AbortSignal } = {}) => {
    if (!sourceId.trim()) return Promise.reject(new ApiRequestError('缺少当前知识源，请重新连接。', { code: 'SOURCE_REQUIRED' }));
    const params = new URLSearchParams({ limit: String(options.limit ?? 20) });
    if (options.cursor) params.set('cursor', options.cursor);
    return requestJson<ScenarioPrompts>(`/scenario-prompts?${params}`, {
      headers: { 'x-lm-source-id': sourceId }, cache: 'no-store', signal: options.signal,
    });
  },
  getPracticeCards: (sourceId: string, signal?: AbortSignal) => {
    if (!sourceId.trim()) return Promise.reject(new ApiRequestError('缺少当前知识空间。', { code: 'SOURCE_REQUIRED' }));
    return requestJson<PracticeCardsResponse>('/practice-cards', {
      headers: { 'x-lm-source-id': sourceId }, cache: 'no-store', signal,
    });
  },
  getPracticeHistory: (cardId: string, sourceId: string, signal?: AbortSignal) => {
    if (!sourceId.trim()) return Promise.reject(new ApiRequestError('缺少当前知识空间。', { code: 'SOURCE_REQUIRED' }));
    return requestJson<PracticeHistoryResponse>(`/practice-cards/${encodeURIComponent(cardId)}/history`, {
      headers: { 'x-lm-source-id': sourceId }, cache: 'no-store', signal,
    });
  },
  postPracticeCard: (payload: PracticeCardRequest, writeToken: string, sourceId: string) =>
    writeJson<WriteReceipt>('/practice-cards', payload, writeToken, sourceId),
  postPracticeAttempt: (payload: PracticeAttemptRequest, writeToken: string, sourceId: string) =>
    writeJson<WriteReceipt>('/practice-attempts', payload, writeToken, sourceId),
  getConceptHistory: (conceptId: string, sourceId: string, options: { limit?: number; cursor?: string; applicationEventId?: string; signal?: AbortSignal } = {}) => {
    if (!sourceId.trim()) return Promise.reject(new ApiRequestError('缺少当前知识源，请重新连接。', { code: 'SOURCE_REQUIRED' }));
    const params = new URLSearchParams({ limit: String(options.limit ?? 20) });
    if (options.cursor) params.set('cursor', options.cursor);
    if (options.applicationEventId) params.set('applicationEventId', options.applicationEventId);
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
  postRetention: (payload: RetentionRequest, writeToken: string, sourceId: string) =>
    writeJson<WriteReceipt>('/retentions', payload, writeToken, sourceId),
  postObservation: (payload: ObservationRequest, writeToken: string, sourceId: string) =>
    writeJson<WriteReceipt>('/observations', payload, writeToken, sourceId),
  postApplication: (payload: ApplicationRecordRequest, writeToken: string, sourceId: string) =>
    writeJson<WriteReceipt>('/applications', payload, writeToken, sourceId),
  postCorrection: (payload: CorrectionRequest, writeToken: string, sourceId: string) =>
    writeJson<WriteReceipt>('/corrections', payload, writeToken, sourceId),
  putConfig: (payload: Pick<ModelConfig, 'halfLifeDays' | 'revision'>, writeToken: string, sourceId: string) =>
    authenticatedJson<ConfigWriteReceipt>('/config', {
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
  sendPending: async (write: PendingWrite, writeToken: string, sourceId: string): Promise<WriteReceipt | ConfigWriteReceipt | Layout> => {
    const result = await authenticatedJson<WriteReceipt | ConfigWriteReceipt | Layout>(write.path, {
      method: write.method,
      body: JSON.stringify(write.payload),
    }, writeToken, sourceId);
    return result;
  },
};

const pendingFlushes = new Map<string, Promise<PendingSyncResult>>();

async function sendPendingBatch(writeToken: string, sourceId: string): Promise<PendingSyncResult> {
  let sent = 0;
  let duplicateConfigs = 0;
  const failures: PendingSyncFailure[] = [];
  const repairs: NonNullable<PendingSyncResult['repairs']> = [];
  let writes: PendingWrite[];
  try {
    writes = await withPendingStorageLock(sourceId, () => validPendingEntries(pendingEntriesForUpdate(pendingKey(sourceId)!)));
  } catch (error) {
    if (error instanceof PendingCoordinationError) throw error;
    throw new ApiRequestError('无法读取浏览器中的待同步记录，原数据未改动。请允许此页面访问本地数据后重试。', {
      code: 'PENDING_STORAGE_UNAVAILABLE', retryable: true,
    });
  }
  for (const write of writes) {
    try {
      const prepared = await withPendingStorageLock(sourceId, () => {
        let entries: unknown[];
        try { entries = pendingEntriesForUpdate(pendingKey(sourceId)!); } catch {
          throw new ApiRequestError('无法重新读取待同步记录，未发送这条请求，请保留页面后重试。', {
            code: 'PENDING_STORAGE_UNAVAILABLE', retryable: true,
          });
        }
        const current = entries.find(item => hasPendingId(item, write.id));
        if (!current) return null;
        if (!samePendingSnapshot(current, write)) throw new ApiRequestError('待同步内容已被另一个页面修改，原请求没有发送。请刷新后核对。', {
          code: 'PENDING_CHANGED', retryable: false,
        });
        return preparePendingLayout(write, sourceId);
      });
      if (!prepared) continue;
      const receipt = await api.sendPending(prepared.write, writeToken, sourceId);
      if (!await removePendingWrite(sourceId, write.id, write)) {
        throw new ApiRequestError('记录已写入服务，但浏览器未能清理待同步标记。请允许此页面保存本地数据后重试。', {
          code: 'PENDING_STORAGE_FAILED', retryable: true,
        });
      }
      sent += 1;
      if (write.path === '/config' && receipt?.status === 'duplicate') duplicateConfigs += 1;
      if (prepared.skippedPositions > 0) repairs.push({ id: write.id, skippedPositions: prepared.skippedPositions });
    } catch (error) {
      const detail: PendingWriteError = {
        code: error instanceof ApiRequestError ? error.code : 'PENDING_SYNC_ERROR',
        status: error instanceof ApiRequestError ? error.status : 0,
        message: error instanceof Error ? error.message : '这条记录同步失败，请稍后重试。',
        retryable: error instanceof ApiRequestError && error.retryable,
        attemptedAt: new Date().toISOString(),
      };
      await savePendingError(sourceId, write, detail);
      const { attemptedAt: _attemptedAt, ...failure } = detail;
      failures.push({ ...failure, id: write.id, label: typeof write.label === 'string' && write.label.trim() ? write.label : '待同步记录' });
      // One stalled connection should not spend another full deadline on every
      // remaining record while holding the cross-tab sender lock.
      if (detail.code === 'REQUEST_TIMEOUT') break;
      // Keep the original id, payload and timestamps, including on non-retryable
      // conflicts. Showing the rejection is safer than silently rewriting history.
    }
  }
  return { sent, failed: failures.length, failures, ...(repairs.length ? { repairs } : {}),
    ...(duplicateConfigs ? { duplicateConfigs } : {}) };
}

export function flushPendingWrites(writeToken: string, sourceId: string | null | undefined): Promise<PendingSyncResult> {
  const source = sourceId?.trim();
  if (!source) return Promise.resolve({ sent: 0, failed: 0, failures: [] });
  const existing = pendingFlushes.get(source);
  if (existing) return existing;
  // Join this page's retries and elect one sender across all updated pages.
  // Read the queue only after acquiring the sync lock, not before waiting.
  const operation = Promise.resolve().then(() => withPendingSyncLock<PendingSyncResult>(source,
    () => sendPendingBatch(writeToken, source),
    () => ({ sent: 0, failed: 0, failures: [], busy: true }),
  )).catch(error => {
    if (error instanceof PendingCoordinationError) throw new ApiRequestError(error.message, { code: error.code });
    throw error;
  }).finally(() => {
    if (pendingFlushes.get(source) === operation) pendingFlushes.delete(source);
  });
  pendingFlushes.set(source, operation);
  return operation;
}
