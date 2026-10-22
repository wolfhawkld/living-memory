import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { AnswerClearingStore, ANSWER_CLEARING_RETIRED_CREDENTIAL } from '../src/server/answer-clearing-store.js';
import { initializeAnswerClearingSchemaV3 } from '../src/server/answer-clearing-schema.js';
import { fullExport } from './helpers/answer-clearing-json-fixture.js';

const namespace='owner',otherNamespace='member';
const recorded='2026-10-20T08:01:00.000Z',clearedAt='2026-10-22T08:00:00.000Z';
const answer='SYNTHETIC_PRIVATE_REPLAY_ANSWER';
const tables=['import_receipts','identity_bindings'] as const;
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fixture(path=':memory:') {
  const db=new DatabaseSync(path);db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
  initializeAnswerClearingSchemaV3(db,{recordedAt:recorded});db.exec('COMMIT');
  for(const ns of [namespace,otherNamespace]) {
    db.prepare('INSERT INTO namespaces(namespace,created_at) VALUES (?,?)').run(ns,recorded);
    db.prepare('INSERT INTO config_history(namespace,revision,model_version,half_life_days,recorded_at) VALUES (?,1,?,7,?)').run(ns,'time-only-v0',recorded);
    seedObservation(db,ns);
    const exportedData=fullExport();exportedData.observations[0].answer=answer;
    for(let i=0;i<2;i++) {
      db.prepare('INSERT INTO import_receipts(namespace,import_id,request_hash,receipt_json) VALUES (?,?,?,?)').run(ns,`import-${i}`,digest({importId:`import-${i}`,data:exportedData,options:{restoreLayout:true,restoreReviewPlan:true}}),JSON.stringify({status:'accepted',importId:`import-${i}`,sourceId:ns,importedAt:recorded,backupId:`backup-${i}`,counts:{duplicates:i}}));
      db.prepare(`INSERT INTO identity_bindings(namespace,operation_id,raw_concept_id,concept_id,from_path,to_path,source_revision,confirmed_at,backup_id,request_hash,receipt_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(ns,`binding-${i}`,`raw-${i}`,`concept-${i}`,null,`Concept-${i}.md`,'rev-1',recorded,`identity-backup-${i}`,digest({operationId:`binding-${i}`,previewToken:digest({sourceId:ns,exportedData}),confirmed:true}),JSON.stringify({status:'accepted',operationId:`binding-${i}`,backupId:`identity-backup-${i}`}));
    }
  }
  return {db,store:new AnswerClearingStore({db,namespace,now:()=>new Date(clearedAt)})};
}
function seedObservation(db:DatabaseSync,ns:string,id='observation-1',value=answer,mental=false) {
  const request={eventId:id,conceptId:'concept-1',sourceRevision:'rev-1',observedAt:recorded,configRevision:1,anchorEventId:null,answer:value,evidenceMode:mental?'mental':'written',rating:'partial',exposure:'unexposed',observedExposure:false};
  db.prepare(`INSERT INTO observations(namespace,event_id,concept_id,source_revision,observed_at,recorded_at,config_revision,half_life_days,anchor_event_id,elapsed_days,decay,answer,rating,exposure,observed_exposure,learning_json,evidence_mode,request_payload) VALUES (?,?,?,?,?,?,1,7,NULL,NULL,NULL,?,'partial','unexposed',0,NULL,?,?)`).run(ns,id,'concept-1','rev-1',recorded,recorded,value,request.evidenceMode,JSON.stringify(request));
}
function snapshot(db:DatabaseSync) {
  const names=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  return Object.fromEntries(names.map(row=>[String(row.name),db.prepare(`SELECT * FROM "${String(row.name)}" ORDER BY rowid`).all()]));
}
function assertOnlyClearingAndRetirement(before:ReturnType<typeof snapshot>,after:ReturnType<typeof snapshot>) {
  for(const [name,rows] of Object.entries(before)) {
    const expected=rows.map(row=>{
      if(row.namespace!==namespace)return row;
      if(name==='observations' && row.event_id==='observation-1')return {...row,answer:null,request_payload:null,answer_cleared_at:clearedAt};
      if(name==='import_receipts'||name==='identity_bindings') {
        const actual=after[name].find(item=>name==='import_receipts'?item.namespace===namespace&&item.import_id===row.import_id:item.namespace===namespace&&item.operation_id===row.operation_id)!;
        assert.equal(actual.request_hash,ANSWER_CLEARING_RETIRED_CREDENTIAL);assert.notEqual(actual.request_hash,row.request_hash);
        assert.doesNotMatch(String(actual.request_hash),/^[a-fA-F0-9]{64}$/);
        return {...row,request_hash:actual.request_hash};
      }
      return row;
    });
    assert.deepEqual(JSON.parse(JSON.stringify(after[name])),JSON.parse(JSON.stringify(expected)),name);
  }
  const hashes=tables.flatMap(table=>after[table].filter(row=>row.namespace===namespace).map(row=>row.request_hash));
  assert.equal(new Set(hashes).size,1,'all retired credentials use the same fixed sentinel');
}

test('first clearing retires every namespace replay credential and preserves facts, receipts and bindings after reopen',()=>{
  const base=mkdtempSync(join(tmpdir(),'lm-clearing-replay-'));const path=join(base,'learning.sqlite');
  let db:DatabaseSync|undefined;
  try {
    const f=fixture(path);db=f.db;const before=snapshot(db);
    assert.deepEqual(f.store.clear({observationEventId:'observation-1'}),{status:'accepted',observationEventId:'observation-1',clearedAt});
    assertOnlyClearingAndRetirement(before,snapshot(db));db.close();db=undefined;
    db=new DatabaseSync(path);db.exec('PRAGMA foreign_keys=ON');
    const reopened=new AnswerClearingStore({db,namespace,now:()=>{throw new Error('duplicate clock forbidden');}});
    assert.equal(reopened.clear({observationEventId:'observation-1'}).status,'duplicate');
    assertOnlyClearingAndRetirement(before,snapshot(db));
  } finally {db?.close();rmSync(base,{recursive:true,force:true});}
});

test('retry repairs old cleared parent with live replay hashes without reading clock or changing first marker',()=>{
  const {db}=fixture();
  try {
    const before=snapshot(db);
    db.prepare('UPDATE observations SET answer=NULL,request_payload=NULL,answer_cleared_at=? WHERE namespace=? AND event_id=?').run(clearedAt,namespace,'observation-1');
    const retry=new AnswerClearingStore({db,namespace,now:()=>{throw new Error('duplicate clock forbidden');}});
    assert.deepEqual(retry.clear({observationEventId:'observation-1'}),{status:'duplicate',observationEventId:'observation-1',clearedAt});
    assertOnlyClearingAndRetirement(before,snapshot(db));
  } finally {db.close();}
});

test('failure updating either replay table rolls back answer, marker and all replay credential changes',()=>{
  for(const table of tables) {
    const {db,store}=fixture();
    try {
      const before=snapshot(db);
      db.exec(`CREATE TEMP TRIGGER stop_retirement BEFORE UPDATE OF request_hash ON ${table} WHEN OLD.namespace='owner' BEGIN SELECT RAISE(ABORT,'PRIVATE_SQL_FAILURE'); END`);
      assert.throws(()=>store.clear({observationEventId:'observation-1'}),{code:'ANSWER_CLEARING_WRITE_FAILED'});
      assert.equal(db.isTransaction,false);assert.deepEqual(snapshot(db),before,table);
    } finally {db.close();}
  }
});

test('unsaved, missing and invalid requests never retire namespace credentials',()=>{
  const {db,store}=fixture();
  try {
    seedObservation(db,namespace,'empty','');seedObservation(db,namespace,'mental','',true);
    const before=snapshot(db);
    for(const [input,code] of [[{observationEventId:'empty'},'ANSWER_CLEARING_NO_SAVED_ANSWER'],[{observationEventId:'mental'},'ANSWER_CLEARING_NO_SAVED_ANSWER'],[{observationEventId:'missing'},'ANSWER_CLEARING_NOT_FOUND'],[{observationEventId:'../bad'},'ANSWER_CLEARING_INVALID_REQUEST'],[{observationEventId:'observation-1',answer},'ANSWER_CLEARING_INVALID_REQUEST']] as const) {
      assert.throws(()=>store.clear(input),{code});assert.equal(db.isTransaction,false);assert.deepEqual(snapshot(db),before);
    }
  } finally {db.close();}
});

test('caller transaction stays owned by caller and failed clearing does not retire replay hashes',()=>{
  const {db,store}=fixture();
  try {
    const before=snapshot(db);db.exec('BEGIN IMMEDIATE');
    db.prepare('UPDATE import_receipts SET receipt_json=? WHERE namespace=? AND import_id=?').run('{"caller":"pending"}',namespace,'import-0');
    const pending=snapshot(db);
    assert.throws(()=>store.clear({observationEventId:'observation-1'}),{code:'ANSWER_CLEARING_WRITE_FAILED'});
    assert.equal(db.isTransaction,true);assert.deepEqual(snapshot(db),pending);
    db.exec('ROLLBACK');assert.deepEqual(snapshot(db),before);
  } finally {if(db.isTransaction)db.exec('ROLLBACK');db.close();}
});

test('competing writer lock leaves answers and both replay tables intact and never ends the competing transaction',()=>{
  const base=mkdtempSync(join(tmpdir(),'lm-clearing-replay-lock-'));const path=join(base,'learning.sqlite');
  let db:DatabaseSync|undefined,blocker:DatabaseSync|undefined;
  try {
    const f=fixture(path);db=f.db;const before=snapshot(db);db.exec('PRAGMA busy_timeout=0');
    blocker=new DatabaseSync(path);blocker.exec('BEGIN IMMEDIATE');
    assert.throws(()=>f.store.clear({observationEventId:'observation-1'}),{code:'ANSWER_CLEARING_WRITE_FAILED'});
    assert.equal(db.isTransaction,false);assert.equal(blocker.isTransaction,true);assert.deepEqual(snapshot(db),before);
    blocker.exec('ROLLBACK');
    assert.equal(f.store.clear({observationEventId:'observation-1'}).status,'accepted');
    assertOnlyClearingAndRetirement(before,snapshot(db));
  } finally {if(blocker?.isTransaction)blocker.exec('ROLLBACK');blocker?.close();db?.close();rmSync(base,{recursive:true,force:true});}
});


test('readiness snapshot and explicit preparation repair old cleared instances without reading clock',()=>{
  const {db}=fixture();
  try {
    const store=new AnswerClearingStore({db,namespace,now:()=>{throw new Error('privacy preparation clock forbidden');}});
    assert.deepEqual(store.getReplayPrivacyStatus(),{status:'ready',clearedObservations:0,activeImportCredentials:2,activeIdentityCredentials:2,retiredImportCredentials:0,retiredIdentityCredentials:0});
    const before=snapshot(db);
    assert.deepEqual(store.prepareReplayPrivacy(),{status:'already-ready',retiredImportCredentials:0,retiredIdentityCredentials:0});
    assert.deepEqual(snapshot(db),before);
    db.prepare('UPDATE observations SET answer=NULL,request_payload=NULL,answer_cleared_at=? WHERE namespace=? AND event_id=?').run(clearedAt,namespace,'observation-1');
    assert.deepEqual(store.getReplayPrivacyStatus(),{status:'repair-required',clearedObservations:1,activeImportCredentials:2,activeIdentityCredentials:2,retiredImportCredentials:0,retiredIdentityCredentials:0});
    assert.deepEqual(store.prepareReplayPrivacy(),{status:'prepared',retiredImportCredentials:2,retiredIdentityCredentials:2});
    assertOnlyClearingAndRetirement(before,snapshot(db));
    assert.deepEqual(store.getReplayPrivacyStatus(),{status:'ready',clearedObservations:1,activeImportCredentials:0,activeIdentityCredentials:0,retiredImportCredentials:2,retiredIdentityCredentials:2});
    assert.deepEqual(store.prepareReplayPrivacy(),{status:'already-ready',retiredImportCredentials:0,retiredIdentityCredentials:0});
    db.prepare('UPDATE import_receipts SET request_hash=? WHERE namespace=? AND import_id=?').run(digest({oldWriter:answer}),namespace,'import-0');
    assert.deepEqual(store.getReplayPrivacyStatus(),{status:'repair-required',clearedObservations:1,activeImportCredentials:1,activeIdentityCredentials:0,retiredImportCredentials:1,retiredIdentityCredentials:2});
    db.exec('BEGIN IMMEDIATE');
    assert.throws(()=>store.assertOperationReplayAllowed('identity','binding-0'),{code:'ANSWER_CLEARING_REPLAY_PREPARATION_REQUIRED'});
    assert.equal(db.isTransaction,true);db.exec('ROLLBACK');
    const parent=store.readObservation('observation-1')!;assert.equal(parent.answer,null);
    if(parent.answer===null)assert.equal(parent.answerClearing.clearedAt,clearedAt);
  } finally {if(db.isTransaction)db.exec('ROLLBACK');db.close();}
});

test('operation replay guards require caller transaction, namespace repair first, then precise retired operation',()=>{
  const {db,store}=fixture();
  try {
    assert.throws(()=>store.assertOperationReplayAllowed('import','import-0'),{code:'ANSWER_CLEARING_TRANSACTION_REQUIRED'});
    db.exec('BEGIN IMMEDIATE');
    for(const kind of ['import','identity'] as const) {
      store.assertOperationReplayAllowed(kind,kind==='import'?'import-0':'binding-0');store.assertOperationReplayAllowed(kind,'missing');
    }
    assert.equal(db.isTransaction,true);db.exec('COMMIT');
    db.prepare('UPDATE observations SET answer=NULL,request_payload=NULL,answer_cleared_at=? WHERE namespace=? AND event_id=?').run(clearedAt,namespace,'observation-1');
    db.exec('BEGIN IMMEDIATE');
    assert.throws(()=>store.assertOperationReplayAllowed('import','missing'),{code:'ANSWER_CLEARING_REPLAY_PREPARATION_REQUIRED'});
    assert.throws(()=>store.assertOperationReplayAllowed('identity','binding-0'),{code:'ANSWER_CLEARING_REPLAY_PREPARATION_REQUIRED'});
    assert.equal(db.isTransaction,true);db.exec('ROLLBACK');
    store.prepareReplayPrivacy();db.exec('BEGIN IMMEDIATE');
    for(const [kind,id] of [['import','import-0'],['identity','binding-0']] as const) {
      assert.throws(()=>store.assertOperationReplayAllowed(kind,id),{code:'ANSWER_CLEARING_OPERATION_RETIRED'});
      store.assertOperationReplayAllowed(kind,'missing');
    }
    assert.equal(db.isTransaction,true);db.exec('COMMIT');
    const member=new AnswerClearingStore({db,namespace:otherNamespace});db.exec('BEGIN IMMEDIATE');
    member.assertOperationReplayAllowed('import','import-0');member.assertOperationReplayAllowed('identity','binding-0');db.exec('ROLLBACK');
  } finally {if(db.isTransaction)db.exec('ROLLBACK');db.close();}
});

test('preparation failure and caller-owned transaction preserve all old credential hashes',()=>{
  for(const table of tables) {
    const {db,store}=fixture();
    try {
      db.prepare('UPDATE observations SET answer=NULL,request_payload=NULL,answer_cleared_at=? WHERE namespace=? AND event_id=?').run(clearedAt,namespace,'observation-1');
      const before=snapshot(db);
      db.exec(`CREATE TEMP TRIGGER stop_preparation BEFORE UPDATE OF request_hash ON ${table} BEGIN SELECT RAISE(ABORT,'PRIVATE_REPLAY_FAILURE'); END`);
      assert.throws(()=>store.prepareReplayPrivacy(),{code:'ANSWER_CLEARING_WRITE_FAILED'});
      assert.equal(db.isTransaction,false);assert.deepEqual(snapshot(db),before);
      db.exec('DROP TRIGGER stop_preparation; BEGIN IMMEDIATE');
      assert.throws(()=>store.prepareReplayPrivacy(),{code:'ANSWER_CLEARING_WRITE_FAILED'});
      assert.equal(db.isTransaction,true);assert.deepEqual(snapshot(db),before);db.exec('ROLLBACK');
    } finally {if(db.isTransaction)db.exec('ROLLBACK');db.close();}
  }
});

test('operation guard validates kind and ID without echoing input or finishing caller transaction',()=>{
  const {db,store}=fixture();
  try {
    db.exec('BEGIN IMMEDIATE');
    for(const [kind,id] of [['not-a-kind','import-0'],['import','../private-path'],['identity',''],['identity',answer+' invalid']] as const) {
      assert.throws(()=>store.assertOperationReplayAllowed(kind as 'import',id),(error:unknown)=>{
        assert.equal((error as {code:string}).code,'ANSWER_CLEARING_INVALID_REQUEST');
        assert.equal(String(error).includes(answer),false);return true;
      });
      assert.equal(db.isTransaction,true);
    }
    db.exec('ROLLBACK');
  } finally {if(db.isTransaction)db.exec('ROLLBACK');db.close();}
});
