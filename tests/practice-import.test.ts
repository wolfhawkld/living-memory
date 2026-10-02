import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildImportPlan } from '../src/server/import-plan.js';
import type { PracticeAttempt, PracticeCardEvent, PracticeData } from '../src/shared/practice.js';
import type { Concept, ExportData } from '../src/shared/types.js';
import { MODEL_VERSION } from '../src/shared/types.js';

const now = '2026-01-10T00:00:00.000Z';
const liveConcept: Concept = {
  id: 'live-alpha', title: 'Alpha', aliases: [], domain: 'Math', summary: 'summary', body: 'body',
  source: { path: 'Alpha.md', revision: 'rev-2' },
};

function card(overrides: Partial<PracticeCardEvent> = {}): PracticeCardEvent {
  return {
    eventId: 'card-event-1', cardId: 'card-alpha', previousEventId: null,
    occurredAt: '2026-01-01T00:00:00.000Z', recordedAt: '2026-01-01T00:01:00.000Z',
    kind: 'detail', title: 'Title', prompt: 'Prompt', referenceAnswer: 'Answer', referenceNotes: 'Notes',
    sources: [{ conceptId: liveConcept.id, sourceRevision: 'rev-1' }], sourceChecked: true, paused: false,
    ...overrides,
  };
}

function attempt(overrides: Partial<PracticeAttempt> = {}): PracticeAttempt {
  return {
    eventId: 'attempt-1', cardId: 'card-alpha', cardEventId: 'card-event-1',
    answeredAt: '2026-01-02T00:00:00.000Z', recordedAt: '2026-01-02T00:01:00.000Z',
    answer: 'my answer', confidence: 70, confidenceAt: '2026-01-02T00:00:00.000Z',
    exposure: 'unexposed', observedExposure: false, cue: 'independent', outcome: 'success', checkNotes: 'checked',
    ...overrides,
  };
}

function base(overrides: Partial<ExportData> = {}): ExportData {
  return {
    schemaVersion: 1,
    exportedAt: '2026-01-09T00:00:00.000Z',
    source: { name: 'synthetic', mode: 'local', conceptCount: 1, limit: 10, diagnostics: [] },
    concepts: [{ id: liveConcept.id, title: 'Alpha', source: { path: 'Alpha.md', revision: 'rev-1' } }],
    config: { modelVersion: MODEL_VERSION, halfLifeDays: 7, revision: 1 },
    configHistory: [{ modelVersion: MODEL_VERSION, halfLifeDays: 7, revision: 1 }],
    anchors: [], observations: [], retentions: [], applications: [], corrections: [], layout: {},
    practice: { cards: [card()], attempts: [attempt()] },
    ...overrides,
  };
}

function current(overrides: Partial<ExportData> = {}): ExportData {
  return base({
    exportedAt: '2026-01-09T12:00:00.000Z',
    concepts: [{ id: liveConcept.id, title: liveConcept.title, source: liveConcept.source }],
    practice: undefined,
    ...overrides,
  });
}

function plan(data: ExportData, currentData = current()) {
  return buildImportPlan({
    data, current: currentData, concepts: [liveConcept], sourceId: 'target-source', now,
    options: { restoreLayout: false, restoreReviewPlan: false },
  });
}

test('round-trips practice cards and attempts, maps every source, and preserves history', () => {
  const prepared = plan(base());
  assert.equal(prepared.preview.canImport, true, JSON.stringify(prepared.preview.issues));
  assert.equal(prepared.preview.counts.practiceCards, 1);
  assert.equal(prepared.preview.counts.practiceAttempts, 1);
  assert.equal(prepared.newPracticeCards[0].sources[0].conceptId, liveConcept.id);
  assert.equal(prepared.newPracticeCards[0].sources[0].sourceRevision, 'rev-1');
  assert.equal(prepared.normalized.practice?.cards[0].sources[0].conceptId, liveConcept.id);
  assert.ok(prepared.preview.issues.some((issue) => issue.code === 'PRACTICE_SOURCE_REVISION_CHANGED'));
  assert.equal(prepared.newPracticeAttempts[0].cardEventId, prepared.newPracticeCards[0].eventId);
});

test('blocks an imported comparison card that repeats one concept at different revisions during preview', () => {
  const duplicateConceptSources = base({
    practice: {
      cards: [card({
        kind: 'comparison',
        sources: [
          { conceptId: liveConcept.id, sourceRevision: 'rev-1' },
          { conceptId: liveConcept.id, sourceRevision: 'rev-2' },
        ],
      })],
      attempts: [],
    },
  });
  const prepared = plan(duplicateConceptSources);
  assert.equal(prepared.preview.canImport, false);
  assert.ok(prepared.preview.issues.some((issue) => issue.code === 'PRACTICE_SOURCE_DUPLICATE_CONCEPT' && issue.severity === 'error'));
  assert.deepEqual(prepared.newPracticeCards, []);
});

test('blocks a source mapping that collapses two distinct backup concepts into one live concept', () => {
  const data = base({
    concepts: [
      { id: liveConcept.id, title: liveConcept.title, source: liveConcept.source },
      { id: 'backup-alpha', title: 'Alpha alias', source: { path: liveConcept.source.path, revision: liveConcept.source.revision } },
    ],
    practice: {
      cards: [card({
        kind: 'comparison',
        sources: [
          { conceptId: liveConcept.id, sourceRevision: liveConcept.source.revision },
          { conceptId: 'backup-alpha', sourceRevision: liveConcept.source.revision },
        ],
      })],
      attempts: [],
    },
  });
  const prepared = plan(data);
  assert.equal(prepared.preview.canImport, false);
  assert.ok(prepared.preview.issues.some((issue) => issue.code === 'PRACTICE_SOURCE_MAPPING_COLLISION' && issue.severity === 'error'));
});

test('appends after the current card tail and skips exact historical duplicates', () => {
  const root = card();
  const tail = card({ eventId: 'card-event-2', previousEventId: root.eventId, occurredAt: '2026-01-03T00:00:00.000Z', recordedAt: '2026-01-03T00:01:00.000Z' });
  const currentData = current({ practice: { cards: [root, tail], attempts: [] } });
  const data = base({
    practice: {
      cards: [tail, card({ eventId: 'card-event-3', previousEventId: tail.eventId, occurredAt: '2026-01-04T00:00:00.000Z', recordedAt: '2026-01-04T00:01:00.000Z', kind: 'comparison', sources: [
        { conceptId: liveConcept.id, sourceRevision: 'rev-1' }, { conceptId: liveConcept.id, sourceRevision: 'rev-1b' },
      ] })],
      attempts: [],
    },
  });
  // Comparison sources must be distinct concept versions; use a second live
  // manifest entry to keep this fixture synthetic and valid.
  data.concepts.push({ id: 'backup-beta', title: 'Beta', source: { path: 'Beta.md', revision: 'rev-1' } });
  data.practice!.cards[1].sources = [
    { conceptId: liveConcept.id, sourceRevision: 'rev-1' },
    { conceptId: 'backup-beta', sourceRevision: 'rev-1' },
  ];
  const beta: Concept = { ...liveConcept, id: 'live-beta', title: 'Beta', source: { path: 'Beta.md', revision: 'rev-1' } };
  const prepared = buildImportPlan({ data, current: currentData, concepts: [liveConcept, beta], sourceId: 'target-source', now, options: { restoreLayout: false, restoreReviewPlan: false } });
  assert.equal(prepared.preview.canImport, true, JSON.stringify(prepared.preview.issues));
  assert.equal(prepared.preview.counts.duplicates, 1);
  assert.deepEqual(prepared.newPracticeCards.map((item) => item.eventId), ['card-event-3']);
  assert.equal(prepared.newPracticeCards[0].kind, 'comparison');
});

test('recognizes a mapped practice duplicate after source lexical order reverses', () => {
  const targetA: Concept = { ...liveConcept, id: 'live-a', title: 'A', source: { path: 'A.md', revision: 'rev-1' } };
  const targetZ: Concept = { ...liveConcept, id: 'live-z', title: 'Z', source: { path: 'Z.md', revision: 'rev-1' } };
  const donorCard = card({
    eventId: 'mapped-card-event', cardId: 'mapped-card', kind: 'comparison',
    sources: [
      { conceptId: 'backup-a', sourceRevision: 'rev-1' },
      { conceptId: 'backup-z', sourceRevision: 'rev-1' },
    ],
  });
  const data = base({
    concepts: [
      { id: 'backup-a', title: 'Backup A', source: { path: 'Z.md', revision: 'rev-1' } },
      { id: 'backup-z', title: 'Backup Z', source: { path: 'A.md', revision: 'rev-1' } },
    ],
    practice: { cards: [donorCard], attempts: [] },
  });
  const targetBase = current({
    concepts: [
      { id: targetA.id, title: targetA.title, source: targetA.source },
      { id: targetZ.id, title: targetZ.title, source: targetZ.source },
    ],
    practice: undefined,
  });
  const first = buildImportPlan({
    data,
    current: targetBase,
    concepts: [targetA, targetZ],
    sourceId: 'target-source',
    now,
    options: { restoreLayout: false, restoreReviewPlan: false },
  });
  assert.equal(first.preview.canImport, true, JSON.stringify(first.preview.issues));
  assert.deepEqual(first.newPracticeCards[0].sources, [
    { conceptId: targetA.id, sourceRevision: targetA.source.revision },
    { conceptId: targetZ.id, sourceRevision: targetZ.source.revision },
  ]);

  const second = buildImportPlan({
    data,
    current: { ...targetBase, practice: { cards: first.newPracticeCards, attempts: [] } },
    concepts: [targetA, targetZ],
    sourceId: 'target-source',
    now,
    options: { restoreLayout: false, restoreReviewPlan: false },
  });
  assert.equal(second.preview.canImport, true, JSON.stringify(second.preview.issues));
  assert.equal(second.preview.counts.duplicates, 1);
  assert.deepEqual(second.newPracticeCards, []);
});

test('rejects card forks, missing parents, and cycles before writing', () => {
  const root = card();
  const tail = card({ eventId: 'card-event-2', previousEventId: root.eventId });
  const fork = base({ practice: { cards: [card({ eventId: 'card-event-3', previousEventId: root.eventId })], attempts: [] } });
  const forkPlan = plan(fork, current({ practice: { cards: [root, tail], attempts: [] } }));
  assert.equal(forkPlan.preview.canImport, false);
  assert.ok(forkPlan.preview.issues.some((issue) => issue.code === 'PRACTICE_CARD_APPEND_INVALID'));

  const missing = plan(base({ practice: { cards: [card({ previousEventId: 'missing-parent' })], attempts: [] } }));
  assert.equal(missing.preview.canImport, false);
  assert.ok(missing.preview.issues.some((issue) => issue.code === 'PRACTICE_CARD_PREVIOUS_NOT_FOUND'));

  const cycle = plan(base({ practice: { cards: [
    card({ eventId: 'cycle-a', previousEventId: 'cycle-b' }),
    card({ eventId: 'cycle-b', previousEventId: 'cycle-a' }),
  ], attempts: [] } }));
  assert.equal(cycle.preview.canImport, false);
  assert.ok(cycle.preview.issues.some((issue) => issue.code === 'PRACTICE_CARD_CYCLE'));
});

test('rejects a revision whose occurredAt moves backward from its parent', () => {
  const root = card();
  const backwards = card({
    eventId: 'card-event-backwards', previousEventId: root.eventId,
    occurredAt: '2025-12-31T00:00:00.000Z', recordedAt: '2025-12-31T00:01:00.000Z',
  });
  const prepared = plan(base({ practice: { cards: [root, backwards], attempts: [] } }));
  assert.equal(prepared.preview.canImport, false);
  assert.ok(prepared.preview.issues.some((issue) => issue.code === 'PRACTICE_CARD_BEFORE_PREVIOUS'));
});

test('keeps unresolved source history as a warning and blocks paused-card attempts', () => {
  const unresolved = base({
    concepts: [{ id: 'backup-unknown', title: 'Unknown', source: { path: 'Unknown.md', revision: 'rev-1' } }],
    practice: { cards: [card({ sources: [{ conceptId: 'backup-unknown', sourceRevision: 'rev-1' }], paused: true })], attempts: [attempt()] },
  });
  const prepared = plan(unresolved);
  // The card is preserved, but this fixture's attempt is a newly imported
  // attempt on a paused revision, so the preview must block the transaction.
  assert.equal(prepared.preview.canImport, false);
  assert.ok(prepared.preview.issues.some((issue) => issue.code === 'PRACTICE_SOURCE_MISSING' && issue.severity === 'warning'));
  assert.ok(prepared.preview.issues.some((issue) => issue.code === 'PRACTICE_ATTEMPT_PAUSED_CARD'));
});

test('rejects cross-kind event IDs and stale tokens when practice changes', () => {
  const conflict = base({ anchors: [{
    eventId: 'card-event-1', conceptId: 'backup-alpha', sourceRevision: 'rev-1',
    occurredAt: '2026-01-01T00:00:00.000Z', recordedAt: '2026-01-01T00:01:00.000Z', kind: 'review',
  }] });
  const conflictPlan = plan(conflict);
  assert.equal(conflictPlan.preview.canImport, false);
  assert.ok(conflictPlan.preview.issues.some((issue) => issue.code === 'EVENT_CONFLICT'));

  const first = plan(base()).preview.token;
  const changed = plan(base({ practice: { cards: [card({ prompt: 'changed' })], attempts: [attempt()] } })).preview.token;
  assert.notEqual(first, changed);
});

test('accepts a legacy backup without practice and never invents practice counts', () => {
  const legacy = base();
  delete legacy.practice;
  const prepared = plan(legacy);
  assert.equal(prepared.preview.canImport, true);
  assert.equal(prepared.preview.counts.practiceCards, undefined);
  assert.equal(prepared.preview.counts.practiceAttempts, undefined);
  assert.equal(prepared.normalized.practice, undefined);
});
