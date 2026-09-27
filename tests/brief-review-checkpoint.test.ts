import assert from 'node:assert/strict';
import test from 'node:test';
import type { BriefReviewSession } from '../src/web/brief-review-session.js';
import {
  briefReviewCheckpointKey,
  clearBriefReviewCheckpoint,
  parseBriefReviewCheckpoint,
  readBriefReviewCheckpoint,
  serializeBriefReviewCheckpoint,
  writeBriefReviewCheckpoint,
  type BriefRecallAttempt,
  type BriefReviewCheckpoint,
  type BriefReviewCheckpointStorage,
} from '../src/web/brief-review-checkpoint.js';

class MemoryStorage implements BriefReviewCheckpointStorage {
  readonly values = new Map<string, string>();
  failGet = false;
  failSet = false;
  failRemove = false;
  getItem(key: string): string | null {
    if (this.failGet) throw new Error('get failed');
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.failSet) throw new Error('set failed');
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    if (this.failRemove) throw new Error('remove failed');
    this.values.delete(key);
  }
}

function session(): BriefReviewSession {
  return {
    id: 'session-a',
    sourceId: 'source-a',
    domainId: 'Cognition/Math',
    items: [
      { conceptId: 'concept-a', title: 'Concept A', sourceRevision: 'rev-a', status: 'stale', elapsedDays: 14, estimated: false, focus: true },
      { conceptId: 'concept-b', title: 'Concept B', sourceRevision: 'rev-b', status: 'revisit', elapsedDays: 7, estimated: true },
    ],
    index: 0,
    results: {},
    reviews: {},
  };
}

function attempt(): BriefRecallAttempt {
  const learning = {
    task: 'concept' as const,
    confidence: 75,
    confidenceAt: '2026-09-27T09:59:00.000Z',
    cue: 'independent' as const,
    outcome: 'partial' as const,
    basis: 'self-check' as const,
  };
  return {
    conceptId: 'concept-a',
    eventId: 'recall-event-a',
    answer: '自己的回忆答案，保留在当前浏览器断点。',
    startedAt: '2026-09-27T09:58:00.000Z',
    observedAt: '2026-09-27T10:00:00.000Z',
    configRevision: 3,
    anchorEventId: 'anchor-a',
    sourceRevision: 'rev-a',
    sourceViewedBefore: false,
    stage: 'feedback',
    rating: 'partial',
    exposure: 'unexposed',
    learning,
    submittedPayload: {
      eventId: 'recall-event-a',
      conceptId: 'concept-a',
      sourceRevision: 'rev-a',
      observedAt: '2026-09-27T10:00:00.000Z',
      configRevision: 3,
      anchorEventId: 'anchor-a',
      answer: '自己的回忆答案，保留在当前浏览器断点。',
      rating: 'partial',
      exposure: 'unexposed',
      observedExposure: false,
      learning,
    },
  };
}

function checkpoint(overrides: Partial<BriefReviewCheckpoint> = {}): BriefReviewCheckpoint {
  return {
    version: 1,
    savedAt: '2026-09-27T10:01:00.000Z',
    session: session(),
    attempt: attempt(),
    ...overrides,
  };
}

test('serializes and restores a source-bound full draft with fixed event, confidence time, payload, and review request', () => {
  const value = checkpoint();
  const raw = serializeBriefReviewCheckpoint('source-a', value);
  const restored = parseBriefReviewCheckpoint(raw, 'source-a');
  assert.deepEqual(restored, value);
  assert.equal(restored?.attempt?.eventId, 'recall-event-a');
  assert.equal(restored?.attempt?.learning.confidenceAt, '2026-09-27T09:59:00.000Z');
  assert.equal(restored?.attempt?.submittedPayload?.eventId, 'recall-event-a');
});

test('restores queued confirmation after a saved observation, but never synthesizes confirmation for skipped items or an unfinished attempt', () => {
  const value = checkpoint({
    session: { ...session(), results: { 'concept-a': 'saved' }, reviews: { 'concept-a': 'queued' } },
    attempt: null,
    reviewRequest: {
      eventId: 'review-event-a', conceptId: 'concept-a', sourceRevision: 'rev-a', kind: 'review', occurredAt: '2026-09-27T10:02:00.000Z',
    },
  });
  const restored = parseBriefReviewCheckpoint(serializeBriefReviewCheckpoint('source-a', value), 'source-a');
  assert.deepEqual(restored, value);

  const skipped = { ...value, session: { ...value.session, results: { 'concept-a': 'skipped' as const } } };
  assert.throws(() => serializeBriefReviewCheckpoint('source-a', skipped));
  const unavailable = { ...value, session: { ...value.session, results: { 'concept-a': 'unavailable' as const } } };
  assert.throws(() => serializeBriefReviewCheckpoint('source-a', unavailable));
  const unfinished = { ...value, attempt: attempt() };
  assert.throws(() => serializeBriefReviewCheckpoint('source-a', unfinished));
});

test('storage is isolated by source and read never writes or silently clears damaged data', () => {
  const storage = new MemoryStorage();
  const raw = serializeBriefReviewCheckpoint('source-a', checkpoint());
  writeBriefReviewCheckpoint('source-a', checkpoint(), storage);
  assert.deepEqual(readBriefReviewCheckpoint('source-a', storage), checkpoint());
  assert.equal(readBriefReviewCheckpoint('source-b', storage), null);
  storage.setItem(briefReviewCheckpointKey('source-b'), raw);
  assert.throws(() => readBriefReviewCheckpoint('source-b', storage), /断点存储已损坏/, 'the envelope source ID prevents copied cache reuse');

  const key = briefReviewCheckpointKey('source-a');
  storage.setItem(key, '{damaged');
  assert.throws(() => readBriefReviewCheckpoint('source-a', storage), /断点存储已损坏/);
  assert.equal(storage.values.get(key), '{damaged', 'read does not overwrite or clear a damaged cache');
});

test('strict validation rejects tampered structure, inconsistent submitted attempts, and completed-item drafts', () => {
  const raw = serializeBriefReviewCheckpoint('source-a', checkpoint());
  const unknownField = JSON.parse(raw) as Record<string, unknown>;
  unknownField.extra = true;
  assert.equal(parseBriefReviewCheckpoint(JSON.stringify(unknownField), 'source-a'), null);

  const duplicateItems = JSON.parse(raw) as Record<string, any>;
  duplicateItems.session.items[1].conceptId = 'concept-a';
  assert.equal(parseBriefReviewCheckpoint(JSON.stringify(duplicateItems), 'source-a'), null);

  const unknownResult = JSON.parse(raw) as Record<string, any>;
  unknownResult.session.results['not-an-item'] = 'saved';
  assert.equal(parseBriefReviewCheckpoint(JSON.stringify(unknownResult), 'source-a'), null);

  const mismatchedPayload = JSON.parse(raw) as Record<string, any>;
  mismatchedPayload.attempt.submittedPayload.eventId = 'different-event';
  assert.equal(parseBriefReviewCheckpoint(JSON.stringify(mismatchedPayload), 'source-a'), null);

  const completedAttempt = JSON.parse(raw) as Record<string, any>;
  completedAttempt.session.results['concept-a'] = 'saved';
  assert.equal(parseBriefReviewCheckpoint(JSON.stringify(completedAttempt), 'source-a'), null);

  const invalidReview = checkpoint({ reviewRequest: {
    eventId: 'review-event-a', conceptId: 'concept-a', sourceRevision: 'rev-a', kind: 'estimated' as 'review', occurredAt: '2026-09-27T10:02:00.000Z',
  } });
  assert.throws(() => serializeBriefReviewCheckpoint('source-a', invalidReview));
  assert.equal(parseBriefReviewCheckpoint(raw, 'source-b'), null);
});

test('keeps legitimate intermediate prediction and feedback drafts without treating them as submitted payloads', () => {
  const prediction = attempt();
  prediction.stage = 'prediction';
  prediction.eventId = null;
  prediction.answer = '';
  prediction.observedAt = null;
  prediction.configRevision = null;
  prediction.rating = null;
  prediction.learning = {
    task: 'concept', confidence: 75, confidenceAt: null,
    cue: 'unknown', outcome: 'unverified', basis: 'unknown',
  };
  delete prediction.submittedPayload;
  const feedback = { ...prediction,
    stage: 'feedback' as const,
    eventId: null,
    observedAt: '2026-09-27T10:00:00.000Z',
    configRevision: 3,
    rating: 'clear' as const,
    learning: { ...prediction.learning, outcome: 'success' as const },
  };
  const predictionCheckpoint = checkpoint({ attempt: prediction });
  const feedbackCheckpoint = checkpoint({ attempt: feedback });
  assert.ok(parseBriefReviewCheckpoint(serializeBriefReviewCheckpoint('source-a', predictionCheckpoint), 'source-a')?.attempt);
  assert.ok(parseBriefReviewCheckpoint(serializeBriefReviewCheckpoint('source-a', feedbackCheckpoint), 'source-a')?.attempt);
});

test('storage failures are surfaced to the caller for read, write, and clear', () => {
  const storage = new MemoryStorage();
  storage.failGet = true;
  assert.throws(() => readBriefReviewCheckpoint('source-a', storage), /get failed/);
  storage.failGet = false;
  storage.failSet = true;
  assert.throws(() => writeBriefReviewCheckpoint('source-a', checkpoint(), storage), /set failed/);
  storage.failSet = false;
  writeBriefReviewCheckpoint('source-a', checkpoint(), storage);
  storage.failRemove = true;
  assert.throws(() => clearBriefReviewCheckpoint('source-a', storage), /remove failed/);
  storage.failRemove = false;
  clearBriefReviewCheckpoint('source-a', storage);
  assert.equal(readBriefReviewCheckpoint('source-a', storage), null);
});
