import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { api } from './api';
import { getAnswerPrivacyChannel, type AnswerPrivacyRecord } from './answer-clearing-privacy';
import { createAnswerClearingOperation } from './answer-clearing-operation';

const EMPTY: readonly AnswerPrivacyRecord[] = [];
const emptySnapshot = () => EMPTY;
const noSubscription = () => () => undefined;
const closed = () => null;

export function useAnswerClearing(scope: { accountId: string; sourceId: string; instanceId: string; protocol?: number; writeToken: string }) {
  const scopeKey = JSON.stringify([scope.accountId, scope.sourceId, scope.instanceId, scope.protocol]);
  const token = useRef(scope.writeToken); token.current = scope.writeToken;
  const channel = useMemo(() => scope.protocol === 3 && scope.sourceId
    ? getAnswerPrivacyChannel({ sourceId: scope.sourceId, instanceId: scope.instanceId }) : undefined, [scopeKey]);
  const operation = useMemo(() => channel ? createAnswerClearingOperation({ channel,
    clear: id => api.clearObservationAnswer(id, token.current, scope.sourceId),
    read: id => api.getObservationAnswerClearingState(id, scope.sourceId),
  }) : undefined, [channel, scopeKey]);
  const records = useSyncExternalStore(channel?.subscribe ?? noSubscription, channel?.getSnapshot ?? emptySnapshot, emptySnapshot);
  const state = useSyncExternalStore(operation?.subscribe ?? noSubscription, operation?.getSnapshot ?? closed, closed);
  const reconcile = useMemo(() => {
    let active = false, disposed = false;
    return {
      activate() { disposed = false; }, dispose() { disposed = true; },
      async run() {
        if (!channel || active || disposed) return;
        active = true;
        try {
          channel.reconcile();
          for (const record of channel.getSnapshot()) {
            if (disposed) break;
            try {
              if (record.status === 'cleared') { if (record.cleanup !== 'complete') await channel.retryCleanup(record.observationEventId); }
              else {
                const status = await api.getObservationAnswerClearingState(record.observationEventId, scope.sourceId);
                if (!disposed && status.status === 'cleared' && status.observationEventId === record.observationEventId) await channel.confirm({ observationEventId: status.observationEventId, clearedAt: status.clearedAt });
              }
            } catch { /* An unresolved intent remains visible; it is never silently retried as POST. */ }
          }
        } finally { active = false; }
      },
    };
  }, [channel, scopeKey]);
  useEffect(() => {
    operation?.activate(); reconcile.activate(); void reconcile.run();
    const refresh = () => { if (!document.hidden) void reconcile.run(); };
    window.addEventListener('focus', refresh); window.addEventListener('pageshow', refresh); document.addEventListener('visibilitychange', refresh);
    return () => { operation?.dispose(); reconcile.dispose(); window.removeEventListener('focus', refresh); window.removeEventListener('pageshow', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [operation, reconcile]);
  const open = useCallback((eventId: string) => operation?.open(eventId), [operation]);
  return { channel, records, state, operation, open, reconcile: reconcile.run };
}
