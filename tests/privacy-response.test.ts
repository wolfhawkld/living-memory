import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Observation, ConceptHistory } from '../src/shared/types';
import type { PrivacyObservation } from '../src/shared/answer-clearing';
import type { ObservationRevisionHistory } from '../src/shared/observation-revision-history';
import { applyAnswerClearing } from '../src/core/answer-clearing';
import { validateConceptHistoryPrivacy, validateRevisionHistoryPrivacy, validateLearningOverviewPrivacy, PrivacyResponseError } from '../src/web/privacy-response';
import { createConceptHistoryLoader } from '../src/web/concept-history-loader';
import { createObservationRevisionHistoryLoader } from '../src/web/observation-revision-history-loader';
import { HistoryObservationAnswer, ConceptHistoryPanel } from '../src/web/ConceptHistoryPanel';
import { ObservationRevisionDialog, initialRevisionDraft, revisionDraftDisabledReason, freezeRevisionDraft, revisionOriginalForDisplay } from '../src/web/ObservationRevisionDialog';
import { LearningSummaryPanel } from '../src/web/LearningSummaryPanel';

const AS_OF = '2026-10-02T00:00:00.000Z';
const CLEAR_AT = '2026-10-03T00:00:00.000Z';
const parent: Observation = { eventId: 'parent', conceptId: 'concept-a', sourceRevision: 'rev-a',
  observedAt: '2026-10-01T00:00:00.000Z', recordedAt: '2026-10-01T00:00:01.000Z',
  answer: 'SYNTHETIC_PRIVATE_ORIGINAL', configRevision: 1, halfLifeDays: 7,
  anchorEventId: null, elapsedDays: null, decay: null, rating: 'clear', exposure: 'unexposed', observedExposure: false };
const cleared = applyAnswerClearing(parent, { observationEventId: parent.eventId, clearedAt: CLEAR_AT });
const scope = { sourceId: 'synthetic-source', conceptId: parent.conceptId, sourceRevision: parent.sourceRevision, learningProtocolVersion: 3 as const };
const version = (digit: string) => digit.repeat(64);
function history(observation: PrivacyObservation = parent, fields: Partial<ConceptHistory<PrivacyObservation>> = {}): ConceptHistory<PrivacyObservation> {
  return { sourceId: scope.sourceId, conceptId: scope.conceptId, sourceRevision: scope.sourceRevision, asOf: AS_OF,
    state: { conceptId: parent.conceptId, status: 'unknown', decay: null, elapsedDays: null, anchor: null, reason: null, asOf: AS_OF },
    entries: [{ type: 'observation', event: observation }], total: 1, nextCursor: null,
    observationAssessmentVersion: version(observation.answer === null ? 'b' : 'a'),
    observationPrivacy: { cleared: observation.answer === null ? 1 : 0, excludedFromPerformance: observation.answer === null ? 1 : 0 }, ...fields };
}
function revisionHistory(observation: PrivacyObservation = parent, fields: Partial<ObservationRevisionHistory<PrivacyObservation>> = {}): ObservationRevisionHistory<PrivacyObservation> {
  return { observation, state: { status: 'active', currentAssessment: { rating: 'clear', learning: null },
    latestRevisionEventId: null, appliedRevisionCount: 0 }, events: [], total: 0, nextCursor: null, observationRevisionCount: 0, ...fields };
}
function invalid(action: () => unknown) {
  assert.throws(action, error => error instanceof PrivacyResponseError
    && error.code === 'LEARNING_PRIVACY_RESPONSE_INVALID' && !error.message.includes(parent.answer));
}
function firstObservation(page: ConceptHistory<PrivacyObservation> | null | undefined): PrivacyObservation {
  const entry = page?.entries[0];
  assert.ok(entry?.type === 'observation');
  return entry.event;
}

test('protocol2 rejects null or every own clearing marker without tightening legacy observation fields', () => {
  const legacy = { ...history(), entries: [{ type: 'observation', event: { answer: 'legacy text', preservedLegacyField: true } }] };
  assert.equal(validateConceptHistoryPrivacy(legacy, 2), legacy);
  assert.equal(validateRevisionHistoryPrivacy({ observation: legacy.entries[0].event }, 2).observation, legacy.entries[0].event);
  for (const observation of [cleared, { ...parent, answerClearing: undefined }, { ...parent, answer: null }]) {
    invalid(() => validateConceptHistoryPrivacy(history(observation as PrivacyObservation), 2));
    invalid(() => validateRevisionHistoryPrivacy(revisionHistory(observation as PrivacyObservation), 2));
  }
  const hidden = { ...parent };
  Object.defineProperty(hidden, 'answerClearing', { value: undefined, enumerable: false });
  invalid(() => validateRevisionHistoryPrivacy({ observation: hidden }, 2));
});

test('protocol3 preserves a valid current marker after historical asOf and rejects inconsistent or fabricated privacy states', () => {
  const page = history(cleared), revision = revisionHistory(cleared);
  const before = JSON.stringify([page, revision]);
  assert.equal(validateConceptHistoryPrivacy(page, 3), page);
  assert.equal(validateRevisionHistoryPrivacy(revision, 3), revision);
  assert.equal(firstObservation(page).answer, null);
  assert.equal(JSON.stringify([page, revision]), before);
  for (const observation of [
    { ...parent, answer: null }, { ...parent, answerClearing: cleared.answerClearing },
    { ...cleared, answerClearing: { ...cleared.answerClearing, observationEventId: 'different-parent' } },
    { ...cleared, answerClearing: { ...cleared.answerClearing, clearedAt: '2026-09-30T00:00:00.000Z' } },
    { ...cleared, evidenceMode: 'mental' },
    { ...cleared, answerClearing: { ...cleared.answerClearing, answerHash: 'forbidden' } },
  ]) {
    invalid(() => validateConceptHistoryPrivacy(history(observation as PrivacyObservation), 3));
    invalid(() => validateRevisionHistoryPrivacy(revisionHistory(observation as PrivacyObservation), 3));
  }
});

test('protocol3 requires a valid assessment watermark and scope counts while protocol2 remains compatible without them', () => {
  for (const fields of [
    { observationAssessmentVersion: undefined }, { observationAssessmentVersion: 'short' },
    { observationPrivacy: undefined }, { observationPrivacy: { cleared: -1, excludedFromPerformance: 0 } },
    { observationPrivacy: { cleared: 1, excludedFromPerformance: 2 } },
    { observationPrivacy: { cleared: 1.5, excludedFromPerformance: 1 } },
  ]) invalid(() => validateConceptHistoryPrivacy({ ...history(cleared), ...fields }, 3));
  const old = { ...history(), observationAssessmentVersion: undefined, observationPrivacy: undefined };
  assert.equal(validateConceptHistoryPrivacy(old, 2), old);
  const overview = { observationPrivacy: { cleared: 3, excludedFromPerformance: 1 }, items: [
    { observationPrivacy: { cleared: 2, excludedFromPerformance: 0 } },
    { observationPrivacy: { cleared: 1, excludedFromPerformance: 1 } },
  ] };
  assert.equal(validateLearningOverviewPrivacy(overview, 3), overview);
  invalid(() => validateLearningOverviewPrivacy({ ...overview, observationPrivacy: undefined }, 3));
  invalid(() => validateLearningOverviewPrivacy({ ...overview, items: [{}] }, 3));
  assert.equal(validateLearningOverviewPrivacy({}, 2).observationPrivacy, undefined);
});

test('concept refresh replaces immutable original text with clearing and never accepts a later rollback or changed first marker', async () => {
  let page = history();
  const loader = createConceptHistoryLoader(scope, async () => page);
  await loader.refresh();
  assert.equal(firstObservation(loader.getSnapshot().history).answer, parent.answer);
  page = history(cleared, { observationAssessmentVersion: history().observationAssessmentVersion });
  await loader.refresh();
  assert.equal(firstObservation(loader.getSnapshot().history).answer, null, 'privacy state changes invalidate immutable-entry reuse even if a broken server repeats its version');
  for (const next of [history(), history({ ...cleared, answerClearing: { ...cleared.answerClearing, clearedAt: '2026-10-04T00:00:00.000Z' } })]) {
    page = next;
    await loader.refresh();
    assert.equal(loader.getSnapshot().history, null);
    assert.match(loader.getSnapshot().error ?? '', /隐私状态无效/);
  }
});

test('concept paging restarts at changed privacy watermarks and invalid or failed reads hide prior text', async () => {
  const calls: Array<string | undefined> = [];
  const loader = createConceptHistoryLoader(scope, async (_id, _source, options) => {
    calls.push(options.cursor);
    return calls.length === 1 ? history(parent, { total: 2, nextCursor: 'next' }) : history(cleared, { total: 2 });
  });
  await loader.refresh(); await loader.loadMore();
  assert.deepEqual(calls, [undefined, 'next', undefined]);
  assert.equal(firstObservation(loader.getSnapshot().history).answer, null);
  for (const failure of ['invalid', 'offline'] as const) {
    let fail = false;
    const unsafe = createConceptHistoryLoader(scope, async () => {
      if (!fail) return history();
      if (failure === 'offline') throw new Error('Synthetic offline');
      return { ...history(), observationAssessmentVersion: undefined };
    });
    await unsafe.refresh(); fail = true; await unsafe.refresh();
    assert.equal(unsafe.getSnapshot().history, null);
    assert.ok(unsafe.getSnapshot().error);
  }
});

test('revision reads use newly cleared parents, restart paging and cannot revive an original or replace a first marker', async () => {
  let response = revisionHistory();
  const loader = createObservationRevisionHistoryLoader(parent, async () => response, 3);
  await loader.refresh();
  response = revisionHistory(cleared); await loader.refresh();
  assert.equal(loader.getSnapshot().history?.observation.answer, null);
  response = revisionHistory(); await loader.refresh();
  assert.equal(loader.getSnapshot().history, null);
  assert.match(loader.getSnapshot().error ?? '', /隐私状态无效/);
  const known = createObservationRevisionHistoryLoader(cleared, async () => revisionHistory({ ...cleared,
    answerClearing: { ...cleared.answerClearing, clearedAt: '2026-10-04T00:00:00.000Z' } }), 3);
  assert.equal(await known.refresh(), null);
  assert.equal(known.getSnapshot().history, null);
  let calls = 0;
  const paging = createObservationRevisionHistoryLoader(parent, async () => ++calls === 1
    ? revisionHistory(parent, { total: 2, nextCursor: 'next' }) : revisionHistory(cleared, { total: 2 }), 3);
  await paging.refresh(); await paging.loadMore();
  assert.equal(calls, 3);
  assert.equal(paging.getSnapshot().history?.observation.answer, null);
  let invalidResponse = false;
  const invalidLoader = createObservationRevisionHistoryLoader(parent, async () => invalidResponse
    ? { ...revisionHistory(), observation: { ...parent, answer: null } as PrivacyObservation } : revisionHistory(), 3);
  await invalidLoader.refresh(); invalidResponse = true;
  assert.equal(await invalidLoader.refresh(), null);
  assert.equal(invalidLoader.getSnapshot().history, null);
});

test('cleared history and revision SSR distinguish intentional removal from blank or mental answers', () => {
  const answerHtml = renderToStaticMarkup(createElement(HistoryObservationAnswer, { event: cleared, onRevealAnswer() {} }));
  assert.match(answerHtml, /原答已清除/);
  assert.doesNotMatch(answerHtml, /空白回答|展开原始回答|脑中回忆|SYNTHETIC_PRIVATE_ORIGINAL/);
  const panelHtml = renderToStaticMarkup(createElement(ConceptHistoryPanel, { history: history(cleared), loading: false,
    loadingMore: false, error: null, onRetry() {}, onLoadMore() {}, onRevealAnswer() {}, pendingCount: 0, simulated: false }));
  assert.match(panelHtml, /当前概念 · 全部资料版本/);
  assert.match(panelHtml, /其中采用中的 1 条不进入当前表现统计/);
  const dialogProps = { scopeKey: 'scope', observation: cleared, learningProtocolVersion: 3 as const, disabledReason: null,
    loadHistory: async () => revisionHistory(cleared), onSubmit: async () => ({ status: 'context-changed' as const }),
    onRetryPending: async () => ({ status: 'context-changed' as const }), onRecheckRejected: async () => false, onRevealAnswer() {}, onClose() {} };
  const dialogHtml = renderToStaticMarkup(createElement(ObservationRevisionDialog, dialogProps));
  assert.match(dialogHtml, /原答已清除/);
  assert.doesNotMatch(dialogHtml, /空白回答|展开原始回答|SYNTHETIC_PRIVATE_ORIGINAL/);
  const unverifiedHtml = renderToStaticMarkup(createElement(ObservationRevisionDialog, { ...dialogProps, observation: parent }));
  assert.match(unverifiedHtml, /原答隐私状态尚未核验/);
  assert.doesNotMatch(unverifiedHtml, /展开原始回答|SYNTHETIC_PRIVATE_ORIGINAL/);
});

test('freshly cleared revision history blocks new original-recheck drafts while preserving other explicit reasons', () => {
  const h = revisionHistory(cleared), draft = initialRevisionDraft(h);
  draft.reason = 'rechecked-original'; draft.action = 'withdraw';
  assert.match(revisionDraftDisabledReason(parent, h, draft, AS_OF)!, /原答已清除/);
  assert.throws(() => freezeRevisionDraft(parent, h, draft, 'new-recheck', AS_OF), /原答已清除/);
  draft.reason = 'other';
  assert.equal(freezeRevisionDraft(cleared, h, draft, 'withdraw-with-other-basis', AS_OF).reason, 'other');
});

test('an invalid protocol2 privacy response removes the old dialog original fallback while ordinary initial v2 disclosure remains', async () => {
  assert.equal(revisionOriginalForDisplay(parent, null, 2, null), parent);
  let response = revisionHistory();
  const loader = createObservationRevisionHistoryLoader(parent, async () => response, 2);
  await loader.refresh();
  assert.equal(revisionOriginalForDisplay(parent, loader.getSnapshot().history, 2, loader.getSnapshot().error)?.answer, parent.answer);
  response = revisionHistory(cleared);
  await loader.refresh();
  const state = loader.getSnapshot();
  assert.equal(state.history, null);
  assert.match(state.error ?? '', /隐私状态无效/);
  assert.equal(revisionOriginalForDisplay(parent, state.history, 2, state.error), null);
  assert.equal(revisionOriginalForDisplay(cleared, state.history, 2, state.error)?.answer, null,
    'a known cleared prop can still show its content-free removal label');
});

test('protocol2 retry waiting after an invalid privacy response cannot redisplay an already-revealed old original', async () => {
  let resolveRetry!: (value: ObservationRevisionHistory<PrivacyObservation>) => void;
  const retryResponse = new Promise<ObservationRevisionHistory<PrivacyObservation>>(resolve => { resolveRetry = resolve; });
  let calls = 0;
  const loader = createObservationRevisionHistoryLoader(parent, async () => {
    calls++;
    if (calls === 1) return revisionHistory();
    if (calls === 2) return revisionHistory(cleared);
    return retryResponse;
  }, 2);
  const display = () => {
    const state = loader.getSnapshot();
    return revisionOriginalForDisplay(parent, state.history, 2, state.error, state.loading);
  };
  await loader.refresh();
  assert.equal(display()?.answer, parent.answer, 'the original could already have been revealed before the invalid response');
  await loader.refresh();
  assert.equal(display(), null);
  const retry = loader.refresh();
  const waiting = loader.getSnapshot();
  assert.equal(waiting.loading, true);
  assert.equal(waiting.error, null);
  assert.equal(waiting.history, null);
  assert.equal(display(), null, 'clearing the error for a pending retry cannot authorize the old parent fallback');
  assert.equal(revisionOriginalForDisplay(cleared, waiting.history, 2, waiting.error, waiting.loading)?.answer, null,
    'an already-cleared prop may still show its content-free label while waiting');
  resolveRetry(revisionHistory());
  await retry;
  assert.equal(loader.getSnapshot().loading, false);
  assert.equal(display()?.answer, parent.answer, 'only a new valid response permits displaying the original again');
});

test('learning summary explains privacy scope separately from assessment adoption and practice consumption', () => {
  const html = renderToStaticMarkup(createElement(LearningSummaryPanel, { observationPrivacy: { cleared: 3, excludedFromPerformance: 1 },
    summary: { scenario: { total: 0, independentSuccess: 0, assisted: 0, partial: 0, failure: 0, unverified: 0 },
      calibration: { concept: { count: 0, meanConfidence: null, successRate: null, gap: null, brier: null },
        scenario: { count: 0, meanConfidence: null, successRate: null, gap: null, brier: null } } } }));
  assert.match(html, /当前概念全部资料版本中，已清除原答 3 条/);
  assert.match(html, /采用中的 1 条/);
  assert.match(html, /评分采用与复习消耗分别保留/);
});
