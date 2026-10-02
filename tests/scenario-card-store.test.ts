import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parsePracticeAttemptRequest, parsePracticeCardRequest } from '../src/server/practice-validation.js';
import { Store, StoreError } from '../src/server/store.js';
import type { PracticeAttemptRequest, PracticeCardRequest } from '../src/shared/practice.js';
import type { Concept } from '../src/shared/types.js';

const NOW = '2026-01-05T00:10:00.000Z';
const SOURCE = { name: 'synthetic', mode: 'local' as const, conceptCount: 1, limit: 10, diagnostics: [] };

const concept: Concept = {
  id: 'alpha', title: 'Alpha', aliases: [], domain: 'test', summary: 'summary', body: 'body',
  source: { path: 'alpha.md', revision: 'rev-1' },
};

function card(overrides: Partial<PracticeCardRequest> = {}): PracticeCardRequest {
  return {
    eventId: 'scenario-card-event', cardId: 'scenario-card', previousEventId: null,
    occurredAt: '2026-01-01T00:00:00Z', kind: 'scenario', title: 'Scenario', prompt: 'What fits?',
    referenceAnswer: 'Use the dependency-aware method.', referenceNotes: '',
    sources: [{ conceptId: concept.id, sourceRevision: concept.source.revision }], sourceChecked: true,
    paused: false,
    scenario: { caseFamily: 'family-a', structureHint: 'Look at the dependency shape.', nameHint: 'Candidate Alpha' },
    ...overrides,
  };
}

function attempt(overrides: Partial<PracticeAttemptRequest> = {}): PracticeAttemptRequest {
  return {
    eventId: 'scenario-attempt-event', cardId: 'scenario-card', cardEventId: 'scenario-card-event',
    answeredAt: '2026-01-01T00:01:00Z', answer: 'Initial answer', confidence: 70,
    confidenceAt: '2026-01-01T00:00:30Z', exposure: 'unknown', observedExposure: true,
    cue: 'unknown', outcome: 'unverified', checkNotes: '',
    scenario: {
      stages: [
        { stage: 'independent', answer: 'Initial answer', answeredAt: '2026-01-01T00:01:00Z', hintShownAt: null, recallOutcome: 'partial', applicabilityOutcome: 'failure' },
        { stage: 'structure', answer: 'Dependency shape', answeredAt: '2026-01-01T00:03:00Z', hintShownAt: '2026-01-01T00:02:00Z', recallOutcome: 'success', applicabilityOutcome: 'partial' },
        { stage: 'name', answer: 'Alpha', answeredAt: '2026-01-01T00:05:00Z', hintShownAt: '2026-01-01T00:04:00Z', recallOutcome: 'success', applicabilityOutcome: 'success' },
      ],
      caseExposure: 'unseen', observedCaseExposure: true,
    },
    ...overrides,
  };
}

function fixture(namespace = 'scenario-store') {
  const dataDir = mkdtempSync(join(tmpdir(), `${namespace}-`));
  let currentNow = NOW;
  const store = new Store({ dataDir, namespace, now: () => new Date(currentNow) });
  return {
    store,
    dataDir,
    setNow(value: string) { currentNow = value; },
    cleanup() { try { store.close(); } catch { /* already closed */ } rmSync(dataDir, { recursive: true, force: true }); },
  };
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

test('scenario card and staged attempt persist, round-trip, and keep old practice shapes stable', () => {
  const data = fixture();
  try {
    const { store } = data;
    const scenarioCard = card();
    assert.deepEqual(store.addPracticeCard(scenarioCard, [concept]), { status: 'accepted', eventId: scenarioCard.eventId });
    const storedCard = store.getPracticeCard(scenarioCard.cardId);
    assert.deepEqual(storedCard, { ...scenarioCard, occurredAt: '2026-01-01T00:00:00.000Z', recordedAt: NOW });

    const scenarioAttempt = attempt();
    assert.deepEqual(store.addPracticeAttempt(scenarioAttempt, [concept]), { status: 'accepted', eventId: scenarioAttempt.eventId });
    const storedAttempt = store.getPracticeData().attempts[0];
    assert.equal(storedAttempt.cue, 'hinted');
    assert.equal(storedAttempt.scenario?.caseExposure, 'seen');
    assert.deepEqual(storedAttempt.scenario?.stages, parsePracticeAttemptRequest(scenarioAttempt).scenario?.stages);
    assert.deepEqual(store.exportData(SOURCE, [concept]).practice, store.getPracticeData());

    const duplicate = store.addPracticeAttempt(scenarioAttempt, [concept]);
    assert.deepEqual(duplicate, { status: 'duplicate', eventId: scenarioAttempt.eventId });
    store.close();
    const restarted = new Store({ dataDir: data.dataDir, namespace: 'scenario-store', now: () => new Date(NOW) });
    assert.deepEqual(restarted.getPracticeData().attempts[0], storedAttempt);
    restarted.close();
  } finally {
    data.cleanup();
  }
});

test('scenario parser and store enforce hint availability, stage shape, and non-scenario isolation', () => {
  const data = fixture('scenario-contract');
  try {
    assert.throws(() => parsePracticeCardRequest({ ...card({ kind: 'detail', scenario: undefined }), scenario: {} }), /非 scenario/);
    assert.throws(() => parsePracticeAttemptRequest(attempt({ outcome: 'success' })), /unverified/);
    assert.throws(() => parsePracticeAttemptRequest(attempt({
      scenario: { ...attempt().scenario!, stages: [attempt().scenario!.stages[0], { ...attempt().scenario!.stages[0], stage: 'independent', hintShownAt: '2026-01-01T00:02:00Z' }] },
    })), /唯一且严格升序|independent/);

    const { store } = data;
    const noStructureHint = card({ eventId: 'no-structure-card', cardId: 'no-structure-card', scenario: { caseFamily: 'family-b', structureHint: '', nameHint: 'name' } });
    store.addPracticeCard(noStructureHint, [concept]);
    assert.throws(() => store.addPracticeAttempt(attempt({ eventId: 'no-structure-attempt', cardId: noStructureHint.cardId, cardEventId: noStructureHint.eventId }), [concept]), (error: unknown) => error instanceof StoreError && error.code === 'PRACTICE_SCENARIO_HINT_MISSING');

    const { scenario: _scenario, ...detailBase } = card({ eventId: 'detail-card', cardId: 'detail-card', kind: 'detail' });
    const detail = { ...detailBase, kind: 'detail' as const };
    store.addPracticeCard(detail, [concept]);
    assert.throws(() => store.addPracticeAttempt(attempt({ eventId: 'detail-attempt', cardId: detail.cardId, cardEventId: detail.eventId } as PracticeAttemptRequest), [concept]), (error: unknown) => error instanceof StoreError && error.code === 'PRACTICE_SCENARIO_MISMATCH');
    assert.equal(Object.hasOwn(store.getPracticeCard(detail.cardId)!, 'scenario'), false);
    assert.equal(Object.hasOwn(store.getPracticeData().attempts.find((item) => item.cardId === detail.cardId) ?? {}, 'scenario'), false);
  } finally {
    data.cleanup();
  }
});

test('old practice schema migrates transactionally while preserving row order, sources, namespaces, and request receipts', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'scenario-schema-migration-'));
  const dbPath = join(dataDir, 'living-memory.sqlite');
  const rootRequest: PracticeCardRequest = {
    eventId: 'old-event-z', cardId: 'old-card', previousEventId: null,
    occurredAt: '2026-01-01T00:00:00Z', kind: 'detail' as const, title: 'Old root', prompt: 'Old prompt',
    referenceAnswer: 'Old answer', referenceNotes: '', sources: [{ conceptId: 'alpha', sourceRevision: 'rev-1' }], sourceChecked: true, paused: false,
  };
  const tailRequest = { ...rootRequest, eventId: 'old-event-a', previousEventId: rootRequest.eventId, title: 'Old tail' };
  const oldAttempt = {
    eventId: 'old-attempt', cardId: rootRequest.cardId, cardEventId: tailRequest.eventId,
    answeredAt: '2026-01-01T00:01:00Z', answer: 'old answer', confidence: null, confidenceAt: null,
    exposure: 'unknown' as const, observedExposure: false, cue: 'independent' as const, outcome: 'partial' as const, checkNotes: '',
  };
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE practice_cards (
      namespace TEXT NOT NULL, event_id TEXT NOT NULL, card_id TEXT NOT NULL, previous_event_id TEXT,
      occurred_at TEXT NOT NULL, recorded_at TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('detail', 'comparison')),
      title TEXT NOT NULL, prompt TEXT NOT NULL, reference_answer TEXT NOT NULL, reference_notes TEXT NOT NULL,
      sources_json TEXT NOT NULL, source_checked INTEGER NOT NULL CHECK(source_checked = 1),
      paused INTEGER NOT NULL CHECK(paused IN (0, 1)), request_payload TEXT NOT NULL,
      PRIMARY KEY(namespace, event_id)
    );
    CREATE TABLE practice_attempts (
      namespace TEXT NOT NULL, event_id TEXT NOT NULL, card_id TEXT NOT NULL, card_event_id TEXT NOT NULL,
      answered_at TEXT NOT NULL, recorded_at TEXT NOT NULL, answer TEXT NOT NULL, confidence INTEGER,
      confidence_at TEXT, exposure TEXT NOT NULL CHECK(exposure IN ('unexposed', 'exposed', 'unknown')),
      observed_exposure INTEGER NOT NULL CHECK(observed_exposure IN (0, 1)),
      cue TEXT NOT NULL CHECK(cue IN ('independent', 'hinted', 'lookup', 'unknown')),
      outcome TEXT NOT NULL CHECK(outcome IN ('success', 'partial', 'failure', 'unverified')),
      check_notes TEXT NOT NULL, request_payload TEXT NOT NULL,
      PRIMARY KEY(namespace, event_id)
    );
    CREATE TABLE practice_card_sources (
      namespace TEXT NOT NULL, card_event_id TEXT NOT NULL, card_id TEXT NOT NULL,
      concept_id TEXT NOT NULL, source_revision TEXT NOT NULL,
      PRIMARY KEY(namespace, card_event_id, concept_id),
      FOREIGN KEY(namespace, card_event_id) REFERENCES practice_cards(namespace, event_id) ON DELETE CASCADE
    );
    CREATE INDEX practice_cards_by_card ON practice_cards(namespace, card_id, occurred_at, recorded_at, event_id);
    CREATE INDEX practice_attempts_by_card ON practice_attempts(namespace, card_id, answered_at, recorded_at, event_id);
    CREATE INDEX practice_sources_by_concept ON practice_card_sources(namespace, concept_id, card_event_id);
    CREATE TABLE import_receipts (
      namespace TEXT NOT NULL, import_id TEXT NOT NULL, request_hash TEXT NOT NULL, receipt_json TEXT NOT NULL,
      PRIMARY KEY(namespace, import_id)
    );
  `);
  db.prepare('INSERT INTO import_receipts(namespace, import_id, request_hash, receipt_json) VALUES (?, ?, ?, ?)').run('legacy', 'old-import', 'hash', '{"status":"accepted"}');
  const insertCard = db.prepare(`INSERT INTO practice_cards(
    namespace, event_id, card_id, previous_event_id, occurred_at, recorded_at, kind, title, prompt,
    reference_answer, reference_notes, sources_json, source_checked, paused, request_payload
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const request of [rootRequest, tailRequest]) {
    insertCard.run('legacy', request.eventId, request.cardId, request.previousEventId, '2026-01-01T00:00:00.000Z', '2026-01-01T00:02:00.000Z', request.kind, request.title, request.prompt, request.referenceAnswer, request.referenceNotes, canonical(request.sources), 1, 0, canonical(parsePracticeCardRequest(request)));
  }
  insertCard.run('other-namespace', 'other-card-event', 'other-card', null, '2026-01-01T00:00:00.000Z', '2026-01-01T00:02:00.000Z', 'detail', 'Other', 'Other', 'Other', '', canonical(rootRequest.sources), 1, 0, canonical({ ...rootRequest, eventId: 'other-card-event', cardId: 'other-card' }));
  db.prepare('INSERT INTO practice_card_sources(namespace, card_event_id, card_id, concept_id, source_revision) VALUES (?, ?, ?, ?, ?)').run('legacy', rootRequest.eventId, rootRequest.cardId, 'alpha', 'rev-1');
  db.prepare('INSERT INTO practice_card_sources(namespace, card_event_id, card_id, concept_id, source_revision) VALUES (?, ?, ?, ?, ?)').run('legacy', tailRequest.eventId, tailRequest.cardId, 'alpha', 'rev-1');
  db.prepare(`INSERT INTO practice_attempts(
    namespace, event_id, card_id, card_event_id, answered_at, recorded_at, answer, confidence, confidence_at,
    exposure, observed_exposure, cue, outcome, check_notes, request_payload
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'legacy', oldAttempt.eventId, oldAttempt.cardId, oldAttempt.cardEventId, '2026-01-01T00:01:00.000Z', '2026-01-01T00:02:00.000Z', oldAttempt.answer, null, null, oldAttempt.exposure, 0, oldAttempt.cue, oldAttempt.outcome, oldAttempt.checkNotes, canonical(parsePracticeAttemptRequest(oldAttempt)),
  );
  db.close();

  try {
    const store = new Store({ dbPath, namespace: 'legacy', now: () => new Date(NOW) });
    const data = store.getPracticeData();
    assert.deepEqual(data.cards.map((item) => item.eventId), [tailRequest.eventId, rootRequest.eventId]);
    assert.equal(store.getPracticeCard(rootRequest.cardId)?.eventId, tailRequest.eventId);
    assert.equal(data.attempts[0].eventId, oldAttempt.eventId);
    assert.deepEqual(store.addPracticeCard(rootRequest, [concept]), { status: 'duplicate', eventId: rootRequest.eventId });
    assert.deepEqual(store.addPracticeAttempt(oldAttempt, [concept]), { status: 'duplicate', eventId: oldAttempt.eventId });
    const migrated = new DatabaseSync(dbPath);
    const schema = migrated.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'practice_cards'").get() as { sql: string };
    assert.match(schema.sql, /scenario/);
    assert.equal((migrated.prepare("SELECT COUNT(*) AS count FROM practice_card_sources WHERE namespace = 'legacy'").get() as { count: number }).count, 2);
    assert.equal((migrated.prepare("SELECT COUNT(*) AS count FROM practice_cards WHERE namespace = 'other-namespace'").get() as { count: number }).count, 1);
    assert.equal((migrated.prepare("SELECT receipt_json FROM import_receipts WHERE namespace = 'legacy' AND import_id = 'old-import'").get() as { receipt_json: string }).receipt_json, '{"status":"accepted"}');
    assert.deepEqual(migrated.prepare('PRAGMA foreign_key_check').all(), []);
    migrated.close();
    store.close();
    const restarted = new Store({ dbPath, namespace: 'legacy', now: () => new Date(NOW) });
    assert.equal(restarted.getPracticeCard(rootRequest.cardId)?.eventId, tailRequest.eventId);
    assert.deepEqual(restarted.addPracticeCard(rootRequest, [concept]), { status: 'duplicate', eventId: rootRequest.eventId });
    assert.deepEqual(restarted.addPracticeAttempt(oldAttempt, [concept]), { status: 'duplicate', eventId: oldAttempt.eventId });
    restarted.close();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
