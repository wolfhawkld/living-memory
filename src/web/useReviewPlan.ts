import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReviewPlanResponse } from '../shared/review-plan';
import { reviewDayKey } from '../shared/review-plan';
import { api } from './api';

export function useReviewPlan(sourceId: string, enabled: boolean, snapshot: unknown) {
  const [timeZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  const [response, setResponse] = useState<ReviewPlanResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sourceRef = useRef(sourceId);
  sourceRef.current = sourceId;
  const active = useRef<AbortController | null>(null);
  const refresh = useCallback(async (): Promise<ReviewPlanResponse | null> => {
    if (!sourceId) return null;
    active.current?.abort();
    const request = new AbortController();
    active.current = request;
    setLoading(true);
    setError(null);
    try {
      const result = await api.getReviewPlan(sourceId, timeZone, request.signal);
      if (request.signal.aborted || active.current !== request || sourceRef.current !== sourceId) return null;
      if (result.sourceId !== sourceId) throw new Error('知识空间已变化，请重新加载页面。');
      setResponse(result);
      return result;
    } catch (cause) {
      if (request.signal.aborted || active.current !== request || sourceRef.current !== sourceId) return null;
      setResponse(null);
      setError(cause instanceof Error ? cause.message : '复习安排读取失败，请重试。');
      throw cause;
    } finally {
      if (active.current === request) { active.current = null; setLoading(false); }
    }
  }, [sourceId, timeZone]);

  useEffect(() => () => { active.current?.abort(); active.current = null; }, [sourceId, enabled]);
  useEffect(() => {
    // A snapshot arriving during an explicit start/resume request must not
    // cancel that request; the next task boundary always refreshes explicitly.
    if (!enabled || !sourceId || active.current) return;
    void refresh().catch(() => undefined);
  }, [sourceId, enabled, snapshot, refresh]);

  useEffect(() => {
    if (!enabled) return;
    let day = reviewDayKey(new Date().toISOString(), timeZone);
    const checkDay = () => {
      const next = reviewDayKey(new Date().toISOString(), timeZone);
      if (next === day) return;
      day = next;
      void refresh().catch(() => undefined);
    };
    const timer = window.setInterval(checkDay, 30_000);
    window.addEventListener('focus', checkDay);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', checkDay); };
  }, [enabled, timeZone, refresh]);

  return { response: response?.sourceId === sourceId && enabled ? response : null, loading, error, timeZone, refresh };
}
