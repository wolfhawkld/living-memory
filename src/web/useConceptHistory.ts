import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { AnswerPrivacyGuard } from './answer-privacy-projection';
import { api } from './api';
import { createConceptHistoryLoader, EMPTY_HISTORY_STATE, type HistoryScope } from './concept-history-loader';

export function useConceptHistory(scope: HistoryScope, enabled: boolean, refreshKey: unknown, privacy?: AnswerPrivacyGuard) {
  const loader = useMemo(() => createConceptHistoryLoader(scope, api.getConceptHistory, privacy), [scope.sourceId, scope.conceptId, scope.sourceRevision, scope.applicationEventId, scope.learningProtocolVersion, privacy]);
  const state = useSyncExternalStore(loader.subscribe, loader.getSnapshot, loader.getSnapshot);
  useEffect(() => privacy?.subscribe(() => { loader.invalidatePrivacy(); if (enabled) void loader.refresh(); }), [privacy, loader, enabled]);
  useEffect(() => () => loader.clear(), [loader, enabled]);
  useEffect(() => {
    if (enabled) void loader.refresh();
  }, [loader, enabled, refreshKey]);
  return {
    ...(enabled ? state : EMPTY_HISTORY_STATE),
    onRetry: () => { if (enabled) void loader.retry(); },
    onLoadMore: () => { if (enabled) void loader.loadMore(); },
  };
}
