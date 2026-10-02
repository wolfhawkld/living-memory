import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildPracticeCards } from '../src/core/practice.js';
import type { Concept } from '../src/shared/types.js';
import type { PracticeCardEvent, PracticeAttempt } from '../src/shared/practice.js';

const at = '2026-01-02T00:00:00.000Z';
const concept: Concept = { id: 'c', title: 'Concept', aliases: [], domain: 'Math', summary: '', body: '', source: { path: 'c.md', revision: 'v1' } };
const card: PracticeCardEvent = { eventId: 'z', cardId: 'card', previousEventId: null, occurredAt: at, recordedAt: at,
  kind: 'detail', title: 'Question', prompt: 'What are the conditions?', referenceAnswer: 'Check the conditions.', referenceNotes: '',
  sources: [{ conceptId: 'c', sourceRevision: 'v1' }], sourceChecked: true, paused: false };
const attempt: PracticeAttempt = { eventId: 'answer', cardId: 'card', cardEventId: 'z', answeredAt: at, recordedAt: at,
  answer: 'Own answer', confidence: null, confidenceAt: null, exposure: 'unknown', observedExposure: false,
  cue: 'unknown', outcome: 'unverified', checkNotes: '' };

test('practice projection follows the revision chain when timestamps and lexical event ordering tie', () => {
  const next = { ...card, eventId: 'a', previousEventId: 'z', prompt: 'A different detail' };
  const data = { cards: [next, card], attempts: [attempt] };
  const before = structuredClone(data);
  const view = buildPracticeCards(data, [concept]);
  assert.equal(view.length, 1);
  assert.equal(view[0].card.eventId, 'a');
  assert.equal(view[0].totalAttempts, 1);
  assert.equal(view[0].currentAttempts, 0);
  assert.equal(view[0].latest, null);
  assert.deepEqual(data, before);
});

test('source changes and disappearance preserve history without promoting old attempts to current evidence', () => {
  const data = { cards: [card], attempts: [attempt] };
  const ready = buildPracticeCards(data, [concept])[0];
  assert.equal(ready.status, 'ready');
  assert.equal(ready.currentAttempts, 1);
  assert.equal(ready.latest?.answer, 'Own answer');
  const changed = buildPracticeCards(data, [{ ...concept, source: { ...concept.source, revision: 'v2' } }])[0];
  assert.equal(changed.status, 'source-changed');
  assert.equal(changed.currentAttempts, 0);
  assert.equal(changed.totalAttempts, 1);
  const missing = buildPracticeCards(data, [])[0];
  assert.equal(missing.status, 'source-missing');
  assert.deepEqual(missing.currentSources, [null]);
  assert.equal(missing.totalAttempts, 1);
});

test('comparison readiness checks every source and never confuses pause with available practice', () => {
  const comparison = { ...card, kind: 'comparison' as const, sources: [...card.sources, { conceptId: 'other', sourceRevision: 'v2' }] };
  assert.equal(buildPracticeCards({ cards: [comparison], attempts: [] }, [concept])[0].status, 'source-missing');
  const paused = buildPracticeCards({ cards: [{ ...card, paused: true }], attempts: [] }, [concept])[0];
  assert.equal(paused.status, 'paused');
});
