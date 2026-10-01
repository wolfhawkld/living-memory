import assert from 'node:assert/strict';
import test from 'node:test';
import { reviewAllowance } from '../src/web/review-allowance.js';
import { briefReviewConfirmationSuperseded, prepareBriefReviewResume } from '../src/web/brief-review-resume.js';
import { api, type PendingWrite } from '../src/web/api.js';
import type { BriefReviewCheckpoint } from '../src/web/brief-review-checkpoint.js';
import type { ReviewPlanResponse } from '../src/shared/review-plan.js';
import type { Snapshot } from '../src/shared/types.js';

const now = '2026-09-27T08:00:00.000Z';
function arrangement(): ReviewPlanResponse {
  return { sourceId: 'user-a', asOf: now, timeZone: 'Asia/Shanghai', dayKey: '2026-09-27',
    plan: { revision: 0, dailyBudget: 5, concepts: {} }, completedConceptIds: [] };
}
function snapshot(): Snapshot {
  return {
    concepts: [{ id: 'a', title: 'A', aliases: [], domain: 'Math', body: 'private', summary: 'private', source: { path: 'Math/a.md', revision: 'v1' } }], links: [],
    source: { name: 'fixture', mode: 'demo', conceptCount: 1, limit: 1, diagnostics: [] },
    config: { modelVersion: 'time-only-v0', revision: 1, halfLifeDays: 7 }, asOf: now, observationsCount: 0,
    states: { a: { conceptId: 'a', status: 'stale', decay: 0.25, elapsedDays: 14, reason: null, asOf: now,
      anchor: { eventId: 'anchor-a', conceptId: 'a', sourceRevision: 'v1', kind: 'review', occurredAt: '2026-09-13T08:00:00.000Z', recordedAt: '2026-09-13T08:00:00.000Z' } } },
  };
}
function checkpoint(): BriefReviewCheckpoint {
  return {
    version: 1, savedAt: now,
    session: { id: 'run-a', sourceId: 'user-a', domainId: 'Math', index: 0, results: {}, reviews: {},
      items: [{ conceptId: 'a', title: 'A', sourceRevision: 'v1', status: 'stale', elapsedDays: 14, estimated: false }] },
    attempt: { conceptId: 'a', eventId: null, answer: 'unfinished personal answer', startedAt: now, observedAt: null,
      configRevision: null, anchorEventId: 'anchor-a', sourceRevision: 'v1', sourceViewedBefore: false,
      stage: 'answer', rating: null, exposure: 'unexposed',
      learning: { task: 'concept', confidence: 70, confidenceAt: now, cue: 'independent', outcome: 'unverified', basis: 'unknown' } },
  };
}
function pending(conceptId: string, eventId: string, observedAt = now, task = 'concept'): PendingWrite {
  return { id: eventId, path: '/observations', method: 'POST', eventId, conceptId, label: 'fixture', createdAt: now,
    payload: { conceptId, eventId, observedAt, learning: { task } } };
}

test('daily allowance deduplicates concepts across accepted and pending recalls and separates scenarios, applications, and local days', () => {
  const response = arrangement();
  response.completedConceptIds = ['a', 'a'];
  const result = reviewAllowance(response, [pending('a', 'one'), pending('b', 'two'), pending('b', 'three'),
    pending('c', 'scenario', now, 'scenario'), pending('d', 'old', '2026-09-26T15:59:59Z'),
    pending('e', 'midnight', '2026-09-26T16:00:00Z'), pending('f', 'future', '2026-09-28T00:00:00Z'),
    { ...pending('g', 'app'), path: '/applications' }]);
  assert.deepEqual({ ...result, excludedIds: [...result.excludedIds] }, { completed: 1, pending: 2, remaining: 2, excludedIds: ['a', 'b', 'e'] });
  response.plan.dailyBudget = 1;
  assert.equal(reviewAllowance(response, [pending('b', 'two')]).remaining, 0);
  assert.equal(reviewAllowance(arrangement(), [pending('b', 'just-queued', '2026-09-27T08:01:00Z')]).pending, 1,
    'a new queued answer after the last server read still reserves today’s workload');
});

test('resume preserves an unfinished answer and prospective confidence while rechecking current source, revision, domain, and anchor', () => {
  const saved = checkpoint();
  const before = JSON.stringify(saved);
  const restored = prepareBriefReviewResume(saved, snapshot(), arrangement(), []);
  assert.deepEqual(restored.attempt, saved.attempt);
  assert.equal(restored.attempt?.learning.confidenceAt, now);
  assert.equal(JSON.stringify(saved), before);
  assert.throws(() => prepareBriefReviewResume(saved, snapshot(), { ...arrangement(), sourceId: 'user-b' }, []), /另一个/);
  const changed = snapshot();
  changed.concepts[0].source.revision = 'v2';
  assert.throws(() => prepareBriefReviewResume(saved, changed, arrangement(), []), /原作答仍保留/);
  changed.concepts[0].source.revision = 'v1';
  changed.concepts[0].source.path = 'AI/a.md';
  assert.throws(() => prepareBriefReviewResume(saved, changed, arrangement(), []), /领域已变化/);
  const anchorChanged = snapshot();
  anchorChanged.states.a.anchor!.eventId = 'new-anchor';
  assert.throws(() => prepareBriefReviewResume(saved, anchorChanged, arrangement(), []), /起点已变化/);
});

test('resume honors retained and deferred state while preserving drafts, and a started answer may finish after a budget decrease', () => {
  const saved = checkpoint();
  const response = arrangement();
  response.plan.dailyBudget = 1;
  response.completedConceptIds = ['other'];
  assert.equal(prepareBriefReviewResume(saved, snapshot(), response, []).attempt?.answer, saved.attempt?.answer);
  assert.throws(() => prepareBriefReviewResume({ ...saved, attempt: null }, snapshot(), response, []), /预算已用完/);
  response.plan.concepts.a = { focus: true, deferUntil: '2026-09-28T08:00:00Z' };
  assert.throws(() => prepareBriefReviewResume(saved, snapshot(), response, []), /暂缓/);
  response.plan.concepts.a.deferUntil = now;
  assert.ok(prepareBriefReviewResume(saved, snapshot(), response, []).state);
  const retained = snapshot();
  retained.states.a.status = 'retained';
  assert.throws(() => prepareBriefReviewResume(saved, retained, response, []), /长期保持/);
});

test('resume reconciles queued observations and confirmed reviews without creating another attempt or event', () => {
  const saved = checkpoint();
  saved.attempt!.eventId = 'frozen-observation';
  const queued = prepareBriefReviewResume(saved, snapshot(), arrangement(), [pending('a', 'frozen-observation')]);
  assert.equal(queued.session.results.a, 'queued');
  assert.equal(queued.attempt, null);
  assert.deepEqual(saved.session.results, {});
  saved.session.results.a = 'saved';
  saved.attempt = null;
  saved.reviewRequest = { eventId: 'fixed-review', conceptId: 'a', sourceRevision: 'v1', kind: 'review', occurredAt: now };
  const nextSnapshot = snapshot();
  nextSnapshot.states.a.anchor!.eventId = 'fixed-review';
  nextSnapshot.states.a.status = 'recent';
  assert.equal(prepareBriefReviewResume(saved, nextSnapshot, arrangement(), []).session.reviews.a, 'saved');
  const reviewPending: PendingWrite = { ...pending('a', 'fixed-review'), path: '/reviews', payload: saved.reviewRequest };
  assert.equal(prepareBriefReviewResume(saved, snapshot(), arrangement(), [reviewPending]).session.reviews.a, 'queued');
  const newerAnchor = { ...nextSnapshot.states.a.anchor!, eventId: 'another-tab-review', occurredAt: '2026-09-27T09:00:00Z' };
  assert.equal(briefReviewConfirmationSuperseded(saved.reviewRequest, newerAnchor), true,
    'a later independent review blocks the old confirmation without assigning it a fresh event ID');
  assert.equal(briefReviewConfirmationSuperseded(saved.reviewRequest, nextSnapshot.states.a.anchor), false);
  assert.equal(briefReviewConfirmationSuperseded(saved.reviewRequest, snapshot().states.a.anchor), false);
});

test('review plan requests use source-scoped authentication, no-store reads, and encode the browser time zone', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ path: String(input), init });
    return new Response(JSON.stringify(arrangement()), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const controller = new AbortController();
    await api.getReviewPlan('user-a', 'Asia/Shanghai', controller.signal);
    await api.putReviewPlan({ revision: 0, dailyBudget: 3 }, 'test-csrf', 'user-a', 'Asia/Shanghai');
    assert.match(calls[0].path, /timeZone=Asia%2FShanghai/);
    assert.equal(calls[0].init?.cache, 'no-store');
    assert.ok(calls[0].init?.signal instanceof AbortSignal);
    assert.notEqual(calls[0].init.signal, controller.signal,
      'transport uses an internal signal so a deadline cannot abort the caller');
    assert.equal(calls[0].init.signal.aborted, controller.signal.aborted,
      'caller cancellation state is reflected when the transport starts');
    assert.equal(new Headers(calls[0].init?.headers).get('x-lm-source-id'), 'user-a');
    assert.equal(new Headers(calls[1].init?.headers).get('x-lm-token'), 'test-csrf');
    assert.equal(calls[1].init?.method, 'PUT');
    await assert.rejects(api.getReviewPlan('', 'UTC'), /缺少/);
    assert.equal(calls.length, 2);
  } finally { globalThis.fetch = originalFetch; }
});
