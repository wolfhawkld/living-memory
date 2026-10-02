import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildImportPlan } from '../src/server/import-plan.js';
import { parsePracticeData } from '../src/server/practice-import.js';
import type { PracticeAttempt, PracticeCardEvent } from '../src/shared/practice.js';
import type { Concept, ExportData } from '../src/shared/types.js';
import { MODEL_VERSION } from '../src/shared/types.js';

const now = '2026-01-10T00:00:00.000Z';
const liveConcept: Concept = {
  id: 'live-alpha', title: 'Alpha', aliases: [], domain: 'test', summary: 'summary', body: 'body',
  source: { path: 'Alpha.md', revision: 'rev-1' },
};

function card(overrides: Partial<PracticeCardEvent> = {}): PracticeCardEvent {
  return {
    eventId: 'scenario-card-event', cardId: 'scenario-card', previousEventId: null,
    occurredAt: '2026-01-01T00:00:00.000Z', recordedAt: '2026-01-01T00:01:00.000Z', kind: 'scenario',
    title: 'Scenario', prompt: 'What fits?', referenceAnswer: 'Alpha', referenceNotes: '',
    sources: [{ conceptId: liveConcept.id, sourceRevision: 'rev-1' }], sourceChecked: true, paused: false,
    scenario: { caseFamily: 'family-a', structureHint: 'Use the dependency shape.', nameHint: 'Alpha' },
    ...overrides,
  };
}

function attempt(overrides: Partial<PracticeAttempt> = {}): PracticeAttempt {
  return {
    eventId: 'scenario-attempt-event', cardId: 'scenario-card', cardEventId: 'scenario-card-event',
    answeredAt: '2026-01-01T00:02:00.000Z', recordedAt: '2026-01-01T00:06:00.000Z',
    answer: 'Initial', confidence: 80, confidenceAt: '2026-01-01T00:01:00.000Z',
    exposure: 'unknown', observedExposure: true, cue: 'unknown', outcome: 'unverified', checkNotes: '',
    scenario: {
      stages: [
        { stage: 'independent', answer: 'Initial', answeredAt: '2026-01-01T00:02:00.000Z', hintShownAt: null, recallOutcome: 'partial', applicabilityOutcome: 'failure' },
        { stage: 'structure', answer: 'Dependency shape', answeredAt: '2026-01-01T00:04:00.000Z', hintShownAt: '2026-01-01T00:03:00.000Z', recallOutcome: 'success', applicabilityOutcome: 'partial' },
        { stage: 'name', answer: 'Alpha', answeredAt: '2026-01-01T00:05:00.000Z', hintShownAt: '2026-01-01T00:04:30.000Z', recallOutcome: 'success', applicabilityOutcome: 'success' },
      ],
      caseExposure: 'unseen', observedCaseExposure: true,
    },
    ...overrides,
  };
}

function base(practice: { cards: PracticeCardEvent[]; attempts: PracticeAttempt[] }): ExportData {
  return {
    schemaVersion: 1,
    exportedAt: '2026-01-09T00:00:00.000Z',
    source: { name: 'synthetic', mode: 'local', conceptCount: 1, limit: 10, diagnostics: [] },
    concepts: [{ id: liveConcept.id, title: liveConcept.title, source: liveConcept.source }],
    config: { modelVersion: MODEL_VERSION, halfLifeDays: 7, revision: 1 },
    configHistory: [{ modelVersion: MODEL_VERSION, halfLifeDays: 7, revision: 1 }],
    anchors: [], observations: [], retentions: [], applications: [], corrections: [], layout: {},
    practice,
  };
}

function plan(data: ExportData) {
  return buildImportPlan({
    data, current: { ...base({ cards: [], attempts: [] }), practice: undefined }, concepts: [liveConcept],
    sourceId: 'target-source', now, options: { restoreLayout: false, restoreReviewPlan: false },
  });
}

test('import parser preserves scenario metadata, canonicalizes dates and floors cue/exposure', () => {
  const prepared = plan(base({ cards: [card()], attempts: [attempt()] }));
  assert.equal(prepared.preview.canImport, true, JSON.stringify(prepared.preview.issues));
  assert.deepEqual(prepared.normalized.practice?.cards[0].scenario, card().scenario);
  assert.deepEqual(prepared.normalized.practice?.attempts[0].scenario, { ...attempt().scenario!, caseExposure: 'seen' });
  assert.equal(prepared.normalized.practice?.attempts[0].cue, 'hinted');
  assert.equal(prepared.normalized.practice?.attempts[0].exposure, 'exposed');
  assert.equal(prepared.normalized.practice?.attempts[0].answeredAt, '2026-01-01T00:02:00.000Z');
  assert.equal(prepared.newPracticeCards[0].scenario?.caseFamily, 'family-a');
  assert.equal(prepared.newPracticeAttempts[0].scenario?.stages.length, 3);
});

test('import relation validation requires the actual card hint and matching scenario kind', () => {
  const noHint = plan(base({
    cards: [card({ scenario: { caseFamily: 'family-a', structureHint: '', nameHint: 'Alpha' } })], attempts: [attempt()],
  }));
  assert.equal(noHint.preview.canImport, false);
  assert.ok(noHint.preview.issues.some((issue) => issue.code === 'PRACTICE_SCENARIO_HINT_MISSING'));

  const detail = card({ kind: 'detail', eventId: 'detail-card-event', cardId: 'detail-card' });
  const { scenario: _scenario, ...detailCard } = detail;
  const mismatch = plan(base({
    cards: [{ ...detailCard, kind: 'detail' }],
    attempts: [attempt({ cardId: 'detail-card', cardEventId: 'detail-card-event' })],
  }));
  assert.equal(mismatch.preview.canImport, false);
  assert.ok(mismatch.preview.issues.some((issue) => issue.code === 'PRACTICE_SCENARIO_UNEXPECTED'));
});

test('import rejects stage times after recordedAt and allows skipping structure when the name hint exists', () => {
  const skipped = attempt({
    scenario: {
      stages: [
        attempt().scenario!.stages[0],
        { ...attempt().scenario!.stages[2], hintShownAt: '2026-01-01T00:03:00.000Z' },
      ],
      caseExposure: 'unknown', observedCaseExposure: false,
    },
    cue: 'independent',
  });
  const accepted = plan(base({ cards: [card()], attempts: [skipped] }));
  assert.equal(accepted.preview.canImport, true, JSON.stringify(accepted.preview.issues));
  assert.equal(accepted.normalized.practice?.attempts[0].cue, 'hinted');

  const late = attempt({ recordedAt: '2026-01-01T00:03:30.000Z' });
  const rejected = plan(base({ cards: [card()], attempts: [late] }));
  assert.equal(rejected.preview.canImport, false);
  assert.ok(rejected.preview.issues.some((issue) => issue.code === 'PRACTICE_SCENARIO_STAGE_AFTER_RECORDED'));
});

test('parsePracticeData does not invent scenario fields for legacy detail records', () => {
  const issues: Array<{ code: string }> = [];
  const legacyCard = card({ kind: 'detail', eventId: 'legacy-card-event', cardId: 'legacy-card' });
  const { scenario: _scenario, ...withoutScenario } = legacyCard;
  const parsed = parsePracticeData({ cards: [{ ...withoutScenario, kind: 'detail' }], attempts: [] }, Date.parse(now), { add(code) { issues.push({ code }); } });
  assert.ok(parsed);
  assert.equal(Object.hasOwn(parsed!.cards[0], 'scenario'), false);
  assert.deepEqual(issues, []);
});
