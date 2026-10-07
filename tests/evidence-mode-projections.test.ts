import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AnchorEvent, Observation, ObservationEvidenceMode, ConceptHistory } from '../src/shared/types.js';
import { buildLearningProgress } from '../src/core/learning-progress.js';
import { summarizeLearning } from '../src/core/learning-evidence.js';
import { buildTimeRecallSummary, selectTimeRecall } from '../src/core/time-recall.js';
import { buildLearningOverview, overviewNeedsScenarioCheck, selectLearningOverviewItems } from '../src/core/learning-overview.js';
import { ConceptHistoryPanel, HistoryObservationAnswer } from '../src/web/ConceptHistoryPanel.js';
import { LearningProgressPanel } from '../src/web/LearningProgressPanel.js';
import { LearningOverviewDialog } from '../src/web/LearningOverviewDialog.js';

const AS_OF = '2026-10-07T00:00:00Z';
const anchor: AnchorEvent = { eventId: 'anchor', conceptId: 'synthetic', sourceRevision: 'v1', kind: 'review', occurredAt: '2026-10-01T00:00:00Z', recordedAt: '2026-10-01T00:00:00Z' };
function event(evidenceMode?: ObservationEvidenceMode, overrides: Partial<Observation> = {}): Observation {
  return { eventId: 'event', conceptId: 'synthetic', sourceRevision: 'v1', observedAt: '2026-10-02T00:00:00Z', recordedAt: '2026-10-02T00:00:00Z', configRevision: 1, halfLifeDays: 1, anchorEventId: 'anchor', elapsedDays: 1, decay: 0.5, answer: 'PRIVATE_ANSWER', rating: 'clear', exposure: 'unexposed', observedExposure: false,
    learning: { task: 'concept', cue: 'independent', outcome: 'success', basis: 'self-check', confidence: 100, confidenceAt: '2026-10-01T23:59:00Z' }, ...(evidenceMode ? { evidenceMode } : {}), ...overrides };
}
function progress(first?: ObservationEvidenceMode, second?: ObservationEvidenceMode) {
  return buildLearningProgress({ conceptId: 'synthetic', sourceRevision: 'v1', asOf: AS_OF, observations: [event(first, { eventId: 'first' }), event(second, { eventId: 'second', observedAt: '2026-10-03T00:00:00Z', recordedAt: '2026-10-03T00:00:00Z' })] });
}
function overview(observations: Observation[]) {
  return buildLearningOverview({ sourceId: 'fixture', asOf: AS_OF, concepts: [{ id: 'synthetic', title: 'Fixture', aliases: [], domain: 'test', summary: '', body: '', source: { path: 'Test/fixture.md', revision: 'v1' } }], states: {}, observations, anchors: [anchor], applications: [] });
}

test('legacy missing modes remain missing and retain condition compatibility', () => {
  const result = progress();
  assert.equal(result.tasks.concept.conditions, 'same');
  assert.equal(Object.hasOwn(result.tasks.concept.latest!, 'evidenceMode'), false);
  assert.equal(summarizeLearning([event()]).calibration.concept.count, 1);
  assert.equal(summarizeLearning([event('written')]).calibration.concept.count, 1);
});

test('explicit answer media differ; a missing medium prevents same-condition comparison', () => {
  assert.equal(progress('mental', 'written').tasks.concept.conditions, 'different');
  assert.equal(progress('written', 'mental').tasks.concept.conditions, 'different');
  assert.equal(progress(undefined, 'written').tasks.concept.conditions, 'unknown');
  assert.equal(progress('mental', undefined).tasks.concept.conditions, 'unknown');
  assert.equal(progress('mental', 'mental').tasks.concept.conditions, 'same');
});

test('mental reports cannot become independent success or calibration through asserted metadata', () => {
  const mental = event('mental');
  const scenario = event('mental', { eventId: 'scenario', learning: { ...mental.learning!, task: 'scenario', basis: 'application' } });
  const summary = summarizeLearning([mental, scenario]);
  assert.equal(summary.calibration.concept.count, 0);
  assert.equal(summary.calibration.scenario.count, 0);
  assert.equal(summary.scenario.total, 1);
  assert.equal(summary.scenario.independentSuccess, 0);
});

test('mental time evidence stays unknown and metadata-only; legacy stays unexposed', () => {
  const mental = buildTimeRecallSummary([event('mental')], [anchor], AS_OF);
  assert.equal(mental.buckets[0].condition, 'unknown');
  assert.equal(mental.buckets[0].latest.evidenceMode, 'mental');
  assert.equal(mental.buckets[0].ratings.clear, 1);
  assert.doesNotMatch(JSON.stringify(mental), /PRIVATE_ANSWER/);
  const legacy = buildTimeRecallSummary([event()], [anchor], AS_OF);
  assert.equal(legacy.buckets[0].condition, 'unexposed');
  assert.equal(Object.hasOwn(legacy.buckets[0].latest, 'evidenceMode'), false);
  const items = overview([event('mental')]).items;
  assert.equal(selectTimeRecall(items, { anchorKind: 'review', condition: 'unexposed', focus: 'all' }).sampleCount, 0);
  assert.equal(selectTimeRecall(items, { anchorKind: 'review', condition: 'unknown', focus: 'all' }).rows[0].evidence.evidenceMode, 'mental');
});

test('history mental reports do not render an original answer button or pretend to be blank answers', () => {
  for (const answer of ['', 'PRIVATE_ANSWER']) {
    const observation = event('mental', { answer });
    const html = renderToStaticMarkup(createElement(HistoryObservationAnswer, { event: observation, onRevealAnswer() {} }));
    assert.match(html, /脑中回忆，未记录原答/);
    assert.doesNotMatch(html, /展开原始回答|空白回答|PRIVATE_ANSWER|<button/);
  }
  const observation = event('mental', { answer: '' });
  const history: ConceptHistory = { sourceId: 'fixture', conceptId: 'synthetic', sourceRevision: 'v1', asOf: AS_OF, state: { conceptId: 'synthetic', status: 'unknown', decay: null, elapsedDays: null, anchor: null, reason: null, asOf: AS_OF }, entries: [{ type: 'observation', event: observation }], total: 1, nextCursor: null };
  const html = renderToStaticMarkup(createElement(ConceptHistoryPanel, { history, loading: false, loadingMore: false, error: null, onRetry() {}, onLoadMore() {}, onRevealAnswer() {}, pendingCount: 0, simulated: false }));
  assert.match(html, /脑中自报/);
  assert.doesNotMatch(html, /展开原始回答|空白回答/);
});

test('progress and overview propagate media and label mental self-reports accurately', () => {
  const result = overview([event('mental')]);
  assert.equal(result.items[0].recall.latest?.evidenceMode, 'mental');
  assert.equal(result.items[0].recall.clear, 1);
  assert.equal(result.items[0].calibration.concept.count, 0);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_ANSWER/);
  const progressHtml = renderToStaticMarkup(createElement(LearningProgressPanel, { progress: progress('mental', 'written') }));
  assert.match(progressHtml, /脑中自报/);
  assert.match(progressHtml, /书面回答/);
  const overviewHtml = renderToStaticMarkup(createElement(LearningOverviewDialog, { overview: result, loading: false, error: null, initialDomainId: '', pendingCount: 0, onRefresh() {}, onClose() {}, onSelect() {} }));
  assert.match(overviewHtml, /清晰 · 脑中自报/);
  assert.match(overviewHtml, /未记录原答/);
  const legacy = overview([event()]);
  assert.equal(Object.hasOwn(legacy.items[0].recall.latest!, 'evidenceMode'), false);
  const legacyHtml = renderToStaticMarkup(createElement(LearningOverviewDialog, { overview: legacy, loading: false, error: null, initialDomainId: '', pendingCount: 0, onRefresh() {}, onClose() {}, onSelect() {} }));
  assert.match(legacyHtml, /作答方式未记录/);
  assert.doesNotMatch(legacyHtml, /书面回答/);
});


test('mental scenario success remains in the needs-check filter rather than becoming verified success', () => {
  const observation = event('mental');
  const result = overview([event('mental', { learning: { ...observation.learning!, task: 'scenario', basis: 'application' } })]);
  const item = result.items[0];
  assert.equal(item.scenario.latest?.evidenceMode, 'mental');
  assert.equal(item.scenario.latest?.outcome, 'success');
  assert.equal(item.scenario.independentSuccess, 0);
  assert.equal(overviewNeedsScenarioCheck(item), true);
  assert.deepEqual(selectLearningOverviewItems(result.items, { filter: 'scenario' }).map((item) => item.conceptId), ['synthetic']);
});

test('known assistance remains assisted for mental reports; claimed independence stays unknown', () => {
  const base = event('mental');
  for (const observation of [
    event('mental', { exposure: 'exposed' }),
    event('mental', { observedExposure: true }),
    event('mental', { learning: { ...base.learning!, cue: 'lookup' } }),
    event('mental', { learning: { ...base.learning!, cue: 'hinted' } }),
  ]) {
    const summary = buildTimeRecallSummary([observation], [anchor], AS_OF);
    assert.equal(summary.buckets[0].condition, 'assisted');
    assert.equal(summary.buckets[0].latest.evidenceMode, 'mental');
  }
  assert.equal(buildTimeRecallSummary([base], [anchor], AS_OF).buckets[0].condition, 'unknown');
});
