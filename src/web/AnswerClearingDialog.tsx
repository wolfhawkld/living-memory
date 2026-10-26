import { useEffect, useId, useRef } from 'react';
import type { AnswerClearingOperationState } from './answer-clearing-operation';

export function AnswerClearingDialog({ state, onConfirm, onCheck, onCleanup, onClose }: {
  state: AnswerClearingOperationState; onConfirm(): void; onCheck(): void; onCleanup(): void; onClose(): void;
}) {
  const ref = useRef<HTMLDialogElement>(null), title = useId();
  useEffect(() => {
    const dialog = ref.current!, previous = document.activeElement as HTMLElement | null;
    dialog.showModal();
    return () => { dialog.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  const busy = state.stage === 'working';
  return <dialog ref={ref} className="answer-clearing-dialog" aria-labelledby={title} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <header><h2 id={title}>{state.stage === 'saved' ? '原答已清除' : '清除这条原答'}</h2><button type="button" aria-label="关闭原答清除" disabled={busy} onClick={onClose}>×</button></header>
    <div className="answer-clearing-content">
      <p className="answer-clearing-id">记录 <code>{state.eventId}</code></p>
      <p>清除已保存的回答文字，以及当前浏览器可管理的同一记录待同步副本和复习断点原答。</p>
      <p>最初自评、修订说明、场景与核对补充、独立应用 / 总结、复习完成事实和时间起点继续保留。此操作不新增一次复习。</p>
      <p><strong>原答清除后不可恢复。</strong>旧备份、离线设备及旧版页面不在本次清理范围内；其它当前版本页面将在收到通知或重新打开核对后隐藏原答。</p>
      {busy ? <p role="status">正在核对并处理，请稍候…</p> : null}
      {state.stage === 'unknown' ? <p role="status">清除结果尚待核对。原答暂时隐藏，不会自动重新提交。</p> : null}
      {state.message ? <p role="status">{state.message}</p> : null}
      {state.stage === 'saved' ? <p>服务端清除和浏览器清理分别核对；如仍提示本地未完成，请重试本地清理。</p> : null}
    </div>
    <footer><button type="button" disabled={busy} onClick={onClose}>{state.stage === 'confirm' ? '取消' : '关闭'}</button>
      {state.stage === 'confirm' ? <button type="button" className="answer-clearing-confirm" onClick={onConfirm}>确认永久清除原答</button> : null}
      {state.stage === 'unknown' ? <><button type="button" onClick={onCheck}>核对服务端状态</button>{state.retryAllowed ? <button type="button" onClick={onConfirm}>重试清除同一条原答</button> : null}</> : null}
      {state.stage === 'saved' ? <button type="button" onClick={onCleanup}>重试本地清理</button> : null}
    </footer>
  </dialog>;
}
