import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Store, assertLearningDatabaseReady } from '../src/server/store.js';
import { initializeAnswerClearingSchemaV3, inspectAnswerClearingSchemaV3 } from '../src/server/answer-clearing-schema.js';
import { buildRelationReviewBasis, type RelationReviewRequest } from '../src/shared/relation-reviews.js';
import type { CorrectionRequest } from '../src/shared/corrections.js';
import type { PracticeAttemptRequest, PracticeCardRequest } from '../src/shared/practice.js';
import type { ApplicationRecordRequest, Concept, ObservationRequest, RelationSuggestion, RetentionRequest, ReviewRequest } from '../src/shared/types.js';

const NAMESPACE = 'synthetic-v3';
const NOW = '2026-10-22T12:00:00.000Z';
const CLEAR_AT = '2026-10-23T12:00:00.000Z';
const source = { name: 'synthetic-v3', mode: 'local' as const, conceptCount: 2, limit: 100, diagnostics: [] };
const concepts: Concept[] = ['alpha', 'beta'].map(id => ({ id, title: id, aliases: [], domain: 'synthetic',
  summary: '', body: '', source: { path: `${id}.md`, revision: `${id}-1` } }));
const [alpha, beta] = concepts;
const endpoint = (concept: Concept) => ({ conceptId: concept.id, title: concept.title,
  path: concept.source.path, sourceRevision: concept.source.revision });
const suggestion: RelationSuggestion = { operation: 'add', source: endpoint(alpha), target: endpoint(beta),
  after: { type: 'synthetic-link', description: 'Synthetic relation' } };
const relationBasis = buildRelationReviewBasis(suggestion, concepts,
  [{ id: 'synthetic-link', source: alpha.id, target: beta.id, ...suggestion.after }]);

function initialize(dbPath: string, namespace = NAMESPACE, config = true): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
    initializeAnswerClearingSchemaV3(db, { recordedAt: '2026-10-01T00:00:00.000Z' });
    db.prepare('INSERT INTO namespaces(namespace,created_at) VALUES (?,?)').run(namespace, '2026-10-01T00:00:00.000Z');
    if (config) db.prepare('INSERT INTO config_history(namespace,revision,model_version,half_life_days,recorded_at) VALUES (?,1,?,7,?)')
      .run(namespace, 'time-only-v0', '2026-10-01T00:00:00.000Z');
    db.exec('COMMIT');
  } finally { if (db.isTransaction) db.exec('ROLLBACK'); db.close(); }
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'lm-store-v3-'));
  const dbPath = join(dir, 'learning.sqlite');
  initialize(dbPath);
  let clock = NOW;
  let failClock = false;
  const now = () => { if (failClock) throw new Error('SYNTHETIC clock must not run'); return new Date(clock); };
  let store = new Store<3>({ dbPath, namespace: NAMESPACE, schemaVersion: 3, now });
  return {
    dir, dbPath,
    get store() { return store; },
    get db() { return (store as unknown as { db: DatabaseSync }).db; },
    setNow(value: string) { clock = value; },
    setFailClock(value: boolean) { failClock = value; },
    reopen() { store.close(); store = new Store<3>({ dbPath, namespace: NAMESPACE, schemaVersion: 3, now }); },
    close() { store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

function observation(eventId = 'observation', changes: Partial<ObservationRequest> = {}): ObservationRequest {
  return { eventId, conceptId: alpha.id, sourceRevision: alpha.source.revision,
    observedAt: '2026-10-22T01:00:00.000Z', configRevision: 1, anchorEventId: null,
    answer: `SYNTHETIC_ANSWER_${eventId}`, evidenceMode: 'written', rating: 'clear', exposure: 'unexposed', observedExposure: false,
    learning: { task: 'concept', confidence: 80, confidenceAt: '2026-10-22T00:59:00.000Z',
      cue: 'independent', outcome: 'success', basis: 'self-check' }, ...changes };
}
function review(eventId = 'anchor'): ReviewRequest {
  return { eventId, conceptId: alpha.id, sourceRevision: alpha.source.revision, kind: 'review', occurredAt: '2026-10-15T00:00:00.000Z' };
}
function retention(eventId = 'retention'): RetentionRequest {
  return { eventId, conceptId: alpha.id, sourceRevision: alpha.source.revision, active: true,
    previousEventId: null, occurredAt: '2026-10-22T02:00:00.000Z' };
}
function application(eventId = 'application'): ApplicationRecordRequest {
  return { eventId, conceptId: alpha.id, sourceRevision: alpha.source.revision,
    occurredAt: '2026-10-22T02:00:00.000Z', kind: 'application', context: 'Synthetic work', content: 'Synthetic use',
    outcome: 'partial', assistance: 'resources', result: '', limitations: '', insight: '',
    correction: 'Synthetic correction proposal', references: '', relationSuggestion: suggestion };
}
function correction(eventId = 'correction'): CorrectionRequest {
  return { eventId, applicationEventId: 'application', conceptId: alpha.id, sourceRevision: 'alpha-2',
    occurredAt: '2026-10-22T03:00:00.000Z', previousEventId: null, status: 'resolved', note: 'Synthetic check' };
}
function relationReview(eventId = 'relation-review'): RelationReviewRequest {
  return { eventId, applicationEventId: 'application', conceptId: alpha.id,
    occurredAt: '2026-10-22T03:00:00.000Z', previousEventId: null, status: 'resolved', note: '', basis: relationBasis };
}
function card(eventId = 'practice-card'): PracticeCardRequest {
  return { eventId, cardId: 'card', previousEventId: null, occurredAt: '2026-10-22T02:00:00.000Z', kind: 'detail',
    title: 'Synthetic detail', prompt: 'Synthetic question', referenceAnswer: 'Synthetic reference', referenceNotes: '',
    sources: [{ conceptId: alpha.id, sourceRevision: alpha.source.revision }], sourceChecked: true, paused: false };
}
function attempt(eventId = 'practice-attempt'): PracticeAttemptRequest {
  return { eventId, cardId: 'card', cardEventId: 'practice-card', answeredAt: '2026-10-22T03:00:00.000Z',
    answer: 'Synthetic practice answer', confidence: null, confidenceAt: null, exposure: 'unexposed',
    observedExposure: false, cue: 'independent', outcome: 'partial', checkNotes: '' };
}
function revision(eventId = 'observation-revision', observationEventId = 'observation') {
  return { eventId, observationEventId, previousEventId: null, occurredAt: '2026-10-22T04:00:00.000Z',
    action: 'revise', reason: 'input-error', assessment: { rating: 'partial', learning: { outcome: 'failure', basis: 'self-check' } } };
}
function code(expected: string) {
  return (error: unknown) => error instanceof Error && 'code' in error && error.code === expected;
}
function seedNineKinds(store: Store<3>) {
  const anchor = review();
  const raw = observation('observation', { anchorEventId: anchor.eventId });
  store.addReview(anchor);
  store.addObservation(raw, anchor.eventId);
  store.addRetention(retention(), null);
  store.addApplication(application());
  store.addCorrection(correction());
  store.addRelationReview(relationReview());
  store.addPracticeCard(card(), concepts);
  store.addPracticeAttempt(attempt(), concepts);
  store.observationRevisions.append(revision());
  return { anchor, raw };
}

test('explicit v3 Store opens only existing compatible initialized namespaces while default product gates remain v2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lm-store-v3-gates-'));
  try {
    const absent = join(dir, 'must-not-create', 'learning.sqlite');
    assert.throws(() => new Store<3>({ dbPath: absent, namespace: NAMESPACE, schemaVersion: 3 }), code('LEARNING_SCHEMA_UNSUPPORTED_VERSION'));
    assert.equal(existsSync(join(dir, 'must-not-create')), false);
    const empty = join(dir, 'empty.sqlite');
    new DatabaseSync(empty).close();
    const emptyBefore = readFileSync(empty);
    assert.throws(() => new Store<3>({ dbPath: empty, namespace: NAMESPACE, schemaVersion: 3 }), code('LEARNING_SCHEMA_UNSUPPORTED_VERSION'));
    assert.deepEqual(readFileSync(empty), emptyBefore);

    const v2 = join(dir, 'v2.sqlite');
    new Store({ dbPath: v2, namespace: NAMESPACE }).close();
    const v2Before = readFileSync(v2);
    assert.throws(() => new Store<3>({ dbPath: v2, namespace: NAMESPACE, schemaVersion: 3 }), code('ANSWER_CLEARING_SCHEMA_UNSUPPORTED_VERSION'));
    assert.deepEqual(readFileSync(v2), v2Before);

    const unknown = join(dir, 'unknown.sqlite');
    const invalid = new DatabaseSync(unknown); invalid.exec('PRAGMA user_version=99'); invalid.close();
    const unknownBefore = readFileSync(unknown);
    assert.throws(() => new Store<3>({ dbPath: unknown, namespace: NAMESPACE, schemaVersion: 3 }), code('ANSWER_CLEARING_SCHEMA_UNSUPPORTED_VERSION'));
    assert.deepEqual(readFileSync(unknown), unknownBefore);

    for (const variant of ['namespace', 'config'] as const) {
      const dbPath = join(dir, `${variant}.sqlite`);
      initialize(dbPath, variant === 'namespace' ? 'other-namespace' : NAMESPACE, variant !== 'config');
      const before = readFileSync(dbPath);
      assert.throws(() => new Store<3>({ dbPath, namespace: NAMESPACE, schemaVersion: 3 }), code('LEARNING_NAMESPACE_UNAVAILABLE'));
      assert.deepEqual(readFileSync(dbPath), before);
    }
    const initialized = join(dir, 'initialized.sqlite');
    initialize(initialized);
    const before = readFileSync(initialized);
    assert.throws(() => new Store({ dbPath: initialized, namespace: NAMESPACE }), code('LEARNING_SCHEMA_UNSUPPORTED_VERSION'));
    assert.throws(() => assertLearningDatabaseReady(initialized), code('LEARNING_SCHEMA_UNSUPPORTED_VERSION'));
    assert.deepEqual(readFileSync(initialized), before);
    const store = new Store<3>({ dbPath: initialized, namespace: NAMESPACE, schemaVersion: 3 });
    try { assert.equal(store.getConfig().halfLifeDays, 7); } finally { store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('all nine v3 event kinds retain precise duplicate receipts without consulting a later clock or freshness conditions', () => {
  const f = fixture();
  try {
    const { anchor, raw } = seedNineKinds(f.store);
    const before = f.store.exportData(source, concepts);
    f.setFailClock(true);
    const replay = [
      () => f.store.addReview(anchor),
      () => f.store.addObservation(raw, 'changed-anchor-parameter'),
      () => f.store.addRetention(retention(), 'changed-retention-parameter'),
      () => f.store.addApplication(application()),
      () => f.store.addCorrection(correction()),
      () => f.store.addRelationReview(relationReview()),
      () => f.store.addPracticeCard(card(), []),
      () => f.store.addPracticeAttempt(attempt(), []),
      () => f.store.observationRevisions.append(revision()),
    ];
    for (const retry of replay) assert.equal(retry().status, 'duplicate');
    f.setFailClock(false);
    assert.deepEqual(f.store.exportData(source, concepts), before);
  } finally { f.close(); }
});

test('clearing preserves raw facts, memory and consumption while excluding all affected performance scopes', () => {
  const f = fixture();
  try {
    f.store.addReview(review());
    const conceptRequest = observation('concept', { anchorEventId: 'anchor' });
    const scenarioRequest = observation('scenario', { anchorEventId: 'anchor', learning: {
      task: 'scenario', scenario: 'Synthetic scenario retained after answer clearing', scenarioRevisit: true,
      confidence: 70, confidenceAt: '2026-10-22T00:59:00.000Z', cue: 'independent', outcome: 'success', basis: 'application',
    } });
    f.store.addObservation(conceptRequest, 'anchor');
    f.store.addObservation(scenarioRequest, 'anchor');
    f.store.addObservation(observation('old', { sourceRevision: 'old-alpha-version' }), null);
    f.store.addObservation(observation('beta', { conceptId: beta.id, sourceRevision: beta.source.revision }), null);
    const raw = f.store.getObservations();
    const state = f.store.getStates(concepts, CLEAR_AT);
    const completed = f.store.getCompletedConceptIds(NOW, 'UTC');
    const plan = f.store.getReviewPlan();
    const config = f.store.getConfigHistory();
    const prompts = f.store.getScenarioPrompts(new Set([alpha.id]), 10);
    const before = f.store.getConceptHistory(alpha, NOW, 20);
    assert.equal(before.learning?.calibration.concept.count, 1);
    assert.equal(before.learning?.calibration.scenario.count, 1);
    assert.equal(before.progress?.tasks.concept.total, 1);
    assert.equal(before.progress?.tasks.scenario.total, 1);
    const beforeOverview = f.store.getLearningOverview(NAMESPACE, concepts, [], NOW);
    assert.equal(beforeOverview.items.find(item => item.conceptId === alpha.id)?.timeRecall?.buckets.reduce((sum, item) => sum + item.count, 0), 1);
    const files = readdirSync(f.dir).sort();
    f.setNow(CLEAR_AT);
    const first = f.store.clearObservationAnswer({ observationEventId: 'concept' });
    assert.equal(first.status, 'accepted');
    assert.equal(first.clearedAt, CLEAR_AT);
    f.store.clearObservationAnswer({ observationEventId: 'scenario' });
    f.store.clearObservationAnswer({ observationEventId: 'old' });
    assert.deepEqual(readdirSync(f.dir).sort(), files, 'clearing does not create a backup artifact');
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM import_receipts').get()!.n, 0);
    const history = f.store.getConceptHistory(alpha, NOW, 20);
    assert.notEqual(history.observationAssessmentVersion, before.observationAssessmentVersion);
    assert.deepEqual(history.observationPrivacy, { cleared: 3, excludedFromPerformance: 3 });
    assert.equal(history.total, before.total);
    assert.equal(history.learning?.calibration.concept.count, 0);
    assert.equal(history.learning?.calibration.scenario.count, 0);
    assert.equal(history.progress?.tasks.concept.total, 0);
    assert.equal(history.progress?.tasks.scenario.total, 0);
    for (const entry of history.entries) if (entry.type === 'observation') {
      if (entry.event.answer !== null) assert.fail('historical asOf before clearedAt must expose current privacy state');
      assert.equal(entry.event.answerClearing.clearedAt, CLEAR_AT);
      assert.equal(entry.event.rating, 'clear');
    }
    const afterRaw = f.store.getObservations();
    assert.equal(afterRaw.length, raw.length);
    for (const old of raw) {
      const current = afterRaw.find(item => item.eventId === old.eventId)!;
      const { answer: oldAnswer, ...oldFacts } = old;
      const { answer: currentAnswer, answerClearing: _marker, ...currentFacts } = current as typeof current & { answerClearing?: unknown };
      assert.deepEqual(currentFacts, oldFacts);
      assert.equal(currentAnswer, old.eventId === 'beta' ? oldAnswer : null);
    }
    assert.deepEqual(f.store.getStates(concepts, CLEAR_AT), state);
    assert.deepEqual(f.store.getCompletedConceptIds(NOW, 'UTC'), completed);
    assert.deepEqual(f.store.getReviewPlan(), plan);
    assert.deepEqual(f.store.getConfigHistory(), config);
    assert.deepEqual(f.store.getScenarioPrompts(new Set([alpha.id]), 10), prompts);
    assert.equal(f.store.countObservations(), 4);
    assert.deepEqual(f.store.getEffectiveObservations(NOW).map(item => item.eventId), ['beta']);
    const overview = f.store.getLearningOverview(NAMESPACE, concepts, [], NOW);
    assert.deepEqual(overview.observationPrivacy, { cleared: 3, excludedFromPerformance: 3 });
    const alphaOverview = overview.items.find(item => item.conceptId === alpha.id)!;
    assert.deepEqual(alphaOverview.observationPrivacy, { cleared: 3, excludedFromPerformance: 3 });
    assert.equal(alphaOverview.recall.total, 0);
    assert.equal(alphaOverview.scenario.total, 0);
    assert.deepEqual(alphaOverview.timeRecall?.buckets, []);
    assert.deepEqual(overview.items.find(item => item.conceptId === beta.id)?.observationPrivacy, { cleared: 0, excludedFromPerformance: 0 });
    assert.equal(overview.items.find(item => item.conceptId === beta.id)?.recall.total, 1);
    const exported = f.store.exportData(source, concepts);
    assert.equal(exported.schemaVersion, 3);
    assert.equal(exported.observations.find(item => item.eventId === 'concept')?.answer, null);
    assert.doesNotMatch(JSON.stringify(exported), /SYNTHETIC_ANSWER_(concept|scenario|old)/);
    f.reopen();
    assert.deepEqual(f.store.exportData(source, concepts), exported);
    assert.equal(inspectAnswerClearingSchemaV3(f.db).kind, 'current-v3');
  } finally { f.close(); }
});

test('cleared observation replay is rejected before anchor and clock checks while repeated clearing keeps the first receipt', () => {
  const f = fixture();
  try {
    const raw = observation();
    f.store.addObservation(raw, null);
    f.setNow(CLEAR_AT);
    const accepted = f.store.clearObservationAnswer({ observationEventId: raw.eventId });
    f.setFailClock(true);
    assert.throws(() => f.store.addObservation(raw, 'changed-anchor'), code('ANSWER_CLEARED'));
    assert.throws(() => f.store.addObservation({ ...raw, answer: '' }, 'changed-anchor'), code('ANSWER_CLEARED'));
    assert.deepEqual(f.store.clearObservationAnswer({ observationEventId: raw.eventId }), { ...accepted, status: 'duplicate' });
    assert.equal(f.db.isTransaction, false);
  } finally { f.close(); }
});

test('withdrawn and reinstated clear records remain excluded from performance with separate adoption and privacy counts', () => {
  const f = fixture();
  try {
    f.store.addObservation(observation(), null);
    f.setNow(CLEAR_AT);
    f.store.clearObservationAnswer({ observationEventId: 'observation' });
    const withdraw = { eventId: 'withdraw', observationEventId: 'observation', previousEventId: null,
      occurredAt: CLEAR_AT, action: 'withdraw', reason: 'other' };
    f.store.observationRevisions.append(withdraw);
    let history = f.store.getConceptHistory(alpha, CLEAR_AT, 10);
    assert.equal(history.observationAssessments?.observation.status, 'withdrawn');
    assert.deepEqual(history.observationPrivacy, { cleared: 1, excludedFromPerformance: 0 });
    f.store.observationRevisions.append({ ...withdraw, eventId: 'reinstate', previousEventId: 'withdraw', action: 'reinstate' });
    history = f.store.getConceptHistory(alpha, CLEAR_AT, 10);
    assert.equal(history.observationAssessments?.observation.status, 'active');
    assert.deepEqual(history.observationPrivacy, { cleared: 1, excludedFromPerformance: 1 });
    assert.equal(history.learning?.calibration.concept.count, 0);
    assert.deepEqual(f.store.getEffectiveObservations(CLEAR_AT), []);
    const overview = f.store.getLearningOverview(NAMESPACE, concepts, [], CLEAR_AT);
    assert.equal(overview.observationAssessments?.effective, 1, 'assessment adoption is not silently redefined as privacy eligibility');
    assert.deepEqual(overview.observationPrivacy, { cleared: 1, excludedFromPerformance: 1 });
    assert.equal(f.store.getObservations()[0].rating, 'clear');
    assert.equal(f.store.countObservations(), 1);
  } finally { f.close(); }
});

test('a cleared observation continues occupying its event ID against every other v3 event writer', () => {
  const f = fixture();
  try {
    seedNineKinds(f.store);
    f.store.addObservation(observation('occupied'), null);
    f.setNow(CLEAR_AT);
    f.store.clearObservationAnswer({ observationEventId: 'occupied' });
    const collision = [
      () => f.store.addReview(review('occupied')),
      () => f.store.addRetention(retention('occupied'), null),
      () => f.store.addApplication(application('occupied')),
      () => f.store.addCorrection(correction('occupied')),
      () => f.store.addRelationReview(relationReview('occupied')),
      () => f.store.addPracticeCard(card('occupied'), concepts),
      () => f.store.addPracticeAttempt(attempt('occupied'), concepts),
    ];
    for (const write of collision) assert.throws(write, code('EVENT_CONFLICT'));
    assert.throws(() => f.store.observationRevisions.append(revision('occupied')), code('OBSERVATION_REVISION_EVENT_CONFLICT'));
    assert.throws(() => f.store.addObservation(observation('occupied'), null), code('ANSWER_CLEARED'));
    assert.equal(f.store.hasEvent('occupied'), true);
    assert.equal(f.store.getObservations().find(item => item.eventId === 'occupied')?.answer, null);
    assert.equal(f.db.isTransaction, false);
  } finally { f.close(); }
});

test('failed nested BEGIN in every v3 writer leaves the caller transaction and its pending rows intact', () => {
  const f = fixture();
  try {
    seedNineKinds(f.store);
    const writers = [
      () => f.store.addReview(review('nested-anchor')),
      () => f.store.addObservation(observation('nested-observation'), null),
      () => f.store.addRetention(retention('nested-retention'), null),
      () => f.store.addApplication(application('nested-application')),
      () => f.store.addCorrection(correction('nested-correction')),
      () => f.store.addRelationReview(relationReview('nested-relation-review')),
      () => f.store.addPracticeCard(card('nested-card'), concepts),
      () => f.store.addPracticeAttempt(attempt('nested-attempt'), concepts),
      () => f.store.observationRevisions.append(revision('nested-revision')),
      () => f.store.clearObservationAnswer({ observationEventId: 'observation' }),
      () => f.store.updateConfig(14, 1),
      () => f.store.updateReviewPlan({ revision: 1, dailyBudget: 3 }),
      () => f.store.setLayout({ alpha: { x: 1, y: 2, z: 3 } }),
      () => f.store.rememberConcepts(concepts),
    ];
    for (const write of writers) {
      f.db.exec('BEGIN IMMEDIATE');
      f.db.prepare('INSERT INTO namespaces(namespace,created_at) VALUES (?,?)').run('outer-pending', NOW);
      assert.throws(write, error => error instanceof Error && 'status' in error && error.status === 503);
      assert.equal(f.db.isTransaction, true);
      assert.equal(f.db.prepare("SELECT count(*) AS n FROM namespaces WHERE namespace='outer-pending'").get()!.n, 1);
      f.db.exec('ROLLBACK');
      assert.equal(f.db.prepare("SELECT count(*) AS n FROM namespaces WHERE namespace='outer-pending'").get()!.n, 0);
    }
    assert.equal(f.store.countObservations(), 1);
  } finally { if (f.db.isTransaction) f.db.exec('ROLLBACK'); f.close(); }
});
