import { observationRevisionRequestEqual, type ObservationRevisionRequest } from '../shared/observation-revisions';
import type { ObservationRevisionHistory, ObservationRevisionReceipt } from '../shared/observation-revision-history';
import { createObservationRevisionPending, type ObservationRevisionPendingOptions, type ObservationRevisionPendingRow,
  type ObservationRevisionPendingSnapshot, type ObservationRevisionPendingFlushResult } from './observation-revision-pending';

export interface ObservationRevisionChannelContext {
  accountId: string; sourceId: string; instanceId: string; writeToken: string;
  mode: 'real' | 'example' | 'forecast'; locked: boolean;
}
export type RevisionChannelResult =
  | { status: 'confirmed'; receipt: ObservationRevisionReceipt; cleanupPending: boolean }
  | { status: 'queued' | 'rejected' | 'blocked'; persisted: true; message: string }
  | { status: 'not-saved'; persisted: false; message: string; outcomeUnknown?: true }
  | { status: 'context-changed' };
export interface ObservationRevisionChannelState {
  scopeKey: string; contextKey: string;
  status: 'inactive' | 'loading' | 'available' | 'unavailable';
  rows: readonly ObservationRevisionPendingRow[]; reason?: string;
  busy: boolean; confirmedVersion: number;
}
interface Options extends Omit<ObservationRevisionPendingOptions, 'transport'> {
  append(request: ObservationRevisionRequest, token: string, sourceId: string): Promise<ObservationRevisionReceipt>;
  readHistory(id: string, sourceId: string, options: { limit?: number; cursor?: string; signal?: AbortSignal }): Promise<ObservationRevisionHistory>;
}
const scopeOf = (c: ObservationRevisionChannelContext) => JSON.stringify([c.accountId, c.sourceId, c.instanceId]);
const securityOf = (c: ObservationRevisionChannelContext) => JSON.stringify([c.accountId, c.sourceId, c.instanceId, c.writeToken]);

/** Manual commands only. The durable queue, rather than component state, owns retries. */
export function createObservationRevisionChannel(options: Options) {
  let context: ObservationRevisionChannelContext | null = null, generation = 0, authRevision = 0, reads = 0;
  let state: ObservationRevisionChannelState = { scopeKey: '', contextKey: '', status: 'inactive', rows: [], busy: false, confirmedVersion: 0 };
  const listeners = new Set<() => void>(), confirmed = new Set<string>();
  function publish(patch: Partial<ObservationRevisionChannelState>) { state = { ...state, ...patch }; listeners.forEach(fn => fn()); }
  function capture() { const c = context && { ...context }, gen = generation; return { c, current: () => gen === generation }; }
  const queue = createObservationRevisionPending({ ...options, transport: { append: (request, scope) => {
    const c = context;
    if (!c?.writeToken || c.mode !== 'real' || c.locked || c.accountId !== scope.accountId || c.sourceId !== scope.sourceId || c.instanceId !== scope.instanceId) {
      return Promise.reject(Object.assign(new Error('当前空间不可写。'), { code: 'SOURCE_MISMATCH', status: 409 }));
    }
    return options.append(request, c.writeToken, c.sourceId);
  } } });
  async function refresh() {
    const captured = capture(), ticket = ++reads;
    if (!captured.c?.writeToken) return;
    const result: ObservationRevisionPendingSnapshot = await queue.snapshot();
    if (!captured.current() || ticket !== reads) return;
    publish(result.status === 'available' ? { status: 'available', rows: result.rows, reason: undefined }
      : { status: 'unavailable', rows: [], reason: result.reason });
  }
  function recordConfirmations(result: ObservationRevisionPendingFlushResult) {
    let count = 0;
    for (const item of result.items) if (item.status === 'confirmed') {
      const key = JSON.stringify([state.scopeKey, item.eventId]);
      if (!confirmed.has(key)) { confirmed.add(key); count++; }
    }
    if (count) publish({ confirmedVersion: state.confirmedVersion + count });
  }
  function resultFor(result: ObservationRevisionPendingFlushResult, eventId: string): RevisionChannelResult {
    const item = result.items.find(item => item.eventId === eventId);
    if (item?.status === 'confirmed') return { status: 'confirmed', receipt: item.receipt, cleanupPending: item.cleanup === 'retained' };
    const row = state.status === 'available' ? state.rows.find(row => row.request.eventId === eventId && row.state !== 'archived') : undefined;
    if (!row) return { status: 'not-saved', persisted: false, outcomeUnknown: true, message: '本机副本未能核实，服务结果未确认。请保留当前固定请求，勿另建决定。' };
    if (item?.status === 'rejected' || row.state === 'rejected') return { status: 'rejected', persisted: true, message: `服务未接受这份决定（${row.lastError ?? (item?.status === 'rejected' ? item.code : 'OBSERVATION_REVISION_INVALID_REQUEST')}）。请重新核对后再确认新的决定。` };
    if (item?.status === 'paused' || result.status === 'inactive') return { status: 'blocked', persisted: true, message: '当前会话或知识空间不可写；原请求已保留，请回到原空间后手动重试。' };
    return { status: 'queued', persisted: true, message: '保存结果尚未确认，固定请求已保存在本机。请原样重试，不要另建决定。' };
  }
  async function send(eventId?: string) {
    const captured = capture();
    const result = await queue.flush(eventId ? { eventId } : {});
    if (!captured.current()) return { result, current: false };
    recordConfirmations(result); await refresh();
    return { result, current: captured.current() };
  }
  return {
    getSnapshot: () => state,
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    setContext(next: ObservationRevisionChannelContext | null) {
      const previous = context;
      if (JSON.stringify(previous) === JSON.stringify(next)) return;
      if (!previous || !next || securityOf(previous) !== securityOf(next)) authRevision++;
      generation++; reads++; context = next ? { ...next } : null;
      queue.setContext(next ? { accountId: next.accountId, sourceId: next.sourceId, instanceId: next.instanceId,
        authRevision, authenticated: Boolean(next.writeToken), mode: next.mode, locked: next.locked } : null);
      const scopeKey = next ? scopeOf(next) : '';
      const changedIdentity = !previous || !next || securityOf(previous) !== securityOf(next);
      publish({ scopeKey, contextKey: JSON.stringify([scopeKey, authRevision, next?.mode]), busy: false,
        ...(changedIdentity ? { rows: [], status: next?.writeToken ? 'loading' as const : 'inactive' as const, reason: undefined } : {}) });
    },
    refresh,
    async assertMaintenanceReady() {
      const captured = capture(); const result = await queue.snapshot();
      if (!captured.current() || result.status !== 'available' || result.rows.some(row => row.state !== 'archived')) {
        throw new Error('请先处理自评修订待同步项，并确认本机队列可读取。');
      }
    },
    async submit(request: ObservationRevisionRequest, expectedContextKey = state.contextKey): Promise<RevisionChannelResult> {
      if (expectedContextKey !== state.contextKey) return { status: 'context-changed' };
      const captured = capture();
      if (state.busy) return { status: 'not-saved', persisted: false, outcomeUnknown: true, message: '另一项同步正在进行，请保留当前固定请求并重读状态。' };
      publish({ busy: true });
      try {
        const saved = await queue.enqueue(request);
        if (!captured.current()) return { status: 'context-changed' };
        if (saved.status === 'not-saved') {
          await refresh();
          return captured.current() ? { status: 'not-saved', persisted: false, message: `请求尚未保存（${saved.reason}），请保留当前窗口和草稿。` } : { status: 'context-changed' };
        }
        const sent = await send(saved.eventId);
        return sent.current ? resultFor(sent.result, saved.eventId) : { status: 'context-changed' };
      } finally { if (captured.current()) publish({ busy: false }); }
    },
    async retry(eventId: string, expectedRequest?: ObservationRevisionRequest, expectedContextKey = state.contextKey): Promise<RevisionChannelResult> {
      if (expectedContextKey !== state.contextKey) return { status: 'context-changed' };
      const captured = capture();
      if (state.busy) return { status: 'not-saved', persisted: false, outcomeUnknown: true, message: '同步正在进行，本机副本尚未核实，请保留当前固定请求。' };
      publish({ busy: true });
      try {
        await refresh(); if (!captured.current()) return { status: 'context-changed' };
        const row = state.rows.find(row => row.request.eventId === eventId && row.state !== 'archived');
        if (state.status !== 'available' || !row || (expectedRequest && !observationRevisionRequestEqual(row.request, expectedRequest))) return { status: 'not-saved', persisted: false, outcomeUnknown: true,
          message: '本机副本未能核实，服务结果未确认。请保留当前固定请求，勿另建决定。' };
        if (row?.state === 'rejected') return { status: 'rejected', persisted: true, message: '此请求已被拒绝。请先重新核对当前链，不会自动改前驱重发。' };
        const sent = await send(eventId);
        return sent.current ? resultFor(sent.result, eventId) : { status: 'context-changed' };
      } finally { if (captured.current()) publish({ busy: false }); }
    },
    async retryAll() {
      const captured = capture(); if (state.busy) return;
      publish({ busy: true });
      try { await send(); } finally { if (captured.current()) publish({ busy: false }); }
    },
    async readHistory(id: string, readOptions: { limit?: number; cursor?: string; signal?: AbortSignal } = {}, expectedContextKey = state.contextKey) {
      if (expectedContextKey !== state.contextKey) throw new Error('账号、知识源或实例已变化。');
      const captured = capture(); if (!captured.c?.writeToken) throw new Error('会话尚未就绪。');
      const result = await options.readHistory(id, captured.c.sourceId, readOptions);
      if (!captured.current()) throw new Error('账号、知识源或实例已变化。');
      return result;
    },
    async archiveRejected(row: ObservationRevisionPendingRow, expectedContextKey = state.contextKey) {
      if (expectedContextKey !== state.contextKey) return false;
      const captured = capture(); const result = await queue.archiveRejected(row);
      if (!captured.current()) return false;
      await refresh(); return captured.current() && result.archived;
    },
    async clearArchived() {
      const captured = capture(); const result = await queue.clearArchived();
      if (!captured.current()) return false;
      await refresh(); return captured.current() && result.cleared >= 0 && !result.reason;
    },
  };
}
