import type { AnswerClearingReceipt, AnswerClearingState } from '../shared/answer-clearing';
import type { getAnswerPrivacyChannel } from './answer-clearing-privacy';

type Channel = ReturnType<typeof getAnswerPrivacyChannel>;
export interface AnswerClearingOperationState {
  eventId: string;
  stage: 'confirm' | 'working' | 'unknown' | 'saved';
  message: string | null;
  retryAllowed: boolean;
}
export interface AnswerClearingOperationDependencies {
  channel: Channel;
  clear(id: string): Promise<AnswerClearingReceipt>;
  read(id: string): Promise<AnswerClearingState>;
  timeoutMs?: number;
}

/** Only the explicit confirm/retry method can issue POST. Recovery is read-only. */
export function createAnswerClearingOperation(deps: AnswerClearingOperationDependencies) {
  let state: AnswerClearingOperationState | null = null;
  let disposed = false, ticket = 0;
  const listeners = new Set<() => void>();
  const publish = (next: typeof state) => { if (!disposed) { state = next; listeners.forEach(fn => fn()); } };
  const current = (id: string, key: number) => !disposed && ticket === key && state?.eventId === id;
  async function bounded<T>(request: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([request, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), deps.timeoutMs ?? 15_000); })]); }
    finally { if (timer) clearTimeout(timer); }
  }
  async function accept(id: string, marker: { observationEventId: string; clearedAt: string }, key: number) {
    if (!current(id, key)) return;
    if (marker.observationEventId !== id) throw new Error('identity');
    const result = await deps.channel.confirm({ observationEventId: marker.observationEventId, clearedAt: marker.clearedAt });
    if (current(id, key)) publish({ eventId: id, stage: 'saved', retryAllowed: false,
      message: result.complete ? '服务端原答已清除；当前浏览器可管理的副本已清理。' : '服务端原答已清除；当前浏览器还有副本未完成清理，请重试本地清理。' });
  }
  async function submit() {
    if (!state || state.stage === 'working' || state.stage === 'saved' || (state.stage === 'unknown' && !state.retryAllowed)) return;
    const id = state.eventId, key = ++ticket;
    publish({ eventId: id, stage: 'working', message: null, retryAllowed: false });
    let sent = false;
    try {
      await deps.channel.begin(id);
      if (!current(id, key)) return;
      sent = true;
      const receipt = await bounded(deps.clear(id));
      await accept(id, receipt, key);
    } catch {
      if (!current(id, key)) return;
      const marker = deps.channel.getMarker(id);
      publish({ eventId: id, stage: marker ? 'saved' : sent ? 'unknown' : 'confirm', retryAllowed: false,
        message: marker ? '服务端原答已确认清除，本地清理尚未完成。' : sent
          ? '提交结果未知，原答已暂时隐藏。请核对服务端状态；不会自动重发清除请求。'
          : '无法保存本次操作的恢复信息，尚未发送清除请求。请恢复浏览器存储后重试。' });
    }
  }
  async function check() {
    if (!state || state.stage === 'working') return;
    const id = state.eventId, key = ++ticket;
    publish({ ...state, stage: 'working', retryAllowed: false, message: null });
    try {
      const result = await bounded(deps.read(id));
      if (!current(id, key)) return;
      if (result.observationEventId !== id) throw new Error('identity');
      if (result.status === 'cleared') await accept(id, result, key);
      else if (deps.channel.getMarker(id)) throw new Error('privacy rollback');
      else publish({ eventId: id, stage: 'unknown', retryAllowed: result.status === 'saved', message: result.status === 'saved'
        ? '刚才核对时原答仍在。此前请求可能仍在途中；可明确重试，同一条记录只保留首次清除时间。'
        : '当前记录未保存原答，无法确认此前清除的结果。请保留这条待核对提示。' });
    } catch {
      if (current(id, key)) publish({ eventId: id, stage: deps.channel.getMarker(id) ? 'saved' : 'unknown', retryAllowed: false,
        message: '暂时无法核对同一实例的状态，请恢复连接后重试。已知清除状态不会回退。' });
    }
  }
  return {
    getSnapshot: () => state,
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    open(eventId: string) {
      if (state?.stage === 'working') return;
      ++ticket;
      const marker = deps.channel.getMarker(eventId);
      publish({ eventId, stage: marker ? 'saved' : deps.channel.isBlocked(eventId) ? 'unknown' : 'confirm', retryAllowed: false, message: null });
    },
    close() { if (state?.stage !== 'working') { ++ticket; publish(null); } },
    submit, check,
    async retryCleanup() {
      if (!state || state.stage === 'working') return;
      if (!deps.channel.getMarker(state.eventId)) { publish({ ...state, stage: 'unknown', retryAllowed: false, message: '请先核对服务端清除状态。' }); return; }
      const id = state.eventId, key = ++ticket;
      try {
        const result = await deps.channel.retryCleanup(id);
        if (current(id, key)) publish({ eventId: id, stage: 'saved', retryAllowed: false, message: result.complete
          ? '当前浏览器可管理的副本已清理。' : '本地清理尚未全部完成。请恢复浏览器存储与标签页协调能力后重试。' });
      } catch { if (current(id, key)) publish({ ...state!, message: '本地清理仍未完成，已确认的服务端清除状态保持不变。' }); }
    },
    activate() { disposed = false; },
    dispose() { disposed = true; ++ticket; state = null; listeners.clear(); },
  };
}
