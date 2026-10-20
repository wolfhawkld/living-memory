import { useState } from 'react';
import type { ObservationRevisionChannelState } from './observation-revision-channel';
import type { ObservationRevisionPendingRow } from './observation-revision-pending';

export function ObservationRevisionPendingPanel({ state, disabled, onRetry, onOpen, onRefresh, onClearArchived }: {
  state: ObservationRevisionChannelState; disabled: boolean;
  onRetry(): Promise<void>; onOpen(row: ObservationRevisionPendingRow): void;
  onRefresh(): Promise<void>; onClearArchived(): Promise<boolean>;
}) {
  const [message, setMessage] = useState<string | null>(null);
  if (state.status === 'inactive') return null;
  const pending = state.rows.filter(row => row.state === 'pending'), rejected = state.rows.filter(row => row.state === 'rejected');
  const archived = state.rows.filter(row => row.state === 'archived');
  if (state.status === 'available' && !state.rows.length) return null;
  return <section className="observation-revision-pending" aria-label="自评修订待同步">
    <strong>自评修订待同步</strong>
    {state.status === 'unavailable' ? <p role="status">无法安全读取本机修订队列（{state.reason}）。原副本保持不变，请先恢复存储与协调能力。</p>
      : state.status === 'loading' ? <p role="status">正在核对本机修订…</p>
        : <p>{pending.length} 项结果待确认 · {rejected.length} 项需重新核对 · {archived.length} 项本机归档</p>}
    <ul>{state.rows.filter(row => row.state !== 'archived').map(row => <li key={row.request.eventId}>
      <span>{row.request.action === 'revise' ? '更正自评' : row.request.action === 'withdraw' ? '暂不计入' : '恢复采用'} · {row.state === 'rejected' ? '已被拒绝' : '结果待确认'}</span>
      <small>原观察 {row.request.observationEventId}</small>
      {row.lastError ? <small>{row.lastError}</small> : null}
      <button type="button" disabled={disabled || state.busy} onClick={() => onOpen(row)}>查看并处理</button>
    </li>)}</ul>
    <div className="observation-revision-pending-actions">
      <button type="button" disabled={state.busy} onClick={() => void onRefresh()}>重读本机队列</button>
      {pending.length ? <button type="button" disabled={disabled || state.busy || state.status !== 'available'} onClick={() => void onRetry()}>{state.busy ? '正在同步…' : '原样重试待确认项'}</button> : null}
      {archived.length ? <button type="button" disabled={disabled || state.busy} onClick={() => {
        if (!window.confirm('只清除本机已归档的拒绝请求副本，服务端审计不会删除。确定清除吗？')) return;
        void onClearArchived().then(ok => setMessage(ok ? '本机归档副本已清除。' : '未能清除，本机副本保持不变。'));
      }}>清除本机归档副本</button> : null}
    </div>
    {message ? <p role="status">{message}</p> : null}
  </section>;
}
