import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Accounts } from '../src/server/accounts.js';
import { StoreError } from '../src/server/store.js';
import { feishuReviewItemId, feishuReviewEventId, feishuReviewCurrentOperations, withFeishuReviewFrozen } from '../src/shared/feishu-review.js';
import type { FeishuReviewSession, FeishuReviewState, FeishuReviewMutation, FeishuReviewWriteIntent } from '../src/shared/feishu-review.js';

const actor = { appId:'app_synthetic',tenantKey:'tenant_synthetic',openId:'open_synthetic' };
const scope = { namespace:'synthetic-batch',sourceFingerprint:'a'.repeat(64),originChatId:'private-chat' };
const sessionId = 'a'.repeat(32);
const now = '2026-10-07T00:00:00.000Z';
const frozen = { observedAt:now,configRevision:1,halfLifeDays:7,anchorEventId:null };
function initial(count = 3): FeishuReviewState {
  return { domainId:'Math',conceptId:'concept-0',sourceRevision:'rev-0',phase:'front',paused:false,page:1,frozen:null,
    batch:{ requestedSize:3,cursor:0,items:Array.from({ length:count },(_,i)=>({ id:String(i+1).repeat(32),conceptId:`concept-${i}`,
      sourceRevision:`rev-${i}`,frozen:null,disposition:'open' })) } };
}
async function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(),'lm-feishu-batch-'));
  let clock = Date.parse(now);
  const options = { dataDir,now:()=>new Date(clock) }; let accounts = new Accounts(options); let counter = 0;
  const user = await accounts.setup('owner','synthetic-batch-test-password');
  const browser = accounts.issueSession(user.id);
  const issued = accounts.issueFeishuBindingRequest(user.id,browser.sessionId,actor);
  assert.equal(accounts.confirmFeishuBinding({ ...actor,code:issued.command.split(' ')[1],eventId:'bind',messageId:'bind-msg',chatId:scope.originChatId }).status,'confirmed');
  const auth = { userId:user.id,accessRevision:user.accessRevision,bindingId:accounts.getFeishuBindingState(user.id).binding!.id };
  const transition = (mutation:FeishuReviewMutation|null, overrides = scope) => accounts.claimFeishuReviewTransition(actor,auth,
    { kind:'message',message:{ ...actor,eventId:`event-${counter}`,messageId:`message-${++counter}`,chatId:scope.originChatId,text:'知识 复习 3' } },overrides,()=>mutation);
  const current = () => accounts.getFeishuReviewSession(actor,auth,scope.namespace)!;
  const create = (state = initial()) => transition({ kind:'create',id:sessionId,state })!.session!;
  const update = (state:FeishuReviewState,intent?:FeishuReviewWriteIntent) => transition({ kind:'update',state,...(intent?{ intent }:{}) });
  const reveal = (session = current()) => update({ ...withFeishuReviewFrozen(session.state,frozen),phase:'revealed' })!.session!;
  return { get accounts(){return accounts;},auth,options,user,transition,current,create,update,reveal,
    reopen(closed=false){ if(!closed)accounts.close(); accounts=new Accounts(options); },
    advance(ms:number){clock+=ms;},
    cleanup(){ accounts.close(); rmSync(dataDir,{recursive:true,force:true}); } };
}
function observation(session:FeishuReviewSession):FeishuReviewWriteIntent {
  return { kind:'observation',request:{ eventId:feishuReviewEventId(session,'observation'),conceptId:session.state.conceptId,
    sourceRevision:session.state.sourceRevision,observedAt:session.state.frozen!.observedAt,configRevision:session.state.frozen!.configRevision,
    anchorEventId:session.state.frozen!.anchorEventId,answer:'',evidenceMode:'mental',rating:'clear',exposure:'unknown',observedExposure:false,
    learning:{ task:'concept',cue:'unknown',outcome:'unverified',basis:'self-check',confidence:null,confidenceAt:null } } };
}
function sql(f:Awaited<ReturnType<typeof fixture>>,query:string){ const db=new DatabaseSync(f.accounts.dbPath);try{return db.prepare(query).all();}finally{db.close();} }
const legacySchema = `CREATE TABLE feishu_review_operations (
 id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES feishu_review_sessions(id),
 kind TEXT NOT NULL CHECK(kind IN ('observation','review')),intent_json TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','applied','conflict')),error_code TEXT,created_at TEXT NOT NULL,settled_at TEXT,
 UNIQUE(session_id,kind))`;
function downgradeOperations(db:DatabaseSync){
  db.exec(`BEGIN IMMEDIATE; ALTER TABLE feishu_review_operations RENAME TO synthetic_new_operations; ${legacySchema};
 INSERT INTO feishu_review_operations(id,session_id,kind,intent_json,status,error_code,created_at,settled_at)
 SELECT id,session_id,kind,intent_json,status,error_code,created_at,settled_at FROM synthetic_new_operations;
 DROP TABLE synthetic_new_operations; COMMIT;`);
}

test('per-item helpers preserve legacy IDs and freeze only the current item without changing phase',()=>{
  const state=initial(); const before=structuredClone(state);
  const session={ id:sessionId,state } as FeishuReviewSession;
  assert.equal(feishuReviewItemId(session),'1'.repeat(32));
  assert.equal(feishuReviewEventId(session,'observation'),`feishu-observation:${sessionId}:${'1'.repeat(32)}`);
  const next=withFeishuReviewFrozen(state,frozen);
  assert.equal(next.phase,'front'); assert.deepEqual(next.batch!.items[0]!.frozen,frozen);
  assert.equal(next.batch!.items[1]!.frozen,null); assert.deepEqual(state,before);
  const { batch:_batch,...legacy }=state;
  assert.equal(feishuReviewItemId({ ...session,state:legacy }),sessionId);
  assert.equal(feishuReviewEventId({ ...session,state:legacy },'review'),`feishu-review:${sessionId}`);
});

test('batch create and ordinary updates enforce queue identity, unique IDs and current-only freezing',async()=>{
 const f=await fixture();try{
  for(const change of [
   { requestedSize:4 },{ cursor:1 },{ items:[] },{ items:initial().batch!.items.concat(initial().batch!.items[0]!) },
   { items:initial().batch!.items.map(item=>({...item,id:'1'.repeat(32)})) },
   { items:initial().batch!.items.map(item=>({...item,conceptId:'concept-0'})) },
   { items:initial().batch!.items.map((item,i)=>i===1?{...item,frozen}:item) },
  ])assert.equal(f.transition({kind:'create',id:sessionId,state:{...initial(),batch:{...initial().batch!,...change}}} as FeishuReviewMutation),null);
  const coherent=initial();coherent.batch!.cursor=1;coherent.batch!.items[0]!.disposition='skipped';
  coherent.conceptId=coherent.batch!.items[1]!.conceptId;coherent.sourceRevision=coherent.batch!.items[1]!.sourceRevision;
  const receiptCount=sql(f,'SELECT * FROM feishu_read_receipts').length;
  assert.equal(f.transition({kind:'create',id:sessionId,state:coherent}),null);
  assert.equal(sql(f,'SELECT * FROM feishu_read_receipts').length,receiptCount);
  assert.equal(f.current(),null);
  const created=f.create(); const before=sql(f,'SELECT * FROM feishu_read_receipts').length;
  for(const change of [
   {cursor:1},{requestedSize:5},{items:created.state.batch!.items.map((item,i)=>i===0?{...item,disposition:'skipped'}:item)},
   {items:created.state.batch!.items.map((item,i)=>i===1?{...item,sourceRevision:'other'}:item)},
  ])assert.equal(f.update({...created.state,batch:{...created.state.batch!,...change}} as FeishuReviewState),null);
  const {batch:_batch,...legacy}=created.state;assert.equal(f.update(legacy),null);
  assert.equal(sql(f,'SELECT * FROM feishu_read_receipts').length,before);
  const revealed=f.reveal(created); assert.deepEqual(revealed.state.batch!.items[0]!.frozen,frozen);
  assert.equal(f.update({...revealed.state,batch:{...revealed.state.batch!,items:revealed.state.batch!.items.map((item,i)=>i===0?{...item,frozen:{...frozen,halfLifeDays:14}}:item)}}),null);
 }finally{f.cleanup();}
});

test('advance and finish are derived atomically, preserve history, and isolate each item journal',async()=>{
 const f=await fixture();try{
  f.create();const first=f.reveal();const intent=observation(first);f.update(first.state,intent);
  assert.equal(f.transition({kind:'advance',disposition:'completed'}),null);
  assert.equal(f.transition({kind:'finish'}),null);
  const saved=f.accounts.settleFeishuReviewOperation(intent.request.eventId,actor,f.auth,{status:'applied'})!;
  const second=f.transition({kind:'advance',disposition:'completed'})!.session!;
  assert.equal(second.state.batch!.cursor,1);assert.equal(second.state.phase,'front');assert.equal(second.state.page,1);
  assert.equal(second.state.frozen,null);assert.equal(second.state.batch!.items[0]!.disposition,'completed');
  assert.deepEqual(second.state.batch!.items[0]!.frozen,saved.state.frozen);
  const all=f.accounts.getFeishuReviewOperations(sessionId,actor,f.auth);
  assert.equal(all[0]!.itemId,'1'.repeat(32));assert.deepEqual(feishuReviewCurrentOperations(second,all),[]);
  assert.deepEqual(f.accounts.settleFeishuReviewOperation(intent.request.eventId,actor,f.auth,{status:'applied'}),second);
  const oldChanged={...second.state,batch:{...second.state.batch!,items:second.state.batch!.items.map((item,i)=>i===0?{...item,frozen:null}:item)}};
  assert.equal(f.update(oldChanged),null);
  const third=f.transition({kind:'advance',disposition:'skipped'})!.session!;
  assert.equal(third.state.batch!.cursor,2);assert.equal(third.state.batch!.items[1]!.disposition,'skipped');
  const done=f.transition({kind:'advance',disposition:'ineligible'})!.session!;
  assert.equal(done.state.phase,'finished');assert.equal(done.state.batch!.cursor,2);
  assert.equal(done.state.batch!.items[2]!.disposition,'ineligible');
  assert.equal(f.accounts.getFeishuReviewSession(actor,f.auth,scope.namespace),null);
  assert.equal(f.accounts.getFeishuReviewOperations(sessionId,actor,f.auth).length,1);
 }finally{f.cleanup();}
});

test('multiple item intents are unique, old-item settlement cannot progress the next item, and conflicts remain journaled',async()=>{
 const f=await fixture();try{
  f.create();let current=f.reveal();const first=observation(current);f.update(current.state,first);
  f.accounts.settleFeishuReviewOperation(first.request.eventId,actor,f.auth,{status:'applied'});
  current=f.transition({kind:'advance',disposition:'completed'})!.session!;
  current=f.reveal(current);const second=observation(current);f.update(current.state,second);
  const before=f.current();
  assert.deepEqual(f.accounts.settleFeishuReviewOperation(first.request.eventId,actor,f.auth,{status:'applied'}),before);
  assert.equal(f.current().state.phase,'revealed');
  const altered=new DatabaseSync(f.accounts.dbPath);
  altered.prepare("UPDATE feishu_review_operations SET status='pending' WHERE id=?").run(first.request.eventId);altered.close();
  assert.equal(f.accounts.settleFeishuReviewOperation(first.request.eventId,actor,f.auth,{status:'applied'}),null);
  assert.deepEqual(f.current(),before);
  const restore=new DatabaseSync(f.accounts.dbPath);
  restore.prepare("UPDATE feishu_review_operations SET status='applied' WHERE id=?").run(first.request.eventId);restore.close();
  assert.equal(f.transition({kind:'advance',disposition:'conflict'}),null);
  current=f.accounts.settleFeishuReviewOperation(second.request.eventId,actor,f.auth,{status:'conflict',errorCode:'ANCHOR_CONFLICT'})!;
  assert.equal(f.transition({kind:'advance',disposition:'completed'}),null);
  current=f.transition({kind:'advance',disposition:'conflict'})!.session!;
  assert.equal(current.state.batch!.items[1]!.disposition,'conflict');
  const operations=f.accounts.getFeishuReviewOperations(sessionId,actor,f.auth);
  assert.equal(operations.length,2);assert.notEqual(operations[0]!.id,operations[1]!.id);
  assert.notEqual(operations[0]!.itemId,operations[1]!.itemId);
  f.reopen();assert.deepEqual(f.accounts.getFeishuReviewOperations(sessionId,actor,f.auth),operations);
  const finished=f.transition({kind:'finish'})!.session!;
  assert.equal(finished.state.batch!.items[2]!.disposition,'ended');
 }finally{f.cleanup();}
});

test('advance blocks pause, changed source and ineligible states; finish leaves future queue untouched',async()=>{
 const f=await fixture();try{
  let current=f.create();f.update({...current.state,paused:true});
  assert.equal(f.transition({kind:'advance',disposition:'skipped'}),null);
  current=f.update({...f.current().state,paused:false})!.session!;
  assert.equal(f.transition({kind:'advance',disposition:'skipped'},{...scope,sourceFingerprint:'b'.repeat(64)}),null);
  current=f.reveal(current);assert.equal(f.transition({kind:'advance',disposition:'ineligible'}),null);
  const before=structuredClone(current.state.batch!.items.slice(1));
  const finished=f.transition({kind:'finish'},{...scope,sourceFingerprint:'b'.repeat(64)})!.session!;
  assert.equal(finished.state.batch!.items[0]!.disposition,'ended');
  assert.deepEqual(finished.state.batch!.items.slice(1),before);
 }finally{f.cleanup();}
});

test('legacy pending journal migrates preserving raw payload and state, then settles under unchanged event ID',async()=>{
 const f=await fixture();try{
  const {batch:_batch,...legacy}=initial();f.create(legacy);const revealed=f.reveal();const intent=observation(revealed);f.update(revealed.state,intent);
  const beforeState=sql(f,'SELECT state_json FROM feishu_review_sessions');
  f.accounts.close();const db=new DatabaseSync(join(f.options.dataDir,'accounts.sqlite'));
  downgradeOperations(db);const before=db.prepare('SELECT * FROM feishu_review_operations').all();db.close();
  f.reopen(true);
  assert.deepEqual(sql(f,'SELECT state_json FROM feishu_review_sessions'),beforeState);
  const after=sql(f,'SELECT id,session_id,kind,intent_json,status,error_code,created_at,settled_at FROM feishu_review_operations');
  assert.deepEqual(after,before);
  assert.equal(f.accounts.getFeishuReviewOperations(sessionId,actor,f.auth)[0]!.itemId,sessionId);
  assert.equal(intent.request.eventId,`feishu-observation:${sessionId}`);
  assert.equal(f.accounts.settleFeishuReviewOperation(intent.request.eventId,actor,f.auth,{status:'applied'})!.state.phase,'saved');
  f.reopen();assert.equal(f.accounts.getFeishuReviewOperations(sessionId,actor,f.auth).length,1);
 }finally{f.cleanup();}
});

test('failed journal migration rolls back schema and rows; corrected legacy database can reopen',async()=>{
 const f=await fixture();try{
  f.accounts.close();const db=new DatabaseSync(join(f.options.dataDir,'accounts.sqlite'));
  downgradeOperations(db);
  db.exec("PRAGMA foreign_keys=OFF; INSERT INTO feishu_review_operations VALUES('invalid-event','missing-session','observation','{}','pending',NULL,'2026-10-07T00:00:00.000Z',NULL)");
  const before=db.prepare('SELECT * FROM feishu_review_operations').all();db.close();
  assert.throws(()=>new Accounts(f.options),(error:unknown)=>error instanceof StoreError&&error.code==='WRITE_FAILED');
  const verify=new DatabaseSync(join(f.options.dataDir,'accounts.sqlite'));
  assert.equal(verify.prepare('PRAGMA table_info(feishu_review_operations)').all().some(column=>column.name==='item_id'),false);
  assert.deepEqual(verify.prepare('SELECT * FROM feishu_review_operations').all(),before);
  assert.equal(verify.prepare("SELECT 1 FROM sqlite_master WHERE name='feishu_review_operations_legacy_03b'").get(),undefined);
  verify.exec("DELETE FROM feishu_review_operations WHERE id='invalid-event'");verify.close();
  f.reopen(true);assert.ok(f.create());
 }finally{f.cleanup();}
});

test('advance SQL failure rolls back receipt and item disposition together',async()=>{
 const f=await fixture();try{
  const current=f.create();const before=sql(f,'SELECT * FROM feishu_read_receipts').length;
  const card=f.accounts.createFeishuCardDraft(actor,f.auth,{...scope,
   view:{kind:'review',sessionId,version:current.version,verb:'skip',page:1},
   actions:[{id:'a0',target:{kind:'review',sessionId,version:current.version,verb:'skip',page:1}}]})!;
  f.accounts.activateFeishuCard(card.id,actor,f.auth,{messageId:'advance-message',chatId:scope.originChatId});
  const action={...actor,cardId:card.id,actionId:'a0',eventId:'advance-event',messageId:'advance-message',chatId:scope.originChatId};
  const db=new DatabaseSync(f.accounts.dbPath);
  db.exec("CREATE TRIGGER synthetic_advance_failure BEFORE UPDATE ON feishu_review_sessions BEGIN SELECT RAISE(ABORT,'synthetic rollback'); END");db.close();
  assert.throws(()=>f.accounts.claimFeishuReviewTransition(actor,f.auth,{kind:'card',action},scope,
   ()=>({kind:'advance',disposition:'skipped'})),(error:unknown)=>error instanceof StoreError&&error.code==='WRITE_FAILED');
  assert.ok(f.accounts.getFeishuCardForAction(action));
  assert.deepEqual(f.current(),current);assert.equal(sql(f,'SELECT * FROM feishu_read_receipts').length,before);
 }finally{f.cleanup();}
});

test('compact batch start resolves only from trusted due-card metadata and rejects other views atomically',async()=>{
 const f=await fixture();try{
  const domainId='Math/'+'Long-domain-'.repeat(35);
  const draft=f.accounts.createFeishuCardDraft(actor,f.auth,{...scope,view:{kind:'due',domainId,limit:5},actions:[{id:'a0',target:{kind:'review-batch-start'}}]})!;
  assert.ok(draft);f.accounts.activateFeishuCard(draft.id,actor,f.auth,{messageId:'due-message',chatId:scope.originChatId});
  const action={...actor,cardId:draft.id,actionId:'a0',eventId:'due-click',messageId:'due-message',chatId:scope.originChatId};
  const result=f.accounts.claimFeishuReviewTransition(actor,f.auth,{kind:'card',action},scope,input=>{
   assert.deepEqual(input.target,{kind:'review-batch-start',domainId,limit:5});
   return {kind:'create',id:sessionId,state:initial()};
  });assert.ok(result);
  const invalid=f.accounts.createFeishuCardDraft(actor,f.auth,{...scope,view:{kind:'help'},actions:[{id:'a0',target:{kind:'review-batch-start'}}]})!;
  f.accounts.activateFeishuCard(invalid.id,actor,f.auth,{messageId:'invalid-message',chatId:scope.originChatId});
  const invalidAction={...action,cardId:invalid.id,messageId:'invalid-message'};
  const before=sql(f,'SELECT * FROM feishu_read_receipts').length;let called=false;
  assert.equal(f.accounts.claimFeishuReviewTransition(actor,f.auth,{kind:'card',action:invalidAction},scope,()=>{called=true;return {kind:'none'};}),null);
  assert.equal(called,false);assert.equal(sql(f,'SELECT * FROM feishu_read_receipts').length,before);
  assert.ok(f.accounts.getFeishuCardForAction(invalidAction));
  assert.equal(f.accounts.createFeishuCardDraft(actor,f.auth,{...scope,view:{kind:'due',domainId:null,limit:3},actions:[{id:'a0',target:{kind:'review-batch-start',domainId:'forged',limit:5} as never}]}),null);
 }finally{f.cleanup();}
});


test('expired batches cannot advance but can finish; revealed skips preserve their frozen history',async()=>{
 const f=await fixture();try{
  f.create();const revealed=f.reveal();
  const second=f.transition({kind:'advance',disposition:'skipped'})!.session!;
  assert.deepEqual(second.state.batch!.items[0]!.frozen,revealed.state.frozen);
  assert.equal(second.state.batch!.items[0]!.disposition,'skipped');
  assert.equal(second.state.frozen,null);
  f.advance(24*60*60_000);
  const before=sql(f,'SELECT * FROM feishu_read_receipts').length;
  assert.equal(f.transition({kind:'advance',disposition:'ineligible'}),null);
  assert.equal(sql(f,'SELECT * FROM feishu_read_receipts').length,before);
  const finished=f.transition({kind:'finish'})!.session!;
  assert.equal(finished.state.batch!.items[1]!.disposition,'ended');
  assert.equal(finished.state.batch!.items[2]!.disposition,'open');
  assert.equal(finished.state.batch!.items[2]!.frozen,null);
 }finally{f.cleanup();}
});
