import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ActivitySettings, ActivitySettingsUpdate } from '../shared/activity';
import { api, ApiRequestError } from './api';
import { createActivityQueue } from './activity-queue';
import { createActivityCapture } from './activity-capture';
import { createActivitySettingsGate } from './activity-settings-gate';

export function useActivity(input: { accountId: string; sourceId: string; instanceId: string; writeToken: string; mode: 'real' | 'example' | 'forecast'; locked: boolean }) {
  const scopeKey = JSON.stringify([input.accountId, input.sourceId, input.instanceId]);
  const current = useRef(input); current.current = input;
  const [state, setState] = useState<{ scopeKey: string; settings: ActivitySettings | null }>({ scopeKey, settings: null });
  const [queueStatus, setQueueStatus] = useState({ pending: 0, conflicts: 0, exhausted: 0, message: undefined as string | undefined });
  const [open, setOpen] = useState(false);
  const gate = useMemo(createActivitySettingsGate, []);
  const [suspended, setSuspended] = useState(false);
  const queue = useMemo(() => createActivityQueue({
    storage: { getItem: (key) => window.localStorage.getItem(key), setItem: (key, value) => window.localStorage.setItem(key, value) },
    transport: { append: (request, scope) => {
      const active = current.current;
      if (active.accountId !== scope.accountId || active.sourceId !== scope.sourceId || active.instanceId !== (scope.instanceId ?? 'legacy') || !active.writeToken) {
        return Promise.reject(new ApiRequestError('知识空间已变化。', { code: 'SOURCE_MISMATCH', status: 409 }));
      }
      return api.appendActivity(request, active.writeToken, scope.sourceId);
    } },
  }), []);
  const refreshQueue = useCallback(async () => {
    const captured = current.current;
    const status = await queue.snapshot();
    if (current.current.accountId !== captured.accountId || current.current.sourceId !== captured.sourceId || current.current.instanceId !== captured.instanceId) return;
    setQueueStatus((previous) => ({ pending: status.rows.filter((row) => row.state === 'pending').length,
      conflicts: status.rows.filter((row) => row.state === 'conflict').length, exhausted: status.rows.filter((row) => row.state === 'exhausted').length,
      message: status.status === 'unavailable' ? '查阅追踪暂不可用；知识查询和学习记录可继续使用。' : previous.message }));
  }, [queue]);
  const capture = useMemo(() => createActivityCapture({ emit: (request, capturedContext) => {
    const captured = current.current;
    if (capturedContext.scopeKey !== JSON.stringify([captured.accountId, captured.sourceId, captured.instanceId])
      || captured.mode !== 'real' || captured.locked || !captured.writeToken || gate.snapshot().suspended) return;
    void queue.enqueue(request).then(async (result) => {
      if (current.current.accountId !== captured.accountId || current.current.sourceId !== captured.sourceId || current.current.instanceId !== captured.instanceId) return;
      if (result.status === 'not-saved') setQueueStatus((previous) => ({ ...previous, message: `本次查阅记录未保存（${result.reason}）。` }));
      else await queue.flush();
      await refreshQueue();
    });
  } }), [gate, queue, refreshQueue]);
  const settings = state.scopeKey === scopeKey ? state.settings : null;
  const checkScope = useCallback((captured: typeof input) => {
    if (current.current.accountId !== captured.accountId || current.current.sourceId !== captured.sourceId || current.current.instanceId !== captured.instanceId || current.current.writeToken !== captured.writeToken) {
      throw new Error('账号或知识空间已变化，请重新打开查阅记录。');
    }
  }, []);
  useLayoutEffect(() => {
    gate.setScope(JSON.stringify([input.accountId, input.sourceId, input.instanceId, input.writeToken]));
    const known = gate.snapshot();
    queue.setContext({ ...input, authenticated: Boolean(input.writeToken), locked: input.locked || known.suspended, settings: known.settings ?? undefined });
    capture.setContext({ scopeKey, epoch: known.settings?.epoch ?? 0, enabled: Boolean(known.settings?.enabled && input.writeToken && input.mode === 'real' && !input.locked && !known.suspended) });
  }, [capture, gate, input.accountId, input.sourceId, input.instanceId, input.writeToken, input.mode, input.locked, queue, scopeKey, settings, suspended]);
  const commitSettings = useCallback(async (next: ActivitySettings, captured: typeof input, verified = true) => {
    checkScope(captured);
    if (!gate.accept(next, verified)) return false;
    const result = await queue.applySettings(next); checkScope(captured);
    if (!result.applied && ['epoch-changed', 'context-changed', 'settings-unavailable', 'inactive'].includes(result.reason ?? '')) {
      gate.markUncertain(); capture.cancel(); setSuspended(true); return false;
    }
    if (!result.applied) setQueueStatus((previous) => ({ ...previous,
      message: '服务端设置已确认，但浏览器待同步副本未能更新，请检查存储后重试同步。' }));
    const known = gate.snapshot(); setSuspended(known.suspended);
    setState({ scopeKey: JSON.stringify([captured.accountId, captured.sourceId, captured.instanceId]), settings: known.settings });
    return true;
  }, [capture, checkScope, gate, queue]);
  const reloadSettings = useCallback(async (signal?: AbortSignal) => {
    const captured = current.current;
    const result = await api.getActivitySettings(captured.sourceId, signal);
    checkScope(captured);
    if (result.sourceId !== captured.sourceId) throw new Error('查阅记录来源不一致。');
    await commitSettings(result.settings, captured);
    await refreshQueue();
    return result.settings;
  }, [checkScope, commitSettings, refreshQueue]);
  useEffect(() => {
    const controller = new AbortController(); setOpen(false);
    if (input.writeToken && input.sourceId) void reloadSettings(controller.signal).catch(() => {
      if (!controller.signal.aborted) setQueueStatus({ pending: 0, conflicts: 0, exhausted: 0, message: '无法读取追踪设置，暂不采集查阅记录。' });
    });
    return () => { controller.abort(); capture.cancel(); };
  }, [capture, input.accountId, input.sourceId, input.instanceId, input.writeToken, input.mode, reloadSettings]);
  useEffect(() => {
    const retry = () => { void reloadSettings().then(() => queue.flush()).then(refreshQueue).catch(() => undefined); };
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  }, [queue, refreshQueue, reloadSettings]);
  const loadPage = useCallback(async (options: Parameters<typeof api.getActivity>[0], signal?: AbortSignal) => {
    const captured = current.current; const page = await api.getActivity(options, captured.sourceId, signal); checkScope(captured);
    if (page.sourceId !== captured.sourceId) throw new Error('查阅记录来源不一致。'); return page;
  }, [checkScope]);
  const updateSettings = useCallback(async (payload: ActivitySettingsUpdate) => {
    gate.beginControl(); capture.cancel(); setSuspended(true);
    const captured = current.current;
    try {
      const result = await api.updateActivitySettings(payload, captured.writeToken, captured.sourceId); checkScope(captured);
      gate.endControl(); if (!await commitSettings(result.settings, captured)) await reloadSettings(); await refreshQueue();
      return gate.snapshot().settings ?? result.settings;
    } catch (error) {
      try { checkScope(captured); gate.endControl(); await reloadSettings(); } catch { /* remain suspended */ }
      throw error;
    }
  }, [capture, checkScope, commitSettings, gate, refreshQueue, reloadSettings]);
  const clear = useCallback(async (payload: Parameters<typeof api.clearActivity>[0]) => {
    gate.beginControl(); capture.cancel(); setSuspended(true);
    const captured = current.current;
    try {
      const result = await api.clearActivity(payload, captured.writeToken, captured.sourceId); checkScope(captured);
      if (payload.scope === 'operation') {
        const local = await queue.clearOperation(payload.operationId);
        if (!local.cleared) setQueueStatus((previous) => ({ ...previous, message: '服务端已清除；浏览器待同步副本未能清理，请检查本地存储。' }));
      }
      gate.endControl(); if (!await commitSettings(result.settings, captured)) await reloadSettings(); await refreshQueue();
      return { ...result, settings: gate.snapshot().settings ?? result.settings };
    } catch (error) {
      // An unknown response may follow a committed clear. Reconcile settings,
      // never resend the destructive request or recreate a reading operation.
      try { checkScope(captured); gate.endControl(); await reloadSettings(); } catch { /* retain the original failure */ }
      throw error;
    }
  }, [capture, checkScope, commitSettings, gate, queue, refreshQueue, reloadSettings]);
  const exportActivity = useCallback(async () => { const captured = current.current; const result = await api.exportActivity(captured.sourceId); checkScope(captured); return result; }, [checkScope]);
  const retry = useCallback(async () => { await reloadSettings(); await queue.retryPending(); await queue.flush(); await refreshQueue(); }, [queue, refreshQueue, reloadSettings]);
  return {
    scopeKey, open, setOpen, settings, capture, queueStatus,
    trackingEnabled: Boolean(settings?.enabled && input.mode === 'real' && !input.locked && input.writeToken && !suspended),
    reloadSettings,
    loadPage, updateSettings, clear, export: exportActivity, retry,
  };
}
