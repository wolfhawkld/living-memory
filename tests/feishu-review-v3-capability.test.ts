import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Accounts } from '../src/server/accounts.js';
import { Store } from '../src/server/store.js';
import { initializeAnswerClearingSchemaV3 } from '../src/server/answer-clearing-schema.js';
import { loadKnowledgeGraph } from '../src/server/kg.js';
import { createFeishuCardCapabilities, type PreparedFeishuCardReply } from '../src/server/feishu-cards.js';
import { feishuReviewEventId } from '../src/shared/feishu-review.js';
import type { FeishuCardNavAction } from '../src/shared/feishu-cards.js';
import { cardButtons } from './helpers/feishu-card-elements.js';

const actor={appId:'synthetic-v3-app',tenantKey:'synthetic-v3-tenant',openId:'synthetic-v3-owner'};
const otherNamespace='synthetic-isolated-v3-namespace';
async function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'lm-feishu-v3-')),root=join(dir,'kg');
  mkdirSync(join(root,'Math'),{recursive:true});
  writeFileSync(join(root,'Math','Alpha.md'),'---\ntype: concept\ntitle: Synthetic Alpha\nsummary: PRIVATE_V3_SUMMARY\n---\nPRIVATE_V3_KNOWLEDGE_BODY');
  const source=loadKnowledgeGraph({root}),concept=source.index.concepts[0];
  const dbPath=join(dir,'learning.sqlite');let instant=Date.parse('2026-10-07T01:00:00.000Z'),sequence=0;
  const now=()=>new Date(instant);
  const db=new DatabaseSync(dbPath);
  try{
    db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');initializeAnswerClearingSchemaV3(db,{recordedAt:now().toISOString()});
    for(const namespace of [source.namespace,otherNamespace]){
      db.prepare('INSERT INTO namespaces(namespace,created_at) VALUES (?,?)').run(namespace,now().toISOString());
      db.prepare('INSERT INTO config_history(namespace,revision,model_version,half_life_days,recorded_at) VALUES (?,1,?,7,?)')
        .run(namespace,'time-only-v0',now().toISOString());
    }
    db.exec('COMMIT');
  }finally{if(db.isTransaction)db.exec('ROLLBACK');db.close();}
  const openStore=(namespace=source.namespace)=>new Store({dbPath,namespace,schemaVersion:3,now});
  let store=openStore(),accounts=new Accounts({dataDir:dir,now});
  const user=await accounts.setup('synthetic','synthetic-v3-feishu-password');
  const browser=accounts.issueSession(user.id);
  const issued=accounts.issueFeishuBindingRequest(user.id,browser.sessionId,actor);
  assert.equal(accounts.confirmFeishuBinding({...actor,code:issued.command.split(' ')[1],eventId:'binding-event',messageId:'binding-message',chatId:'private-chat'}).status,'confirmed');
  const authorization={userId:user.id,accessRevision:user.accessRevision,bindingId:accounts.getFeishuBindingState(user.id).binding!.id};
  store.addReview({eventId:'original-anchor',conceptId:concept.id,sourceRevision:concept.source.revision,kind:'review',occurredAt:'2026-09-30T01:00:00.000Z'});
  const other=openStore(otherNamespace);
  other.addObservation({eventId:'other-observation',conceptId:concept.id,sourceRevision:concept.source.revision,observedAt:now().toISOString(),configRevision:1,
    anchorEventId:null,answer:'PRIVATE_OTHER_NAMESPACE_ANSWER',evidenceMode:'written',rating:'clear',exposure:'unexposed',observedExposure:false},null);
  const otherBefore=other.exportData(source.index.source,source.index.concepts);other.close();
  const capabilities=()=>createFeishuCardCapabilities({accounts,scope:actor,timeZone:'UTC',now,
    contextForUser:id=>{assert.equal(id,user.id);return{source,store};}});
  let cards=capabilities();
  function message(text:string){return{...actor,text,messageId:`message-${++sequence}`,eventId:`event-${sequence}`,chatId:'private-chat'};}
  function accept(reply:PreparedFeishuCardReply){assert.equal(reply.stillAuthorized(),true);reply.settle({status:'platform-accepted',messageId:`platform-${reply.operationId}`,chatId:'private-chat'});return reply;}
  function action(reply:PreparedFeishuCardReply,caption:string):FeishuCardNavAction{
    const button=cardButtons(reply.card).find(item=>item.text?.content===caption);assert.ok(button,`missing ${caption}`);
    return{...actor,...button.behaviors![0].value,eventId:`click-${++sequence}`,messageId:`platform-${reply.operationId}`,chatId:'private-chat'};
  }
  function send(text:string){const reply=cards.prepareMessage(message(text));assert.ok(reply);return accept(reply);}
  function click(reply:PreparedFeishuCardReply,caption:string){const next=cards.prepareAction(action(reply,caption));assert.ok(next);return accept(next);}
  const session=()=>accounts.getFeishuReviewSession(actor,authorization,source.namespace)!;
  const operations=()=>accounts.getFeishuReviewOperations(session().id,actor,authorization);
  return{dir,dbPath,source,concept,now,get store(){return store;},get accounts(){return accounts;},get cards(){return cards;},
    session,operations,send,click,action,accept,
    export:()=>store.exportData(source.index.source,source.index.concepts),
    advance(ms:number){instant+=ms;},
    sql(statement:string){const connection=new DatabaseSync(dbPath);try{connection.exec(statement);}finally{connection.close();}},
    reopen(){store.close();accounts.close();store=openStore();accounts=new Accounts({dataDir:dir,now});cards=capabilities();},
    assertIsolated(){const isolated=openStore(otherNamespace);try{const after=isolated.exportData(source.index.source,source.index.concepts);
      for(const key of ['observations','anchors','retentions','config','configHistory','observationRevisions','reviewPlan'] as const)assert.deepEqual(after[key],otherBefore[key],key);
    }finally{isolated.close();}},
    close(){store.close();accounts.close();rmSync(dir,{recursive:true,force:true});},
  };
}

test('synthetic Feishu cards share v3 Store mental facts, budget and explicit rewarm without automatic memory updates',async()=>{
  const f=await fixture();
  try{
    const before=f.export(),asOf=f.now().toISOString(),memory=f.store.getStates([f.concept],asOf);
    const saved=f.click(f.click(f.send('知识 复习'),'查看资料'),'模糊');
    const observation=f.store.getObservations()[0];
    assert.equal(observation.answer,'');assert.equal(observation.evidenceMode,'mental');assert.equal(observation.rating,'partial');
    assert.equal(observation.configRevision,1);assert.equal(observation.anchorEventId,'original-anchor');
    assert.equal(observation.halfLifeDays,7);assert.equal(observation.elapsedDays,7);assert.equal(observation.decay,0.5);
    assert.deepEqual(observation.learning,{task:'concept',cue:'unknown',outcome:'unverified',basis:'self-check',confidence:null,confidenceAt:null});
    assert.equal(Object.hasOwn(observation,'answerClearing'),false);
    assert.deepEqual(f.store.getStates([f.concept],asOf),memory);assert.deepEqual(f.export().anchors,before.anchors);assert.deepEqual(f.export().config,before.config);
    assert.deepEqual(f.store.getCompletedConceptIds(asOf,'UTC'),[f.concept.id]);
    const overview=f.store.getLearningOverview(f.source.namespace,[f.concept],[],asOf);
    assert.equal(overview.items[0].calibration.concept.count,0);assert.deepEqual(overview.observationPrivacy,{cleared:0,excludedFromPerformance:0});
    assert.throws(()=>f.store.clearObservationAnswer({observationEventId:observation.eventId}),{code:'ANSWER_CLEARING_NO_SAVED_ANSWER'});
    f.advance(60_000);f.click(saved,'确认已重温，更新时间');
    assert.equal(f.export().anchors.length,before.anchors.length+1);assert.equal(f.store.countObservations(),1);
    assert.deepEqual(f.export().config,before.config);f.assertIsolated();
  }finally{f.close();}
});

test('a real v3 learning write failure keeps the frozen Feishu intent pending and an explicit retry after reopening saves once',async()=>{
  const f=await fixture();
  try{
    const revealed=f.click(f.send('知识 复习'),'查看资料');
    f.sql("CREATE TRIGGER reject_v3_grade BEFORE INSERT ON observations BEGIN SELECT RAISE(ABORT,'synthetic unavailable'); END");
    f.click(revealed,'清楚');assert.equal(f.store.countObservations(),0);assert.equal(f.operations()[0].status,'pending');
    const original=structuredClone(f.operations()[0]),before=f.export();
    f.sql('DROP TRIGGER reject_v3_grade');f.reopen();f.advance(120_000);
    assert.deepEqual(f.operations()[0].intent,original.intent);assert.equal(f.operations()[0].status,'pending');
    f.send('知识 继续复习');assert.equal(f.store.countObservations(),1);assert.equal(f.operations()[0].status,'applied');
    assert.deepEqual(f.operations()[0].intent,original.intent);assert.equal(f.operations()[0].id,original.id);
    const event=f.store.getObservations()[0];assert.equal(event.answer,'');assert.equal(event.evidenceMode,'mental');
    assert.equal(event.observedAt,original.intent.kind==='observation'?original.intent.request.observedAt:'');
    assert.deepEqual(f.export().anchors,before.anchors);assert.deepEqual(f.export().config,before.config);
    f.send('知识 继续复习');assert.equal(f.store.countObservations(),1);assert.equal(f.operations().length,1);
    assert.deepEqual(f.store.getCompletedConceptIds(f.now().toISOString(),'UTC'),[f.concept.id]);f.assertIsolated();
  }finally{f.close();}
});

test('v3 committed learning with failed Feishu settlement replays the exact event across reopen without refunding its original budget fact',async()=>{
  const f=await fixture();
  try{
    const revealed=f.click(f.send('知识 复习'),'查看资料');
    f.accounts.settleFeishuReviewOperation=()=>{throw new Error('synthetic settlement unavailable');};
    f.click(revealed,'想不起');assert.equal(f.store.countObservations(),1);assert.equal(f.operations()[0].status,'pending');
    const original=structuredClone(f.operations()[0]),before=f.export(),event=f.store.getObservations()[0];
    assert.equal(original.intent.kind,'observation');
    f.reopen();f.advance(25*60*60_000);
    f.send('知识 继续复习');assert.equal(f.operations()[0].status,'applied');assert.equal(f.store.countObservations(),1);
    assert.deepEqual(f.operations()[0].intent,original.intent);assert.deepEqual(f.export().observations,before.observations);assert.deepEqual(f.export().anchors,before.anchors);
    if(original.intent.kind==='observation')assert.equal(f.store.addObservation(original.intent.request,'original-anchor').status,'duplicate');
    assert.deepEqual(f.store.getCompletedConceptIds(event.recordedAt,'UTC'),[f.concept.id]);f.assertIsolated();
  }finally{f.close();}
});

test('a cleared v3 event collision settles the Feishu intent as terminal ANSWER_CLEARED without restoring its answer or repeating the write',async()=>{
  const f=await fixture();
  try{
    const revealed=f.click(f.send('知识 复习'),'查看资料'),session=f.session(),frozen=session.state.frozen!;
    const eventId=feishuReviewEventId(session,'observation');
    // A synthetic cross-channel collision exercises the shared guard. Normal Feishu mental answers have nothing to clear.
    f.store.addObservation({eventId,conceptId:f.concept.id,sourceRevision:f.concept.source.revision,
      observedAt:frozen.observedAt,configRevision:frozen.configRevision,anchorEventId:frozen.anchorEventId,
      answer:'SYNTHETIC_CLEARED_COLLISION',evidenceMode:'written',rating:'clear',exposure:'unexposed',observedExposure:false},frozen.anchorEventId);
    const clearing=f.store.clearObservationAnswer({observationEventId:eventId});
    f.click(revealed,'清楚');const operation=f.operations()[0];
    assert.equal(operation.status,'conflict');assert.equal(operation.errorCode,'ANSWER_CLEARED');assert.equal(f.store.countObservations(),1);
    const before=f.export();assert.equal(before.observations[0].answer,null);
    f.send('知识 继续复习');assert.deepEqual(f.operations()[0],operation);assert.deepEqual(f.export().observations,before.observations);
    assert.equal(f.store.countObservations(),1);assert.deepEqual(f.store.getCompletedConceptIds(f.now().toISOString(),'UTC'),[f.concept.id]);
    const parent=f.store.getObservations()[0];if(parent.answer===null)assert.equal(parent.answerClearing.clearedAt,clearing.clearedAt);
    assert.equal(JSON.stringify(f.export()).includes('SYNTHETIC_CLEARED_COLLISION'),false);f.assertIsolated();
  }finally{f.close();}
});
