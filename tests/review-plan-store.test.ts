import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store, StoreError } from '../src/server/store.js';
import type { Concept, ObservationRequest } from '../src/shared/types.js';

const concept: Concept = {
  id: 'concept-alpha',
  title: 'Alpha',
  aliases: [],
  domain: 'Math',
  summary: 'summary',
  body: 'body',
  source: { path: 'Alpha.md', revision: 'rev-1' },
};

function fixture(now = '2026-01-02T01:00:00.000Z') {
  const dataDir = mkdtempSync(join(tmpdir(), 'living-memory-review-plan-store-'));
  let currentNow = now;
  const store = new Store({
    dataDir,
    namespace: 'review-plan-source',
    now: () => new Date(currentNow),
  });
  return {
    store,
    dataDir,
    setNow(value: string) { currentNow = value; },
    cleanup() { store.close(); rmSync(dataDir, { recursive: true, force: true }); },
  };
}

function assertStoreError(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) => error instanceof StoreError && error.code === code);
}

function observation(overrides: Partial<ObservationRequest> = {}): ObservationRequest {
  return {
    eventId: 'observation-alpha',
    conceptId: concept.id,
    sourceRevision: concept.source.revision,
    observedAt: '2026-01-01T16:00:00Z',
    configRevision: 1,
    anchorEventId: null,
    answer: 'answer',
    rating: 'clear',
    exposure: 'unexposed',
    observedExposure: false,
    ...overrides,
  };
}

test('review plan defaults are read-only, namespace isolated, CAS protected, and restartable', () => {
  const first = fixture();
  const second = new Store({ dataDir: first.dataDir, namespace: 'other-review-plan-source', now: () => new Date('2026-01-02T01:00:00.000Z') });
  try {
    assert.deepEqual(first.store.getReviewPlan(), { revision: 0, dailyBudget: 5, concepts: {} });
    const db = new DatabaseSync(join(first.dataDir, 'living-memory.sqlite'));
    try {
      assert.equal((db.prepare('SELECT COUNT(*) AS count FROM review_plans WHERE namespace = ?').get('review-plan-source') as { count: number }).count, 0);
    } finally {
      db.close();
    }

    const budget = first.store.updateReviewPlan({ revision: 0, dailyBudget: 7 });
    assert.deepEqual(budget, { revision: 1, dailyBudget: 7, concepts: {} });
    assert.deepEqual(first.store.updateReviewPlan({ revision: 0, dailyBudget: 7 }), budget, 'same stale payload is idempotent');
    assertStoreError(() => first.store.updateReviewPlan({ revision: 0, dailyBudget: 8 }), 'REVIEW_PLAN_CONFLICT');
    assert.deepEqual(second.getReviewPlan(), { revision: 0, dailyBudget: 5, concepts: {} });

    const focused = first.store.updateReviewPlan({
      revision: budget.revision,
      concept: { conceptId: concept.id, sourceRevision: concept.source.revision, focus: true, deferUntil: null },
    });
    assert.equal(focused.revision, 2);
    assert.deepEqual(focused.concepts, { [concept.id]: { focus: true, deferUntil: null } });
    assert.deepEqual(first.store.updateReviewPlan({
      revision: 0,
      concept: { conceptId: concept.id, sourceRevision: concept.source.revision, focus: true, deferUntil: null },
    }), focused, 'same concept intent is idempotent across stale revision');
    assert.equal(second.getReviewPlan().revision, 0, 'other namespace cannot observe the plan');

    const withDefer = first.store.updateReviewPlan({
      revision: focused.revision,
      concept: { conceptId: concept.id, sourceRevision: concept.source.revision, focus: false, deferUntil: '2026-01-03T01:00:00+00:00' },
    });
    assert.equal(withDefer.concepts[concept.id].deferUntil, '2026-01-03T01:00:00.000Z');
    assertStoreError(() => first.store.updateReviewPlan({
      revision: withDefer.revision,
      concept: { conceptId: concept.id, sourceRevision: concept.source.revision, focus: false, deferUntil: '2026-01-02T00:00:00Z' },
    }), 'INVALID_DEFER_UNTIL');
    assertStoreError(() => first.store.updateReviewPlan({
      revision: withDefer.revision,
      concept: { conceptId: concept.id, sourceRevision: concept.source.revision, focus: false, deferUntil: '2027-01-04T01:00:00Z' },
    }), 'INVALID_DEFER_UNTIL');

    first.store.close();
    const reopened = new Store({ dataDir: first.dataDir, namespace: 'review-plan-source', now: () => new Date('2026-01-02T01:00:00.000Z') });
    try {
      assert.deepEqual(reopened.getReviewPlan(), withDefer);
      const exported = reopened.exportData({ name: 'test', mode: 'local', conceptCount: 1, limit: 1, diagnostics: [] }, [concept]);
      assert.deepEqual(exported.reviewPlan, withDefer);
    } finally {
      reopened.close();
    }
  } finally {
    // first may already be closed by the restart assertion.
    try { first.store.close(); } catch { /* already closed */ }
    second.close();
    rmSync(first.dataDir, { recursive: true, force: true });
  }
});

test('review plan writes do not affect learning state and completed IDs count only local-day concept recall', () => {
  const current = fixture();
  try {
    const { store } = current;
    const before = store.getStates([concept], '2026-01-02T01:00:00Z')[concept.id];
    store.addObservation(observation({ eventId: 'legacy-recall' }), null);
    store.addObservation(observation({
      eventId: 'scenario-recall',
      observedAt: '2026-01-01T17:00:00Z',
      learning: { task: 'scenario', scenario: 'scenario', cue: 'independent', outcome: 'success', basis: 'application', confidence: null, confidenceAt: null },
    }), null);
    store.addObservation(observation({
      eventId: 'same-concept-new-version',
      sourceRevision: 'rev-2',
      observedAt: '2026-01-01T18:00:00Z',
    }), null);
    current.setNow('2026-01-02T03:00:00Z');
    store.addObservation(observation({
      eventId: 'tomorrow-recall',
      conceptId: 'concept-tomorrow',
      observedAt: '2026-01-02T02:00:00Z',
    }), null);
    const beforeCounts = store.countObservations();
    const plan = store.updateReviewPlan({ revision: 0, dailyBudget: 6 });
    assert.equal(plan.revision, 1);
    assert.equal(store.countObservations(), beforeCounts);
    const after = store.getStates([concept], '2026-01-02T01:00:00Z')[concept.id];
    assert.deepEqual(after, before, 'plan metadata does not alter memory projection');
    assert.deepEqual(store.getCompletedConceptIds('2026-01-02T01:00:00Z', 'Asia/Shanghai'), [concept.id]);
    assert.deepEqual(store.getCompletedConceptIds('2026-01-02T01:00:00Z', 'UTC'), []);
  } finally {
    current.cleanup();
  }
});
