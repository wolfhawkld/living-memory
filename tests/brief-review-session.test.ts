import assert from 'node:assert/strict';
import test from 'node:test';
import { advanceBriefReview, briefReviewCounts, completeBriefReviewItem, resolveBriefReviewItem, type BriefReviewSession } from '../src/web/brief-review-session.js';
import type { Snapshot } from '../src/shared/types.js';

function session(id = 'run-a'): BriefReviewSession {
  return {
    id, sourceId: 'account-a', domainId: 'Math', index: 0, results: {}, reviews: {},
    items: ['a', 'b', 'c'].map((conceptId) => ({ conceptId, title: conceptId,
      sourceRevision: 'v1', status: 'stale', elapsedDays: 20, estimated: false })),
  };
}

test('a brief session counts saved, queued and skipped separately without changing its frozen candidates', () => {
  const start = session();
  const saved = completeBriefReviewItem(start, start.id, 'a', 'saved')!;
  const next = advanceBriefReview(saved);
  const queued = completeBriefReviewItem(next, start.id, 'b', 'queued')!;
  const last = advanceBriefReview(queued);
  const done = completeBriefReviewItem(last, start.id, 'c', 'skipped')!;
  assert.deepEqual(briefReviewCounts(done), { saved: 1, queued: 1, skipped: 1 });
  assert.equal(advanceBriefReview(done), done);
  assert.equal(done.items, start.items);
  assert.deepEqual(start.results, {});
  assert.deepEqual(done.reviews, {}, 'observations and skip never confirm a review');
});

test('an unfinished item cannot advance and duplicate or late completions cannot affect another item', () => {
  const start = session();
  assert.equal(advanceBriefReview(start), start);
  assert.equal(completeBriefReviewItem(start, start.id, 'b', 'saved'), start);
  const saved = completeBriefReviewItem(start, start.id, 'a', 'saved')!;
  assert.equal(completeBriefReviewItem(saved, start.id, 'a', 'queued'), saved);
  const next = advanceBriefReview(saved);
  assert.equal(completeBriefReviewItem(next, start.id, 'a', 'skipped'), next);
  assert.deepEqual(briefReviewCounts(next), { saved: 1, queued: 0, skipped: 0 });
});

test('closed sessions and new sessions reject callbacks from an old run or account', () => {
  assert.equal(completeBriefReviewItem(null, 'run-a', 'a', 'saved'), null);
  const newer = { ...session('run-b'), sourceId: 'account-b' };
  assert.equal(completeBriefReviewItem(newer, 'run-a', 'a', 'saved'), newer);
  assert.deepEqual(newer.results, {});
});

test('a removed, retained or changed candidate can be skipped as unavailable without a success claim', () => {
  const start = session();
  const unavailable = completeBriefReviewItem(start, start.id, 'a', 'unavailable')!;
  assert.deepEqual(briefReviewCounts(unavailable), { saved: 0, queued: 0, skipped: 1 });
  assert.equal(advanceBriefReview(unavailable).items[1].conceptId, 'b');
  assert.deepEqual(unavailable.reviews, {});
});

test('next-item validation uses current state, excludes pending writes, and never substitutes a changed source or domain', () => {
  const run = session();
  const concept = { id: 'a', title: 'A', aliases: [], domain: 'Math', summary: 'hidden answer', body: 'hidden body',
    source: { path: 'Math/a.md', revision: 'v1' } };
  const snapshot: Snapshot = {
    concepts: [concept], links: [], source: { name: 'fixture', mode: 'demo', conceptCount: 1, limit: 1, diagnostics: [] },
    asOf: '2026-09-26T00:00:00.000Z', observationsCount: 0,
    config: { modelVersion: 'time-only-v0', halfLifeDays: 7, revision: 1 },
    states: { a: { conceptId: 'a', status: 'stale', decay: 0.25, elapsedDays: 14, reason: null,
      asOf: '2026-09-26T00:00:00.000Z', anchor: { eventId: 'anchor-a', conceptId: 'a', sourceRevision: 'v1',
        kind: 'review', occurredAt: '2026-09-12T00:00:00.000Z', recordedAt: '2026-09-12T00:00:00.000Z' } } },
  };
  assert.equal(resolveBriefReviewItem(run, snapshot, new Set())?.concept, concept);
  assert.equal(resolveBriefReviewItem(run, snapshot, new Set(['a'])), null);
  assert.equal(resolveBriefReviewItem(run, { ...snapshot, concepts: [] }, new Set()), null);
  assert.equal(resolveBriefReviewItem(run, { ...snapshot, concepts: [{ ...concept, source: { ...concept.source, revision: 'v2' } }] }, new Set()), null);
  assert.equal(resolveBriefReviewItem(run, { ...snapshot, concepts: [{ ...concept, source: { ...concept.source, path: 'AI/a.md' } }] }, new Set()), null);
  for (const status of ['retained', 'recent', 'unknown', 'pending'] as const) {
    assert.equal(resolveBriefReviewItem(run, { ...snapshot, states: { a: { ...snapshot.states.a, status } } }, new Set()), null);
  }
  assert.equal(run.items[0].sourceRevision, 'v1');
  assert.deepEqual(run.results, {});
});
