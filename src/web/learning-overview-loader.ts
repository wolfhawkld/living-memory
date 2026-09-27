import type { LearningOverview, LearningOverviewItem } from '../shared/learning-overview';
import type { Concept, Snapshot } from '../shared/types';

export interface OverviewLoadState { overview: LearningOverview | null; loading: boolean; error: string | null }
export const EMPTY_OVERVIEW_STATE: OverviewLoadState = { overview: null, loading: false, error: null };
export type OverviewFetcher = (sourceId: string, signal: AbortSignal) => Promise<LearningOverview>;

/** One source lifetime. A cancelled or superseded request never restores another view's data. */
export function createLearningOverviewLoader(sourceId: string, fetchOverview: OverviewFetcher) {
  let state = EMPTY_OVERVIEW_STATE;
  let active: AbortController | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: OverviewLoadState) => { state = next; listeners.forEach((listener) => listener()); };
  const clear = () => { active?.abort(); active = null; publish(EMPTY_OVERVIEW_STATE); };
  async function refresh(): Promise<void> {
    active?.abort();
    const request = new AbortController();
    active = request;
    publish({ ...state, loading: true, error: null });
    try {
      const overview = await fetchOverview(sourceId, request.signal);
      if (active !== request || request.signal.aborted) return;
      if (overview.sourceId !== sourceId) {
        publish({ overview: null, loading: false, error: '知识空间已变化，请关闭总览并重新连接。' });
        return;
      }
      publish({ overview, loading: false, error: null });
    } catch (error) {
      if (active !== request || request.signal.aborted) return;
      const scopeChanged = error && typeof error === 'object' && 'code' in error
        && (error.code === 'SOURCE_MISMATCH' || error.code === 'AUTH_REQUIRED');
      publish({ overview: scopeChanged ? null : state.overview, loading: false,
        error: error instanceof Error ? error.message : '总览加载失败，请重试。' });
    } finally {
      if (active === request) active = null;
    }
  }
  return { getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh, clear };
}

/** Navigation rechecks current source and revision, including nodes beyond the visible graph limit. */
export function resolveOverviewSelection(sourceId: string, overview: LearningOverview, item: LearningOverviewItem, snapshot: Snapshot): Concept {
  if (sourceId !== overview.sourceId) throw new Error('知识空间已变化，请关闭总览并重新连接。');
  if (!overview.items.some((row) => row.conceptId === item.conceptId && row.sourceRevision === item.sourceRevision)) {
    throw new Error('这条概念记录已不在当前总览中，请刷新总览。');
  }
  const concept = snapshot.concepts.find((candidate) => candidate.id === item.conceptId);
  if (!concept || concept.source.revision !== item.sourceRevision) throw new Error('概念已移动、移除或更新，请刷新总览后再查看。');
  return concept;
}
