import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Store } from '../src/server/store.js';
import { createObservationRevisionTables, ObservationRevisionStore, ObservationRevisionStoreError } from '../src/server/observation-revision-store.js';
import { buildRelationReviewBasis } from '../src/shared/relation-reviews.js';
import type { ApplicationRecordRequest, Concept, ObservationRequest } from '../src/shared/types.js';
import type { ObservationRevisionRequest } from '../src/shared/observation-revisions.js';

const NOW = '2026-10-05T12:00:00.000Z';
const NAMESPACE = 'revision-integration';
const TABLE_KINDS = [
  ['anchors', 'anchor'], ['observations', 'observation'], ['retentions', 'retention'],
  ['applications', 'application'], ['corrections', 'correction'], ['relation_reviews', 'relation-review'],
  ['practice_cards', 'practice-card'], ['practice_attempts', 'practice-attempt'],
] as const;
const concepts: Concept[] = ['alpha', 'beta'].map(id => ({ id, title: id, aliases: [], domain: 'synthetic',
  summary: 'Synthetic integration fixture', body: 'Synthetic integration fixture', source: { path: `${id}.md`, revision: 'v1' } }));
const observation: ObservationRequest = { eventId: 'original-observation', conceptId: 'alpha', sourceRevision: 'v1',
  observedAt: '2026-10-05T00:00:00Z', configRevision: 1, anchorEventId: 'original-anchor',
  answer: 'PRIVATE original answer', rating: 'clear', evidenceMode: 'written', exposure: 'unexposed', observedExposure: false,
  learning: { task: 'concept', confidence: 80, confidenceAt: '2026-10-04T23:59:00Z',
    cue: 'independent', outcome: 'success', basis: 'self-check' } };

function rawDatabase(store: Store): DatabaseSync { return (store as unknown as { db: DatabaseSync }).db; }
function ledger(db: DatabaseSync, store: Store, now = () => new Date(NOW)) {
  return new ObservationRevisionStore({ db, namespace: store.namespace, now,
    getObservation: (namespace, eventId) => namespace === store.namespace
      ? store.getObservations().find(item => item.eventId === eventId) ?? null : null,
    findOtherEvent: (namespace, eventId) => {
      for (const [table, kind] of TABLE_KINDS) {
        const row = db.prepare(`SELECT request_payload FROM ${table} WHERE namespace = ? AND event_id = ?`)
          .get(namespace, eventId) as { request_payload: string } | undefined;
        if (row) return { kind, requestPayload: row.request_payload };
      }
      return null;
    },
  });
}
function request(eventId: string, previousEventId: string | null = null): Extract<ObservationRevisionRequest, { action: 'revise' }> {
  return { eventId, observationEventId: observation.eventId, previousEventId, occurredAt: '2026-10-05T01:00:00Z',
    action: 'revise', reason: 'input-error', assessment: { rating: 'partial', learning: { outcome: 'failure', basis: 'self-check' } } };
}
function fixture(createTables = true) {
  const dataDir = mkdtempSync(join(tmpdir(), 'lm-revision-integration-'));
  const store = new Store({ dataDir, namespace: NAMESPACE, now: () => new Date(NOW) });
  const db = rawDatabase(store);
  store.addReview({ eventId: 'original-anchor', conceptId: 'alpha', sourceRevision: 'v1', kind: 'review', occurredAt: '2026-10-04T00:00:00Z' });
  store.addObservation(observation, observation.anchorEventId);
  store.addRetention({ eventId: 'original-retention', conceptId: 'alpha', sourceRevision: 'v1',
    occurredAt: '2026-10-05T00:00:00Z', previousEventId: null, active: true }, null);
  const [source, target] = concepts.map(item => ({ conceptId: item.id, title: item.title, path: item.source.path, sourceRevision: item.source.revision }));
  const application: ApplicationRecordRequest = { eventId: 'original-application', conceptId: 'alpha', sourceRevision: 'v1',
    occurredAt: '2026-10-05T00:00:00Z', kind: 'summary', context: 'Synthetic case', content: 'Synthetic summary',
    outcome: 'unverified', assistance: 'unknown', result: '', limitations: '', insight: '', correction: 'Synthetic correction', references: '',
    relationSuggestion: { operation: 'add', source, target, after: { type: 'related', description: 'Synthetic relationship' } } };
  store.addApplication(application);
  store.addCorrection({ eventId: 'original-correction', applicationEventId: application.eventId, conceptId: 'alpha', sourceRevision: 'v1',
    occurredAt: '2026-10-05T00:00:00Z', previousEventId: null, status: 'dismissed', note: '' });
  store.addRelationReview({ eventId: 'original-relation-review', applicationEventId: application.eventId, conceptId: 'alpha',
    occurredAt: '2026-10-05T00:00:00Z', previousEventId: null, status: 'dismissed', note: '',
    basis: buildRelationReviewBasis(application.relationSuggestion!, concepts, []) });
  store.addPracticeCard({ eventId: 'original-card', cardId: 'card', previousEventId: null, occurredAt: '2026-10-05T00:00:00Z',
    kind: 'detail', title: 'Synthetic card', prompt: 'Synthetic question', referenceAnswer: 'Synthetic answer', referenceNotes: '',
    sources: [{ conceptId: 'alpha', sourceRevision: 'v1' }], sourceChecked: true, paused: false }, concepts);
  store.addPracticeAttempt({ eventId: 'original-attempt', cardId: 'card', cardEventId: 'original-card', answeredAt: '2026-10-05T00:00:01Z',
    answer: 'Synthetic attempt', confidence: null, confidenceAt: null, exposure: 'unexposed', observedExposure: false,
    cue: 'independent', outcome: 'partial', checkNotes: '' }, concepts);
  if (createTables) createObservationRevisionTables(db);
  return { dataDir, store, db, ledger: createTables ? ledger(db, store) : null,
    close() { store.close(); rmSync(dataDir, { recursive: true, force: true }); } };
}
function originalSnapshot(store: Store): string {
  const db = rawDatabase(store);
  const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'observation_revisions' ORDER BY name")
    .all() as Array<{ name: string; sql: string }>;
  return JSON.stringify({ tables: tables.map(table => ({ ...table,
    rows: db.prepare(`SELECT * FROM "${table.name.replaceAll('"', '""')}" ORDER BY rowid`).all() })),
    observations: store.getObservations(), anchors: store.getAnchors(), config: store.getConfig(),
    budget: store.getReviewPlan(), completed: store.getCompletedConceptIds(NOW, 'UTC'), states: store.getStates(concepts, NOW) });
}
function rejected(action: () => unknown, suffix: string, status: number) {
  assert.throws(action, error => {
    assert.ok(error instanceof ObservationRevisionStoreError);
    assert.equal(error.code, `OBSERVATION_REVISION_${suffix}`);
    assert.equal(error.status, status);
    assert.equal(error.message, error.code);
    assert.doesNotMatch(error.message, /PRIVATE|SQLite|constraint/);
    return true;
  });
}

test('ledger success, duplicate and rejection preserve all existing rows, budgets, anchors and original observation retry', () => {
  const f = fixture();
  try {
    const before = originalSnapshot(f.store);
    const first = request('corrected');
    assert.equal(f.ledger!.append(first).status, 'accepted');
    assert.equal(f.ledger!.append(first).status, 'duplicate');
    rejected(() => f.ledger!.append(request('stale')), 'PREVIOUS_EVENT_CONFLICT', 409);
    const withdraw = { eventId: 'withdrawn', observationEventId: observation.eventId, previousEventId: first.eventId,
      occurredAt: first.occurredAt, action: 'withdraw', reason: 'unreliable-evidence' };
    assert.equal(f.ledger!.append(withdraw).status, 'accepted');
    assert.equal(f.ledger!.readHistory(observation.eventId).state.status, 'withdrawn');
    assert.deepEqual(f.store.addObservation(observation, observation.anchorEventId), { status: 'duplicate', eventId: observation.eventId });
    assert.equal(originalSnapshot(f.store), before);
    assert.deepEqual(f.store.getCompletedConceptIds(NOW, 'UTC'), ['alpha']);
    assert.equal(f.store.getStates(concepts, NOW).alpha.status, 'retained');
  } finally { f.close(); }
});

test('ledger checks collisions against all eight existing learning event kinds without changing them', () => {
  const f = fixture();
  try {
    const before = originalSnapshot(f.store);
    for (const [table] of TABLE_KINDS) {
      const id = String(f.db.prepare(`SELECT event_id FROM ${table} WHERE namespace = ? LIMIT 1`).get(NAMESPACE)!.event_id);
      rejected(() => f.ledger!.append(request(id)), 'EVENT_CONFLICT', 409);
    }
    assert.equal(f.ledger!.getRevisionCount(), 0);
    assert.equal(originalSnapshot(f.store), before);
  } finally { f.close(); }
});

test('failed BEGIN under a competing SQLite writer leaves that transaction intact and allows a later retry', () => {
  const f = fixture();
  const competitor = new DatabaseSync(f.store.dbPath);
  try {
    f.db.exec('PRAGMA busy_timeout = 0');
    competitor.exec('BEGIN IMMEDIATE');
    competitor.prepare('INSERT INTO namespaces(namespace, created_at) VALUES (?, ?)').run('uncommitted-competitor', NOW);
    rejected(() => f.ledger!.append(request('blocked')), 'WRITE_FAILED', 503);
    assert.equal(competitor.prepare("SELECT count(*) AS count FROM namespaces WHERE namespace = 'uncommitted-competitor'").get()!.count, 1);
    assert.equal(f.db.prepare("SELECT count(*) AS count FROM namespaces WHERE namespace = 'uncommitted-competitor'").get()!.count, 0);
    competitor.exec('ROLLBACK');
    assert.equal(f.ledger!.append(request('blocked')).status, 'accepted');
  } finally { competitor.close(); f.close(); }
});

test('nested append and history errors neither commit nor roll back the caller transaction', () => {
  const f = fixture();
  const observer = new DatabaseSync(f.store.dbPath);
  try {
    f.db.exec('BEGIN IMMEDIATE');
    f.db.prepare('INSERT INTO namespaces(namespace, created_at) VALUES (?, ?)').run('outer-only', NOW);
    rejected(() => f.ledger!.append(request('nested')), 'WRITE_FAILED', 503);
    assert.equal(f.ledger!.readHistory(observation.eventId).total, 0);
    rejected(() => f.ledger!.readHistory('missing-parent'), 'NOT_FOUND', 404);
    assert.equal(f.db.prepare("SELECT count(*) AS count FROM namespaces WHERE namespace = 'outer-only'").get()!.count, 1);
    assert.equal(observer.prepare("SELECT count(*) AS count FROM namespaces WHERE namespace = 'outer-only'").get()!.count, 0);
    f.db.exec('ROLLBACK');
    assert.equal(f.db.prepare("SELECT count(*) AS count FROM namespaces WHERE namespace = 'outer-only'").get()!.count, 0);
    assert.equal(f.ledger!.append(request('nested')).status, 'accepted');
  } finally { observer.close(); f.close(); }
});

test('an INSERT failure is redacted, fully rolled back, and releases the transaction for retry', () => {
  const f = fixture();
  try {
    const before = originalSnapshot(f.store);
    f.db.exec("CREATE TRIGGER synthetic_failure BEFORE INSERT ON observation_revisions BEGIN SELECT RAISE(ABORT, 'PRIVATE original answer'); END");
    rejected(() => f.ledger!.append(request('retry-after-insert-failure')), 'WRITE_FAILED', 503);
    assert.equal(f.ledger!.getRevisionCount(), 0);
    assert.equal(originalSnapshot(f.store), before);
    f.db.exec('DROP TRIGGER synthetic_failure');
    assert.equal(f.ledger!.append(request('retry-after-insert-failure')).status, 'accepted');
    assert.equal(originalSnapshot(f.store), before);
  } finally { f.close(); }
});

test('explicit ledger DDL stays inside the caller transaction and does not migrate or change old tables', () => {
  const f = fixture(false);
  const observer = new DatabaseSync(f.store.dbPath);
  try {
    const before = originalSnapshot(f.store);
    f.db.exec('BEGIN IMMEDIATE');
    createObservationRevisionTables(f.db);
    assert.equal(ledger(f.db, f.store).getRevisionCount(), 0);
    assert.equal(observer.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name = 'observation_revisions'").get()!.count, 0);
    f.db.exec('ROLLBACK');
    assert.equal(f.db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name = 'observation_revisions'").get()!.count, 0);
    assert.equal(originalSnapshot(f.store), before);
    createObservationRevisionTables(f.db);
    assert.equal(ledger(f.db, f.store).append(request('after-ddl')).status, 'accepted');
  } finally { observer.close(); f.close(); }
});

/** Two fresh processes reach the same pre-write barrier before either appends. */
function competingWriter(dbPath: string, candidate: ObservationRevisionRequest) {
  const script = `
    import { Store } from './src/server/store.ts';
    import { ObservationRevisionStore } from './src/server/observation-revision-store.ts';
    const store = new Store({ dbPath: process.argv[1], namespace: '${NAMESPACE}', now: () => new Date('${NOW}') });
    const db = store.db;
    const tables = ${JSON.stringify(TABLE_KINDS)};
    const ledger = new ObservationRevisionStore({ db, namespace: store.namespace, now: () => new Date('${NOW}'),
      getObservation: (namespace, id) => namespace === store.namespace ? store.getObservations().find(item => item.eventId === id) ?? null : null,
      findOtherEvent: (namespace, id) => {
        for (const [table, kind] of tables) {
          const row = db.prepare('SELECT request_payload FROM '+table+' WHERE namespace=? AND event_id=?').get(namespace, id);
          if (row) return { kind, requestPayload: row.request_payload };
        }
        return null;
      }
    });
    process.stdout.write(JSON.stringify({ phase: 'ready' })+'\\n');
    process.stdin.once('data', () => {
      try { process.stdout.write(JSON.stringify({ phase: 'result', receipt: ledger.append(JSON.parse(process.argv[2])) })+'\\n'); }
      catch (error) { process.stdout.write(JSON.stringify({ phase: 'result', error: { code: error.code, status: error.status } })+'\\n'); }
      finally { store.close(); process.stdin.destroy(); }
    });
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, dbPath, JSON.stringify(candidate)],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  let outcome: { receipt?: { status: string; eventId: string }; error?: { code: string; status: number } } | undefined;
  let output = '', stderr = '';
  const done = new Promise<NonNullable<typeof outcome>>((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); const error = new Error('Synthetic writer timed out'); readyReject(error); reject(error); }, 20_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdout.on('data', chunk => {
      output += chunk;
      let newline: number;
      while ((newline = output.indexOf('\n')) >= 0) {
        const line = output.slice(0, newline); output = output.slice(newline + 1);
        try {
          const value = JSON.parse(line);
          if (value.phase === 'ready') readyResolve();
          if (value.phase === 'result') outcome = value;
        } catch { /* Non-protocol output is diagnosed on exit. */ }
      }
    });
    child.once('error', error => { clearTimeout(timeout); readyReject(error); reject(error); });
    child.once('exit', code => {
      clearTimeout(timeout);
      if (code === 0 && outcome) resolve(outcome);
      else { const error = new Error(`Synthetic writer exited ${code}: ${stderr}`); readyReject(error); reject(error); }
    });
  });
  // The caller awaits both readiness promises before the completion promises.
  // Attach a rejection handler immediately so early startup failures are owned.
  void done.catch(() => {});
  return { ready, done, go: () => child.stdin.end('go\n'), stop: () => child.kill() };
}

test('two processes racing from the same parent tail produce exactly one persisted successor', async () => {
  const f = fixture();
  const before = originalSnapshot(f.store);
  const leftRequest = request('concurrent-left');
  const rightRequest = { ...request('concurrent-right'), assessment: { rating: 'blank' as const,
    learning: { outcome: 'failure' as const, basis: 'self-check' as const } } };
  const left = competingWriter(f.store.dbPath, leftRequest), right = competingWriter(f.store.dbPath, rightRequest);
  try {
    await Promise.all([left.ready, right.ready]);
    left.go(); right.go();
    const results = await Promise.all([left.done, right.done]);
    assert.equal(results.filter(item => item.receipt?.status === 'accepted').length, 1);
    assert.deepEqual(results.filter(item => item.error).map(item => item.error), [
      { code: 'OBSERVATION_REVISION_PREVIOUS_EVENT_CONFLICT', status: 409 },
    ]);
    const winner = results.find(item => item.receipt)?.receipt!;
    assert.equal(f.ledger!.getRevisionCount(), 1);
    assert.equal(f.ledger!.readHistory(observation.eventId).state.latestRevisionEventId, winner.eventId);
    assert.equal(f.ledger!.append(winner.eventId === leftRequest.eventId ? leftRequest : rightRequest).status, 'duplicate');
    assert.equal(originalSnapshot(f.store), before);
  } finally { left.stop(); right.stop(); f.close(); }
});
