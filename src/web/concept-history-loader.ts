import type { ConceptHistory } from '../shared/types';

export interface HistoryLoadState {
  history: ConceptHistory | null;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
}

export const EMPTY_HISTORY_STATE: HistoryLoadState = { history: null, loading: false, loadingMore: false, error: null };
export interface HistoryScope { sourceId: string; conceptId: string; sourceRevision: string }
export type HistoryFetcher = (conceptId: string, sourceId: string, options: { limit: number; cursor?: string; signal: AbortSignal }) => Promise<ConceptHistory>;

/** One concept/source lifetime; late responses cannot enter a new selection or recall task. */
export function createConceptHistoryLoader(scope: HistoryScope, fetchHistory: HistoryFetcher) {
  let state = EMPTY_HISTORY_STATE;
  let active: AbortController | null = null;
  let refreshQueued = false;
  let failedMode: 'refresh' | 'more' = 'refresh';
  const listeners = new Set<() => void>();
  const publish = (next: HistoryLoadState) => { state = next; listeners.forEach((listener) => listener()); };

  async function load(mode: 'refresh' | 'more', force = false): Promise<void> {
    if (active && !force) {
      if (mode === 'refresh') refreshQueued = true;
      return;
    }
    if (mode === 'more' && !state.history?.nextCursor) return;
    active?.abort();
    const request = new AbortController();
    active = request;
    const before = state.history;
    const cursor = mode === 'more' ? before?.nextCursor ?? undefined : undefined;
    publish({ ...state, loading: mode === 'refresh', loadingMore: mode === 'more', error: null });
    try {
      const page = await fetchHistory(scope.conceptId, scope.sourceId, { limit: 20, cursor, signal: request.signal });
      if (active !== request || request.signal.aborted) return;
      if (page.sourceId !== scope.sourceId || page.conceptId !== scope.conceptId || page.sourceRevision !== scope.sourceRevision) {
        publish({ ...state, history: null });
        throw new Error('知识来源或版本已变化，请刷新知识源后重新查看历史。');
      }
      if (mode === 'more' && before && page.total !== before.total) {
        // Backdated insertions can fall on either side of the cursor. Start over
        // instead of silently presenting an incomplete history as complete.
        active = null;
        return load('refresh');
      }
      let history = page;
      if (before && mode === 'more') {
        const seen = new Set(before.entries.map((entry) => `${entry.type}:${entry.event.eventId}`));
        history = { ...page, entries: [...before.entries, ...page.entries.filter((entry) => !seen.has(`${entry.type}:${entry.event.eventId}`))] };
      } else if (before && before.total === page.total && page.entries.length <= before.entries.length
        && page.entries.every((entry, index) => entry.type === before.entries[index].type && entry.event.eventId === before.entries[index].event.eventId)) {
        // Events are immutable. A clock-only refresh keeps loaded pages and open
        // answers while replacing the live anchor projection.
        history = { ...page, entries: before.entries, nextCursor: before.nextCursor };
      }
      publish({ history, loading: false, loadingMore: false, error: null });
    } catch (error) {
      if (active !== request || request.signal.aborted) return;
      failedMode = mode;
      publish({ ...state, loading: false, loadingMore: false, error: error instanceof Error ? error.message : '读取学习历史失败，请重试。' });
    } finally {
      if (active === request) {
        active = null;
        if (refreshQueued) {
          refreshQueued = false;
          void load('refresh');
        }
      }
    }
  }

  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh: () => load('refresh'),
    loadMore: () => load('more'),
    retry: () => load(failedMode, true),
    clear: () => { active?.abort(); active = null; refreshQueued = false; publish(EMPTY_HISTORY_STATE); },
  };
}
