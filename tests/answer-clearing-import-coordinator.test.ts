import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { AnswerClearingImportCoordinator } from '../src/server/answer-clearing-import-coordinator.js';
import { AnswerClearingStore, ANSWER_CLEARING_RETIRED_CREDENTIAL } from '../src/server/answer-clearing-store.js';
import { SAFE_IMPORT_CREDENTIAL } from '../src/server/answer-clearing-replay-contract.js';
import { initializeAnswerClearingSchemaV3 } from '../src/server/answer-clearing-schema.js';
import type { ExportDataV3 } from '../src/shared/answer-clearing-export.js';
import type { ImportCommitRequest, ImportOptions } from '../src/shared/import-data.js';
import { clone, concepts, emptyCurrent, fullExport, now, sourceId } from './helpers/answer-clearing-json-fixture.js';

const options = { restoreLayout: true, restoreReviewPlan: true };
const source = fullExport().source;
function open(path = ':memory:') { const db = new DatabaseSync(path); db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=50'); return db; }
function initialize(db: DatabaseSync) {
  // V3 initialization requires the caller's transaction; open() enables foreign keys first.
  db.exec('BEGIN IMMEDIATE');
  try {
    initializeAnswerClearingSchemaV3(db, { recordedAt: now });
    for (const namespace of [sourceId, 'other-source']) {
      db.prepare('INSERT INTO namespaces VALUES (?,?)').run(namespace, now);
      db.prepare('INSERT INTO config_history VALUES (?,1,?,7,?)').run(namespace, 'time-only-v0', '2025-12-31T00:00:00.000Z');
    }
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}
function fixture(path = ':memory:') {
  const db = open(path); initialize(db);
  const coordinator = new AnswerClearingImportCoordinator({ db, namespace: sourceId, now: () => new Date(now) });
  return { db, coordinator };
}
function request(coordinator: AnswerClearingImportCoordinator, importId = 'full-import', data = fullExport(), opts: ImportOptions = options): ImportCommitRequest {
  const preview = coordinator.previewImport(data, opts, source, concepts);
  return { importId, data, options: opts, previewToken: preview.token, confirmed: true };
}
function expectCode(action: () => unknown, expected: string | string[]) {
  const codes = Array.isArray(expected) ? expected : [expected];
  assert.throws(action, error => {
    assert.ok(error instanceof Error);
    const code = (error as Error & { code?: string }).code;
    assert.ok(codes.includes(code ?? ''), `expected ${codes.join('/')} received ${code}: ${error.message}`);
    assert.equal(error.message, code);
    for (const secret of ['private-answer-sentinel', 'CHANGED-PRIVATE-ANSWER', 'SECRET-TOKEN', 'PRIVATE-SQL-ERROR']) assert.equal(error.message.includes(secret), false);
    return true;
  });
}
function rows(db: DatabaseSync) {
  return JSON.stringify(db.prepare("SELECT name FROM main.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(({ name }) => [name, db.prepare(`SELECT * FROM main."${String(name).replaceAll('"', '""')}" ORDER BY rowid`).all()]));
}
function credentials(db: DatabaseSync) {
  const hash = createHash('sha256').update('private-answer-sentinel').digest('hex');
  db.prepare('INSERT INTO import_receipts VALUES (?,?,?,?)').run(sourceId, 'unsafe-import', hash, '{"status":"accepted"}');
  db.prepare('INSERT INTO import_receipts VALUES (?,?,?,?)').run(sourceId, 'already-retired', ANSWER_CLEARING_RETIRED_CREDENTIAL, '{}');
  db.prepare('INSERT INTO identity_bindings VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(sourceId, 'unsafe-identity', 'raw-unused', concepts[0].id,
    null, concepts[0].source.path, concepts[0].source.revision, '2026-01-08T00:00:00.000Z', 'identity-backup', hash, '{}');
  return hash;
}
function newClearedData(): ExportDataV3 {
  const parent = fullExport().observations[0];
  return emptyCurrent({ observations: [{ ...parent, eventId: 'new-cleared-observation', anchorEventId: null, elapsedDays: null, decay: null,
    answer: null, answerClearing: { observationEventId: 'new-cleared-observation', clearedAt: '2026-01-08T03:00:00.000Z' } }] });
}

test('v3 coordinator commits all nine collections, stores a safe envelope and reopens with one backup and duplicate receipt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lm-v3-import-')); const path = join(dir, 'test.sqlite');
  let db: DatabaseSync | undefined;
  try {
    ({ db } = fixture(path));
    let coordinator = new AnswerClearingImportCoordinator({ db, namespace: sourceId, now: () => new Date(now) });
    let backups = 0; const backup = (data: ExportDataV3) => { backups++; assert.equal(data.observations.length, 0); return 'synthetic-backup'; };
    const input = request(coordinator); const receipt = coordinator.commitImport(input, source, concepts, backup);
    assert.equal(receipt.status, 'accepted'); assert.equal(backups, 1);
    for (const table of ['anchors','observations','observation_revisions','retentions','applications','corrections','relation_reviews','practice_cards','practice_attempts']) {
      assert.equal(db.prepare(`SELECT count(*) AS count FROM ${table} WHERE namespace=?`).get(sourceId)!.count, 1, table);
      assert.equal(db.prepare(`SELECT count(*) AS count FROM ${table} WHERE namespace=?`).get('other-source')!.count, 0, table);
    }
    const saved = db.prepare('SELECT * FROM import_receipts WHERE namespace=?').get(sourceId)!;
    assert.equal(saved.request_hash, SAFE_IMPORT_CREDENTIAL);
    assert.equal(String(saved.receipt_json).includes('private-answer-sentinel'), false);
    assert.equal(String(saved.receipt_json).includes(input.previewToken), false);
    const before = rows(db); db.close(); db = open(path);
    coordinator = new AnswerClearingImportCoordinator({ db, namespace: sourceId, now: () => new Date(now) });
    assert.deepEqual(coordinator.commitImport({ ...input, previewToken: 'SECRET-TOKEN' }, source, concepts, backup), { ...receipt, status: 'duplicate' });
    assert.equal(backups, 1); assert.equal(rows(db), before);
    assert.equal(coordinator.exportData(source, concepts).observations[0].answer, 'private-answer-sentinel');
  } finally { db?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('same import ID rejects changed bodies, recordedAt, event membership and all non-event replay inputs', () => {
  const mutations: Array<[string, (data: ExportDataV3) => void]> = [
    ['answer', d => { d.observations[0].answer = 'CHANGED-PRIVATE-ANSWER'; }],
    ['application body', d => { d.applications![0].content += ' changed'; }],
    ['originally duplicate observation answer', d => { d.observations[0].answer = 'CHANGED-PRIVATE-ANSWER'; }],
    ['recordedAt', d => { d.observations[0].recordedAt = '2026-01-08T00:02:00.000Z'; }],
    ['event removal', d => { d.corrections = []; }],
    ['equal-count replacement', d => { d.corrections![0].eventId = 'replacement-correction'; }],
    ['event addition', d => { d.observations.push({ ...d.observations[0], eventId: 'additional-observation' }); }],
    ['layout', d => { d.layout[concepts[0].id].x += 1; }],
    ['configuration', d => { d.config.halfLifeDays = 8; d.configHistory![0].halfLifeDays = 8; }],
    ['concept metadata', d => { d.concepts[0].title += ' changed'; }],
    ['config recorded metadata', d => { d.restoreMetadata!.configRecordedAt!['1'] = '2025-12-30T00:00:00.000Z'; }],
    ['anchor omitted occurredAt', d => { d.restoreMetadata!.anchorRequests![0].occurredAt = d.anchors[0].occurredAt; }],
    ['review plan', d => { d.reviewPlan!.dailyBudget = 4; }],
    ['exportedAt', d => { d.exportedAt = '2026-01-09T00:01:00.000Z'; }],
  ];
  for (const [label, mutate] of mutations) {
    const { db, coordinator } = fixture();
    try {
      let backups = 0; const backup = () => { backups++; return 'backup'; };
      const first = request(coordinator); coordinator.commitImport(first, source, concepts, backup);
      const input = label === 'originally duplicate observation answer' ? request(coordinator, 'all-duplicates') : first;
      if (input !== first) coordinator.commitImport(input, source, concepts, backup);
      const before = rows(db); const changed = clone(input.data) as ExportDataV3; mutate(changed);
      expectCode(() => coordinator.commitImport({ ...input, data: changed, previewToken: 'SECRET-TOKEN' }, source, concepts, backup), ['IMPORT_CONFLICT','INVALID_IMPORT_DATA']);
      assert.equal(rows(db), before, label); assert.equal(backups, input === first ? 1 : 2, label);
    } finally { db.close(); }
  }
});

test('replay ignores only token changes while changed options conflict and first-commit stale token never writes', () => {
  const { db, coordinator } = fixture();
  try {
    const input = request(coordinator); const before = rows(db); let backups = 0;
    const backup = () => { backups++; return 'backup'; };
    expectCode(() => coordinator.commitImport({ ...input, previewToken: 'SECRET-TOKEN' }, source, concepts, backup), 'IMPORT_STALE');
    assert.equal(rows(db), before); assert.equal(backups, 0);
    const accepted = coordinator.commitImport(input, source, concepts, backup);
    assert.deepEqual(coordinator.commitImport({ ...input, previewToken: 'SECRET-TOKEN' }, source, concepts, backup), { ...accepted, status: 'duplicate' });
    expectCode(() => coordinator.commitImport({ ...input, options: { ...options, restoreLayout: false } }, source, concepts, backup), 'IMPORT_CONFLICT');
    assert.equal(backups, 1);
  } finally { db.close(); }
});

test('local clearing guards the old operation before envelope parsing and a new ID cannot restore the old answer', () => {
  const { db, coordinator } = fixture();
  try {
    const input = request(coordinator); coordinator.commitImport(input, source, concepts, () => 'backup');
    new AnswerClearingStore({ db, namespace: sourceId, now: () => new Date(now) }).clear({ observationEventId: 'observation-alpha' });
    // Even corrupt replay data must not be read before the retired-operation guard.
    db.prepare("UPDATE import_receipts SET receipt_json='broken' WHERE namespace=? AND import_id=?").run(sourceId, input.importId);
    const before = rows(db);
    expectCode(() => coordinator.commitImport(input, source, concepts, () => { throw new Error('unexpected backup'); }), 'ANSWER_CLEARING_OPERATION_RETIRED');
    expectCode(() => coordinator.previewImport(input.data, options, source, concepts), 'ANSWER_CLEARED');
    expectCode(() => coordinator.commitImport({ ...input, importId: 'new-id-old-answer' }, source, concepts,
      () => { throw new Error('unexpected backup'); }), 'ANSWER_CLEARED');
    assert.equal(rows(db), before);
    assert.equal(coordinator.exportData(source, concepts).observations[0].answer, null);
  } finally { db.close(); }
});

test('new cleared import retires unsafe credentials atomically, preserves safe envelopes, and permits fresh operations', () => {
  const { db, coordinator } = fixture();
  try {
    const safeRequest = request(coordinator); coordinator.commitImport(safeRequest, source, concepts, () => 'safe-backup');
    const safeBefore = db.prepare('SELECT receipt_json FROM import_receipts WHERE import_id=?').get(safeRequest.importId)!.receipt_json;
    credentials(db);
    const cleared = request(coordinator, 'new-cleared-import', newClearedData());
    assert.equal(coordinator.commitImport(cleared, source, concepts, () => 'cleared-backup').status, 'accepted');
    for (const id of ['unsafe-import','already-retired']) assert.equal(db.prepare('SELECT request_hash FROM import_receipts WHERE import_id=?').get(id)!.request_hash, ANSWER_CLEARING_RETIRED_CREDENTIAL);
    assert.equal(db.prepare('SELECT request_hash FROM identity_bindings WHERE operation_id=?').get('unsafe-identity')!.request_hash, ANSWER_CLEARING_RETIRED_CREDENTIAL);
    assert.deepEqual(db.prepare('SELECT request_hash,receipt_json FROM import_receipts WHERE import_id=?').get(safeRequest.importId),
      Object.assign(Object.create(null), { request_hash: SAFE_IMPORT_CREDENTIAL, receipt_json: safeBefore }));
    assert.equal(coordinator.commitImport({ ...safeRequest, previewToken: 'different' }, source, concepts, () => 'unused').status, 'duplicate');
    const fresh = request(coordinator, 'fresh-after-retirement', emptyCurrent());
    assert.equal(coordinator.commitImport(fresh, source, concepts, () => 'fresh-backup').status, 'accepted');
  } finally { db.close(); }
});

test('late receipt failure rolls back imported markers, all learning rows and both old credential families', () => {
  const { db, coordinator } = fixture();
  try {
    coordinator.commitImport(request(coordinator), source, concepts, () => 'backup'); credentials(db);
    const input = request(coordinator, 'fail-late', newClearedData());
    db.exec("CREATE TRIGGER fail_import_receipt BEFORE INSERT ON import_receipts WHEN NEW.import_id='fail-late' BEGIN SELECT RAISE(ABORT,'PRIVATE-SQL-ERROR'); END");
    const before = rows(db); let backups = 0;
    expectCode(() => coordinator.commitImport(input, source, concepts, () => { backups++; return 'late-backup'; }), 'IMPORT_FAILED');
    assert.equal(backups, 1); assert.equal(rows(db), before); assert.equal(db.isTransaction, false);
  } finally { db.close(); }
});

test('a marked namespace with legacy credentials rejects new operations until explicit privacy preparation', () => {
  const { db, coordinator } = fixture();
  try {
    coordinator.commitImport(request(coordinator, 'marked', newClearedData()), source, concepts, () => 'backup');
    credentials(db);
    const input = request(coordinator, 'after-repair', emptyCurrent());
    const before = rows(db);
    let backups = 0;
    const backup = () => { backups++; return 'repair-backup'; };
    expectCode(() => coordinator.commitImport(input, source, concepts, backup), 'ANSWER_CLEARING_REPLAY_PREPARATION_REQUIRED');
    assert.equal(backups, 0); assert.equal(rows(db), before);
    const privacy = new AnswerClearingStore({ db, namespace: sourceId });
    assert.equal(privacy.prepareReplayPrivacy().status, 'prepared');
    assert.equal(coordinator.commitImport(input, source, concepts, backup).status, 'accepted');
    assert.equal(backups, 1);
    assert.equal(privacy.getReplayPrivacyStatus().status, 'ready');
  } finally { db.close(); }
});

test('legacy operation IDs are rejected without old-hash comparison and unknown safe envelopes fail closed', () => {
  const { db, coordinator } = fixture();
  try {
    credentials(db); const input = request(coordinator);
    expectCode(() => coordinator.commitImport({ ...input, importId: 'unsafe-import' }, source, concepts, () => 'unused'), 'IMPORT_LEGACY_OPERATION');
    coordinator.commitImport(input, source, concepts, () => 'backup');
    for (const envelope of [{ version: 99 }, { version: 1, receipt: {}, replay: {} }, { version: 1, receipt: {}, replay: {}, unknown: true }]) {
      db.prepare('UPDATE import_receipts SET receipt_json=? WHERE import_id=?').run(JSON.stringify(envelope), input.importId);
      const before = rows(db);
      expectCode(() => coordinator.commitImport(input, source, concepts, () => 'unused'), 'ANSWER_CLEARING_REPLAY_DATA_INVALID');
      assert.equal(rows(db), before);
    }
  } finally { db.close(); }
});

test('caller transaction and a competing connection lock are left intact on failed BEGIN', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lm-v3-import-lock-')); const path = join(dir, 'test.sqlite');
  const { db, coordinator } = fixture(path); let blocker: DatabaseSync | undefined;
  try {
    const input = request(coordinator); db.exec('BEGIN IMMEDIATE');
    db.prepare('UPDATE config_history SET half_life_days=13 WHERE namespace=?').run(sourceId);
    expectCode(() => coordinator.commitImport(input, source, concepts, () => 'unused'), 'IMPORT_FAILED');
    assert.equal(db.isTransaction, true); assert.equal(db.prepare('SELECT half_life_days FROM config_history WHERE namespace=?').get(sourceId)!.half_life_days, 13);
    db.exec('ROLLBACK'); blocker = open(path); blocker.exec('BEGIN IMMEDIATE');
    expectCode(() => coordinator.commitImport(input, source, concepts, () => 'unused'), 'IMPORT_FAILED');
    assert.equal(db.isTransaction, false); assert.equal(blocker.isTransaction, true); blocker.exec('ROLLBACK');
    assert.equal(coordinator.commitImport(input, source, concepts, () => 'backup').status, 'accepted');
  } finally { if (db.isTransaction) db.exec('ROLLBACK'); if (blocker?.isTransaction) blocker.exec('ROLLBACK'); blocker?.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('changed KG mapping cannot turn an old operation into a different normalized import', () => {
  const { db, coordinator } = fixture();
  try {
    const data = emptyCurrent({
      concepts: [{ id: 'raw-alpha', title: 'Raw Alpha', source: concepts[0].source }],
      anchors: [{ ...fullExport().anchors[0], conceptId: 'raw-alpha' }],
      restoreMetadata: { sourceId: 'backup-source',
        anchorRequests: [{ eventId: 'anchor-alpha', conceptId: 'raw-alpha', sourceRevision: 'rev-1', kind: 'review' }],
        configRecordedAt: { '1': '2025-12-31T00:00:00.000Z' } },
    });
    const input = request(coordinator, 'kg-mapped-import', data);
    coordinator.commitImport(input, source, concepts, () => 'backup');
    assert.equal(db.prepare('SELECT concept_id FROM anchors WHERE event_id=?').get('anchor-alpha')!.concept_id, concepts[0].id);
    const changedConcepts = concepts.map(concept => ({ ...concept, id: `new-${concept.id}` }));
    const before = rows(db);
    expectCode(() => coordinator.commitImport(input, source, changedConcepts, () => 'unused'), 'IMPORT_CONFLICT');
    assert.equal(rows(db), before);
  } finally { db.close(); }
});

test('two processes racing for the same import ID accept once, back up once and return a shared receipt', { timeout: 25000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lm-v3-import-race-')); const path = join(dir, 'test.sqlite'); const log = join(dir, 'backups.log');
  const children: ChildProcess[] = [];
  try {
    const { db, coordinator } = fixture(path); const input = request(coordinator); db.close();
    const moduleUrl = new URL('../src/server/answer-clearing-import-coordinator.ts', import.meta.url).href;
    const script = `import {DatabaseSync} from 'node:sqlite'; import {appendFileSync} from 'node:fs'; import {AnswerClearingImportCoordinator} from ${JSON.stringify(moduleUrl)};
      const db=new DatabaseSync(process.env.TEST_DB);db.exec('PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000');
      const store=new AnswerClearingImportCoordinator({db,namespace:${JSON.stringify(sourceId)},now:()=>new Date(${JSON.stringify(now)})});
      process.on('message',message=>{try {const receipt=store.commitImport(message.request,message.source,message.concepts,()=>{appendFileSync(process.env.TEST_BACKUPS,'backup\\n');return 'race-backup';});process.send({receipt});db.close();process.disconnect();}
      catch(error){process.send({error:String(error.code||error)});db.close();process.exitCode=1;process.disconnect();}});process.send({ready:true});`;
    const runs = [0,1].map(() => {
      const child = spawn(process.execPath, ['--import','tsx','--input-type=module','-e',script],
        { cwd: process.cwd(), env: { ...process.env, TEST_DB: path, TEST_BACKUPS: log }, stdio: ['ignore','pipe','pipe','ipc'] });
      children.push(child); let stderr = ''; child.stderr!.on('data', chunk => { stderr += chunk; });
      let readyResolve!: () => void, readyReject!: (error: Error) => void, resultResolve!: (value: unknown) => void, resultReject!: (error: Error) => void;
      const ready = new Promise<void>((resolve,reject) => { readyResolve=resolve; readyReject=reject; });
      const result = new Promise<unknown>((resolve,reject) => { resultResolve=resolve; resultReject=reject; });
      void result.catch(() => {}); let received = false;
      const fail = (error: Error) => { readyReject(error); resultReject(error); };
      child.on('error', fail); child.on('message', (message: unknown) => {
        const value = message as { ready?: boolean; receipt?: unknown; error?: string };
        if (value.ready) readyResolve(); else if (value.error) fail(new Error(value.error)); else { received=true; resultResolve(value.receipt); }
      });
      child.on('exit', code => { if (code !== 0 || !received) fail(new Error(`child exit ${code}: ${stderr}`)); });
      return { child, ready, result };
    });
    await Promise.all(runs.map(run => run.ready));
    for (const run of runs) run.child.send({ request: input, source, concepts });
    const receipts = await Promise.all(runs.map(run => run.result)) as Array<{ status: string; backupId: string; importedAt: string }>;
    assert.deepEqual(receipts.map(receipt => receipt.status).sort(), ['accepted','duplicate']);
    assert.deepEqual({ ...receipts[0], status: 'accepted' }, { ...receipts[1], status: 'accepted' });
    assert.equal(readFileSync(log, 'utf8'), 'backup\n');
    const reader = open(path); try { assert.equal(reader.prepare('SELECT count(*) AS count FROM observations').get()!.count, 1); assert.equal(reader.prepare('SELECT count(*) AS count FROM import_receipts').get()!.count, 1); }
    finally { reader.close(); }
  } finally { for (const child of children) if (child.exitCode === null) child.kill(); rmSync(dir, { recursive: true, force: true }); }
});
