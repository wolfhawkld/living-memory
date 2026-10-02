import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Concept } from '../src/shared/types.ts';
import type { PracticeAttemptRequest, PracticeCardEvent } from '../src/shared/practice.ts';
import {
  buildPracticeAttemptRequest,
  buildPracticeCardRequest,
  capturePracticeSourceExposure,
  createPracticeSaveCoordinator,
  createPracticeSessionState,
  setPracticeConfidence,
  startPracticeSession,
  submitPracticeAnswer,
  validatePracticeCardDraft,
  createPracticeCardDraft,
} from '../src/web/practice-session.ts';

const concept: Concept = {
  id: 'math:boolean',
  title: '布尔逻辑',
  aliases: ['Boolean logic'],
  domain: 'Math',
  summary: '用真值与逻辑联结词表达规则。',
  body: '# 布尔逻辑\n完整资料',
  source: { path: 'Math/Boolean.md', revision: 'revision-1' },
};

const card: PracticeCardEvent = {
  eventId: 'card-event-1',
  cardId: 'card-1',
  previousEventId: null,
  occurredAt: '2026-10-01T10:00:00.000Z',
  kind: 'detail',
  title: '解释规则条件',
  prompt: '什么时候应该先拆分规则条件？',
  referenceAnswer: '先把条件拆成可以单独核对的判断。',
  referenceNotes: '来自当前布尔逻辑资料。',
  sources: [{ conceptId: concept.id, sourceRevision: concept.source.revision }],
  sourceChecked: true,
  paused: false,
  recordedAt: '2026-10-01T10:00:01.000Z',
};

function feedbackState(viewed = true) {
  let state = createPracticeSessionState(card, { [concept.id]: viewed });
  state = setPracticeConfidence(state, 75);
  state = startPracticeSession(state, '2026-10-02T09:00:00.000Z');
  state = { ...state, answer: '先拆分成独立的布尔判断。' };
  state = submitPracticeAnswer(state, '2026-10-02T09:01:00.000Z', 'attempt-1');
  return { ...state, outcome: 'partial' as const, cue: 'independent' as const, exposure: 'unexposed' as const, checkNotes: '需要补充边界条件。' };
}

test('practice submission freezes the blind answer, timing, confidence and exposure', () => {
  const state = feedbackState(true);
  assert.equal(state.submittedCore?.answer, '先拆分成独立的布尔判断。');
  assert.equal(Object.isFrozen(state.card), true);
  assert.equal(Object.isFrozen(state.submittedCore), true);
  assert.equal(setPracticeConfidence(state, 10), state);
  const request = buildPracticeAttemptRequest(state);
  assert.equal(request.eventId, 'attempt-1');
  assert.equal(request.answeredAt, '2026-10-02T09:01:00.000Z');
  assert.equal(request.confidence, 75);
  assert.equal(request.confidenceAt, '2026-10-02T09:00:00.000Z');
  assert.equal(request.answer, '先拆分成独立的布尔判断。');
  assert.equal(request.observedExposure, true);
  assert.equal(request.exposure, 'exposed');
  assert.equal(request.outcome, 'partial');
  assert.equal(request.checkNotes, '需要补充边界条件。');
  assert.throws(() => { (request as { answer: string }).answer = '改写'; }, TypeError);
});

test('reported unexposed cannot override a true pre-answer source view', () => {
  const state = feedbackState(true);
  const request = buildPracticeAttemptRequest({ ...state, exposure: 'unexposed' });
  assert.equal(request.observedExposure, true);
  assert.equal(request.exposure, 'exposed');
  const unseen = buildPracticeAttemptRequest({ ...feedbackState(false), exposure: 'unexposed' });
  assert.equal(unseen.observedExposure, false);
  assert.equal(unseen.exposure, 'unexposed');
});

test('source exposure capture is limited to the card sources', () => {
  const other = { ...concept, id: 'math:other', title: '另一个概念' };
  const result = capturePracticeSourceExposure(card, [concept, other], () => true);
  assert.deepEqual(result, { [concept.id]: true });
});

test('save coordinator deduplicates double clicks and retains successful requests', async () => {
  let calls = 0;
  let release!: (value: boolean) => void;
  const coordinator = createPracticeSaveCoordinator(async () => {
    calls += 1;
    return new Promise<boolean>((resolve) => { release = resolve; });
  });
  const request = buildPracticeAttemptRequest(feedbackState());
  const first = coordinator.save(request);
  const second = coordinator.save(request);
  assert.equal(calls, 1);
  release(true);
  assert.equal((await first).saved, true);
  assert.equal((await second).saved, true);
  assert.strictEqual(coordinator.retainedRequest, request);
  assert.equal((await coordinator.save(request)).saved, true);
  assert.equal(calls, 1);
});

test('a failed save retries the exact frozen request', async () => {
  let calls = 0;
  let next = false;
  const requests: PracticeAttemptRequest[] = [];
  const coordinator = createPracticeSaveCoordinator<PracticeAttemptRequest>(async (request) => {
    calls += 1;
    requests.push(request);
    return next;
  });
  const request = buildPracticeAttemptRequest(feedbackState());
  assert.equal((await coordinator.save(request)).saved, false);
  next = true;
  assert.equal((await coordinator.save(request)).saved, true);
  assert.equal(calls, 2);
  assert.strictEqual(requests[0], requests[1]);
});

test('card drafts enforce current source versions and explicit confirmation', () => {
  const draft = createPracticeCardDraft('detail', { cardId: 'card-new', sources: [{ conceptId: concept.id, sourceRevision: concept.source.revision }] });
  draft.title = card.title;
  draft.prompt = card.prompt;
  draft.referenceAnswer = card.referenceAnswer;
  draft.referenceNotes = card.referenceNotes;
  assert.match(validatePracticeCardDraft(draft, [concept]) ?? '', /勾选/);
  draft.sourceChecked = true;
  assert.equal(validatePracticeCardDraft(draft, [concept]), null);
  const request = buildPracticeCardRequest(draft, '2026-10-02T10:00:00.000Z', 'card-event-2');
  assert.equal(request.sources[0].sourceRevision, concept.source.revision);
  assert.throws(() => buildPracticeCardRequest({ ...draft, sourceChecked: false }, '2026-10-02T10:00:00.000Z', 'card-event-3'), /勾选/);
  const changed = { ...concept, source: { ...concept.source, revision: 'revision-2' } };
  assert.match(validatePracticeCardDraft(draft, [changed]) ?? '', /版本/);
});
