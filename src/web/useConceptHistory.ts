import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { api } from './api';
import { createConceptHistoryLoader, EMPTY_HISTORY_STATE, type HistoryScope } from './concept-history-loader';

export function useConceptHistory(scope: HistoryScope, enabled: boolean, refreshKey: unknown) {
  const loader = useMemo(() => createConceptHistoryLoader(scope, api.getConceptHistory), [scope.sourceId, scope.conceptId, scope.sourceRevision]);
  const state = useSyncExternalStore(loader.subscribe, loader.getSnapshot, loader.getSnapshot);
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
