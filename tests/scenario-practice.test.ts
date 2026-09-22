import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Snapshot } from '../src/shared/types.ts';
import {
  buildScenarioObservationRequest,
  createScenarioPracticeState,
  freezeScenarioSnapshot,
  ScenarioPractice,
  startScenarioPractice,
  submitScenarioAnswer,
  validateScenarioPractice,
} from '../src/web/ScenarioPractice.tsx';

const concept = {
  id: 'math:boolean',
  title: '布尔逻辑',
  aliases: ['Boolean logic'],
  domain: 'Math',
  summary: '用真值与逻辑联结词表达规则。',
  body: '# 布尔逻辑\n完整资料',
  source: { path: 'Cognition/Math/Boolean.md', revision: 'revision-1' },
};
const originalConceptTitle = concept.title;

const snapshot: Snapshot = {
  concepts: [concept],
  links: [],
  source: { name: 'test', mode: 'local', conceptCount: 1, limit: 100, diagnostics: [] },
  config: { modelVersion: 'time-only-v0', halfLifeDays: 7, revision: 4 },
  states: {
    [concept.id]: {
      conceptId: concept.id,
      status: 'revisit',
      decay: .4,
      elapsedDays: 8,
      anchor: {
        eventId: 'anchor-1',
        conceptId: concept.id,
        sourceRevision: concept.source.revision,
        occurredAt: '2026-09-01T00:00:00.000Z',
        recordedAt: '2026-09-01T00:00:00.000Z',
        kind: 'review',
      },
      reason: null,
      asOf: '2026-09-22T00:00:00.000Z',
    },
  },
  asOf: '2026-09-22T00:00:00.000Z',
  observationsCount: 0,
};

function feedbackState(): ReturnType<typeof createScenarioPracticeState> {
  let state = createScenarioPracticeState(snapshot, { [concept.id]: true });
  state = { ...state, scenario: '为一个 orchestrator 设计强规则校验和上下文记忆。', confidence: 75 };
  state = startScenarioPractice(state, '2026-09-22T10:00:00.000Z');
  state = { ...state, answer: '我会先拆出规则与状态机。' };
  state = submitScenarioAnswer(state, '2026-09-22T10:01:00.000Z', 'scenario-1');
  return {
    ...state,
    conceptId: concept.id,
    applicability: '规则校验可以表达安全和范围条件，状态机负责流程迁移。',
    cue: 'independent',
    outcome: 'success',
    basis: 'application',
    exposure: 'unknown',
  };
}

test('a scenario snapshot is cloned and frozen at exercise start', () => {
  const frozen = freezeScenarioSnapshot(snapshot);
  assert.notEqual(frozen, snapshot);
  assert.notEqual(frozen.concepts, snapshot.concepts);
  assert.equal(Object.isFrozen(frozen), true);
  assert.equal(Object.isFrozen(frozen.concepts[0]), true);

  snapshot.concepts[0].title = 'changed after mount';
  assert.equal(frozen.concepts[0].title, '布尔逻辑');
  snapshot.concepts[0].title = originalConceptTitle;
});

test('scenario submission preserves blank recall and freezes timing, anchor and calibration evidence', () => {
  const state = feedbackState();
  const request = buildScenarioObservationRequest(state);

  assert.equal(request.eventId, 'scenario-1');
  assert.equal(request.observedAt, '2026-09-22T10:01:00.000Z');
  assert.equal(request.configRevision, 4);
  assert.equal(request.anchorEventId, 'anchor-1');
  assert.equal(request.rating, 'clear');
  assert.equal(request.exposure, 'exposed');
  assert.equal(request.observedExposure, true);
  assert.deepEqual(request.learning, {
    task: 'scenario',
    scenario: '为一个 orchestrator 设计强规则校验和上下文记忆。',
    confidence: 75,
    applicability: '规则校验可以表达安全和范围条件，状态机负责流程迁移。',
    confidenceAt: '2026-09-22T10:00:00.000Z',
    cue: 'independent',
    outcome: 'success',
    basis: 'application',
  });

  const blank = { ...feedbackState(), answer: '', outcome: 'failure' as const, basis: 'self-check' as const };
  assert.equal(buildScenarioObservationRequest(blank).answer, '');
  assert.equal(buildScenarioObservationRequest(blank).rating, 'blank');
});

test('known outcomes require an explicit basis and unverified outcomes remain available', () => {
  const missingBasis = { ...feedbackState(), basis: 'unknown' as const };
  assert.match(validateScenarioPractice(missingBasis) ?? '', /依据/);

  const unverified = { ...missingBasis, outcome: 'unverified' as const };
  assert.equal(validateScenarioPractice(unverified), null);
  assert.equal(buildScenarioObservationRequest(unverified).rating, 'blank');
});

test('the setup stage does not leak concept choices or source summaries before the answer is submitted', () => {
  const html = renderToStaticMarkup(createElement(ScenarioPractice, {
    snapshot,
    sourceId: 'source:test',
    busy: false,
    onClose: () => undefined,
    onSave: async () => true,
    onReadSource: () => undefined,
    wasSourceViewed: () => false,
  }));

  assert.match(html, /场景描述/);
  assert.match(html, /开始前的信心/);
  assert.doesNotMatch(html, /布尔逻辑/);
  assert.doesNotMatch(html, /用真值与逻辑联结词表达规则/);
  assert.doesNotMatch(html, /搜索概念、别名或领域/);
});
