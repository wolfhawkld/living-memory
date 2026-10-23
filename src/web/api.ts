import { LEARNING_PROTOCOL_HEADER, LEARNING_PROTOCOL_ERROR, LEARNING_PROTOCOL_MESSAGE, supportsLearningProtocol, isLearningProtocolExempt, type LearningProtocolVersion } from '../shared/learning-protocol';
import type { PrivacyObservation } from '../shared/answer-clearing';
import { validateConceptHistoryPrivacy, validateRevisionHistoryPrivacy, validateLearningOverviewPrivacy } from './privacy-response';
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
import { createSessionRecovery, normalizeInstanceId, type LocalSession } from './session-recovery';
import { inspectLayout } from '../shared/layout';
import type { AccountUser } from '../shared/accounts';
import type { FeishuBindingStatus, FeishuBindingIssued } from '../shared/feishu-binding';
import type { LearningOverview } from '../shared/learning-overview';
import type { ScenarioPrompts } from '../shared/scenario-prompts';
import type { PracticeCardRequest, PracticeAttemptRequest, PracticeCardsResponse, PracticeHistoryResponse } from '../shared/practice';
import type { CorrectionRequest } from '../shared/corrections';
import type { ObservationRevisionRequest } from '../shared/observation-revisions';
import type { ObservationRevisionHistory, ObservationRevisionReceipt } from '../shared/observation-revision-history';
import type { RelationReviewRequest, RelationReviewResponse } from '../shared/relation-reviews';
import type { ReviewPlanResponse, ReviewPlanUpdate } from '../shared/review-plan';
import type { IdentityStatus, IdentityLinkRequest, IdentityLinkPreview, IdentityLinkCommit, IdentityLinkReceipt } from '../shared/identity';
import type { ImportPreviewRequest, ImportPreview, ImportCommitRequest, ImportReceipt } from '../shared/import-data';
import type { KnowledgeReferences } from '../shared/knowledge-references';
import type { ActivitySettings, ActivitySettingsUpdate, ActivityAppendRequest, ActivityAppendResult, ActivityListOptions, ActivityExport } from '../shared/activity';
import type { ActivityViewPage } from '../shared/activity-reference-status';
import { PendingCoordinationError, withPendingStorageLock, withPendingSyncLock } from './pending-coordination';
import { BULK_REQUEST_TIMEOUT_MS, RequestDeadlineError, withRequestDeadline } from './request-deadline';

export type SessionResponse = LocalSession & { user?: AccountUser; learningProtocolVersion: LearningProtocolVersion };

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
  | { kind: 'source-mismatch'; sourceId?: string }
  | { kind: 'instance-mismatch'; sourceId?: string; instanceId?: string; expectedInstanceId?: string };
const sessionListeners = new Set<(event: SessionRecoveryEvent) => void>();
const notifySession = (event: SessionRecoveryEvent) => {
  for (const listener of sessionListeners) listener(event);
};

export function subscribeToSessionRecovery(listener: (event: SessionRecoveryEvent) => void): () => void {
  sessionListeners.add(listener);
  return () => { sessionListeners.delete(listener); };
}

/** Token bindings are immutable: a late GET must never upgrade old credentials. */
const tokenInstances = new Map<string, string>();
const tokenProtocols = new Map<string, LearningProtocolVersion>();
let activeScope: { sourceId: string; instanceId: string; learningProtocolVersion?: LearningProtocolVersion } | null = null;
let scopeConfigured = false;
let scopeGeneration = 0;
let protocolConfirmation: { generation: number; session: SessionResponse } | null = null;
interface ProtocolHandshake { generation: number; promise: Promise<SessionResponse> }
let protocolHandshake: ProtocolHandshake | null = null;
function instanceError(): ApiRequestError {
  return new ApiRequestError('知识空间实例已变化，请重新加载页面后确认操作。', { code: 'INSTANCE_MISMATCH', status: 409 });
}
function protocolError(): ApiRequestError {
  return new ApiRequestError(LEARNING_PROTOCOL_MESSAGE, { code: LEARNING_PROTOCOL_ERROR, status: 426 });
}
function bindToken(session: LocalSession): string {
  const instance = normalizeInstanceId(session.instanceId);
  const previous = tokenInstances.get(session.writeToken);
  if (previous !== undefined && previous !== instance) throw instanceError();
  if (session.learningProtocolVersion !== undefined) {
    if (!supportsLearningProtocol(session.learningProtocolVersion)) throw protocolError();
    const protocol = tokenProtocols.get(session.writeToken);
    if (protocol !== undefined && protocol !== session.learningProtocolVersion) throw protocolError();
    tokenProtocols.set(session.writeToken, session.learningProtocolVersion);
  }
  tokenInstances.set(session.writeToken, instance);
  return instance;
}
/** Only the authenticated loader commits an active scope; GET alone never does. */
export function configureSessionScope(session: LocalSession | null): void {
  const next = session ? { sourceId: session.sourceId.trim(), instanceId: bindToken(session),
    learningProtocolVersion: session.learningProtocolVersion ?? tokenProtocols.get(session.writeToken) } : null;
  if (!session || !scopeConfigured || next?.sourceId !== activeScope?.sourceId || next?.instanceId !== activeScope?.instanceId
    || next?.learningProtocolVersion !== activeScope?.learningProtocolVersion) {
    scopeGeneration++; protocolConfirmation = null;
  }
  scopeConfigured = true;
  activeScope = next;
  if (!session) protocolConfirmation = null;
}
interface QueueScope { sourceId: string; instanceId: string; generation: number; lock: string }
function captureScope(sourceId: string): QueueScope {
  const source = sourceId.trim();
  const instanceId = activeScope?.sourceId === source ? activeScope.instanceId : 'legacy';
  return { sourceId: source, instanceId, generation: scopeGeneration,
    lock: instanceId === 'legacy' ? source : `${source}.instance.${encodeURIComponent(instanceId)}` };
}
function scopeCurrent(scope: QueueScope): boolean {
  return scope.generation === scopeGeneration && (!scopeConfigured ||
    (activeScope?.sourceId === scope.sourceId && activeScope.instanceId === scope.instanceId));
}
function assertScope(scope: QueueScope): void { if (!scopeCurrent(scope)) throw instanceError(); }
function scopedKey(prefix: string, source: string, instance: string): string {
  return `${prefix}.${encodeURIComponent(source.trim())}${instance === 'legacy' ? '' : `:instance:${encodeURIComponent(instance)}`}`;
}

async function getSession(): Promise<SessionResponse> {
  const generation = scopeGeneration;
  const session = await requestJson<SessionResponse>('/session', { cache: 'no-store' });
  if (generation !== scopeGeneration) throw instanceError();
  if (!supportsLearningProtocol(session?.learningProtocolVersion)) {
    scopeGeneration++; protocolConfirmation = null;
    throw new ApiRequestError(LEARNING_PROTOCOL_MESSAGE, { code: LEARNING_PROTOCOL_ERROR, status: 426 });
  }
  if (!session || typeof session.writeToken !== 'string' || !session.writeToken.trim()
      || typeof session.sourceId !== 'string' || !session.sourceId.trim()) {
    throw new ApiRequestError('无法取得有效的本地会话，请重新连接。', { code: 'SESSION_INVALID' });
  }
  const previousProtocol = tokenProtocols.get(session.writeToken);
  if (previousProtocol !== undefined && previousProtocol !== session.learningProtocolVersion) {
    scopeGeneration++; protocolConfirmation = null;
    throw protocolError();
  }
  bindToken(session);
  if (activeScope && activeScope.sourceId === session.sourceId.trim()
      && activeScope.instanceId === normalizeInstanceId(session.instanceId)
      && activeScope.learningProtocolVersion !== undefined
      && activeScope.learningProtocolVersion !== session.learningProtocolVersion) {
    // The loader may inspect this new session, but in-flight work from the old
    // protocol must not consume responses or renew credentials into it.
    scopeGeneration++; protocolConfirmation = null;
    return session;
  }
  protocolConfirmation = { generation, session };
  return session;
}

const sessionRecovery = createSessionRecovery({
  getSession,
  isExpired: (error) => error instanceof ApiRequestError && error.status === 401 && error.code === 'TOKEN_REQUIRED',
  onInstanceMismatch: (session, original) => notifySession({ kind: 'instance-mismatch', sourceId: session.sourceId, instanceId: normalizeInstanceId(session.instanceId), expectedInstanceId: normalizeInstanceId(original.instanceId) }),
  instanceMismatchError: instanceError,
  onSourceMismatch: (sourceId) => notifySession({ kind: 'source-mismatch', sourceId }),
  sourceMismatchError: () => new ApiRequestError('知识源已变化，请完成当前输入后重新加载页面。', { code: 'SOURCE_MISMATCH', status: 409 }),
});

async function withSession<T>(writeToken: string, sourceId: string, send: (headers: Record<string, string>) => Promise<T>): Promise<T> {
  if (!sourceId?.trim()) throw new ApiRequestError('缺少当前知识源，未执行写入，请重新连接。', { code: 'SOURCE_REQUIRED' });
  const scope = captureScope(sourceId);
  const instanceId = tokenInstances.get(writeToken) ?? 'legacy';
  try {
    if (scopeConfigured && activeScope && activeScope.sourceId !== sourceId.trim()) {
      throw new ApiRequestError('知识源已变化，请重新加载页面。', { code: 'SOURCE_MISMATCH', status: 409 });
    }
    assertScope(scope);
    if (instanceId !== scope.instanceId) throw instanceError();
    bindToken({ writeToken, sourceId, instanceId });
    let attempts = 0;
    const learningProtocolVersion = tokenProtocols.get(writeToken) ?? activeScope?.learningProtocolVersion;
    return await sessionRecovery.run({ writeToken, sourceId, instanceId, learningProtocolVersion }, (session) => {
      assertScope(scope);
      // The first request may have performed the initial handshake itself.
      // Re-read the original token binding before any recovery attempt.
      const originalProtocol = tokenProtocols.get(writeToken) ?? learningProtocolVersion;
      if (originalProtocol !== undefined && session.learningProtocolVersion !== undefined
        && originalProtocol !== session.learningProtocolVersion) {
        scopeGeneration++; protocolConfirmation = null;
        throw protocolError();
      }
      if (attempts++ > 0) {
        if (scopeConfigured) configureSessionScope(session);
        notifySession({ kind: 'recovered', session });
      }
      return send({
        'x-lm-token': session.writeToken,
        'x-lm-source-id': session.sourceId,
        'x-lm-instance-id': instanceId,
      });
    });
  } catch (error) {
    if (scopeCurrent(scope) && error instanceof ApiRequestError && error.code === 'INSTANCE_MISMATCH') notifySession({ kind: 'instance-mismatch', sourceId, expectedInstanceId: instanceId });
    if (scopeCurrent(scope) && error instanceof ApiRequestError && error.code === 'SOURCE_MISMATCH') notifySession({ kind: 'source-mismatch' });
    throw error;
  }
}

function authenticatedJson<T>(path: string, init: RequestInit, writeToken: string, sourceId: string): Promise<T> {
  return withSession(writeToken, sourceId, (headers) => requestJson<T>(path, { ...init, headers }));
}

function pendingKey(sourceId: string | null | undefined, instanceId = sourceId ? captureScope(sourceId).instanceId : 'legacy'): string | null {
  if (!sourceId?.trim()) return null;
  return scopedKey(PENDING_KEY_PREFIX, sourceId, instanceId);
}

function correctionRecoveryKey(sourceId: string, instanceId: string): string {
  return scopedKey(CORRECTION_RECOVERY_KEY_PREFIX, sourceId, instanceId);
}

/** Observe this space only. Browser storage events reach other tabs; the custom
 * event reaches the page that performed the mutation. Neither carries answers. */
export function subscribePendingWrites(sourceId: string, changed: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const scope = captureScope(sourceId);
  const key = pendingKey(sourceId, scope.instanceId);
  if (!key) return () => {};
  const local = (event: Event) => {
    const detail = (event as CustomEvent<{ sourceId?: string; instanceId?: string }>).detail;
    if (detail?.sourceId === sourceId.trim() && normalizeInstanceId(detail.instanceId) === scope.instanceId) changed();
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
  window.dispatchEvent(new CustomEvent('lm-pending-changed', { detail: { sourceId: sourceId.trim(), instanceId: captureScope(sourceId).instanceId } }));
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
  const scope = sourceId ? captureScope(sourceId) : null;
  if (!scope || !scopeCurrent(scope)) return [];
  const key = pendingKey(sourceId, scope.instanceId);
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
  if (write.method !== 'POST') return false;
  if (write.path === '/corrections') return write.lastError?.code === 'SOURCE_REVISION_MISMATCH' || write.lastError?.code === 'CORRECTION_CONFLICT';
  return write.path === '/relation-reviews'
    && (write.lastError?.code === 'RELATION_REVIEW_SOURCE_CHANGED' || write.lastError?.code === 'RELATION_REVIEW_CONFLICT');
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
  const scope = captureScope(source);
  if (!scopeCurrent(scope)) return false;
  const queueStorageKey = pendingKey(source, scope.instanceId);
  if (!queueStorageKey) return false;
  const recoveryStorageKey = correctionRecoveryKey(source, scope.instanceId);
  try {
    return await withPendingSyncLock<boolean>(scope.lock,
      () => withPendingStorageLock(scope.lock, () => {
        assertScope(scope);
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
  const scope = sourceId ? captureScope(sourceId) : null;
  if (!scope || !scopeCurrent(scope)) return null;
  const key = pendingKey(sourceId, scope.instanceId);
  if (!key) return null;
  try {
    // Freeze caller-owned content before waiting for another page's short lock.
    const frozen = JSON.parse(JSON.stringify(pending)) as PendingWrite;
    return await withPendingStorageLock(scope.lock, () => {
      assertScope(scope);
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

export async function removePendingWrite(sourceId: string | null | undefined, id: string, expected?: PendingWrite, frozenScope?: QueueScope): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  const scope = frozenScope ?? (sourceId ? captureScope(sourceId) : null);
  if (!scope || !scopeCurrent(scope)) return false;
  const key = pendingKey(sourceId, scope.instanceId);
  if (!key) return false;
  try {
    return await withPendingStorageLock(scope.lock, () => {
      assertScope(scope);
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

async function savePendingError(sourceId: string, expected: PendingWrite, error: PendingWriteError, scope: QueueScope): Promise<void> {
  const key = pendingKey(sourceId, scope.instanceId);
  if (!key || typeof window === 'undefined') return;
  try {
    await withPendingStorageLock(scope.lock, () => {
      assertScope(scope);
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

function preparePendingLayout(write: PendingWrite, scope: QueueScope): { write: PendingWrite; skippedPositions: number } {
  if (write.method !== 'PUT' || write.path !== '/layout') return { write, skippedPositions: 0 };
  const inspected = inspectLayout(write.payload);
  // Only a recognizable layout with invalid positions can be repaired. Other
  // validation failures must remain visible, with the original request intact.
  if (!inspected || inspected.invalidIds.length === 0) return { write, skippedPositions: 0 };
  try {
    const key = scopedKey(LAYOUT_RECOVERY_KEY_PREFIX, scope.sourceId, scope.instanceId);
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
  const scope = sourceId ? captureScope(sourceId) : null;
  if (!scope || !scopeCurrent(scope)) return;
  const key = pendingKey(sourceId, scope.instanceId);
  if (!key) return;
  try {
    await withPendingStorageLock(scope.lock, () => {
      assertScope(scope);
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
  return new ApiRequestError(message, {
    code,
    status: response.status,
    retryable: response.status === 408 || response.status === 425 || response.status >= 500,
  });
}

async function requestBody<T>(path: string, init: RequestInit, consume: (response: Response, protocol?: LearningProtocolVersion) => Promise<T>, bulk = false): Promise<T> {
  try {
    init.signal?.throwIfAborted();
    const generation = scopeGeneration;
    let protocol: LearningProtocolVersion | undefined;
    if (!isLearningProtocolExempt(path)) {
      if (protocolConfirmation?.generation !== generation) {
        if (protocolHandshake?.generation !== generation) {
          const entry: ProtocolHandshake = { generation, promise: getSession() };
          protocolHandshake = entry;
          entry.promise = entry.promise.finally(() => { if (protocolHandshake === entry) protocolHandshake = null; });
        }
        const handshake = protocolHandshake!.promise;
        const callerSignal = init.signal;
        if (callerSignal) {
          callerSignal.throwIfAborted();
          // Cancellation releases this caller, not other callers sharing a handshake.
          await new Promise<void>((resolve, reject) => {
            const onAbort = () => { callerSignal.removeEventListener('abort', onAbort); reject(callerSignal.reason); };
            callerSignal.addEventListener('abort', onAbort, { once: true });
            handshake.then(() => { callerSignal.removeEventListener('abort', onAbort); resolve(); }, error => {
              callerSignal.removeEventListener('abort', onAbort); reject(error);
            });
          });
        } else await handshake;
      }
      if (generation !== scopeGeneration) throw instanceError();
      const confirmed = protocolConfirmation?.session;
      if (!confirmed || protocolConfirmation?.generation !== generation) {
        throw new ApiRequestError(LEARNING_PROTOCOL_MESSAGE, { code: LEARNING_PROTOCOL_ERROR, status: 426 });
      }
      if (activeScope && confirmed.sourceId.trim() !== activeScope.sourceId) {
        throw new ApiRequestError('知识源已变化，请重新连接后确认操作。', { code: 'SOURCE_MISMATCH', status: 409 });
      }
      if (activeScope && normalizeInstanceId(confirmed.instanceId) !== activeScope.instanceId) throw instanceError();
      if (activeScope?.learningProtocolVersion !== undefined
        && confirmed.learningProtocolVersion !== activeScope.learningProtocolVersion) throw protocolError();
      protocol = confirmed.learningProtocolVersion;
    }
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/json');
    if (init.body) headers.set('Content-Type', 'application/json');
    if (protocol !== undefined) {
      headers.set(LEARNING_PROTOCOL_HEADER, String(protocol));
      const token = headers.get('x-lm-token');
      if (token) {
        const previous = tokenProtocols.get(token);
        if (previous !== undefined && previous !== protocol) throw protocolError();
        tokenProtocols.set(token, protocol);
      }
    } else headers.delete(LEARNING_PROTOCOL_HEADER);
    return await withRequestDeadline(async signal => {
      let response: Response;
      try {
        response = await fetch(`${API_ROOT}${path}`, {
          credentials: 'same-origin',
          ...init,
          signal,
          headers,
        });
      } catch {
        signal.throwIfAborted();
        throw new ApiRequestError('本地服务暂时不可达，请检查服务是否正在运行。', {
          code: 'NETWORK_OFFLINE', retryable: true,
        });
      }
      signal.throwIfAborted();
      if (generation !== scopeGeneration) throw instanceError();
      if (!response.ok) {
        const error = await parseError(response, signal);
        if (generation !== scopeGeneration) throw instanceError();
        if (error.code === 'INSTANCE_MISMATCH') notifySession({ kind: 'instance-mismatch' });
        if ((error.code === 'AUTH_REQUIRED' || error.code === 'SOURCE_MISMATCH') && typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('lm-auth-required'));
        }
        if (response.status === 426) { scopeGeneration++; protocolConfirmation = null; }
        throw error;
      }
      const result = await consume(response, protocol);
      signal.throwIfAborted();
      if (generation !== scopeGeneration) throw instanceError();
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

function requestJson<T>(path: string, init: RequestInit = {}, decode?: (value: unknown, protocol: LearningProtocolVersion) => T): Promise<T> {
  return requestBody(path, init, async (response, protocol) => {
    const value: unknown = response.status === 204 ? undefined : await response.json();
    if (!decode) return value as T;
    if (protocol === undefined) throw protocolError();
    return decode(value, protocol);
  },
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
  configureSessionScope,
  appendActivity: (payload: ActivityAppendRequest, writeToken: string, sourceId: string) =>
    writeJson<ActivityAppendResult>('/activity', payload, writeToken, sourceId),
  getActivity: (options: ActivityListOptions, sourceId: string, signal?: AbortSignal) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(options)) if (value !== undefined) params.set(key, String(value));
    return requestJson<ActivityViewPage & { sourceId: string }>(`/activity?${params}`, {
      cache: 'no-store', headers: { 'x-lm-source-id': sourceId }, signal,
    });
  },
  exportActivity: (sourceId: string, signal?: AbortSignal) => requestJson<ActivityExport>('/activity/export', {
    cache: 'no-store', headers: { 'x-lm-source-id': sourceId }, signal,
  }),
  getActivitySettings: (sourceId: string, signal?: AbortSignal) => {
    if (!sourceId.trim()) return Promise.reject(new ApiRequestError('缺少当前知识空间。', { code: 'SOURCE_REQUIRED' }));
    return requestJson<{ sourceId: string; settings: ActivitySettings }>('/activity/settings', {
      cache: 'no-store', headers: { 'x-lm-source-id': sourceId }, signal,
    });
  },
  updateActivitySettings: (payload: ActivitySettingsUpdate, writeToken: string, sourceId: string) =>
    writeJson<{ sourceId: string; settings: ActivitySettings }>('/activity/settings', payload, writeToken, sourceId),
  clearActivity: (payload: { scope: 'all'; expectedEpoch: number } | { scope: 'operation'; expectedEpoch: number; operationId: string }, writeToken: string, sourceId: string) =>
    writeJson<{ sourceId: string; settings: ActivitySettings; deletedEvents: number; deletedDeliveries: number }>('/activity/clear', payload, writeToken, sourceId),
  getKnowledgeReferences: (conceptId: string, sourceRevision: string, sourceId: string, signal?: AbortSignal) => {
    if (!sourceId.trim()) return Promise.reject(new ApiRequestError('缺少当前知识空间。', { code: 'SOURCE_REQUIRED' }));
    const params = new URLSearchParams({ conceptId, sourceRevision });
    return requestJson<KnowledgeReferences>(`/knowledge/references?${params}`, {
      cache: 'no-store', headers: { 'x-lm-source-id': sourceId }, signal,
    });
  },
  getFeishuBindingStatus: (sourceId: string, signal?: AbortSignal) => requestJson<FeishuBindingStatus>('/feishu/binding', {
    cache: 'no-store', headers: { 'x-lm-source-id': sourceId }, signal,
  }),
  issueFeishuBindingRequest: (writeToken: string, sourceId: string) =>
    writeJson<FeishuBindingIssued>('/feishu/binding/request', {}, writeToken, sourceId),
  cancelFeishuBindingRequest: (requestId: string, writeToken: string, sourceId: string) =>
    writeJson<FeishuBindingStatus>('/feishu/binding/cancel', { requestId }, writeToken, sourceId),
  revokeFeishuBinding: (bindingId: string, writeToken: string, sourceId: string) =>
    writeJson<FeishuBindingStatus>('/feishu/binding/revoke', { bindingId }, writeToken, sourceId),
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
  adminRequest: <T>(path: string, init: RequestInit, writeToken: string, sourceId: string): Promise<T> => {
    if (!/^\/admin\/users(?:\/[A-Za-z0-9%._~-]+)?$/.test(path)) {
      return Promise.reject(new ApiRequestError('账号管理请求路径无效。', { code: 'INVALID_REQUEST' }));
    }
    return authenticatedJson<T>(path, { ...init, cache: 'no-store' }, writeToken, sourceId);
  },
  getLearningOverview: (sourceId: string, signal?: AbortSignal) => {
    if (!sourceId.trim()) return Promise.reject(new ApiRequestError('缺少当前知识源，请重新连接。', { code: 'SOURCE_REQUIRED' }));
    return requestJson<LearningOverview>('/learning-overview', {
      headers: { 'x-lm-source-id': sourceId }, cache: 'no-store', signal,
    }, validateLearningOverviewPrivacy);
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
    return requestJson<ConceptHistory<PrivacyObservation>>(`/concepts/${encodeURIComponent(conceptId)}/history?${params}`, {
      headers: { 'x-lm-source-id': sourceId }, cache: 'no-store', signal: options.signal,
    }, validateConceptHistoryPrivacy);
  },
  getObservationRevisions: (observationEventId: string, sourceId: string, options: { limit?: number; cursor?: string; signal?: AbortSignal } = {}) => {
    if (!sourceId.trim()) return Promise.reject(new ApiRequestError('缺少当前知识空间，请重新连接。', { code: 'SOURCE_REQUIRED' }));
    const params = new URLSearchParams({ limit: String(options.limit ?? 20) });
    if (options.cursor) params.set('cursor', options.cursor);
    return requestJson<ObservationRevisionHistory<PrivacyObservation>>(`/observations/${encodeURIComponent(observationEventId)}/revisions?${params}`, {
      headers: { 'x-lm-source-id': sourceId }, cache: 'no-store', signal: options.signal,
    }, validateRevisionHistoryPrivacy);
  },
  postObservationRevision: (payload: ObservationRevisionRequest, writeToken: string, sourceId: string) =>
    writeJson<ObservationRevisionReceipt>(`/observations/${encodeURIComponent(payload.observationEventId)}/revisions`, payload, writeToken, sourceId),
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
  getRelationReview: (applicationEventId: string, sourceId: string, signal: AbortSignal) =>
    requestJson<RelationReviewResponse>(`/applications/${encodeURIComponent(applicationEventId)}/relation-review`, {
      headers: { 'x-lm-source-id': sourceId }, cache: 'no-store', signal,
    }),
  postRelationReview: (payload: RelationReviewRequest, writeToken: string, sourceId: string) =>
    writeJson<WriteReceipt>('/relation-reviews', payload, writeToken, sourceId),
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

async function sendPendingBatch(writeToken: string, sourceId: string, scope: QueueScope): Promise<PendingSyncResult> {
  let sent = 0;
  let duplicateConfigs = 0;
  const failures: PendingSyncFailure[] = [];
  const repairs: NonNullable<PendingSyncResult['repairs']> = [];
  let writes: PendingWrite[];
  try {
    writes = await withPendingStorageLock(scope.lock, () => { assertScope(scope); return validPendingEntries(pendingEntriesForUpdate(pendingKey(sourceId, scope.instanceId)!)); });
  } catch (error) {
    if (error instanceof PendingCoordinationError || (error instanceof ApiRequestError && error.code === 'INSTANCE_MISMATCH')) throw error;
    throw new ApiRequestError('无法读取浏览器中的待同步记录，原数据未改动。请允许此页面访问本地数据后重试。', {
      code: 'PENDING_STORAGE_UNAVAILABLE', retryable: true,
    });
  }
  assertScope(scope);
  for (const write of writes) {
    if (!scopeCurrent(scope)) break;
    try {
      const prepared = await withPendingStorageLock(scope.lock, () => {
        assertScope(scope);
        let entries: unknown[];
        try { entries = pendingEntriesForUpdate(pendingKey(sourceId, scope.instanceId)!); } catch {
          throw new ApiRequestError('无法重新读取待同步记录，未发送这条请求，请保留页面后重试。', {
            code: 'PENDING_STORAGE_UNAVAILABLE', retryable: true,
          });
        }
        const current = entries.find(item => hasPendingId(item, write.id));
        if (!current) return null;
        if (!samePendingSnapshot(current, write)) throw new ApiRequestError('待同步内容已被另一个页面修改，原请求没有发送。请刷新后核对。', {
          code: 'PENDING_CHANGED', retryable: false,
        });
        return preparePendingLayout(write, scope);
      });
      assertScope(scope);
      if (!prepared) continue;
      const receipt = await api.sendPending(prepared.write, writeToken, sourceId);
      if (!scopeCurrent(scope)) break;
      const removed = await removePendingWrite(sourceId, write.id, write, scope);
      if (!scopeCurrent(scope)) break;
      if (!removed) {
        throw new ApiRequestError('记录已写入服务，但浏览器未能清理待同步标记。请允许此页面保存本地数据后重试。', {
          code: 'PENDING_STORAGE_FAILED', retryable: true,
        });
      }
      sent += 1;
      if (write.path === '/config' && receipt?.status === 'duplicate') duplicateConfigs += 1;
      if (prepared.skippedPositions > 0) repairs.push({ id: write.id, skippedPositions: prepared.skippedPositions });
    } catch (error) {
      if (!scopeCurrent(scope)) break;
      const detail: PendingWriteError = {
        code: error instanceof ApiRequestError ? error.code : 'PENDING_SYNC_ERROR',
        status: error instanceof ApiRequestError ? error.status : 0,
        message: error instanceof Error ? error.message : '这条记录同步失败，请稍后重试。',
        retryable: error instanceof ApiRequestError && error.retryable,
        attemptedAt: new Date().toISOString(),
      };
      await savePendingError(sourceId, write, detail, scope);
      if (!scopeCurrent(scope)) break;
      const { attemptedAt: _attemptedAt, ...failure } = detail;
      failures.push({ ...failure, id: write.id, label: typeof write.label === 'string' && write.label.trim() ? write.label : '待同步记录' });
      // One stalled connection should not spend another full deadline on every
      // remaining record while holding the cross-tab sender lock.
      if (detail.code === 'REQUEST_TIMEOUT' || detail.code === 'INSTANCE_MISMATCH' || detail.code === 'SOURCE_MISMATCH') break;
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
  const scope = captureScope(source);
  if (!scopeCurrent(scope)) return Promise.reject(instanceError());
  const key = `${scope.lock}:${scope.generation}`;
  const existing = pendingFlushes.get(key);
  if (existing) return existing;
  // Join this page's retries and elect one sender across all updated pages.
  // Read the queue only after acquiring the sync lock, not before waiting.
  const operation = Promise.resolve().then(() => withPendingSyncLock<PendingSyncResult>(scope.lock,
    () => { assertScope(scope); return sendPendingBatch(writeToken, source, scope); },
    () => ({ sent: 0, failed: 0, failures: [], busy: true }),
  )).catch(error => {
    if (error instanceof PendingCoordinationError) throw new ApiRequestError(error.message, { code: error.code });
    throw error;
  }).finally(() => {
    if (pendingFlushes.get(key) === operation) pendingFlushes.delete(key);
  });
  pendingFlushes.set(key, operation);
  return operation;
}
