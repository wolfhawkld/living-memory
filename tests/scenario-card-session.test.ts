import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Concept } from '../src/shared/types.ts';
import type { PracticeAttemptRequest, PracticeCardEvent, PracticeCardView } from '../src/shared/practice.ts';
import {
  buildPracticeAttemptRequest,
  buildPracticeCardRequest,
  buildPracticeCardRevisionRequest,
  createPracticeCardDraft,
  createPracticeSaveCoordinator,
  createPracticeSessionState,
  revealPracticeReference,
  setPracticeCaseExposure,
  setPracticeConfidence,
  setPracticeScenarioRating,
  showPracticeScenarioHint,
  startPracticeSession,
  submitPracticeAnswer,
  validatePracticeCardDraft,
} from '../src/web/practice-session.ts';

const concepts: Concept[] = [1, 2, 3, 4].map((index) => ({
  id: `concept:${index}`,
  title: `概念 ${index}`,
  aliases: [],
  domain: 'Synthetic',
  summary: `摘要 ${index}`,
  body: `正文 ${index}`,
  source: { path: `Synthetic/${index}.md`, revision: `revision-${index}` },
}));

const scenarioCard: PracticeCardEvent = {
  eventId: 'scenario-card-v1',
  cardId: 'scenario-card',
  previousEventId: null,
  occurredAt: '2026-10-01T10:00:00.000Z',
  kind: 'scenario',
  title: '处理一个边界案例',
  prompt: '面对一个陌生边界案例时，你会怎样判断下一步？',
  referenceAnswer: '先拆出约束、证据和可逆的下一步，再选择处理路径。',
  referenceNotes: '这是手工维护的核对依据。',
  sources: [{ conceptId: concepts[0].id, sourceRevision: concepts[0].source.revision }],
  sourceChecked: true,
  paused: false,
  scenario: {
    caseFamily: '首次接手遗留系统',
    structureHint: '先按约束、证据、风险和可逆行动拆开。',
    nameHint: '这是一个分层诊断流程。',
  },
  recordedAt: '2026-10-01T10:00:01.000Z',
};

const scenarioView: PracticeCardView = {
  card: scenarioCard,
  status: 'ready',
  currentSources: [{ conceptId: concepts[0].id, title: concepts[0].title, sourceRevision: concepts[0].source.revision }],
  currentAttempts: 0,
  totalAttempts: 0,
  latest: null,
  scenarioHistory: { sameCardAttempts: 0, sameFamilyAttempts: 2 },
};

function completeScenarioAnswer(view: PracticeCardView = scenarioView) {
  let state = createPracticeSessionState(view, { [concepts[0].id]: false });
  state = setPracticeCaseExposure(state, 'unseen');
  state = setPracticeConfidence(state, 75);
  state = startPracticeSession(state, '2026-10-02T09:00:00.000Z');
  state = { ...state, answer: '先确认约束，再寻找可验证且可回退的处理方式。' };
  state = submitPracticeAnswer(state, '2026-10-02T09:01:00.000Z', 'scenario-attempt-1');
  return state;
}

test('scenario card drafts validate metadata, distinct sources, and revision preservation', () => {
  const draft = createPracticeCardDraft('scenario', {
    cardId: 'scenario-new',
    sources: [{ conceptId: concepts[0].id, sourceRevision: concepts[0].source.revision }],
    scenario: scenarioCard.scenario,
  });
  draft.title = scenarioCard.title;
  draft.prompt = scenarioCard.prompt;
  draft.referenceAnswer = scenarioCard.referenceAnswer;
  draft.referenceNotes = scenarioCard.referenceNotes;
  assert.match(validatePracticeCardDraft(draft, concepts) ?? '', /勾选/);
  draft.sourceChecked = true;
  assert.equal(validatePracticeCardDraft(draft, concepts), null);

  const request = buildPracticeCardRequest(draft, '2026-10-02T10:00:00.000Z', 'scenario-card-v2', concepts);
  assert.deepEqual(request.scenario, scenarioCard.scenario);
  assert.equal(request.sources.length, 1);

  const revision = buildPracticeCardRevisionRequest(scenarioCard, true, '2026-10-02T11:00:00.000Z', 'scenario-card-v3');
  assert.deepEqual(revision.scenario, scenarioCard.scenario);
  assert.equal(revision.paused, true);

  const duplicate = { ...draft, sources: [draft.sources[0], draft.sources[0]] };
  assert.match(validatePracticeCardDraft(duplicate, concepts) ?? '', /不同概念/);
  const tooLongFamily = { ...draft, scenario: { ...draft.scenario!, caseFamily: 'x'.repeat(161) } };
  assert.match(validatePracticeCardDraft(tooLongFamily, concepts) ?? '', /案例族名称/);
});

test('scenario session freezes each answer before hints, allows a skipped layer, and cannot rewind', () => {
  let state = completeScenarioAnswer();
  assert.equal(state.observedCaseExposure, true);
  assert.equal(state.caseExposure, 'seen');
  assert.equal(state.scenarioReferenceVisible, false);
  assert.deepEqual(state.scenarioStages.map((stage) => stage.stage), ['independent']);
  assert.equal(state.scenarioStages[0].hintShownAt, null);
  assert.equal(state.scenarioStages[0].answer, '先确认约束，再寻找可验证且可回退的处理方式。');

  const beforeHint = state;
  assert.strictEqual(showPracticeScenarioHint(state, 'structure', '2026-10-02T09:01:30.000Z').scenarioStages, beforeHint.scenarioStages);
  assert.strictEqual(showPracticeScenarioHint(state, 'structure', '2026-10-02T09:00:59.000Z'), beforeHint);
  state = showPracticeScenarioHint(state, 'structure', '2026-10-02T09:02:00.000Z');
  assert.equal(state.stage, 'answer');
  assert.equal(state.scenarioStages.length, 1);
  assert.equal(state.scenarioHintShownAt, '2026-10-02T09:02:00.000Z');

  state = { ...state, answer: '按约束、证据和风险逐层拆开。' };
  state = submitPracticeAnswer(state, '2026-10-02T09:03:00.000Z', 'ignored-second-event-id');
  assert.equal(state.stage, 'feedback');
  assert.equal(state.scenarioStages[1].hintShownAt, '2026-10-02T09:02:00.000Z');
  assert.equal(state.scenarioStages[1].answeredAt, '2026-10-02T09:03:00.000Z');
  assert.equal(state.submittedCore?.eventId, 'scenario-attempt-1');
  assert.equal(state.submittedCore?.answeredAt, '2026-10-02T09:01:00.000Z');

  state = showPracticeScenarioHint(state, 'name', '2026-10-02T09:04:00.000Z');
  state = { ...state, answer: '这是分层诊断流程。' };
  state = submitPracticeAnswer(state, '2026-10-02T09:05:00.000Z', 'ignored-third-event-id');
  assert.deepEqual(state.scenarioStages.map((stage) => stage.stage), ['independent', 'structure', 'name']);
  assert.equal(state.scenarioStages[2].hintShownAt, '2026-10-02T09:04:00.000Z');
  assert.equal(state.scenarioStages[0].answer, '先确认约束，再寻找可验证且可回退的处理方式。');

  // Once a later layer has been used, returning to structure or adding another name layer is rejected.
  assert.strictEqual(showPracticeScenarioHint(state, 'structure', '2026-10-02T09:06:00.000Z'), state);
  assert.strictEqual(showPracticeScenarioHint(state, 'name', '2026-10-02T09:06:00.000Z'), state);
});

test('direct name hint is a valid skipped structure path and ratings stay independent', () => {
  let state = completeScenarioAnswer();
  state = showPracticeScenarioHint(state, 'name', '2026-10-02T09:02:00.000Z');
  state = { ...state, answer: '提示后补充的候选解释。' };
  state = submitPracticeAnswer(state, '2026-10-02T09:03:00.000Z', 'ignored-second-event-id');
  assert.deepEqual(state.scenarioStages.map((stage) => stage.stage), ['independent', 'name']);

  state = setPracticeScenarioRating(state, 'independent', 'recallOutcome', 'failure');
  state = setPracticeScenarioRating(state, 'independent', 'applicabilityOutcome', 'partial');
  state = setPracticeScenarioRating(state, 'name', 'recallOutcome', 'success');
  assert.equal(state.scenarioStages[0].recallOutcome, 'failure');
  assert.equal(state.scenarioStages[0].applicabilityOutcome, 'partial');
  assert.equal(state.scenarioStages[1].recallOutcome, 'success');
  assert.equal(state.scenarioStages[1].applicabilityOutcome, 'unverified');
});

test('scenario request keeps first answer and time, reports hint cue, and freezes case exposure', () => {
  let state = completeScenarioAnswer();
  state = showPracticeScenarioHint(state, 'structure', '2026-10-02T09:02:00.000Z');
  state = { ...state, answer: '结构提示后的回答。' };
  state = submitPracticeAnswer(state, '2026-10-02T09:03:00.000Z', 'ignored-second-event-id');
  state = setPracticeScenarioRating(state, 'independent', 'recallOutcome', 'partial');
  state = setPracticeScenarioRating(state, 'structure', 'applicabilityOutcome', 'success');
  state = revealPracticeReference(state);
  state = { ...state, cue: 'independent', exposure: 'unexposed', checkNotes: '发生在结构提示阶段。' };

  const request = buildPracticeAttemptRequest(state);
  assert.equal(request.answer, '先确认约束，再寻找可验证且可回退的处理方式。');
  assert.equal(request.answeredAt, '2026-10-02T09:01:00.000Z');
  assert.equal(request.eventId, 'scenario-attempt-1');
  assert.equal(request.outcome, 'unverified');
  assert.equal(request.cue, 'hinted');
  assert.equal(request.scenario?.caseExposure, 'seen');
  assert.equal(request.scenario?.observedCaseExposure, true);
  assert.equal(request.scenario?.stages[0].recallOutcome, 'partial');
  assert.equal(request.scenario?.stages[0].applicabilityOutcome, 'unverified');
  assert.equal(request.scenario?.stages[1].applicabilityOutcome, 'success');
  assert.equal(request.checkNotes, '发生在结构提示阶段。');
  assert.equal(Object.isFrozen(request), true);
  assert.equal(Object.isFrozen(request.scenario), true);
  assert.equal(Object.isFrozen(request.scenario?.stages[0]), true);
});

test('source exposure is frozen at the first submit and old card payloads stay unchanged', () => {
  let state = createPracticeSessionState(scenarioView, { [concepts[0].id]: true });
  state = startPracticeSession(state, null);
  state = { ...state, answer: '先答后看。' };
  state = submitPracticeAnswer(state, '2026-10-02T09:01:00.000Z', 'scenario-exposed');
  state = revealPracticeReference(state);
  state = { ...state, exposure: 'unexposed' };
  const scenarioRequest = buildPracticeAttemptRequest(state);
  assert.equal(scenarioRequest.observedExposure, true);
  assert.equal(scenarioRequest.exposure, 'exposed');

  const legacy: PracticeCardEvent = {
    ...scenarioCard,
    kind: 'detail',
    scenario: undefined,
    cardId: 'legacy-card',
    eventId: 'legacy-card-event',
  };
  let legacyState = createPracticeSessionState(legacy, { [concepts[0].id]: false });
  legacyState = startPracticeSession(legacyState, null);
  legacyState = { ...legacyState, answer: '旧卡回答。' };
  legacyState = submitPracticeAnswer(legacyState, '2026-10-02T10:01:00.000Z', 'legacy-attempt');
  legacyState = { ...legacyState, outcome: 'partial', cue: 'independent' };
  const legacyRequest = buildPracticeAttemptRequest(legacyState);
  assert.equal(Object.hasOwn(legacyRequest, 'scenario'), false);
  assert.equal(legacyRequest.outcome, 'partial');
});

test('failed scenario saves retry the exact retained request', async () => {
  let allow = false;
  let calls = 0;
  const requests: PracticeAttemptRequest[] = [];
  const coordinator = createPracticeSaveCoordinator<PracticeAttemptRequest>(async (request) => {
    calls += 1;
    requests.push(request);
    return allow;
  });
  let state = completeScenarioAnswer();
  state = revealPracticeReference(state);
  const request = buildPracticeAttemptRequest(state);
  assert.equal((await coordinator.save(request)).saved, false);
  allow = true;
  assert.equal((await coordinator.save(request)).saved, true);
  assert.equal(calls, 2);
  assert.strictEqual(requests[0], requests[1]);
  assert.strictEqual(coordinator.retainedRequest, request);
});
