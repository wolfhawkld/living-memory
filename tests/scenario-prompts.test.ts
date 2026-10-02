import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildScenarioPromptPage } from '../src/core/scenario-prompts.js';
import type { Observation } from '../src/shared/types.js';

function observation(
  eventId: string,
  conceptId: string,
  observedAt: string,
  recordedAt: string,
  learning: Observation['learning'] | null = {
    task: 'scenario',
    scenario: `场景 ${eventId}`,
    confidence: null,
    confidenceAt: null,
    cue: 'unknown',
    outcome: 'unverified',
    basis: 'unknown',
  },
): Observation {
  return {
    eventId,
    conceptId,
    sourceRevision: 'sha256:revision',
    observedAt,
    recordedAt,
    configRevision: 1,
    halfLifeDays: 7,
    anchorEventId: null,
    elapsedDays: null,
    decay: null,
    answer: 'private answer must not be returned',
    rating: 'blank',
    exposure: 'unexposed',
    observedExposure: false,
    ...(learning ? { learning } : {}),
  };
}

test('scenario prompt selection filters to current concepts and orders by observed, recorded, then event ID', () => {
  const observations = [
    observation('same-z', 'alpha', '2026-01-02T00:00:00.000Z', '2026-01-02T03:00:00.000Z'),
    observation('same-a', 'alpha', '2026-01-02T00:00:00.000Z', '2026-01-02T03:00:00.000Z'),
    observation('newer-recorded', 'alpha', '2026-01-01T00:00:00.000Z', '2026-01-03T00:00:00.000Z'),
    observation('old-revision', 'alpha', '2025-12-01T00:00:00.000Z', '2025-12-01T00:01:00.000Z', {
      task: 'scenario', scenario: '旧资料版本场景', confidence: null, confidenceAt: null,
      cue: 'unknown', outcome: 'unverified', basis: 'unknown', scenarioRevisit: true,
    }),
    observation('other-concept', 'beta', '2026-01-04T00:00:00.000Z', '2026-01-04T00:00:00.000Z'),
    observation('concept-only', 'alpha', '2026-01-05T00:00:00.000Z', '2026-01-05T00:00:00.000Z', null),
  ];
  const first = buildScenarioPromptPage(observations, new Set(['alpha']), 2);
  assert.equal(first.total, 4);
  assert.deepEqual(first.items.map((item) => item.eventId), ['same-z', 'same-a']);
  assert.deepEqual(Object.keys(first.items[0]).sort(), ['eventId', 'observedAt', 'scenario']);
  assert.ok(first.hasMore);
  assert.deepEqual(first.last, {
    observedAt: '2026-01-02T00:00:00.000Z',
    recordedAt: '2026-01-02T03:00:00.000Z',
    eventId: 'same-a',
  });

  const second = buildScenarioPromptPage(observations, new Set(['alpha']), 2, first.last!);
  assert.deepEqual(second.items.map((item) => item.eventId), ['newer-recorded', 'old-revision']);
  assert.equal(second.hasMore, false);
  assert.equal(second.last?.eventId, 'old-revision');
});

test('scenario prompt selection never includes concept answers or non-scenario observations', () => {
  const result = buildScenarioPromptPage([
    observation('concept-task', 'alpha', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', {
      task: 'concept', confidence: null, confidenceAt: null, cue: 'unknown', outcome: 'unverified', basis: 'unknown',
    }),
    observation('missing-evidence', 'alpha', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', null),
  ], new Set(['alpha']), 20);
  assert.deepEqual(result, { items: [], total: 0, hasMore: false, last: null });
});
