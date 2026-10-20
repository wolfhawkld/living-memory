import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Store, StoreError, assertLearningDatabaseReady } from '../src/server/store.js';
import { ObservationRevisionStoreError } from '../src/server/observation-revision-store.js';
import { inspectLearningSchema, LearningSchemaError } from '../src/server/learning-schema.js';
import { createLegacyLearningFixture } from './helpers/legacy-learning-schema.js';
import type { Concept, ObservationRequest } from '../src/shared/types.js';

const NOW = '2026-10-18T12:00:00.000Z';
const source = { name: 'synthetic', mode: 'local' as const, conceptCount: 1, limit: 1, diagnostics: [] };
const concept: Concept = { id: 'alpha', title: 'Alpha', aliases: [], domain: 'synthetic', summary: '', body: '', source: { path: 'alpha.md', revision: 'v1' } };
const request: ObservationRequest = { eventId: 'raw', conceptId: 'alpha', sourceRevision: 'v1', observedAt: '2026-10-18T01:00:00Z',
  anchorEventId: null, configRevision: 1, answer: 'SYNTHETIC answer', rating: 'clear', exposure: 'unexposed', observedExposure: false,
  learning: { task: 'scenario', scenario: 'SYNTHETIC case', cue: 'independent', confidence: 80, confidenceAt: '2026-10-18T00:59:00Z', outcome: 'success', basis: 'self-check' } };
function revision(eventId = 'revision') {
  return { eventId, observationEventId: 'raw', previousEventId: null, occurredAt: '2026-10-18T02:00:00Z', action: 'revise', reason: 'input-error',
    assessment: { rating: 'blank', learning: { outcome: 'failure', basis: 'self-check' } } };
}
function fixture(namespace = 'synthetic', seed = true) {
  const dir = mkdtempSync(join(tmpdir(), 'lm-or03-product-'));
  let clock = '2026-10-18T01:01:00.000Z';
  const store = new Store({ dataDir: dir, namespace, now: () => new Date(clock) });
  const db = (store as unknown as { db: DatabaseSync }).db;
  if (seed) store.addObservation(request, null);
  clock = NOW;
  return { dir, store, db, close() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('fresh stores atomically mark schema2; legacy/future startup gates leave database bytes and namespaces untouched', () => {
  const f = fixture();
  try { assert.equal(inspectLearningSchema(f.db).kind, 'current-v2'); } finally { f.close(); }
  for (const variant of ['current', 'ancient-five-table', 'activity-partial'] as const) {
    const dir = mkdtempSync(join(tmpdir(), 'lm-or03-gate-')), path = join(dir, 'legacy.sqlite');
    const db = new DatabaseSync(path); createLegacyLearningFixture(db, variant); db.close();
    try {
      const bytes = readFileSync(path);
      for (const action of [() => assertLearningDatabaseReady(path), () => new Store({ dbPath: path, namespace: 'MUST-NOT-INSERT' })]) {
        assert.throws(action, error => variant === 'current'
          ? error instanceof StoreError && error.code === 'LEARNING_SCHEMA_UPGRADE_REQUIRED'
          : error instanceof LearningSchemaError);
        assert.deepEqual(readFileSync(path), bytes);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('revise/withdraw/reinstate update effective history while raw answers, time state, prompt and daily consumption remain identical', () => {
  const f = fixture();
  try {
    const raw = f.store.getObservations(), state = f.store.getStates([concept], NOW), completed = f.store.getCompletedConceptIds(NOW, 'UTC');
    const prompt = f.store.getScenarioPrompts(new Set(['alpha']), 5);
    const initial = f.store.getConceptHistory(concept, NOW, 5);
    assert.equal(initial.learning?.calibration.scenario.successRate, 100);
    f.store.observationRevisions.append(revision());
    const corrected = f.store.getConceptHistory(concept, NOW, 5);
    assert.equal(corrected.learning?.calibration.scenario.successRate, 0);
    assert.equal(corrected.observationRevisionCount, 1);
    assert.equal(corrected.observationAssessments?.raw.currentAssessment?.rating, 'blank');
    assert.equal(corrected.total, initial.total);
    assert.deepEqual(corrected.entries, initial.entries);
    const withdraw = { eventId: 'withdraw', observationEventId: 'raw', previousEventId: 'revision', occurredAt: '2026-10-18T03:00:00Z', action: 'withdraw', reason: 'unreliable-evidence' };
    f.store.observationRevisions.append(withdraw);
    assert.equal(f.store.getConceptHistory(concept, NOW, 5).learning?.calibration.scenario.count, 0);
    assert.equal(f.store.getEffectiveObservations(NOW).length, 0);
    assert.equal(f.store.getEffectiveObservations('2026-10-18T10:00:00Z')[0].rating, 'clear', 'server receipts, not stated occurrence time, decide historical visibility');
    f.store.observationRevisions.append({ ...withdraw, eventId: 'reinstate', previousEventId: 'withdraw', action: 'reinstate' });
    assert.equal(f.store.getEffectiveObservations(NOW)[0].rating, 'blank');
    assert.deepEqual(f.store.getObservations(), raw);
    assert.deepEqual(f.store.getStates([concept], NOW), state);
    assert.deepEqual(f.store.getCompletedConceptIds(NOW, 'UTC'), completed);
    assert.deepEqual(f.store.getScenarioPrompts(new Set(['alpha']), 5), prompt);
    assert.equal(f.store.addObservation(request, null).status, 'duplicate');
  } finally { f.close(); }
});

test('V2 import commits parent and full chain atomically with original receipts, V2 backup and exact retries; V1 leaves existing revisions intact', () => {
  const donor = fixture(), target = fixture('receiver', false);
  try {
    donor.store.observationRevisions.append(revision());
    const data = donor.store.exportData(source, [concept]);
    assert.equal(data.schemaVersion, 2);
    const preview = target.store.previewImport(data, undefined, source, [concept]);
    assert.equal(preview.canImport, true, JSON.stringify(preview.issues));
    let backups = 0;
    const commit = { importId: 'import', options: { restoreLayout: false, restoreReviewPlan: false }, data, previewToken: preview.token, confirmed: true as const };
    const backup = (value: typeof data) => { backups++; assert.equal(value.schemaVersion, 2); assert.deepEqual(value.observationRevisions, []); return 'synthetic-backup'; };
    const accepted = target.store.commitImport(commit, source, [concept], value => backup(value as typeof data));
    assert.equal(accepted.status, 'accepted');
    assert.equal(target.store.commitImport(commit, source, [concept], () => { throw new Error('must not run'); }).status, 'duplicate');
    assert.equal(backups, 1);
    assert.deepEqual(target.store.exportData(source, [concept]).observationRevisions, data.observationRevisions);
    assert.equal(target.store.observationRevisions.append(revision()).status, 'duplicate');
    assert.equal(target.store.observationRevisions.readHistory('raw').observation.answer, request.answer);
    const { observationRevisions: _revisions, ...base } = data;
    const v1 = { ...base, schemaVersion: 1 as const };
    const legacyPreview = target.store.previewImport(v1, undefined, source, [concept]);
    assert.equal(legacyPreview.canImport, true, JSON.stringify(legacyPreview.issues));
    target.store.commitImport({ importId: 'v1', options: { restoreLayout: false, restoreReviewPlan: false }, data: v1, previewToken: legacyPreview.token, confirmed: true }, source, [concept], () => 'synthetic-backup');
    assert.deepEqual(target.store.observationRevisions.getRevisions(), data.observationRevisions);
  } finally { donor.close(); target.close(); }
});

test('late revision insert failure rolls back parent/config/catalog/layout/receipt and leaves a retryable import', () => {
  const donor = fixture(), target = fixture('receiver', false);
  try {
    donor.store.observationRevisions.append(revision());
    const data = donor.store.exportData(source, [concept]);
    const preview = target.store.previewImport(data, undefined, source, [concept]);
    const commit = { importId: 'rollback', options: { restoreLayout: false, restoreReviewPlan: false }, data, previewToken: preview.token, confirmed: true as const };
    const before = target.store.exportData(source, [concept]);
    target.db.exec("CREATE TRIGGER synthetic_failure BEFORE INSERT ON observation_revisions BEGIN SELECT RAISE(ABORT,'SYNTHETIC'); END");
    assert.throws(() => target.store.commitImport(commit, source, [concept], () => 'synthetic-backup'), (error: unknown) => error instanceof StoreError && error.code === 'IMPORT_FAILED');
    assert.deepEqual(target.store.exportData(source, [concept]), before);
    assert.equal(target.db.prepare('SELECT count(*) AS n FROM import_receipts').get()!.n, 0);
    target.db.exec('DROP TRIGGER synthetic_failure');
    assert.equal(target.store.commitImport(commit, source, [concept], () => 'synthetic-backup').status, 'accepted');
  } finally { donor.close(); target.close(); }
});

test('strict revision/effective/export readers reject corrupt optional evidence instead of treating it as legacy evidence', () => {
  for (const change of ["learning_json='{'", "learning_json='{}'", "evidence_mode='invalid'", "learning_json=''" ]) {
    const f = fixture();
    try {
      f.db.exec(`UPDATE observations SET ${change}`);
      for (const action of [() => f.store.exportData(source, [concept]), () => f.store.getEffectiveObservations(NOW), () => f.store.observationRevisions.readHistory('raw')]) {
        assert.throws(action, (error: unknown) => error instanceof ObservationRevisionStoreError && error.code === 'OBSERVATION_REVISION_DATA_INVALID');
      }
    } finally { f.close(); }
  }
});

test('original writers cannot reuse revision IDs and failed nested BEGIN does not roll back caller transaction', () => {
  const f = fixture();
  try {
    f.store.observationRevisions.append(revision('occupied'));
    const actions = [
      () => f.store.addReview({ eventId: 'occupied', conceptId: 'alpha', sourceRevision: 'v1', kind: 'review' }),
      () => f.store.addObservation({ ...request, eventId: 'occupied' }, null),
      () => f.store.addRetention({ eventId: 'occupied', conceptId: 'alpha', sourceRevision: 'v1', active: true, previousEventId: null, occurredAt: NOW }, null),
      () => f.store.addApplication({ eventId: 'occupied', conceptId: 'alpha', sourceRevision: 'v1', occurredAt: NOW, kind: 'summary', context: '', content: 'Synthetic summary', outcome: 'unverified', assistance: 'unknown', result: '', limitations: '', insight: '', correction: '', references: '' }),
    ];
    for (const action of actions) assert.throws(action, (error: unknown) => error instanceof StoreError && error.code === 'EVENT_CONFLICT');
    f.db.exec('BEGIN IMMEDIATE');
    f.db.prepare('INSERT INTO namespaces VALUES (?,?)').run('outer', NOW);
    assert.throws(() => f.store.addReview({ eventId: 'nested', conceptId: 'alpha', sourceRevision: 'v1', kind: 'review' }), (error: unknown) => error instanceof StoreError && error.code === 'WRITE_FAILED');
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM namespaces WHERE namespace='outer'").get()!.n, 1);
    f.db.exec('ROLLBACK');
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM namespaces WHERE namespace='outer'").get()!.n, 0);
  } finally { f.close(); }
});


test('corrupt revision ownership cannot revive raw scores in history while overview excludes them', () => {
  const f = fixture();
  try {
    f.store.observationRevisions.append(revision());
    f.db.exec("UPDATE observation_revisions SET concept_id='wrong-concept'");
    const history = f.store.getConceptHistory(concept, NOW, 5);
    assert.equal(history.observationAssessments?.raw.status, 'unresolved');
    assert.equal(history.learning?.calibration.scenario.count, 0);
    assert.equal(f.store.getEffectiveObservations(NOW).length, 0);
    assert.equal(f.store.getObservations()[0].rating, 'clear');
  } finally { f.close(); }
});

test('history assessment version changes across an existing receipt without changing revision count', () => {
  const f = fixture();
  try {
    f.store.observationRevisions.append(revision());
    const before = f.store.getConceptHistory(concept, '2026-10-18T10:00:00Z', 1);
    const after = f.store.getConceptHistory(concept, NOW, 1);
    const later = f.store.getConceptHistory(concept, '2026-10-18T13:00:00Z', 1);
    assert.equal(before.observationRevisionCount, 1);
    assert.equal(after.observationRevisionCount, 1);
    assert.notEqual(before.observationAssessmentVersion, after.observationAssessmentVersion);
    assert.equal(after.observationAssessmentVersion, later.observationAssessmentVersion);
    assert.equal(before.observationAssessments?.raw.currentAssessment?.rating, 'clear');
    assert.equal(after.observationAssessments?.raw.currentAssessment?.rating, 'blank');
  } finally { f.close(); }
});

test('nested import failure preserves the calling transaction and performs no backup', () => {
  const donor = fixture(), target = fixture('receiver', false);
  try {
    donor.store.observationRevisions.append(revision());
    const data = donor.store.exportData(source, [concept]);
    const preview = target.store.previewImport(data, undefined, source, [concept]);
    target.db.exec('BEGIN IMMEDIATE');
    target.db.prepare('INSERT INTO namespaces VALUES (?,?)').run('outer', NOW);
    assert.throws(() => target.store.commitImport({ importId: 'nested-import', data, previewToken: preview.token,
      options: { restoreLayout: false, restoreReviewPlan: false }, confirmed: true }, source, [concept], () => { throw new Error('must not back up'); }),
    (error: unknown) => error instanceof StoreError && error.code === 'IMPORT_FAILED');
    assert.equal(target.db.prepare("SELECT count(*) AS n FROM namespaces WHERE namespace='outer'").get()!.n, 1);
    assert.equal(target.store.countObservations(), 0);
    target.db.exec('ROLLBACK');
    assert.equal(target.db.prepare("SELECT count(*) AS n FROM namespaces WHERE namespace='outer'").get()!.n, 0);
  } finally { donor.close(); target.close(); }
});

test('history and overview keep effective judgments and watermarks in the same read snapshot under another writer', () => {
  for (const kind of ['history', 'overview'] as const) {
    const f = fixture();
    f.db.exec('PRAGMA journal_mode=WAL');
    const other = new Store({ dbPath: f.store.dbPath, namespace: f.store.namespace, now: () => new Date(NOW) });
    try {
      const original = f.store.observationRevisions.getRevisionCount.bind(f.store.observationRevisions);
      let appended = false;
      f.store.observationRevisions.getRevisionCount = () => {
        if (!appended) { appended = true; other.observationRevisions.append(revision()); }
        return original();
      };
      if (kind === 'history') {
        const first = f.store.getConceptHistory(concept, NOW, 1);
        assert.equal(first.observationRevisionCount, 0);
        assert.equal(first.observationAssessments?.raw.currentAssessment?.rating, 'clear');
        const next = f.store.getConceptHistory(concept, NOW, 1);
        assert.equal(next.observationRevisionCount, 1);
        assert.equal(next.observationAssessments?.raw.currentAssessment?.rating, 'blank');
      } else {
        const first = f.store.getLearningOverview(f.store.namespace, [concept], [], NOW);
        assert.deepEqual(first.observationAssessments, { raw: 1, effective: 1, withdrawn: 0, unresolved: 0, notYetRecorded: 0, revisionCount: 0 });
        assert.equal(first.items[0].calibration.scenario.successRate, 100);
        const next = f.store.getLearningOverview(f.store.namespace, [concept], [], NOW);
        assert.equal(next.observationAssessments.revisionCount, 1);
        assert.equal(next.items[0].calibration.scenario.successRate, 0);
      }
    } finally { other.close(); f.close(); }
  }
});
