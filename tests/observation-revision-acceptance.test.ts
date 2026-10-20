import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Store, StoreError } from '../src/server/store.js';
import type { CalibrationSummary, Concept, ObservationRequest } from '../src/shared/types.js';

const AS_OF = '2026-10-20T12:00:00.000Z';
const concepts: Concept[] = ['alpha', 'beta'].map(id => ({
  id, title: id, aliases: [], domain: 'synthetic', summary: '', body: '',
  source: { path: `${id}.md`, revision: 'v1' },
}));
const source = { name: 'synthetic', mode: 'local' as const, conceptCount: 2, limit: 2, diagnostics: [] };

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'lm-or05-acceptance-'));
  let clock = '2026-10-01T00:00:00.000Z';
  const store = new Store({ dataDir: dir, namespace: 'synthetic', now: () => new Date(clock) });
  const db = (store as unknown as { db: DatabaseSync }).db;
  return {
    store, db, at(value: string) { clock = value; },
    close() { store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

function observation(eventId: string, observedAt: string, fields: Partial<ObservationRequest> = {}): ObservationRequest {
  return {
    eventId, conceptId: 'alpha', sourceRevision: 'v1', observedAt,
    anchorEventId: null, configRevision: 1, answer: 'SYNTHETIC original answer',
    rating: 'clear', exposure: 'unexposed', observedExposure: false, evidenceMode: 'written',
    learning: { task: 'concept', cue: 'independent', confidence: 80,
      confidenceAt: new Date(Date.parse(observedAt) - 60_000).toISOString(), outcome: 'success', basis: 'self-check' },
    ...fields,
  };
}

function assertCalibration(value: CalibrationSummary | undefined, count: number, rate: number, brier: number) {
  assert.ok(value);
  assert.equal(value.count, count);
  assert.equal(value.meanConfidence, 80);
  assert.equal(value.successRate, rate);
  assert.ok(Math.abs(value.brier! - brier) < 1e-12);
}

/** Include stored request bytes and every row, rather than only exported projections. */
function rows(db: DatabaseSync, tables: string[]): unknown {
  return tables.map(table => [table, db.prepare(`SELECT * FROM "${table}"`).all()
    .map(row => JSON.stringify(row)).sort()]);
}

test('cross-midnight reassessment changes calibration without moving original practice, frozen time state or nonempty daily consumption', () => {
  const f = fixture();
  try {
    f.store.updateConfig(11.5, 1);
    f.store.addReview({ eventId: 'anchor', conceptId: 'alpha', sourceRevision: 'v1', kind: 'review', occurredAt: '2026-10-01T00:00:00.000Z' });
    const older = observation('older', '2026-10-12T15:59:00.000Z', { anchorEventId: 'anchor', configRevision: 2 });
    f.at('2026-10-12T15:59:30.000Z');
    f.store.addObservation(older, 'anchor');
    f.at('2026-10-18T00:00:00.000Z');
    f.store.addRetention({ eventId: 'retained', conceptId: 'alpha', sourceRevision: 'v1', occurredAt: '2026-10-18T00:00:00.000Z', active: true, previousEventId: null }, null);
    f.store.updateReviewPlan({ revision: 0, dailyBudget: 3 });
    const recent = observation('recent', '2026-10-19T15:59:00.000Z', { anchorEventId: 'anchor', configRevision: 2 });
    f.at('2026-10-19T15:59:30.000Z');
    f.store.addObservation(recent, 'anchor');
    f.at('2026-10-19T16:00:20.000Z');
    f.store.addObservation(observation('next-day', '2026-10-19T16:00:10.000Z', { conceptId: 'beta', configRevision: 2 }), null);
    const oldDay = '2026-10-19T15:59:59.000Z', nextDay = '2026-10-19T16:00:59.000Z';
    const daily = () => [oldDay, nextDay, AS_OF].map(asOf => f.store.getCompletedConceptIds(asOf, 'Asia/Shanghai'));
    assert.deepEqual(daily(), [['alpha'], ['beta'], ['beta']]);
    const raw = f.store.getObservations();
    assert.equal(raw.find(item => item.eventId === 'recent')?.halfLifeDays, 11.5);
    assert.equal(raw.find(item => item.eventId === 'recent')?.elapsedDays, (Date.parse(recent.observedAt) - Date.parse('2026-10-01T00:00:00.000Z')) / 86_400_000);
    const tables = ['observations', 'anchors', 'retentions', 'config_history', 'review_plans'];
    const persisted = rows(f.db, tables), states = f.store.getStates(concepts, AS_OF), plan = f.store.getReviewPlan();
    assert.equal(states.alpha.retention?.active, true);
    assert.equal(states.alpha.anchor?.eventId, 'anchor');
    const originalHistory = f.store.getConceptHistory(concepts[0], AS_OF, 100);
    const check = (asOf: string, count: number, rate: number, brier: number) => {
      const history = f.store.getConceptHistory(concepts[0], asOf, 100);
      const overview = f.store.getLearningOverview('synthetic', concepts, [], asOf).items.find(item => item.conceptId === 'alpha')!;
      assertCalibration(history.learning?.calibration.concept, count, rate, brier);
      assertCalibration(overview.calibration.concept, count, rate, brier);
      return history;
    };
    check(AS_OF, 2, 100, .04);
    f.at('2026-10-19T16:01:00.000Z');
    f.store.observationRevisions.append({ eventId: 'revised', observationEventId: 'recent', previousEventId: null,
      occurredAt: '2026-10-19T16:00:30.000Z', action: 'revise', reason: 'rechecked-original',
      assessment: { rating: 'blank', learning: { outcome: 'failure', basis: 'self-check' } } });
    check(nextDay, 2, 100, .04); // Stated occurrence precedes this asOf; server receipt does not.
    const corrected = check('2026-10-19T16:01:00.000Z', 2, 50, .34);
    assert.equal(corrected.progress?.tasks.concept.latest?.eventId, 'recent');
    assert.equal(corrected.progress?.tasks.concept.previous?.eventId, 'older');
    assert.equal(corrected.progress?.tasks.concept.intervalDays, 7);
    const { rating: _rating, outcome: _outcome, basis: _basis, ...conditions } = corrected.progress!.tasks.concept.latest!;
    const { rating: _oldRating, outcome: _oldOutcome, basis: _oldBasis, ...oldConditions } = originalHistory.progress!.tasks.concept.latest!;
    assert.deepEqual(conditions, oldConditions);
    for (const [eventId, previousEventId, action, time, count, rate, brier] of [
      ['withdrawn', 'revised', 'withdraw', '2026-10-19T16:02:00.000Z', 1, 100, .04],
      ['reinstated', 'withdrawn', 'reinstate', '2026-10-19T16:03:00.000Z', 2, 50, .34],
    ] as const) {
      f.at(time);
      f.store.observationRevisions.append({ eventId, observationEventId: 'recent', previousEventId, occurredAt: time, action, reason: 'unreliable-evidence' });
      const history = check(time, count, rate, brier);
      assert.equal(history.total, originalHistory.total);
      assert.deepEqual(history.entries, originalHistory.entries);
      assert.deepEqual(rows(f.db, tables), persisted);
      assert.deepEqual(f.store.getStates(concepts, AS_OF), states);
      assert.deepEqual(f.store.getReviewPlan(), plan);
      assert.deepEqual(daily(), [['alpha'], ['beta'], ['beta']]);
    }
    assert.equal(f.store.getConceptHistory(concepts[0], AS_OF, 100).progress?.tasks.concept.intervalDays, 7);
    assert.deepEqual(f.store.getObservations(), raw);
    assert.equal(f.store.addObservation(recent, 'anchor').status, 'duplicate');
  } finally { f.close(); }
});

test('persisted mental, exposed and legacy reassessments cannot manufacture independent calibration or missing learning', () => {
  const f = fixture();
  try {
    f.at('2026-10-18T12:00:00.000Z');
    const requests = [
      observation('mental', '2026-10-18T01:00:00.000Z', { evidenceMode: 'mental', answer: '', rating: 'blank', learning: { task: 'concept', cue: 'independent', confidence: 80, confidenceAt: '2026-10-18T00:59:00.000Z', outcome: 'failure', basis: 'self-check' } }),
      observation('exposed', '2026-10-18T02:00:00.000Z', { exposure: 'exposed', observedExposure: true, rating: 'blank', learning: { task: 'concept', cue: 'independent', confidence: 80, confidenceAt: '2026-10-18T01:59:00.000Z', outcome: 'failure', basis: 'self-check' } }),
      observation('legacy', '2026-10-18T03:00:00.000Z', { rating: 'blank', learning: undefined, evidenceMode: undefined }),
    ];
    requests.forEach(request => f.store.addObservation(request, null));
    const before = rows(f.db, ['observations']);
    f.at('2026-10-19T12:00:00.000Z');
    requests.forEach(request => f.store.observationRevisions.append({ eventId: `recheck-${request.eventId}`, observationEventId: request.eventId,
      previousEventId: null, occurredAt: '2026-10-19T01:00:00.000Z', action: 'revise', reason: 'rechecked-original',
      assessment: { rating: 'clear', learning: request.learning ? { outcome: 'success', basis: 'self-check' } : null } }));
    const effective = f.store.getEffectiveObservations(AS_OF);
    assert.equal(effective.length, 3);
    assert.ok(effective.every(item => item.rating === 'clear'));
    assert.equal(effective.find(item => item.eventId === 'mental')?.evidenceMode, 'mental');
    assert.equal(effective.find(item => item.eventId === 'mental')?.learning?.outcome, 'success');
    assert.equal(effective.find(item => item.eventId === 'exposed')?.learning?.outcome, 'success');
    assert.equal(effective.find(item => item.eventId === 'exposed')?.observedExposure, true);
    assert.equal(effective.find(item => item.eventId === 'legacy')?.learning, undefined);
    const empty = { count: 0, meanConfidence: null, successRate: null, gap: null, brier: null };
    assert.deepEqual(f.store.getConceptHistory(concepts[0], AS_OF, 100).learning?.calibration.concept, empty);
    assert.deepEqual(f.store.getLearningOverview('synthetic', concepts, [], AS_OF).items.find(item => item.conceptId === 'alpha')?.calibration.concept, empty);
    assert.deepEqual(rows(f.db, ['observations']), before);
    requests.forEach(request => assert.equal(f.store.addObservation(request, null).status, 'duplicate'));
  } finally { f.close(); }
});

test('a revision alone invalidates an import preview before backup or any import mutation and a fresh preview can commit', () => {
  const donor = fixture(), target = fixture();
  try {
    donor.at(AS_OF); target.at(AS_OF);
    const parent = observation('shared-parent', '2026-10-18T01:00:00.000Z');
    donor.store.addObservation(parent, null); target.store.addObservation(parent, null);
    donor.store.addObservation(observation('import-only', '2026-10-18T02:00:00.000Z', { conceptId: 'beta' }), null);
    const data = donor.store.exportData(source, concepts);
    const options = { restoreLayout: true, restoreReviewPlan: true };
    const preview = target.store.previewImport(data, options, source, concepts);
    assert.equal(preview.canImport, true, JSON.stringify(preview.issues));
    target.store.observationRevisions.append({ eventId: 'local-revision', observationEventId: parent.eventId, previousEventId: null,
      occurredAt: '2026-10-19T01:00:00.000Z', action: 'revise', reason: 'input-error',
      assessment: { rating: 'blank', learning: { outcome: 'failure', basis: 'self-check' } } });
    const tables = (target.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(row => row.name);
    const before = rows(target.db, tables);
    let backups = 0;
    const commit = { importId: 'stale-revision-import', data, options, previewToken: preview.token, confirmed: true as const };
    assert.throws(() => target.store.commitImport(commit, source, concepts, () => { backups++; return 'synthetic-backup'; }),
      (error: unknown) => error instanceof StoreError && error.code === 'IMPORT_STALE');
    assert.equal(backups, 0);
    assert.deepEqual(rows(target.db, tables), before);
    assert.equal(target.store.hasEvent('import-only'), false);
    assert.equal(target.db.prepare('SELECT count(*) AS n FROM import_receipts').get()!.n, 0);
    assert.equal(target.store.observationRevisions.getRevisions().length, 1);
    const fresh = target.store.previewImport(data, options, source, concepts);
    assert.equal(fresh.canImport, true, JSON.stringify(fresh.issues));
    assert.notEqual(fresh.token, preview.token);
    assert.equal(target.store.commitImport({ ...commit, previewToken: fresh.token }, source, concepts, () => { backups++; return 'synthetic-backup'; }).status, 'accepted');
    assert.equal(backups, 1);
    assert.equal(target.store.hasEvent('import-only'), true);
    assert.equal(target.store.observationRevisions.getRevisions().length, 1);
  } finally { donor.close(); target.close(); }
});
