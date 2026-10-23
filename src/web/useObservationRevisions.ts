import { useEffect, useLayoutEffect, useMemo, useSyncExternalStore } from 'react';
import { api } from './api';
import { createObservationRevisionChannel, type ObservationRevisionChannelContext } from './observation-revision-channel';
import { observationRevisionPendingStorageKey } from './observation-revision-pending';

export function useObservationRevisions(context: ObservationRevisionChannelContext) {
  const channel = useMemo(() => createObservationRevisionChannel({
    storage: { getItem: key => window.localStorage.getItem(key), setItem: (key, value) => window.localStorage.setItem(key, value) },
    append: api.postObservationRevision, readHistory: api.getObservationRevisions,
  }), []);
  const state = useSyncExternalStore(channel.subscribe, channel.getSnapshot, channel.getSnapshot);
  useLayoutEffect(() => {
    channel.setContext(context);
    void channel.refresh();
  }, [channel, context.accountId, context.sourceId, context.instanceId, context.writeToken, context.mode, context.locked, context.learningProtocolVersion]);
  useLayoutEffect(() => () => channel.setContext(null), [channel]);
  useEffect(() => {
    const key = observationRevisionPendingStorageKey(context);
    const refresh = (event: StorageEvent) => { if (event.storageArea === window.localStorage && (event.key === key || event.key === null)) void channel.refresh(); };
    window.addEventListener('storage', refresh);
    return () => window.removeEventListener('storage', refresh);
  }, [channel, context.accountId, context.sourceId, context.instanceId]);
  return { ...state, channel };
}
