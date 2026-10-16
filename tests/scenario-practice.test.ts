import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Snapshot } from '../src/shared/types.ts';
import {
  buildScenarioObservationRequest,
  createScenarioPracticeState,
  freezeScenarioSnapshot,
  hasUnsavedScenarioDraft,
  ScenarioPractice,
  selectScenarioConcept,
  independentQueryBlockedReason,
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

function feedbackState(sourceSnapshot: Snapshot = snapshot): ReturnType<typeof createScenarioPracticeState> {
  let state = createScenarioPracticeState(sourceSnapshot, { [concept.id]: true });
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

test('a saved prompt seeds only the scenario and marks a same-scenario revisit', () => {
  const state = createScenarioPracticeState(snapshot, { [concept.id]: true }, '已保存的合成工作场景', true);
  assert.equal(state.stage, 'setup');
  assert.equal(state.scenario, '已保存的合成工作场景');
  assert.equal(state.scenarioRevisit, true);
  assert.equal(state.confidence, null);
  assert.equal(state.answer, '');
  assert.equal(state.conceptId, null);
  assert.equal(state.applicability, '');

  let feedback = startScenarioPractice(state, '2026-09-22T10:00:00.000Z');
  feedback = submitScenarioAnswer(feedback, '2026-09-22T10:01:00.000Z', 'scenario-revisit-1');
  feedback = {
    ...feedback,
    conceptId: concept.id,
    answer: '重新写下的回答',
    applicability: '重新核对的适用性',
    cue: 'independent',
    outcome: 'partial',
    basis: 'self-check',
  };
  const request = buildScenarioObservationRequest(feedback);
  assert.equal(request.learning?.scenarioRevisit, true);
  assert.equal(request.eventId, 'scenario-revisit-1');
  assert.equal(request.answer, '重新写下的回答');
  assert.equal(request.learning?.scenario, '已保存的合成工作场景');
});

test('a failed frozen request remains a discardable draft until it is retained', () => {
  const state = feedbackState();
  const request = buildScenarioObservationRequest(state);
  const failed = { ...state, submittedRequest: request, observationSaved: false };
  const retained = { ...failed, observationSaved: true };
  assert.equal(hasUnsavedScenarioDraft(failed), true);
  assert.equal(hasUnsavedScenarioDraft(retained), false);
});

test('an anchor from an older source revision is not sent as the current observation anchor', () => {
  const oldRevisionSnapshot = structuredClone(snapshot);
  oldRevisionSnapshot.states[concept.id].anchor = {
    ...oldRevisionSnapshot.states[concept.id].anchor!,
    sourceRevision: 'revision-old',
  };
  const request = buildScenarioObservationRequest(feedbackState(oldRevisionSnapshot));
  assert.equal(request.anchorEventId, null);
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

test('a supplied revisit prompt stays in blind setup and does not expose concept material', () => {
  const html = renderToStaticMarkup(createElement(ScenarioPractice, {
    snapshot,
    sourceId: 'source:test',
    initialScenario: '已保存的业务场景提示',
    onLoadPrompts: async () => ({ sourceId: 'source:test', asOf: '2026-09-22T00:00:00.000Z', items: [], total: 0, nextCursor: null }),
    busy: false,
    onClose: () => undefined,
    onSave: async () => true,
    onReadSource: () => undefined,
    wasSourceViewed: () => false,
  }));

  assert.match(html, /回访已保存场景/);
  assert.match(html, /新场景/);
  assert.match(html, /已保存的业务场景提示/);
  assert.match(html, /同场景回访/);
  assert.doesNotMatch(html, /布尔逻辑/);
  assert.doesNotMatch(html, /用真值与逻辑联结词表达规则/);
  assert.doesNotMatch(html, /搜索概念、别名或领域/);
});

test('query reflection freezes name hints and never treats seeded problem text as scenario revisit', () => {
  const hints = [concept.id];
  const state = createScenarioPracticeState(snapshot, {}, '如何做规则校验？', true, { variant: 'query', nameHintedConceptIds: hints });
  hints.push('another');
  assert.equal(state.variant, 'query');
  assert.equal(state.scenarioRevisit, false);
  assert.deepEqual(state.nameHintedConceptIds, [concept.id]);
  assert.equal(Object.isFrozen(state.nameHintedConceptIds), true);
  assert.equal(state.cue, 'unknown');
  assert.equal(state.exposure, 'unknown');
});

function queryFeedback(options: { hints?: string[]; exposed?: boolean; answer?: string } = {}) {
  let state = createScenarioPracticeState(snapshot, { [concept.id]: Boolean(options.exposed) }, '如何做规则校验？', false,
    { variant: 'query', nameHintedConceptIds: options.hints });
  state = startScenarioPractice(state, '2026-09-22T10:00:00.000Z');
  state = { ...state, answer: options.answer ?? '用布尔逻辑表达约束，合取所有强校验条件。' };
  state = submitScenarioAnswer(state, '2026-09-22T10:01:00.000Z', 'query-1');
  return selectScenarioConcept(state, concept.id);
}

test('query name hint sets a prompted cue without inventing source exposure', () => {
  const state = queryFeedback({ hints: [concept.id] });
  assert.equal(state.cue, 'hinted');
  assert.equal(state.exposure, 'unknown');
  const request = buildScenarioObservationRequest(state);
  assert.equal(request.exposure, 'unknown');
  assert.equal(request.observedExposure, false);
  assert.equal(request.learning?.task, 'scenario');
  assert.equal(request.learning?.scenarioRevisit, undefined);
});

test('query independent claim is rejected by both validation and payload building for prior hints, source views and blank recall', () => {
  for (const state of [queryFeedback({ hints: [concept.id] }), queryFeedback({ exposed: true }), queryFeedback({ answer: '  ' }), { ...queryFeedback(), exposure: 'exposed' as const }]) {
    const unsafe = { ...state, cue: 'independent' as const };
    assert.match(validateScenarioPractice(unsafe) ?? '', /不能记录为独立想到/);
    assert.throws(() => buildScenarioObservationRequest(unsafe), /不能记录为独立想到/);
  }
  const confirmed = { ...queryFeedback(), cue: 'independent' as const };
  assert.equal(validateScenarioPractice(confirmed), null);
  assert.equal(buildScenarioObservationRequest(confirmed).learning?.cue, 'independent');
});

test('query prior source view forces exposure, while choosing another concept resets all judgments and preserves original answer time', () => {
  const previous = queryFeedback({ exposed: true });
  assert.equal(buildScenarioObservationRequest(previous).exposure, 'exposed');
  assert.equal(buildScenarioObservationRequest(previous).observedExposure, true);
  const second = { ...concept, id: 'ai:other', domain: 'AI', title: '另一个概念' };
  const state = { ...previous, snapshot: freezeScenarioSnapshot({ ...snapshot, concepts: [concept, second] }), cue: 'lookup' as const, outcome: 'success' as const, basis: 'application' as const, applicability: '旧判断' };
  const next = selectScenarioConcept(state, second.id);
  assert.equal(next.cue, 'unknown');
  assert.equal(next.outcome, 'unverified');
  assert.equal(next.basis, 'unknown');
  assert.equal(next.applicability, '');
  assert.equal(next.exposure, 'unknown');
  assert.equal(next.answer, state.answer);
  assert.equal(next.observedAt, state.observedAt);
  assert.equal(next.eventId, state.eventId);
  assert.equal(selectScenarioConcept({ ...next, submittedRequest: buildScenarioObservationRequest(next) }, concept.id).conceptId, second.id);
});

test('query setup offers blind problem input without candidate, summary or history prompt exposure', () => {
  const html = renderToStaticMarkup(createElement(ScenarioPractice, {
    snapshot, sourceId: 'test', busy: false, variant: 'query', initialScenario: '我的问题',
    nameHintedConceptIds: [concept.id], onClose: () => {}, onSave: async () => true,
    onReadSource: () => {}, wasSourceViewed: () => false,
    onLoadPrompts: async () => { throw new Error('must not load'); },
  }));
  assert.match(html, /查询前先想一下/);
  assert.match(html, /要解决的问题 \/ 场景/);
  assert.doesNotMatch(html, /回访已保存场景|scenario-concept-results|布尔逻辑|完整资料|用真值/);
});


test('query explains independent-option restrictions with blank answer and source exposure taking priority over name hints', () => {
  assert.match(independentQueryBlockedReason(queryFeedback({ answer: '', exposed: true, hints: [concept.id] })) ?? '', /原回答留空/);
  const alreadyRead = { ...queryFeedback({ exposed: true, hints: [concept.id] }), exposure: 'unexposed' as const };
  assert.match(independentQueryBlockedReason(alreadyRead) ?? '', /进入前已看过/);
  assert.match(independentQueryBlockedReason(queryFeedback({ hints: [concept.id] })) ?? '', /原页面已显示.*名称/);
  assert.equal(independentQueryBlockedReason(queryFeedback()), null);
});
