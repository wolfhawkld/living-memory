import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { summarizeLearning } from '../src/core/learning-evidence.js';
import { LearningSummaryPanel } from '../src/web/LearningSummaryPanel.js';
import type { LearningEvidence, Observation } from '../src/shared/types.js';

function observation(evidence: Partial<LearningEvidence> = {}, fields: Partial<Observation> = {}): Observation {
  return { eventId: 'test', conceptId: 'test', sourceRevision: 'v1', observedAt: '2026-09-22T01:00:00Z',
    recordedAt: '2026-09-22T01:00:01Z', configRevision: 1, halfLifeDays: 7, anchorEventId: null,
    elapsedDays: null, decay: null, answer: 'answer', rating: 'clear', exposure: 'unexposed', observedExposure: false,
    learning: { task: 'scenario', scenario: 'scenario', confidence: 75, confidenceAt: '2026-09-22T00:59:00Z', cue: 'independent', outcome: 'success', basis: 'self-check', ...evidence }, ...fields };
}

test('calibration compares prospectively recorded confidence with explicit outcomes and separates tasks', () => {
  const summary = summarizeLearning([observation(), observation({ confidence: 25, outcome: 'failure' }), observation({ task: 'concept', confidence: 50 })]);
  assert.deepEqual(summary.calibration.scenario, { count: 2, meanConfidence: 50, successRate: 50, gap: 0, brier: .0625 });
  assert.deepEqual(summary.calibration.concept, { count: 1, meanConfidence: 50, successRate: 100, gap: -50, brier: .25 });
  assert.equal(summary.scenario.total, 2);
  assert.equal(summary.scenario.independentSuccess, 1);
  assert.equal(summary.scenario.failure, 1);
});

test('legacy, assisted, partial, unknown and retrospective confidence do not imply calibration evidence', () => {
  const excluded = [
    observation({}, { learning: undefined }), observation({ cue: 'hinted' }), observation({ cue: 'lookup' }),
    observation({ cue: 'unknown' }), observation({ outcome: 'partial' }), observation({ outcome: 'unverified' }),
    observation({ basis: 'unknown' }), observation({ confidence: null, confidenceAt: null }),
    observation({ confidenceAt: '2026-09-22T01:00:01Z' }), observation({ confidenceAt: 'invalid' }),
    observation({ confidence: NaN }), observation({ confidence: 101 }),
    observation({}, { exposure: 'unknown' }), observation({}, { exposure: 'exposed' }), observation({}, { observedExposure: true }),
  ];
  const result = summarizeLearning(excluded);
  assert.deepEqual(result.calibration.scenario, { count: 0, meanConfidence: null, successRate: null, gap: null, brier: null });
  assert.equal(result.scenario.total, excluded.length - 1);
  assert.equal(result.scenario.assisted, 4);
});

test('summary shows sample counts, keeps self-check limits and empty state visible', () => {
  const html = renderToStaticMarkup(createElement(LearningSummaryPanel, { summary: summarizeLearning([observation()]) }));
  assert.match(html, /1 次可比较记录/);
  assert.match(html, /75/);
  assert.match(html, /结果由你核对/);
  assert.match(html, /样本少时只作观察/);
  const empty = renderToStaticMarkup(createElement(LearningSummaryPanel, { summary: summarizeLearning([]) }));
  assert.match(empty, /等待事前信心/);
  assert.doesNotMatch(empty, /NaN|Infinity/);
});
