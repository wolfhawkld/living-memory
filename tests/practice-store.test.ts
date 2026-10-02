import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parsePracticeAttemptRequest, parsePracticeCardRequest } from '../src/server/practice-validation.js';
import { Store, StoreError } from '../src/server/store.js';
import type { PracticeAttemptRequest, PracticeCardRequest } from '../src/shared/practice.js';
import type { Concept } from '../src/shared/types.js';

const SOURCE = { name: 'practice-test', mode: 'local' as const, conceptCount: 2, limit: 100, diagnostics: [] };
const NOW = '2026-01-02T00:00:00.000Z';

function concept(id: string, revision = 'rev-1', title = id): Concept {
  return {
    id,
    title,
    aliases: [],
    domain: 'test',
    summary: title,
    body: `${title} body`,
    source: { path: `${id}.md`, revision },
  };
}

function fixture(namespace = 'practice-store-test') {
  const dataDir = mkdtempSync(join(tmpdir(), `${namespace}-`));
  let currentNow = NOW;
  const store = new Store({ dataDir, namespace, now: () => new Date(currentNow) });
  return {
    store,
    dataDir,
    setNow(value: string) { currentNow = value; },
    cleanup() { store.close(); rmSync(dataDir, { recursive: true, force: true }); },
  };
}

function detailCard(overrides: Partial<PracticeCardRequest> = {}): PracticeCardRequest {
  return {
    eventId: 'card-event-1',
    cardId: 'card-1',
    previousEventId: null,
    occurredAt: '2026-01-01T00:00:00Z',
    kind: 'detail',
    title: '关键细节',
    prompt: '问题？',
    referenceAnswer: '答案。',
    referenceNotes: '',
    sources: [{ conceptId: 'alpha', sourceRevision: 'rev-1' }],
    sourceChecked: true,
    paused: false,
    ...overrides,
  };
}

function attempt(overrides: Partial<PracticeAttemptRequest> = {}): PracticeAttemptRequest {
  return {
    eventId: 'attempt-1',
    cardId: 'card-1',
    cardEventId: 'card-event-1',
    answeredAt: '2026-01-01T00:01:00Z',
    answer: '',
    confidence: 60,
    confidenceAt: '2026-01-01T00:01:00Z',
    exposure: 'unexposed',
    observedExposure: false,
    cue: 'independent',
    outcome: 'partial',
    checkNotes: '',
    ...overrides,
  };
}

function expectStoreError(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) => error instanceof StoreError && error.code === code);
}

test('practice request parsers enforce card/source and attempt evidence boundaries', () => {
  const card = parsePracticeCardRequest(detailCard({ sourceChecked: true }));
  assert.equal(card.occurredAt, '2026-01-01T00:00:00.000Z');
  assert.deepEqual(card.sources, [{ conceptId: 'alpha', sourceRevision: 'rev-1' }]);
  assert.throws(() => parsePracticeCardRequest({ ...detailCard(), sourceChecked: false }), /sourceChecked/);
  assert.throws(() => parsePracticeCardRequest(detailCard({ sources: [] })), /恰好/);
  assert.throws(() => parsePracticeCardRequest(detailCard({ kind: 'comparison', sources: [{ conceptId: 'alpha', sourceRevision: 'rev-1' }] })), /2 到 4/);
  assert.throws(() => parsePracticeCardRequest(detailCard({ kind: 'comparison', sources: [
    { conceptId: 'alpha', sourceRevision: 'rev-1' }, { conceptId: 'alpha', sourceRevision: 'rev-2' },
  ] })), /不同概念/);
  const parsedAttempt = parsePracticeAttemptRequest(attempt({ observedExposure: true, exposure: 'unexposed' }));
  assert.equal(parsedAttempt.exposure, 'exposed');
  assert.throws(() => parsePracticeAttemptRequest(attempt({ confidence: null, confidenceAt: '2026-01-01T00:01:00Z' })), /confidenceAt/);
  assert.throws(() => parsePracticeAttemptRequest(attempt({ outcome: 'invalid' as PracticeAttemptRequest['outcome'] })), /outcome/);
});

test('practice cards and attempts are append-only, idempotent, source-checked, and restartable', () => {
  const fixtureData = fixture();
  const alpha = concept('alpha');
  const beta = concept('beta');
  try {
    const { store } = fixtureData;
    const card = detailCard();
    assert.deepEqual(store.addPracticeCard(card, [alpha, beta]), { status: 'accepted', eventId: card.eventId });
    assert.deepEqual(store.addPracticeCard(card, [concept('alpha', 'changed'), beta]), { status: 'duplicate', eventId: card.eventId });
    assert.deepEqual(store.getPracticeCard(card.cardId), {
      ...card,
      occurredAt: '2026-01-01T00:00:00.000Z',
      recordedAt: NOW,
    });

    const firstAttempt = attempt({ observedExposure: true, exposure: 'unexposed' });
    assert.deepEqual(store.addPracticeAttempt(firstAttempt, [alpha, beta]), { status: 'accepted', eventId: firstAttempt.eventId });
    const storedAttempt = store.getPracticeData().attempts[0];
    assert.equal(storedAttempt.exposure, 'exposed');
    assert.equal(storedAttempt.observedExposure, true);
    assert.deepEqual(store.addPracticeAttempt(firstAttempt, [concept('alpha', 'changed'), beta]), { status: 'duplicate', eventId: firstAttempt.eventId });

    const revisedCard = detailCard({ eventId: 'card-event-2', previousEventId: card.eventId, occurredAt: '2026-01-01T00:02:00Z', prompt: '更新问题？' });
    assert.deepEqual(store.addPracticeCard(revisedCard, [alpha, beta]), { status: 'accepted', eventId: revisedCard.eventId });
    expectStoreError(() => store.addPracticeCard(detailCard({ eventId: 'card-event-fork', previousEventId: card.eventId, occurredAt: '2026-01-01T00:03:00Z' }), [alpha, beta]), 'PRACTICE_CARD_CONFLICT');
    expectStoreError(() => store.addPracticeAttempt(attempt({ eventId: 'attempt-old-revision', cardEventId: card.eventId }), [alpha, beta]), 'PRACTICE_CARD_CONFLICT');
    expectStoreError(() => store.addPracticeCard(detailCard({ eventId: 'card-event-old-source', previousEventId: revisedCard.eventId, occurredAt: '2026-01-01T00:04:00Z' }), [concept('alpha', 'changed'), beta]), 'PRACTICE_CARD_CONFLICT');

    const paused = detailCard({ eventId: 'card-event-paused', previousEventId: revisedCard.eventId, occurredAt: '2026-01-01T00:05:00Z', paused: true });
    assert.deepEqual(store.addPracticeCard(paused, [alpha, beta]), { status: 'accepted', eventId: paused.eventId });
    expectStoreError(() => store.addPracticeAttempt(attempt({ eventId: 'attempt-paused', cardEventId: paused.eventId, answeredAt: '2026-01-01T00:06:00Z' }), [alpha, beta]), 'PRACTICE_CARD_PAUSED');
    // Replaying a previously accepted answer remains a receipt even after the card is paused/source-changed.
    assert.deepEqual(store.addPracticeAttempt(firstAttempt, [concept('alpha', 'changed'), beta]), { status: 'duplicate', eventId: firstAttempt.eventId });

    const dataBeforeRestart = store.getPracticeData();
    assert.equal(dataBeforeRestart.cards.length, 3);
    assert.equal(dataBeforeRestart.attempts.length, 1);
    const exported = store.exportData(SOURCE, [alpha, beta]);
    assert.deepEqual(exported.practice, dataBeforeRestart);
    store.close();

    const restarted = new Store({ dataDir: fixtureData.dataDir, namespace: 'practice-store-test', now: () => new Date(NOW) });
    assert.deepEqual(restarted.getPracticeData(), dataBeforeRestart);
    restarted.close();
  } finally {
    // The store may have been closed above; closing a second time is harmless for cleanup purposes.
    try { fixtureData.store.close(); } catch { /* already closed */ }
    rmSync(fixtureData.dataDir, { recursive: true, force: true });
  }
});

test('practice uses namespace-scoped storage and reserves event IDs across event kinds', () => {
  const fixtureData = fixture('practice-shared');
  const dbPath = join(fixtureData.dataDir, 'shared.sqlite');
  fixtureData.store.close();
  const first = new Store({ dbPath, namespace: 'first', now: () => new Date(NOW) });
  const second = new Store({ dbPath, namespace: 'second', now: () => new Date(NOW) });
  const alpha = concept('alpha');
  try {
    assert.deepEqual(first.addPracticeCard(detailCard({ eventId: 'shared-event', cardId: 'first-card' }), [alpha]), { status: 'accepted', eventId: 'shared-event' });
    assert.deepEqual(second.addPracticeCard(detailCard({ eventId: 'shared-event', cardId: 'second-card' }), [alpha]), { status: 'accepted', eventId: 'shared-event' });
    expectStoreError(() => first.addReview({ eventId: 'shared-event', conceptId: alpha.id, sourceRevision: alpha.source.revision, kind: 'review', occurredAt: '2026-01-01T00:00:00Z' }), 'EVENT_CONFLICT');
    expectStoreError(() => first.addPracticeCard(detailCard({ eventId: 'shared-event-2', cardId: 'first-card' }), [alpha]), 'PRACTICE_CARD_CONFLICT');
    assert.equal(first.getPracticeData().cards.length, 1);
    assert.equal(second.getPracticeData().cards.length, 1);
    assert.equal(first.hasEvent('shared-event'), true);
  } finally {
    first.close();
    second.close();
    rmSync(fixtureData.dataDir, { recursive: true, force: true });
  }
});

test('private practice leaves observation counts, completion, and identity target history isolated except for identity safety counts', () => {
  const fixtureData = fixture('practice-identity');
  const oldConcept = concept('old');
  const targetConcept = concept('target');
  try {
    const { store } = fixtureData;
    store.addReview({ eventId: 'anchor-1', conceptId: oldConcept.id, sourceRevision: oldConcept.source.revision, kind: 'review', occurredAt: '2026-01-01T00:00:00Z' });
    store.addObservation({ eventId: 'observation-1', conceptId: oldConcept.id, sourceRevision: oldConcept.source.revision, observedAt: '2026-01-01T00:01:00Z', configRevision: 1, anchorEventId: 'anchor-1', answer: 'remembered', rating: 'clear', exposure: 'unexposed', observedExposure: false }, 'anchor-1');
    const observationCount = store.countObservations();
    const completed = store.getCompletedConceptIds(NOW, 'UTC');
    store.rememberConcepts([oldConcept, targetConcept]);
    store.addPracticeCard(detailCard({ eventId: 'practice-only-card', cardId: 'practice-only', sources: [{ conceptId: oldConcept.id, sourceRevision: oldConcept.source.revision }] }), [oldConcept, targetConcept]);
    store.addPracticeAttempt(attempt({ eventId: 'practice-only-attempt', cardId: 'practice-only', cardEventId: 'practice-only-card', answeredAt: '2026-01-01T00:01:00Z' }), [oldConcept, targetConcept]);
    assert.equal(store.countObservations(), observationCount);
    assert.deepEqual(store.getCompletedConceptIds(NOW, 'UTC'), completed);
    assert.equal(store.getObservations().length, 1);
    const status = store.getIdentityStatus([targetConcept]);
    const orphan = status.orphans.find((item) => item.conceptId === oldConcept.id);
    assert.equal(orphan?.counts.practiceCards, 1);
    assert.equal(orphan?.counts.practiceAttempts, 1);
    const target = status.targets.find((item) => item.conceptId === targetConcept.id);
    assert.equal(target?.counts.practiceCards, undefined);
    const link = store.previewIdentityLink({ fromConceptId: oldConcept.id, toConceptId: targetConcept.id }, SOURCE, [targetConcept]);
    assert.equal(link.canLink, true);

    store.addPracticeCard(detailCard({ eventId: 'target-practice-card', cardId: 'target-practice', sources: [{ conceptId: targetConcept.id, sourceRevision: targetConcept.source.revision }] }), [oldConcept, targetConcept]);
    const blocked = store.previewIdentityLink({ fromConceptId: oldConcept.id, toConceptId: targetConcept.id }, SOURCE, [targetConcept]);
    assert.equal(blocked.canLink, false);
    assert.equal(blocked.issues.some((issue) => issue.code === 'IDENTITY_TARGET_HAS_HISTORY'), true);
  } finally {
    fixtureData.cleanup();
  }
});
