import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { AnswerClearingStore, AnswerClearingStoreError } from '../src/server/answer-clearing-store.js';
import { initializeAnswerClearingSchemaV3 } from '../src/server/answer-clearing-schema.js';
import type { Observation, ObservationRequest } from '../src/shared/types.js';

const OBSERVED = '2026-10-20T08:00:00.000Z', RECORDED = '2026-10-20T08:01:00.000Z';
const CLEARED = '2026-10-22T08:00:00.000Z', ORIGINAL = 'SYNTHETIC_PRIVATE_ANSWER_42';
const now = () => new Date(CLEARED);
const namespace = 'synthetic-owner';

function initialize(db: DatabaseSync) {
  db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
  try { initializeAnswerClearingSchemaV3(db, { recordedAt: RECORDED }); db.exec('COMMIT'); }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
function fixture(path = ':memory:') {
  const db = new DatabaseSync(path); initialize(db);
  return { db, store: new AnswerClearingStore({ db, namespace, now }) };
}
function seed(db: DatabaseSync, options: { namespace?: string; eventId?: string; answer?: string; mental?: boolean; legacy?: boolean } = {}) {
  const ns = options.namespace ?? namespace, eventId = options.eventId ?? 'observation-1';
  db.prepare('INSERT OR IGNORE INTO namespaces(namespace,created_at) VALUES (?,?)').run(ns, RECORDED);
  db.prepare('INSERT OR IGNORE INTO config_history(namespace,revision,model_version,half_life_days,recorded_at) VALUES (?,1,?,7,?)')
    .run(ns, 'time-v1', RECORDED);
  const anchor = { eventId: 'anchor-1', conceptId: 'concept-1', sourceRevision: 'revision-1', kind: 'review', occurredAt: OBSERVED };
  db.prepare('INSERT OR IGNORE INTO anchors(namespace,event_id,concept_id,source_revision,occurred_at,recorded_at,kind,request_payload) VALUES (?,?,?,?,?,?,?,?)')
    .run(ns, anchor.eventId, anchor.conceptId, anchor.sourceRevision, OBSERVED, RECORDED, 'review', JSON.stringify(anchor));
  const request: ObservationRequest = {
    eventId, conceptId: 'concept-1', sourceRevision: 'revision-1', observedAt: OBSERVED, configRevision: 1, anchorEventId: 'anchor-1',
    answer: options.answer ?? ORIGINAL, rating: 'partial', exposure: 'unexposed', observedExposure: false,
    ...(!options.legacy ? { evidenceMode: options.mental ? 'mental' as const : 'written' as const,
      learning: { task: 'scenario' as const, scenario: 'Independent scenario prompt remains', applicability: 'Independent modeling note remains',
        confidence: 80, confidenceAt: '2026-10-20T07:59:00.000Z', cue: 'independent' as const, outcome: 'partial' as const, basis: 'self-check' as const } } : {}),
  };
  const observation: Observation = { ...request, recordedAt: RECORDED, halfLifeDays: 7, elapsedDays: 1, decay: 0.9 };
  db.prepare(`INSERT INTO observations(namespace,event_id,concept_id,source_revision,observed_at,recorded_at,config_revision,half_life_days,
    anchor_event_id,elapsed_days,decay,answer,rating,exposure,observed_exposure,learning_json,evidence_mode,request_payload)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(ns,eventId,'concept-1','revision-1',OBSERVED,RECORDED,1,7,'anchor-1',1,0.9,
      request.answer,'partial','unexposed',0,request.learning ? JSON.stringify(request.learning) : null,request.evidenceMode ?? null,JSON.stringify(request));
  return observation;
}
function row(db: DatabaseSync, id = 'observation-1', ns = namespace) {
  return db.prepare('SELECT * FROM observations WHERE namespace=? AND event_id=?').get(ns,id)!;
}
function rows(db: DatabaseSync, table: 'anchors' | 'observation_revisions' | 'observations') {
  return db.prepare(`SELECT * FROM ${table} ORDER BY namespace,event_id`).all();
}
function fails(action: () => unknown, code: string, status: number) {
  assert.throws(action, error => {
    assert.ok(error instanceof AnswerClearingStoreError);
    assert.equal(error.code, code); assert.equal(error.status, status); assert.equal(error.message, code);
    assert.doesNotMatch(error.message, /SYNTHETIC_PRIVATE|constraint failed|SQLite|request_payload/); return true;
  });
}

test('v3 clearing atomically removes both saved copies and keeps all other observation, anchor and revision columns', () => {
  const { db, store } = fixture();
  try {
    const original = seed(db);
    db.prepare(`INSERT INTO observation_revisions(namespace,event_id,observation_event_id,previous_event_id,concept_id,source_revision,
      occurred_at,recorded_at,action,reason,note,assessment_json,request_payload) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(namespace,'revision-event','observation-1',null,'concept-1','revision-1',RECORDED,RECORDED,'withdraw','other',
        'Independent revision note remains',null,JSON.stringify({ eventId:'revision-event', action:'withdraw' }));
    const before = row(db), anchors = rows(db,'anchors'), revisions = rows(db,'observation_revisions');
    assert.deepEqual(store.readObservation('observation-1'), original);
    assert.deepEqual(store.clear({ observationEventId:'observation-1' }), { status:'accepted', observationEventId:'observation-1', clearedAt:CLEARED });
    const after = row(db);
    assert.equal(after.answer, null); assert.equal(after.request_payload, null); assert.equal(after.answer_cleared_at,CLEARED);
    for (const key of Object.keys(before)) if (!['answer','request_payload','answer_cleared_at'].includes(key)) assert.equal(after[key],before[key],key);
    assert.deepEqual(rows(db,'anchors'),anchors); assert.deepEqual(rows(db,'observation_revisions'),revisions);
    assert.doesNotMatch(JSON.stringify(after),new RegExp(ORIGINAL));
    assert.equal(Object.keys(after).some(key=>/hash/i.test(key)),false);
    const { answer: _answer, ...rest } = original;
    assert.deepEqual(store.readObservation('observation-1'), { ...rest, answer:null, answerClearing:{ observationEventId:'observation-1',clearedAt:CLEARED } });
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  } finally { db.close(); }
});

test('repeated clearing retains its first marker without reading the clock; identical IDs in another namespace remain intact', () => {
  const { db, store } = fixture();
  try {
    seed(db); const other = seed(db,{ namespace:'synthetic-member' });
    store.clear({ observationEventId:'observation-1' }); const after = row(db);
    const retry = new AnswerClearingStore({ db, namespace, now:()=>{ throw new Error('must not read repeat clock'); } });
    assert.deepEqual(retry.clear({ observationEventId:' observation-1 ' }), { status:'duplicate',observationEventId:'observation-1',clearedAt:CLEARED });
    assert.deepEqual(row(db),after);
    assert.deepEqual(new AnswerClearingStore({ db,namespace:'synthetic-member',now }).readObservation('observation-1'),other);
    assert.equal(row(db,'observation-1','synthetic-member').request_payload !== null,true);
  } finally { db.close(); }
});

test('SQL projection exposes only known frozen learning fields and clearing drops the entire mechanical request payload', () => {
  const { db,store }=fixture();
  try {
    const original=seed(db), evidence={ ...original.learning!,scenarioRevisit:true as const };
    db.prepare('UPDATE observations SET learning_json=?,request_payload=? WHERE namespace=? AND event_id=?').run(
      JSON.stringify({ ...evidence,answerHash:'unrecognized-derived-value',request_payload:{ internal:'unrecognized-projection-field' } }),
      JSON.stringify({ answer:ORIGINAL,nested:{ mechanicalAnswer:ORIGINAL,answerHash:'synthetic-derived-value' } }),namespace,'observation-1');
    const before=store.readObservation('observation-1')!;
    assert.deepEqual(before.learning,evidence); assert.equal(Object.isFrozen(before),true); assert.equal(Object.isFrozen(before.learning),true);
    assert.equal(Object.hasOwn(before,'request_payload'),false);
    assert.equal(Object.hasOwn(before.learning!,'answerHash'),false); assert.equal(Object.hasOwn(before.learning!,'request_payload'),false);
    assert.equal(Object.keys(before.learning!).length,9);
    store.clear({ observationEventId:'observation-1' });
    assert.equal(row(db).request_payload,null); assert.equal(row(db).answer,null);
    const after=store.readObservation('observation-1')!;
    assert.deepEqual(after.learning,evidence); assert.equal(Object.isFrozen(after),true); assert.equal(Object.isFrozen(after.learning),true);
    assert.doesNotMatch(JSON.stringify(after),/SYNTHETIC_PRIVATE|Hash|request_payload|mechanicalAnswer|unrecognized/);
  } finally {db.close();}
});

test('only saved characters can be cleared; empty written/mental evidence stays distinct, whitespace and legacy answers can be removed', () => {
  const { db, store } = fixture();
  try {
    for (const options of [{ eventId:'empty',answer:'' },{ eventId:'mental',answer:'',mental:true }]) {
      const original=seed(db,options), before=row(db,options.eventId);
      fails(()=>store.clear({ observationEventId:options.eventId }),'ANSWER_CLEARING_NO_SAVED_ANSWER',409);
      assert.deepEqual(row(db,options.eventId),before); assert.deepEqual(store.readObservation(options.eventId),original);
    }
    for (const options of [{ eventId:'whitespace',answer:' \n\t' },{ eventId:'legacy',legacy:true }]) {
      seed(db,options); assert.equal(store.clear({ observationEventId:options.eventId }).status,'accepted');
      assert.equal(store.readObservation(options.eventId)!.answer,null);
    }
  } finally { db.close(); }
});

test('strict request/ID failures are fixed and read-only; a foreign namespace target is not found', () => {
  const { db, store } = fixture();
  try {
    seed(db); const before=rows(db,'observations');
    for (const input of [null,[],{}, { observationEventId:'../bad' },{ observationEventId:'observation-1',answer:ORIGINAL },
      { get observationEventId() { throw new Error(ORIGINAL); } }]) {
      fails(()=>store.clear(input),'ANSWER_CLEARING_INVALID_REQUEST',400);
    }
    fails(()=>store.readObservation('../bad'),'ANSWER_CLEARING_INVALID_REQUEST',400);
    assert.equal(store.readObservation('missing'),null);
    fails(()=>store.clear({ observationEventId:'missing' }),'ANSWER_CLEARING_NOT_FOUND',404);
    const foreign = new AnswerClearingStore({ db,namespace:'not-owner',now });
    fails(()=>foreign.clear({ observationEventId:'observation-1' }),'ANSWER_CLEARING_NOT_FOUND',404);
    assert.deepEqual(rows(db,'observations'),before); assert.equal(db.isTransaction,false);
  } finally { db.close(); }
});

test('first-clearing time cannot precede parent receipt and an invalid clock cannot write a marker', () => {
  const { db } = fixture();
  try {
    seed(db); const before=row(db);
    for (const time of ['2026-10-19T00:00:00Z','invalid']) {
      const store=new AnswerClearingStore({ db,namespace,now:()=>new Date(time) });
      fails(()=>store.clear({ observationEventId:'observation-1' }),'ANSWER_CLEARING_INVALID_CLEARED_AT',400);
      assert.deepEqual(row(db),before); assert.equal(db.isTransaction,false);
    }
    const equal=new AnswerClearingStore({ db,namespace,now:()=>new Date(RECORDED) });
    assert.equal(equal.clear({ observationEventId:'observation-1' }).clearedAt,RECORDED);
  } finally { db.close(); }
});

test('corrupt persisted markers, NULL pairs and exposure flags fail closed without returning text or writing changes', () => {
  for (const change of [
    "answer=NULL,request_payload=NULL,answer_cleared_at='not-an-instant'",
    "answer=NULL,request_payload=NULL,answer_cleared_at='2026-10-22T16:00:00+08:00'",
    "answer=NULL,request_payload=NULL,answer_cleared_at='2026-10-19T00:00:00.000Z'",
    'answer=NULL', 'request_payload=NULL', 'observed_exposure=2',
  ]) {
    const { db,store }=fixture();
    try {
      seed(db); db.exec(`PRAGMA ignore_check_constraints=ON; UPDATE observations SET ${change}; PRAGMA ignore_check_constraints=OFF`);
      const before=row(db);
      fails(()=>store.readObservation('observation-1'),'ANSWER_CLEARING_DATA_INVALID',503);
      fails(()=>store.clear({ observationEventId:'observation-1' }),'ANSWER_CLEARING_DATA_INVALID',503);
      assert.equal(db.isTransaction,false); assert.deepEqual(row(db),before);
      db.exec('BEGIN IMMEDIATE');
      fails(()=>store.assertReplayAllowed('observation-1'),'ANSWER_CLEARING_DATA_INVALID',503);
      assert.equal(db.isTransaction,true); db.exec('ROLLBACK');
    } finally { if(db.isTransaction)db.exec('ROLLBACK');db.close(); }
  }
});

test('a failed update rolls back both copies and marker; caller transactions are never committed or rolled back', () => {
  const { db, store } = fixture();
  try {
    seed(db); const before=row(db);
    // Inspector intentionally rejects extra schema objects. Install a temporary failure only after construction.
    db.exec(`CREATE TEMP TRIGGER fail_answer_clear BEFORE UPDATE ON observations BEGIN SELECT RAISE(ABORT,'SYNTHETIC_PRIVATE_FAILURE'); END`);
    fails(()=>store.clear({ observationEventId:'observation-1' }),'ANSWER_CLEARING_WRITE_FAILED',503);
    assert.equal(db.isTransaction,false); assert.deepEqual(row(db),before);
    db.exec('DROP TRIGGER fail_answer_clear; BEGIN IMMEDIATE');
    db.prepare('UPDATE config_history SET half_life_days=9 WHERE namespace=?').run(namespace);
    fails(()=>store.clear({ observationEventId:'observation-1' }),'ANSWER_CLEARING_WRITE_FAILED',503);
    assert.equal(db.isTransaction,true); assert.equal(db.prepare('SELECT half_life_days FROM config_history').get()!.half_life_days,9);
    assert.deepEqual(row(db),before); db.exec('ROLLBACK');
    assert.equal(db.prepare('SELECT half_life_days FROM config_history').get()!.half_life_days,7);
    assert.equal(store.clear({ observationEventId:'observation-1' }).status,'accepted');
  } finally { if(db.isTransaction) db.exec('ROLLBACK'); db.close(); }
});

test('replay guard requires caller-owned transaction and rejects cleared occupancy without allowing event reuse', () => {
  const { db, store } = fixture();
  try {
    seed(db);
    fails(()=>store.assertReplayAllowed('observation-1'),'ANSWER_CLEARING_TRANSACTION_REQUIRED',503);
    db.exec('BEGIN IMMEDIATE');
    store.assertReplayAllowed('observation-1'); store.assertReplayAllowed('missing');
    fails(()=>store.assertReplayAllowed('../bad'),'ANSWER_CLEARING_INVALID_REQUEST',400);
    assert.equal(db.isTransaction,true); db.exec('COMMIT');
    store.clear({ observationEventId:'observation-1' }); const before=row(db);
    db.exec('BEGIN IMMEDIATE');
    fails(()=>store.assertReplayAllowed('observation-1'),'ANSWER_CLEARED',409);
    assert.equal(db.isTransaction,true); assert.deepEqual(row(db),before); db.exec('ROLLBACK');
    assert.throws(()=>seed(db),/UNIQUE constraint/);
  } finally { if(db.isTransaction) db.exec('ROLLBACK'); db.close(); }
});

test('a competing connection lock cannot partly clear data; reopening preserves the original first marker', () => {
  const base=mkdtempSync(join(tmpdir(),'lm-answer-clear-lock-')), path=join(base,'learning.sqlite');
  let db:DatabaseSync|undefined, blocker:DatabaseSync|undefined;
  try {
    const f=fixture(path); db=f.db; seed(db); const before=row(db);
    blocker=new DatabaseSync(path); blocker.exec('BEGIN IMMEDIATE');
    db.exec('PRAGMA busy_timeout=0');
    fails(()=>f.store.clear({ observationEventId:'observation-1' }),'ANSWER_CLEARING_WRITE_FAILED',503);
    assert.deepEqual(row(db),before); assert.equal(db.isTransaction,false); assert.equal(blocker.isTransaction,true);
    blocker.exec('ROLLBACK'); blocker.close(); blocker=undefined;
    f.store.clear({ observationEventId:'observation-1' }); db.close();
    db=new DatabaseSync(path); const reopened=new AnswerClearingStore({ db,namespace,now:()=>new Date('2027-01-01Z') });
    assert.equal(reopened.readObservation('observation-1')!.answer,null);
    assert.deepEqual(reopened.clear({ observationEventId:'observation-1' }),{ status:'duplicate',observationEventId:'observation-1',clearedAt:CLEARED });
    assert.equal(row(db).request_payload,null);
  } finally { if(blocker?.isTransaction) blocker.exec('ROLLBACK'); blocker?.close(); db?.close(); rmSync(base,{recursive:true,force:true}); }
});

test('two ready processes racing to clear accept once and return one shared first marker', { timeout:20000 }, async () => {
  const base=mkdtempSync(join(tmpdir(),'lm-answer-clear-race-')), path=join(base,'learning.sqlite');
  const children:ChildProcess[]=[];
  try {
    const { db }=fixture(path); seed(db); db.close();
    const moduleUrl=new URL('../src/server/answer-clearing-store.ts',import.meta.url).href;
    const source=`import {DatabaseSync} from 'node:sqlite'; import {AnswerClearingStore} from ${JSON.stringify(moduleUrl)};
      const db=new DatabaseSync(process.env.TEST_DB); db.exec('PRAGMA busy_timeout=5000');
      const store=new AnswerClearingStore({db,namespace:${JSON.stringify(namespace)},now:()=>new Date(process.env.TEST_NOW)});
      process.on('message',()=>{try {const receipt=store.clear({observationEventId:'observation-1'}); process.send({receipt}); db.close(); process.disconnect();}
      catch(error){process.send({error:String(error.code || error)});db.close();process.exitCode=1;process.disconnect();}});process.send({ready:true});`;
    const runs=[CLEARED,'2026-10-22T08:00:01.000Z'].map(time=>{
      const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',source],
        {cwd:process.cwd(),env:{...process.env,TEST_DB:path,TEST_NOW:time},stdio:['ignore','pipe','pipe','ipc']});
      children.push(child); let stderr=''; child.stderr!.on('data',chunk=>{stderr+=chunk;});
      let readyResolve!:()=>void, readyReject!:(error:Error)=>void, resultResolve!:(value:unknown)=>void, resultReject!:(error:Error)=>void;
      let received=false;
      const ready=new Promise<void>((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
      const result=new Promise<unknown>((resolve,reject)=>{resultResolve=resolve;resultReject=reject;});
      // A startup failure must reject readiness immediately, rather than leave the test waiting for its timeout.
      void result.catch(()=>{});
      const fail=(error:Error)=>{readyReject(error);resultReject(error);};
      child.on('error',fail); child.on('message',(message:unknown)=>{
        const value=message as {ready?:boolean;receipt?:unknown;error?:string};
        if(value.ready) readyResolve(); else if(value.error) fail(new Error(value.error)); else {received=true;resultResolve(value.receipt);}
      });
      child.on('exit',code=>{if(code!==0 || !received)fail(new Error(`child exit ${code}: ${stderr}`));});
      return { child,ready,result };
    });
    await Promise.all(runs.map(run=>run.ready)); for(const run of runs) run.child.send('clear');
    const receipts=await Promise.all(runs.map(run=>run.result)) as Array<{status:string;clearedAt:string}>;
    assert.deepEqual(receipts.map(value=>value.status).sort(),['accepted','duplicate']);
    assert.equal(receipts[0].clearedAt,receipts[1].clearedAt); assert.ok([CLEARED,'2026-10-22T08:00:01.000Z'].includes(receipts[0].clearedAt));
    const reader=new DatabaseSync(path); try { assert.equal(row(reader).answer,null);assert.equal(row(reader).request_payload,null);
      assert.equal(row(reader).answer_cleared_at,receipts[0].clearedAt); } finally {reader.close();}
  } finally { for(const child of children) if(child.exitCode===null) child.kill(); rmSync(base,{recursive:true,force:true}); }
});
