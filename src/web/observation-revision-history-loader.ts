import { parseObservationRevision, parseObservationRevisionRequest } from '../shared/observation-revisions';
import type { PrivacyObservation } from '../shared/answer-clearing';
import type { ObservationRevisionHistory } from '../shared/observation-revision-history';
import type { LearningProtocolVersion } from '../shared/learning-protocol';
import { PrivacyResponseError, observationPrivacyVersion, rememberObservationPrivacy, validateObservationPrivacy, validateRevisionHistoryPrivacy } from './privacy-response';
type PrivacyRevisionHistory = ObservationRevisionHistory<PrivacyObservation>;
export type RevisionHistoryLoader = (options: { limit?: number; cursor?: string; signal?: AbortSignal }) => Promise<PrivacyRevisionHistory>;
export interface RevisionHistoryLoadState { history: PrivacyRevisionHistory | null; loading: boolean; error: string | null; }
export function revisionHistoryMatches(parent: PrivacyObservation, history: PrivacyRevisionHistory): boolean {
  return history.observation.eventId === parent.eventId && history.observation.conceptId === parent.conceptId
    && history.observation.sourceRevision === parent.sourceRevision;
}
export function validateRevisionHistory(parent: PrivacyObservation, history: PrivacyRevisionHistory, protocol: LearningProtocolVersion = 2): void {
  validateRevisionHistoryPrivacy(history, protocol);
  if (!history || !history.observation || !revisionHistoryMatches(parent, history)) throw new Error('修订历史与原观察不匹配，请重新核对。');
  const state = history.state;
  if (!state || !['active', 'withdrawn'].includes(state.status) || !Number.isSafeInteger(state.appliedRevisionCount) || state.appliedRevisionCount < 0
    || !(state.latestRevisionEventId === null || typeof state.latestRevisionEventId === 'string')
    || !Number.isSafeInteger(history.total) || history.total < 0 || !Number.isSafeInteger(history.observationRevisionCount) || history.observationRevisionCount < 0
    || !Array.isArray(history.events) || !(history.nextCursor === null || typeof history.nextCursor === 'string')) throw new Error('修订历史响应不完整，不能提交决定。');
  parseObservationRevisionRequest({eventId:'validation',observationEventId:parent.eventId,previousEventId:null,occurredAt:parent.observedAt,
    action:'revise',reason:'other',assessment:state.currentAssessment});
  if (Boolean(state.currentAssessment.learning) !== Boolean(parent.learning)) throw new Error('修订历史判断字段与原观察不一致。');
  for (const raw of history.events) {
    const event = parseObservationRevision(raw);
    if(event.observationEventId !== parent.eventId || event.conceptId !== parent.conceptId || event.sourceRevision !== parent.sourceRevision) throw new Error('修订审计与原观察不匹配。');
  }
}
export function createObservationRevisionHistoryLoader(parent: PrivacyObservation, fetchPage: RevisionHistoryLoader, protocol: LearningProtocolVersion = 2) {
  const knownClearings = new Map<string, string>();
  if (protocol === 3) rememberObservationPrivacy(knownClearings, validateObservationPrivacy(parent, protocol));
  let state: RevisionHistoryLoadState = { history: null, loading: false, error: null };
  let active: AbortController | null = null; let disposed = false;
  const listeners = new Set<() => void>();
  const publish = (next: RevisionHistoryLoadState) => { state = next; listeners.forEach(fn => fn()); };
  async function load(more = false): Promise<PrivacyRevisionHistory | null> {
    if (disposed || (more && (state.loading || !state.history?.nextCursor || state.history.events.length >= 100))) return null;
    active?.abort(); const controller = new AbortController(); active = controller;
    const before = state.history;
    publish({ history: before, loading: true, error: null });
    try {
      const page = await fetchPage({ limit: 20, ...(more ? { cursor: before!.nextCursor! } : {}), signal: controller.signal });
      if (disposed || active !== controller || controller.signal.aborted) return null;
      validateRevisionHistory(parent, page, protocol);
      if (protocol === 3) rememberObservationPrivacy(knownClearings, page.observation);
      if (more && before && (page.total !== before.total || page.state.latestRevisionEventId !== before.state.latestRevisionEventId
        || (protocol === 3 && observationPrivacyVersion(page.observation) !== observationPrivacyVersion(before.observation)))) {
        publish({ history: null, loading: false, error: null }); return load();
      }
      const history = more && before ? { ...page, events: [...before.events, ...page.events.filter(event => !before.events.some(old => old.eventId === event.eventId))].slice(0, 100) } : { ...page, events: page.events.slice(0, 100) };
      publish({ history, loading: false, error: null }); return history;
    } catch (error) {
      if (disposed || active !== controller || controller.signal.aborted) return null;
      if (more && (error as { code?: string })?.code === 'OBSERVATION_REVISION_HISTORY_CHANGED') {
        publish({ history: null, loading: false, error: null }); return load();
      }
      publish({ history: protocol === 3 || error instanceof PrivacyResponseError ? null : before,
        loading: false, error: error instanceof Error ? error.message : '修订历史暂不可用，请重试。' }); return null;
    } finally { if (active === controller) active = null; }
  }
  return { getSnapshot: () => state, subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    refresh: () => load(), loadMore: () => load(true), activate() { disposed = false; }, dispose() { disposed = true; active?.abort(); active = null; listeners.clear(); } };
}
