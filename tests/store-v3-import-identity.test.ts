import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Store } from '../src/server/store.js';
import { initializeAnswerClearingSchemaV3 } from '../src/server/answer-clearing-schema.js';
import { AnswerClearingStore, ANSWER_CLEARING_RETIRED_CREDENTIAL } from '../src/server/answer-clearing-store.js';
import { SAFE_IDENTITY_CREDENTIAL } from '../src/server/answer-clearing-identity-replay-contract.js';
import { SAFE_IMPORT_CREDENTIAL } from '../src/server/answer-clearing-replay-contract.js';
import type { Concept, ObservationRequest } from '../src/shared/types.js';
import type { IdentityLinkCommit } from '../src/shared/identity.js';
import type { ImportCommitRequest } from '../src/shared/import-data.js';
import { concepts, emptyCurrent, fullExport, now, sourceId } from './helpers/answer-clearing-json-fixture.js';

const source = fullExport().source;
const options = { restoreLayout: true, restoreReviewPlan: true };
const secret = 'STORE-V3-PRIVATE-ANSWER';
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'lm-store-v3-operations-'));
  const path = join(dir, 'learning.sqlite');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
  initializeAnswerClearingSchemaV3(db, { recordedAt: now });
  for (const namespace of [sourceId, 'other']) {
    db.prepare('INSERT INTO namespaces VALUES (?,?)').run(namespace, now);
    db.prepare('INSERT INTO config_history VALUES (?,1,?,7,?)').run(namespace, 'time-only-v0', '2025-12-31T00:00:00.000Z');
  }
  db.exec('COMMIT');
  let clock = () => new Date(now);
  const open = () => new Store({ dbPath: path, namespace: sourceId, schemaVersion: 3, now: () => clock() });
  let store = open();
  return { db, path, get store() { return store; }, setClock(next: () => Date) { clock = next; },
    reopen() { store.close(); store = open(); return store; },
    close() { store.close(); db.close(); rmSync(dir, { recursive: true, force: true }); } };
}
function code(action: () => unknown, expected: string | string[]) {
  assert.throws(action, error => {
    assert.ok(error instanceof Error);
    const actual = (error as Error & { code?: string }).code;
    assert.ok((Array.isArray(expected) ? expected : [expected]).includes(actual ?? ''), `${actual}: ${error.message}`);
    assert.equal(error.message.includes(secret), false);
    return true;
  });
}
function rows(db: DatabaseSync): string {
  return JSON.stringify(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(({ name }) => [name, db.prepare(`SELECT * FROM "${String(name).replaceAll('"', '""')}" ORDER BY rowid`).all()]));
}
function importRequest(store: Store<3>, data = fullExport(), importId = 'store-import'): ImportCommitRequest {
  const preview = store.previewImport(data, options, source, concepts);
  assert.equal(preview.canImport, true);
  return { importId, data, options, previewToken: preview.token, confirmed: true };
}
const oldConcept: Concept = { ...concepts[0], id: 'old-id', source: { path: 'Old.md', revision: 'rev-1' } };
const movedConcept: Concept = { ...oldConcept, id: 'new-id', source: { path: 'New.md', revision: 'rev-1' } };
function observation(id: string): ObservationRequest {
  return { eventId: id, conceptId: oldConcept.id, sourceRevision: 'rev-1', observedAt: '2026-01-08T00:00:00.000Z',
    configRevision: 1, anchorEventId: null, answer: secret, rating: 'clear', evidenceMode: 'written',
    exposure: 'unexposed', observedExposure: false };
}
function identityRequest(store: Store<3>, operationId = 'store-identity'): IdentityLinkCommit {
  const preview = store.previewIdentityLink({ fromConceptId: oldConcept.id, toConceptId: movedConcept.id }, source, [movedConcept]);
  assert.equal(preview.canLink, true, JSON.stringify(preview.issues));
  return { operationId, fromConceptId: oldConcept.id, toConceptId: movedConcept.id, previewToken: preview.token, confirmed: true };
}

test('real v3 Store imports nine collections, reopens safe retries, and blocks old answers after clearing', () => {
  const f = fixture();
  try {
    const input = importRequest(f.store);
    let backups = 0;
    const receipt = f.store.commitImport(input, source, concepts, backup => {
      backups++; assert.equal(backup.schemaVersion, 3); assert.equal(backup.observations.length, 0); return 'backup-before-import';
    });
    assert.equal(receipt.status, 'accepted');
    for (const table of ['anchors','observations','observation_revisions','retentions','applications','corrections','relation_reviews','practice_cards','practice_attempts']) {
      assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE namespace=?`).get(sourceId)!.n, 1, table);
      assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE namespace=?`).get('other')!.n, 0, table);
    }
    assert.equal(f.db.prepare('SELECT request_hash FROM import_receipts WHERE import_id=?').get(input.importId)!.request_hash, SAFE_IMPORT_CREDENTIAL);
    const before = rows(f.db);
    f.reopen();
    assert.deepEqual(f.store.commitImport({ ...input, previewToken: 'changed-token' }, source, concepts, () => {
      throw new Error('duplicate must not back up');
    }), { ...receipt, status: 'duplicate' });
    assert.equal(rows(f.db), before); assert.equal(backups, 1);
    assert.equal(f.store.exportData(source, concepts).schemaVersion, 3);
    const first = f.store.clearObservationAnswer({ observationEventId: 'observation-alpha' });
    assert.equal(first.status, 'accepted');
    f.db.prepare("UPDATE import_receipts SET receipt_json='broken' WHERE import_id=?").run(input.importId);
    code(() => f.store.commitImport(input, source, concepts, () => 'unexpected'), 'ANSWER_CLEARING_OPERATION_RETIRED');
    code(() => f.store.previewImport(input.data, options, source, concepts), 'ANSWER_CLEARED');
    code(() => f.store.commitImport({ ...input, importId: 'new-id' }, source, concepts, () => 'unexpected'), 'ANSWER_CLEARED');
    const exported = f.store.exportData(source, concepts);
    assert.equal(exported.observations[0].answer, null);
    assert.deepEqual(exported.observations[0].answer === null ? exported.observations[0].answerClearing : null,
      { observationEventId: first.observationEventId, clearedAt: first.clearedAt });
    f.reopen();
    assert.deepEqual(f.store.exportData(source, concepts).observations, exported.observations);
    assert.equal(backups, 1);
  } finally { f.close(); }
});

test('real v3 Store restores marked absent records and exports their missing-answer semantics without an original', () => {
  const f = fixture();
  try {
    const data = fullExport();
    data.observations = [{ ...data.observations[0], answer: null,
      answerClearing: { observationEventId: 'observation-alpha', clearedAt: '2026-01-09T00:00:00.000Z' } }];
    const input = importRequest(f.store, data);
    f.store.commitImport(input, source, concepts, backup => { assert.equal(backup.schemaVersion, 3); return 'backup'; });
    const exported = f.store.exportData(source, concepts);
    assert.deepEqual(exported.observations, data.observations);
    const raw = f.db.prepare('SELECT answer,request_payload,answer_cleared_at FROM observations WHERE namespace=?').get(sourceId)!;
    assert.equal(raw.answer, null); assert.equal(raw.request_payload, null);
    assert.equal(raw.answer_cleared_at, '2026-01-09T00:00:00.000Z');
    const current = rows(f.db);
    f.reopen();
    assert.equal(f.store.commitImport(input, source, concepts, () => 'unexpected').status, 'duplicate');
    assert.equal(rows(f.db), current);
    assert.deepEqual(f.store.getLearningOverview(sourceId, concepts, [], now).observationPrivacy,
      { cleared: 1, excludedFromPerformance: 0 }); // The original withdrawal remains in force.
  } finally { f.close(); }
});

test('v3 identity uses safe semantic receipts beside cleared records, then local clearing retires them before replay parsing', () => {
  const f = fixture();
  try {
    f.store.rememberConcepts([oldConcept]);
    f.store.addObservation(observation('already-cleared'), null);
    f.store.clearObservationAnswer({ observationEventId: 'already-cleared' });
    f.store.addObservation(observation('clear-after-binding'), null);
    const input = identityRequest(f.store);
    let backups = 0;
    const receipt = f.store.commitIdentityLink(input, source, [movedConcept], backup => {
      backups++; assert.equal(backup.schemaVersion, 3); return 'identity-backup';
    });
    assert.equal(receipt.status, 'accepted');
    const saved = f.db.prepare('SELECT request_hash,receipt_json FROM identity_bindings WHERE operation_id=?').get(input.operationId)!;
    assert.equal(saved.request_hash, SAFE_IDENTITY_CREDENTIAL);
    for (const forbidden of [secret, input.previewToken, createHash('sha256').update(input.previewToken).digest('hex')]) {
      assert.equal(String(saved.receipt_json).includes(forbidden), false);
    }
    const privacy = new AnswerClearingStore({ db: f.db, namespace: sourceId }).getReplayPrivacyStatus();
    assert.equal(privacy.status, 'ready'); assert.equal(privacy.safeIdentityCredentials, 1); assert.equal(privacy.activeIdentityCredentials, 0);
    const before = rows(f.db);
    f.reopen();
    f.setClock(() => { throw new Error('retry must not read clock'); });
    assert.deepEqual(f.store.commitIdentityLink({ ...input, previewToken: 'NEW-TOKEN' }, source, [movedConcept], () => {
      throw new Error('retry must not back up');
    }), { ...receipt, status: 'duplicate' });
    code(() => f.store.commitIdentityLink({ ...input, toConceptId: 'different' }, source, [movedConcept], () => 'unexpected'), 'IDENTITY_CONFLICT');
    code(() => f.store.commitIdentityLink({ ...input, fromConceptId: 'different' }, source, [movedConcept], () => 'unexpected'), 'IDENTITY_CONFLICT');
    assert.equal(rows(f.db), before); assert.equal(backups, 1);
    f.setClock(() => new Date(now));
    f.store.clearObservationAnswer({ observationEventId: 'clear-after-binding' });
    assert.equal(f.db.prepare('SELECT request_hash FROM identity_bindings WHERE operation_id=?').get(input.operationId)!.request_hash,
      ANSWER_CLEARING_RETIRED_CREDENTIAL);
    f.db.prepare("UPDATE identity_bindings SET receipt_json='broken' WHERE operation_id=?").run(input.operationId);
    code(() => f.store.commitIdentityLink(input, source, [movedConcept], () => 'unexpected'), 'ANSWER_CLEARING_OPERATION_RETIRED');
    assert.equal(backups, 1);
  } finally { f.close(); }
});

test('v3 identity refuses legacy and damaged receipts, and late SQL failure rolls the whole binding transition back', () => {
  const f = fixture();
  try {
    f.store.rememberConcepts([oldConcept]);
    const input = identityRequest(f.store);
    f.db.prepare('INSERT INTO identity_bindings VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(sourceId, 'legacy-op',
      'legacy-raw', 'legacy-id', null, 'Legacy.md', 'revision', now, 'old-backup', 'old-digest', 'broken');
    let backups = 0;
    const backup = () => { backups++; return 'backup'; };
    code(() => f.store.commitIdentityLink({ ...input, operationId: 'legacy-op' }, source, [movedConcept], backup), 'IDENTITY_LEGACY_OPERATION');
    assert.equal(backups, 0);
    f.db.prepare("DELETE FROM identity_bindings WHERE operation_id='legacy-op'").run();
    const fresh = identityRequest(f.store);
    const before = rows(f.db);
    f.db.exec("CREATE TRIGGER fail_identity_catalog BEFORE UPDATE ON identity_catalog BEGIN SELECT RAISE(ABORT,'STORE-V3-PRIVATE-ANSWER'); END");
    // The canonical old catalog row exists, so identity's late UPSERT must fail after receipt insertion.
    code(() => f.store.commitIdentityLink(fresh, source, [movedConcept], backup), 'IDENTITY_FAILED');
    assert.equal(backups, 1); assert.equal(rows(f.db), before);
    f.db.exec('DROP TRIGGER fail_identity_catalog');
    f.store.commitIdentityLink(fresh, source, [movedConcept], backup);
    f.db.prepare("UPDATE identity_bindings SET receipt_json='{}' WHERE operation_id=?").run(fresh.operationId);
    code(() => f.store.commitIdentityLink(fresh, source, [movedConcept], backup), 'ANSWER_CLEARING_IDENTITY_REPLAY_DATA_INVALID');
    assert.equal(backups, 2);
  } finally { f.close(); }
});

test('v3 identity and import BEGIN failures leave a caller-owned transaction and its uncommitted writes intact', () => {
  const f = fixture();
  try {
    f.store.rememberConcepts([oldConcept]);
    const identity = identityRequest(f.store);
    const incoming = importRequest(f.store, emptyCurrent());
    const db = (f.store as unknown as { db: DatabaseSync }).db;
    db.exec('BEGIN IMMEDIATE');
    db.prepare('INSERT INTO layouts VALUES (?,?,?)').run(sourceId, '{"caller":{"x":1,"y":2,"z":3}}', now);
    const before = rows(db);
    assert.equal(f.store.previewIdentityLink(identity, source, [movedConcept]).canLink, true);
    assert.equal(db.isTransaction, true); assert.equal(rows(db), before);
    code(() => f.store.commitIdentityLink(identity, source, [movedConcept], () => 'unexpected'), 'IDENTITY_FAILED');
    assert.equal(db.isTransaction, true); assert.equal(rows(db), before);
    code(() => f.store.commitImport(incoming, source, concepts, () => 'unexpected'), 'IMPORT_FAILED');
    assert.equal(db.isTransaction, true); assert.equal(rows(db), before);
    db.exec('ROLLBACK');
  } finally { f.close(); }
});

test('two real v3 Store processes racing clearing and an old replay never restore the original answer', async () => {
  const f = fixture();
  const children: ReturnType<typeof spawn>[] = [];
  try {
    const request = observation('racing-observation');
    f.store.addObservation(request, null);
    const script = `
      import { Store } from './src/server/store.ts';
      const input=JSON.parse(process.argv[1]);
      const store=new Store({dbPath:input.path,namespace:input.namespace,schemaVersion:3,now:()=>new Date(input.now)});
      process.stdout.write('READY\\n');
      await new Promise(resolve=>process.stdin.once('data',resolve));
      try {
        const result=input.kind==='clear'
          ? store.clearObservationAnswer({observationEventId:input.request.eventId})
          : store.addObservation(input.request,null);
        process.stdout.write(JSON.stringify({status:result.status}));
      } catch(error) { process.stdout.write(JSON.stringify({code:error.code})); }
      finally { store.close(); }
    `;
    function run(kind: 'clear' | 'replay') {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script,
        JSON.stringify({ path: f.path, namespace: sourceId, now, request, kind })],
      { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
      children.push(child);
      let markReady!: () => void, failReady!: (error: Error) => void;
      const ready = new Promise<void>((resolve, reject) => { markReady = resolve; failReady = reject; });
      const result = new Promise<{ status?: string; code?: string }>((resolve, reject) => {
        let output = '', errors = '', initialized = false;
        child.stdout!.on('data', chunk => {
          output += String(chunk);
          if (!initialized && output.startsWith('READY\n')) {
            initialized = true; output = output.slice(6); markReady();
          }
        });
        child.stderr!.on('data', chunk => { errors += String(chunk); });
        child.on('error', error => { failReady(error); reject(error); });
        child.on('close', exit => {
          if (exit !== 0 || !initialized) {
            const error = new Error(`child exit ${exit}: ${errors}`);
            failReady(error); return reject(error);
          }
          try { resolve(JSON.parse(output)); } catch (error) { reject(error); }
        });
      });
      return { ready, result, release: () => child.stdin!.end('go\n') };
    }
    const clearing = run('clear'), replay = run('replay');
    await Promise.all([clearing.ready, replay.ready]);
    clearing.release(); replay.release();
    const [clearResult, replayResult] = await Promise.all([clearing.result, replay.result]);
    assert.equal(clearResult.status, 'accepted');
    assert.ok(replayResult.status === 'duplicate' || replayResult.code === 'ANSWER_CLEARED');
    const raw = f.db.prepare('SELECT answer,request_payload,answer_cleared_at FROM observations WHERE namespace=? AND event_id=?')
      .get(sourceId, request.eventId)!;
    assert.equal(raw.answer, null); assert.equal(raw.request_payload, null); assert.equal(raw.answer_cleared_at, now);
    assert.equal(f.store.countObservations(), 1);
    code(() => f.store.addReview({ eventId: request.eventId, conceptId: request.conceptId,
      sourceRevision: request.sourceRevision, kind: 'review' }), 'EVENT_CONFLICT');
    code(() => f.store.addObservation(request, null), 'ANSWER_CLEARED');
    assert.equal(f.store.countObservations(), 1);
  } finally { for (const child of children) if (child.exitCode === null) child.kill(); f.close(); }
});
