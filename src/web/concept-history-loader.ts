import type { ConceptHistory } from '../shared/types';
import type { PrivacyObservation } from '../shared/answer-clearing';
import type { LearningProtocolVersion } from '../shared/learning-protocol';
import { PrivacyResponseError, observationPrivacyVersion, rememberObservationPrivacy, validateConceptHistoryPrivacy } from './privacy-response';

type PrivacyHistory = ConceptHistory<PrivacyObservation>;

export interface HistoryLoadState {
  history: PrivacyHistory | null;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
}

export const EMPTY_HISTORY_STATE: HistoryLoadState = { history: null, loading: false, loadingMore: false, error: null };
export interface HistoryScope { sourceId: string; conceptId: string; sourceRevision: string; applicationEventId?: string; learningProtocolVersion?: LearningProtocolVersion }
export type HistoryFetcher = (conceptId: string, sourceId: string, options: { limit: number; cursor?: string; applicationEventId?: string; signal: AbortSignal }) => Promise<PrivacyHistory>;

/** One concept/source lifetime; late responses cannot enter a new selection or recall task. */
export function createConceptHistoryLoader(scope: HistoryScope, fetchHistory: HistoryFetcher) {
  const protocol = scope.learningProtocolVersion ?? 2;
  const knownClearings = new Map<string, string>();
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
      const response = await fetchHistory(scope.conceptId, scope.sourceId, { limit: 20, cursor, applicationEventId: scope.applicationEventId, signal: request.signal });
      if (active !== request || request.signal.aborted) return;
      const page = validateConceptHistoryPrivacy(response, protocol);
      if (page.sourceId !== scope.sourceId || page.conceptId !== scope.conceptId || page.sourceRevision !== scope.sourceRevision) {
        publish({ ...state, history: null });
        throw new Error('知识来源或版本已变化，请刷新知识源后重新查看历史。');
      }
      if (page.progress && (page.progress.conceptId !== scope.conceptId
        || page.progress.sourceRevision !== scope.sourceRevision || page.progress.asOf !== page.asOf)) {
        publish({ ...state, history: null });
        throw new Error('回忆变化记录与当前概念或资料版本不一致，请刷新后重试。');
      }
      if (page.focusedApplicationEventId !== scope.applicationEventId || (scope.applicationEventId
        && (page.entries.length !== 1 || page.total !== 1 || page.nextCursor !== null
          || page.entries[0].type !== 'application' || page.entries[0].event.eventId !== scope.applicationEventId))) {
        publish({ ...state, history: null });
        throw new Error('未能定位指定的应用 / 总结记录，请刷新后重试，或查看全部历史。');
      }
      if (protocol === 3) for (const entry of page.entries) if (entry.type === 'observation') {
        rememberObservationPrivacy(knownClearings, entry.event);
      }
      const previousObservations = new Map(before?.entries.flatMap(entry => entry.type === 'observation' ? [[entry.event.eventId, entry.event] as const] : []) ?? []);
      const privacyChanged = protocol === 3 && page.entries.some(entry => entry.type === 'observation'
        && previousObservations.has(entry.event.eventId)
        && observationPrivacyVersion(previousObservations.get(entry.event.eventId)!) !== observationPrivacyVersion(entry.event));
      const decisionsChanged = before && (privacyChanged || page.correctionCount !== before.correctionCount || page.observationRevisionCount !== before.observationRevisionCount || page.observationAssessmentVersion !== before.observationAssessmentVersion);
      if (mode === 'more' && before && (page.total !== before.total || decisionsChanged)) {
        // Backdated insertions can fall on either side of the cursor. Start over
        // instead of silently presenting an incomplete history as complete.
        active = null;
        if (protocol === 3) publish({ history: null, loading: true, loadingMore: false, error: null });
        return load('refresh');
      }
      let history = page;
      if (before && mode === 'more') {
        const seen = new Set(before.entries.map((entry) => `${entry.type}:${entry.event.eventId}`));
        history = { ...page, entries: [...before.entries, ...page.entries.filter((entry) => !seen.has(`${entry.type}:${entry.event.eventId}`))],
          ...(page.corrections ? { corrections: { ...before.corrections, ...page.corrections } } : {}),
          ...(page.observationAssessments ? { observationAssessments: { ...before.observationAssessments, ...page.observationAssessments } } : {}) };
      } else if (before && !decisionsChanged && before.total === page.total && page.entries.length <= before.entries.length
        && page.entries.every((entry, index) => entry.type === before.entries[index].type && entry.event.eventId === before.entries[index].event.eventId)) {
        // Events are immutable. A clock-only refresh keeps loaded pages and open
        // answers while replacing the live anchor projection.
        history = { ...page, entries: before.entries, nextCursor: before.nextCursor,
          ...(page.corrections ? { corrections: { ...before.corrections, ...page.corrections } } : {}),
          ...(page.observationAssessments ? { observationAssessments: { ...before.observationAssessments, ...page.observationAssessments } } : {}) };
      }
      publish({ history, loading: false, loadingMore: false, error: null });
    } catch (error) {
      if (active !== request || request.signal.aborted) return;
      failedMode = mode;
      publish({ ...state, ...(protocol === 3 || error instanceof PrivacyResponseError ? { history: null } : {}),
        loading: false, loadingMore: false, error: error instanceof Error ? error.message : '读取学习历史失败，请重试。' });
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
