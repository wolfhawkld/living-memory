import type {
  Layout,
  ModelConfig,
  ObservationRequest,
  ReviewRequest,
  Snapshot,
  WriteReceipt,
} from '../shared/types';

export interface SessionResponse {
  writeToken: string;
  sourceId?: string;
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

export async function writeJson<T>(path: string, payload: unknown, writeToken: string): Promise<T> {
  return requestJson<T>(path, {
    method: 'POST',
    headers: { 'x-lm-token': writeToken },
    body: JSON.stringify(payload),
  });
}

export const api = {
  getSession: () => requestJson<SessionResponse>('/session'),
  getSnapshot: (asOf?: string, sourceId?: string) => requestJson<Snapshot>(`/snapshot${asOf ? `?asOf=${encodeURIComponent(asOf)}` : ''}`, sourceId ? { headers: { 'x-lm-source-id': sourceId } } : {}),
  postReview: (payload: ReviewRequest, writeToken: string) =>
    writeJson<WriteReceipt>('/reviews', payload, writeToken),
  postObservation: (payload: ObservationRequest, writeToken: string) =>
    writeJson<WriteReceipt>('/observations', payload, writeToken),
  putConfig: (payload: Pick<ModelConfig, 'halfLifeDays' | 'revision'>, writeToken: string) =>
    requestJson<ModelConfig>('/config', {
      method: 'PUT',
      headers: { 'x-lm-token': writeToken },
      body: JSON.stringify(payload),
    }),
  getLayout: (sourceId?: string) => requestJson<Layout>('/layout', sourceId ? { headers: { 'x-lm-source-id': sourceId } } : {}),
  putLayout: (payload: Layout, writeToken: string) =>
    requestJson<Layout>('/layout', {
      method: 'PUT',
      headers: { 'x-lm-token': writeToken },
      body: JSON.stringify(payload),
    }),
  refresh: (writeToken: string) => writeJson<{ status: string }>('/refresh', {}, writeToken),
  exportData: (writeToken: string) => requestBlob('/export', { headers: { 'x-lm-token': writeToken } }),
  sendPending: async (write: PendingWrite, writeToken: string): Promise<void> => {
    const result = await requestJson<WriteReceipt | ModelConfig | Layout>(write.path, {
      method: write.method,
      headers: { 'x-lm-token': writeToken },
      body: JSON.stringify(write.payload),
    });
    if (!result) return;
  },
};

export async function flushPendingWrites(writeToken: string, sourceId: string | null | undefined): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  for (const write of getPendingWrites(sourceId)) {
    try {
      await api.sendPending(write, writeToken);
      removePendingWrite(sourceId, write.id);
      sent += 1;
    } catch {
      failed += 1;
      // Keep the original id and payload. A later retry may be idempotently accepted.
    }
  }
  return { sent, failed };
}
