import { useEffect, useId, useRef, useState, type ReactElement } from 'react';
import type { FeishuBindingStatus } from '../shared/feishu-binding.js';
import { api } from './api.js';

export interface FeishuBindingDialogProps {
  accountLabel: string;
  sourceId: string;
  writeToken: string;
  onClose: () => void;
}

/** Invalidates both fetches and late mutation responses when an operation or identity changes. */
export function createFeishuBindingGate() {
  let generation = 0;
  let controller: AbortController | null = null;
  return {
    begin() {
      controller?.abort();
      controller = new AbortController();
      const version = ++generation;
      return { signal: controller.signal, current: () => version === generation };
    },
    invalidate() { generation += 1; controller?.abort(); },
    checkpoint() { const version = generation; return () => generation === version; },
  };
}

export function feishuBindingPending(status: FeishuBindingStatus | null, now: number): boolean {
  return Boolean(!status?.binding && status?.request?.status === 'pending'
    && Number.isFinite(Date.parse(status.request.expiresAt)) && Date.parse(status.request.expiresAt) > now);
}

export function feishuBindingCanIssue(status: FeishuBindingStatus | null): boolean {
  return Boolean(status?.channelState === 'connected' && status.scope && !status.binding);
}

export function feishuBindingShouldPoll(status: FeishuBindingStatus | null, now: number, visible: boolean, mutating: boolean): boolean {
  return visible && !mutating && feishuBindingPending(status, now);
}

export function FeishuBindingDialog(props: FeishuBindingDialogProps): ReactElement {
  // A changed account/session gets a fresh component: no previous command can flash in the next account.
  return <BindingDialogSession key={`${props.accountLabel}:${props.sourceId}:${props.writeToken}`} {...props} />;
}

function BindingDialogSession({ accountLabel, sourceId, writeToken, onClose }: FeishuBindingDialogProps): ReactElement {
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const gate = useRef(createFeishuBindingGate());
  const busy = useRef(false);
  const closed = useRef(false);
  const [status, setStatus] = useState<FeishuBindingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [command, setCommand] = useState<{ requestId: string; text: string } | null>(null);
  const [copyNote, setCopyNote] = useState('');
  const [now, setNow] = useState(Date.now);
  const [visible, setVisible] = useState(() => typeof document !== 'undefined' && !document.hidden);

  function accept(next: FeishuBindingStatus) {
    setStatus(next);
    setNow(Date.now());
    setCommand((previous) => previous && previous.requestId === next.request?.id
      && feishuBindingPending(next, Date.now()) ? previous : null);
    if (!feishuBindingPending(next, Date.now())) setCopyNote('');
  }

  async function refresh() {
    if (busy.current || closed.current) return;
    const operation = gate.current.begin();
    setLoading(true);
    setError(null);
    try {
      const next = await api.getFeishuBindingStatus(sourceId, operation.signal);
      if (operation.current()) accept(next);
    } catch {
      if (operation.current()) setError('无法读取绑定状态，请重试。');
    } finally {
      if (operation.current()) setLoading(false);
    }
  }

  async function mutate(kind: 'issue' | 'cancel' | 'revoke') {
    if (busy.current || closed.current || !status) return;
    if (kind === 'issue' && !feishuBindingCanIssue(status)) return;
    if (kind === 'cancel' && status.request?.status !== 'pending') return;
    if (kind === 'revoke' && !status.binding) return;
    busy.current = true;
    const operation = gate.current.begin();
    setMutating(true);
    setLoading(false);
    setError(null);
    setCopyNote('');
    setCommand(null);
    try {
      if (kind === 'issue') {
        const issued = await api.issueFeishuBindingRequest(writeToken, sourceId);
        if (!operation.current()) return;
        const next = { ...status, request: issued.request };
        accept(next);
        if (feishuBindingPending(next, Date.now())) setCommand({ requestId: issued.request.id, text: issued.command });
      } else {
        const next = kind === 'cancel'
          ? await api.cancelFeishuBindingRequest(status.request!.id, writeToken, sourceId)
          : await api.revokeFeishuBinding(status.binding!.id, writeToken, sourceId);
        if (operation.current()) accept(next);
      }
    } catch {
      if (operation.current()) {
        setError('操作结果尚未确认，请先刷新绑定状态后再操作。');
        // An interrupted response may still have committed on the server. Hide stale action controls.
        setStatus(null);
      }
    } finally {
      if (operation.current()) { busy.current = false; setMutating(false); }
    }
  }

  function close() { closed.current = true; gate.current.invalidate(); setCommand(null); onClose(); }

  useEffect(() => {
    closed.current = false;
    void refresh();
    const element = dialog.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (element && !element.open) {
      try { element.showModal(); } catch { element.setAttribute('open', ''); }
    }
    return () => {
      closed.current = true;
      gate.current.invalidate();
      if (element?.open) {
        if (typeof element.close === 'function') element.close();
        else element.removeAttribute('open');
      }
      if (previous?.isConnected && !previous.closest('[inert]')) previous.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    const updateVisibility = () => { setVisible(!document.hidden); setNow(Date.now()); };
    document.addEventListener('visibilitychange', updateVisibility);
    return () => document.removeEventListener('visibilitychange', updateVisibility);
  }, []);

  const pending = feishuBindingPending(status, now);
  useEffect(() => {
    if (!pending) { setCommand(null); setCopyNote(''); }
  }, [pending]);
  useEffect(() => {
    if (!pending || !status?.request) return;
    // One expiry timer also clears the command while the page is hidden; no per-second polling clock.
    const expiry = setTimeout(() => {
      setNow(Date.now()); setCommand(null); setCopyNote('');
    }, Math.max(0, Date.parse(status.request.expiresAt) - Date.now()));
    return () => clearTimeout(expiry);
  }, [pending, status?.request?.expiresAt]);

  useEffect(() => {
    if (!feishuBindingShouldPoll(status, Date.now(), visible, mutating) || closed.current) return;
    const poll = setInterval(() => {
      // Check actual visibility and time as well as state: background timer throttling cannot send expired polls.
      if (closed.current || !feishuBindingShouldPoll(status, Date.now(), !document.hidden, busy.current)) {
        clearInterval(poll);
        return;
      }
      void refresh();
    }, 2500);
    return () => clearInterval(poll);
  }, [status, mutating, visible, pending]);

  async function copyCommand() {
    if (!command) return;
    const current = gate.current.checkpoint();
    // Copying does not invalidate an in-flight status read.
    const text = command.text;
    try {
      await navigator.clipboard.writeText(text);
      if (current() && dialog.current?.open) setCopyNote('已复制，请发送到飞书机器人的私聊。');
    } catch {
      if (current() && dialog.current?.open) setCopyNote('无法自动复制，请选中上方文本手动复制。');
    }
  }

  const visibleCommand = pending && command && command.requestId === status?.request?.id ? command.text : null;
  return <dialog ref={dialog} className="feishu-binding-dialog" aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); close(); }}>
    <header><h2 id={titleId}>飞书账号绑定</h2><button type="button" onClick={close} autoFocus aria-label="关闭飞书账号绑定">关闭</button></header>
    <p>当前网页账号：<strong>{accountLabel}</strong></p>
    <p className="feishu-binding-muted">在飞书机器人的私聊中发送确认指令，关联你自己的账号。绑定并连接后可发送「知识」查看资料；卡片复习尚未接入。</p>
    {loading ? <p role="status">读取绑定状态中…</p> : null}
    {error ? <p className="feishu-binding-error" role="alert">{error}</p> : null}
    {status && status.channelState !== 'connected' ? <p className="feishu-binding-notice">{status.channelState === 'disabled'
      ? '飞书通道尚未启用。启用并连接后才能生成确认指令。'
      : '飞书通道当前未连接，暂不能生成确认指令。'}已有绑定仍可解除，待确认请求仍可取消。</p> : null}
    {status?.binding ? <section className="feishu-binding-box"><strong>已绑定飞书账号</strong><p>绑定时间：{new Date(status.binding.boundAt).toLocaleString('zh-CN')}</p>
      <button type="button" disabled={mutating} onClick={() => { void mutate('revoke'); }}>解除绑定</button></section> : null}
    {status && !status.binding && status.request?.status === 'pending' ? <section className="feishu-binding-box">
      <strong>{pending ? '等待飞书私聊确认' : '确认指令已过期'}</strong>
      {visibleCommand ? <><p>复制完整指令，发送到对应机器人的私聊：</p><textarea aria-label="飞书绑定确认指令" readOnly value={visibleCommand} rows={2} onFocus={(event) => event.currentTarget.select()} />
        <button type="button" disabled={mutating} onClick={() => { void copyCommand(); }}>复制确认指令</button></> : pending ? <p>指令仅在生成时显示。页面刷新后，可重新生成确认指令，旧指令立即失效。</p> : <p>可重新生成确认指令。</p>}
      <p>到期时间：{new Date(status.request.expiresAt).toLocaleString('zh-CN')}</p>
      <button type="button" disabled={mutating} onClick={() => { void mutate('cancel'); }}>取消待确认请求</button>
    </section> : null}
    {feishuBindingCanIssue(status) ? <><button type="button" disabled={mutating || loading} onClick={() => { void mutate('issue'); }}>{status?.request?.status === 'pending' ? '重新生成确认指令' : '生成飞书确认指令'}</button>
      {status?.request?.status === 'pending' ? <p className="feishu-binding-muted">重新生成后，旧确认指令立即失效。</p> : null}</> : null}
    {copyNote ? <p role="status">{copyNote}</p> : null}
    {mutating ? <p role="status">正在处理…</p> : null}
    <footer><button type="button" disabled={mutating} onClick={() => { void refresh(); }}>刷新状态</button></footer>
  </dialog>;
}
