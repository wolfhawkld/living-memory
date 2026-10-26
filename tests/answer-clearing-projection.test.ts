import assert from 'node:assert/strict';
import test from 'node:test';
import type { AnswerClearingMarker, PrivacyObservation } from '../src/shared/answer-clearing';
import type { ConceptHistory, Observation, Snapshot } from '../src/shared/types';
import type { ObservationRevisionHistory } from '../src/shared/observation-revision-history';
import { createConceptHistoryLoader } from '../src/web/concept-history-loader';
import { createObservationRevisionHistoryLoader } from '../src/web/observation-revision-history-loader';
import { projectPrivateHistory, type AnswerPrivacyGuard } from '../src/web/answer-privacy-projection';
import { createScenarioPracticeState, startScenarioPractice, submitScenarioAnswer, buildScenarioObservationRequest, scrubScenarioAnswer } from '../src/web/ScenarioPractice';
import { buildScenarioApplicationDraft } from '../src/web/scenario-application-handoff';
import { initialRevisionDraft, freezeRevisionDraft, revisionDraftDisabledReason } from '../src/web/ObservationRevisionDialog';
const parent: Observation = { eventId: 'parent', conceptId: 'concept-a', sourceRevision: 'rev-a', observedAt: '2026-10-01T00:00:00.000Z', recordedAt: '2026-10-01T00:00:01.000Z', answer: 'SYNTHETIC_PRIVATE_ORIGINAL', configRevision: 1, halfLifeDays: 7, anchorEventId: null, elapsedDays: null, decay: null, rating: 'clear', exposure: 'unexposed', observedExposure: false };
const marker = { observationEventId: parent.eventId, clearedAt: '2026-10-03T00:00:00.000Z' };
const scope = { sourceId: 'projection-source', conceptId: parent.conceptId, sourceRevision: parent.sourceRevision, learningProtocolVersion: 3 as const };
function guard() {
  const markers = new Map<string, AnswerClearingMarker>(), pending = new Set<string>(), listeners = new Set<() => void>();
  const value: AnswerPrivacyGuard = { getMarker: id => markers.get(id) ?? null, isBlocked: id => pending.has(id) || markers.has(id), subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
  return { value, begin(id: string) { pending.add(id); listeners.forEach(fn => fn()); }, confirm(input: AnswerClearingMarker) { markers.set(input.observationEventId, input); listeners.forEach(fn => fn()); } };
}
function history(observations: PrivacyObservation[] = [parent], nextCursor: string | null = null): ConceptHistory<PrivacyObservation> {
  return { sourceId: scope.sourceId, conceptId: scope.conceptId, sourceRevision: scope.sourceRevision, asOf: '2026-10-04T00:00:00.000Z', state: { conceptId: parent.conceptId, status: 'unknown', decay: null, elapsedDays: null, anchor: null, reason: null, asOf: '2026-10-04T00:00:00.000Z' }, entries: observations.map(event => ({ type: 'observation', event })), total: 2, nextCursor, observationAssessmentVersion: 'a'.repeat(64), observationPrivacy: { cleared: 0, excludedFromPerformance: 0 } };
}
function revisions(observation: PrivacyObservation = parent): ObservationRevisionHistory<PrivacyObservation> {
  return { observation, state: { status: 'active', currentAssessment: { rating: 'clear', learning: null }, latestRevisionEventId: null, appliedRevisionCount: 0 }, events: [], total: 0, nextCursor: null, observationRevisionCount: 0 };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function observation(page: ConceptHistory<PrivacyObservation> | null, id = parent.eventId) { const entry = page?.entries.find(entry => entry.type === 'observation' && entry.event.eventId === id); assert.ok(entry?.type === 'observation'); return entry.event; }

test('confirmed clearing immediately replaces a loaded original and preserves another page during old refresh responses', async () => {
  const privacy = guard(), other = { ...parent, eventId: 'independent', answer: 'INDEPENDENT_ANSWER' };
  let phase = 'initial'; const delayed = deferred<ConceptHistory<PrivacyObservation>>();
  const loader = createConceptHistoryLoader(scope, async (_concept, _source, options) => phase === 'delayed' ? delayed.promise : options.cursor ? history([other]) : history([parent], 'page-two'), privacy.value);
  const unsubscribe = privacy.value.subscribe(loader.invalidatePrivacy);
  await loader.refresh(); await loader.loadMore(); assert.equal(loader.getSnapshot().history?.entries.length, 2);
  phase = 'delayed'; const request = loader.refresh(); privacy.confirm(marker);
  assert.equal(observation(loader.getSnapshot().history).answer, null); assert.equal(observation(loader.getSnapshot().history, other.eventId).answer, other.answer);
  delayed.resolve(history([parent], 'page-two')); await request;
  assert.equal(observation(loader.getSnapshot().history).answer, null, 'late original response cannot undo immediate invalidation');
  phase = 'refresh'; await loader.refresh(); assert.equal(observation(loader.getSnapshot().history).answer, null);
  assert.equal(JSON.stringify(loader.getSnapshot()).includes(parent.answer), false);
  unsubscribe(); loader.clear();
});

test('unknown target is hidden before and after paginated responses without dropping independent entries', async () => {
  const privacy = guard(), other = { ...parent, eventId: 'independent', answer: 'INDEPENDENT_ANSWER' };
  const before = history([parent, other]); privacy.begin(parent.eventId);
  const projected = projectPrivateHistory(before, privacy.value);
  assert.equal(projected.entries.length, 1); assert.equal(observation(projected, other.eventId).answer, other.answer);
  assert.equal(JSON.stringify(projected).includes(parent.answer), false); assert.equal(observation(before).answer, parent.answer, 'caller-owned immutable response is not modified');
  const loader = createConceptHistoryLoader(scope, async (_c, _s, options) => options.cursor ? history([parent]) : history([other], 'more'), privacy.value);
  await loader.refresh(); await loader.loadMore(); assert.equal(loader.getSnapshot().history?.entries.length, 1);
  assert.equal(observation(loader.getSnapshot().history, other.eventId).answer, other.answer);
});

test('revision history invalidates its original parent immediately, ignores late reads and retains audit judgment', async () => {
  const privacy = guard(), delayed = deferred<ObservationRevisionHistory<PrivacyObservation>>(); let wait = false;
  const loader = createObservationRevisionHistoryLoader(parent, async () => wait ? delayed.promise : revisions(), 3, privacy.value);
  const unsubscribe = privacy.value.subscribe(loader.invalidatePrivacy);
  await loader.refresh(); wait = true; const request = loader.refresh(); privacy.confirm(marker);
  assert.equal(loader.getSnapshot().history?.observation.answer, null);
  assert.deepEqual(loader.getSnapshot().history?.state.currentAssessment, { rating: 'clear', learning: null });
  delayed.resolve(revisions()); await request; assert.equal(loader.getSnapshot().history?.observation.answer, null);
  wait = false; await loader.refresh(); assert.equal(loader.getSnapshot().history?.observation.answer, null);
  const draft = { ...initialRevisionDraft(revisions()), assessment: { rating: 'partial' as const, learning: null }, reason: 'other' as const, note: 'independent revision note' };
  const current = loader.getSnapshot().history!;
  const requestDraft = freezeRevisionDraft(current.observation, current, draft, 'revision-after-clearing', '2026-10-04T00:00:00.000Z');
  assert.equal(requestDraft.note, draft.note); assert.equal(JSON.stringify(requestDraft).includes(parent.answer), false);
  assert.match(revisionDraftDisabledReason(current.observation, current, { ...draft, reason: 'rechecked-original' }) ?? '', /原答已清除/);
  unsubscribe(); loader.dispose(); assert.equal(loader.getSnapshot().history, null);
});

const snapshot: Snapshot = { concepts: [{ id: parent.conceptId, title: 'Concept A', aliases: [], domain: 'Math', summary: 'Summary', body: 'Source', source: { path: 'Math/a.md', revision: parent.sourceRevision } }], links: [], source: { name: 'synthetic', mode: 'local', conceptCount: 1, limit: 100, diagnostics: [] }, config: { modelVersion: 'time-only-v0', halfLifeDays: 7, revision: 1 }, states: {}, asOf: '2026-10-01T00:00:00.000Z', observationsCount: 0 };
function scenarioState() {
  let state = createScenarioPracticeState(snapshot, {});
  state = startScenarioPractice({ ...state, scenario: 'INDEPENDENT_SCENARIO', confidence: 75 }, '2026-10-01T00:00:00.000Z');
  state = submitScenarioAnswer({ ...state, answer: parent.answer }, parent.observedAt, parent.eventId);
  state = { ...state, conceptId: parent.conceptId, applicability: 'INDEPENDENT_APPLICABILITY', cue: 'independent', outcome: 'success', basis: 'application' };
  return { ...state, submittedRequest: buildScenarioObservationRequest(state), observationSaved: true };
}
test('scenario cleanup removes answer and frozen payload while preserving independently authored handoff and judgment', () => {
  const privacy = guard(), state = scenarioState(); privacy.confirm(marker);
  const result = scrubScenarioAnswer(state, privacy.value);
  assert.equal(result.answer, ''); assert.equal(result.submittedRequest, null); assert.equal(result.observationSaved, true);
  assert.equal(result.scenario, state.scenario); assert.equal(result.applicability, state.applicability); assert.equal(result.confidence, state.confidence); assert.equal(result.outcome, state.outcome);
  assert.equal(JSON.stringify(result).includes(parent.answer), false);
  const draft = buildScenarioApplicationDraft(result.clearedHandoff!); assert.equal(draft.context, state.scenario); assert.equal(draft.content, state.applicability);
  assert.equal(scrubScenarioAnswer(result, privacy.value), result, 'a fully scrubbed state is stable');
});
test('late scenario save success or failure cannot reinstall original payload or undo saved fact after a prior cleanup', () => {
  const privacy = guard(), state = scenarioState(); privacy.confirm(marker); const cleaned = scrubScenarioAnswer(state, privacy.value);
  for (const accepted of [true, false]) {
    const late = scrubScenarioAnswer({ ...cleaned, submittedRequest: state.submittedRequest, observationSaved: accepted, saveError: accepted ? null : 'old error' }, privacy.value);
    assert.equal(late.submittedRequest, null); assert.equal(late.answer, ''); assert.equal(late.observationSaved, true); assert.equal(late.saveError, null);
    assert.equal(JSON.stringify(late).includes(parent.answer), false); assert.deepEqual(late.clearedHandoff, cleaned.clearedHandoff);
  }
});
