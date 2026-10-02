import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildPracticeCards } from '../src/core/practice.js';
import type { Concept } from '../src/shared/types.js';
import type { PracticeAttempt, PracticeCardEvent } from '../src/shared/practice.js';

const at = '2026-01-02T00:00:00.000Z';
const concept: Concept = { id: 'c', title: 'Concept', aliases: [], domain: 'Math', summary: '', body: '', source: { path: 'c.md', revision: 'v1' } };
const card = (eventId: string, cardId: string, family: string, previousEventId: string | null = null): PracticeCardEvent => ({
  eventId, cardId, previousEventId, occurredAt: at, recordedAt: at, kind: 'scenario',
  title: 'A situation', prompt: 'Which approach fits?', referenceAnswer: 'Check its assumptions', referenceNotes: '',
  sources: [{ conceptId: 'c', sourceRevision: 'v1' }], sourceChecked: true, paused: false,
  scenario: { caseFamily: family, structureHint: 'Think of dependencies', nameHint: 'A candidate' },
});
const attempt = (version: PracticeCardEvent, eventId: string): PracticeAttempt => ({
  eventId, cardId: version.cardId, cardEventId: version.eventId, answeredAt: at, recordedAt: at,
  answer: 'Original', confidence: null, confidenceAt: null, exposure: 'unknown', observedExposure: false,
  cue: 'unknown', outcome: 'unverified', checkNotes: '', scenario: {
    stages: [{ stage: 'independent', answer: 'Original', answeredAt: at, hintShownAt: null,
      recallOutcome: 'partial', applicabilityOutcome: 'failure' }],
    caseExposure: 'unknown', observedCaseExposure: false,
  },
});

test('scenario family history follows the family of the answered version and never moves old grades to a new version', () => {
  const old = card('old', 'case-a', 'family-before');
  const revised = card('current', 'case-a', 'family-after', 'old');
  const neighbor = card('neighbor', 'case-b', 'family-before');
  const newNeighbor = card('new-neighbor', 'case-c', 'family-after');
  const data = { cards: [old, revised, neighbor, newNeighbor], attempts: [attempt(old, 'answer-a'), attempt(neighbor, 'answer-b')] };
  const before = structuredClone(data);
  const views = buildPracticeCards(data, [concept]);
  const current = views.find((view) => view.card.cardId === 'case-a')!;
  assert.deepEqual(current.scenarioHistory, { sameCardAttempts: 1, sameFamilyAttempts: 0 });
  assert.equal(current.currentAttempts, 0);
  assert.equal(current.latest, null);
  assert.deepEqual(views.find((view) => view.card.cardId === 'case-b')?.scenarioHistory, { sameCardAttempts: 1, sameFamilyAttempts: 2 });
  assert.deepEqual(views.find((view) => view.card.cardId === 'case-c')?.scenarioHistory, { sameCardAttempts: 0, sameFamilyAttempts: 0 });
  assert.deepEqual(data, before);
  // Source changes suppress current evidence but do not erase known case exposure.
  const changed = buildPracticeCards(data, [{ ...concept, source: { ...concept.source, revision: 'v2' } }]);
  const sibling = changed.find((view) => view.card.cardId === 'case-b')!;
  assert.equal(sibling.status, 'source-changed');
  assert.equal(sibling.currentAttempts, 0);
  assert.deepEqual(sibling.scenarioHistory, { sameCardAttempts: 1, sameFamilyAttempts: 2 });
});

test('family labels use exact manual labels, and legacy detail cards have no scenario metadata', () => {
  const known = card('known', 'case', 'Same');
  const caseDifferent = card('different', 'other', 'same');
  const { scenario: _scenario, ...base } = card('detail', 'detail', 'Same');
  const legacy: PracticeCardEvent = { ...base, kind: 'detail' };
  const views = buildPracticeCards({ cards: [known, caseDifferent, legacy], attempts: [attempt(known, 'answer')] }, [concept]);
  assert.equal(views.find((view) => view.card.cardId === 'other')?.scenarioHistory?.sameFamilyAttempts, 0);
  assert.equal(Object.hasOwn(views.find((view) => view.card.cardId === 'detail')!, 'scenarioHistory'), false);
});
