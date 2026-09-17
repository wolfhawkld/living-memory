import type {
  Layout,
  ModelConfig,
  ObservationRequest,
  ReviewRequest,
  Snapshot,
  WriteReceipt,
} from '../shared/types';
import { createSessionRecovery, type LocalSession } from './session-recovery';

export type SessionResponse = LocalSession;

export interface PendingWrite {
  id: string;
  method: 'POST' | 'PUT';
  path: string;
  payload: unknown;
  eventId: string | null;
  conceptId: string | null;
  label: string;
  createdAt: string;
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

function parsePending(value: string | null): PendingWrite[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is PendingWrite => {
      if (!item || typeof item !== 'object') return false;
      const candidate = item as Record<string, unknown>;
      return (
        typeof candidate.id === 'string' &&
        (candidate.method === 'POST' || candidate.method === 'PUT') &&
        typeof candidate.path === 'string' &&
        typeof candidate.createdAt === 'string'
      );
    });
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
    const next = getPendingWrites(sourceId).filter((item) => item.id !== pending.id);
    next.push(pending);
    window.localStorage.setItem(key, JSON.stringify(next));
    window.dispatchEvent(new CustomEvent('lm-pending-changed'));
    return pending;
  } catch {
    return null;
  }
}

export function removePendingWrite(sourceId: string | null | undefined, id: string): void {
  if (typeof window === 'undefined') return;
  const key = pendingKey(sourceId);
  if (!key) return;
  try {
    const next = getPendingWrites(sourceId).filter((item) => item.id !== id);
    window.localStorage.setItem(key, JSON.stringify(next));
    window.dispatchEvent(new CustomEvent('lm-pending-changed'));
  } catch {
    // If storage has become unavailable, keep the current form open for a manual retry.
  }
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
  putLayout: (payload: Layout, writeToken: string, sourceId: string) =>
    authenticatedJson<Layout>('/layout', {
      method: 'PUT',
      body: JSON.stringify(payload),
    }, writeToken, sourceId),
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

export async function flushPendingWrites(writeToken: string, sourceId: string | null | undefined): Promise<{ sent: number; failed: number }> {
  if (!sourceId) return { sent: 0, failed: 0 };
  let sent = 0;
  let failed = 0;
  for (const write of getPendingWrites(sourceId)) {
    try {
      await api.sendPending(write, writeToken, sourceId);
      removePendingWrite(sourceId, write.id);
      sent += 1;
    } catch {
      failed += 1;
      // Keep the original id and payload. A later retry may be idempotently accepted.
    }
  }
  return { sent, failed };
}
