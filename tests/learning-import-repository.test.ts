import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { LearningImportRepository } from '../src/server/learning-import-repository.js';
import { Store,StoreError } from '../src/server/store.js';
import { buildImportPlan, type PreparedImport } from '../src/server/import-plan.js';
import { initializeLearningSchemaV2 } from '../src/server/learning-schema.js';
import { initializeAnswerClearingSchemaV3 } from '../src/server/answer-clearing-schema.js';
import { createLegacyLearningFixture } from './helpers/legacy-learning-schema.js';
import { clone,deepFreeze,concepts,emptyCurrent,fullExport,now,sourceId } from './helpers/answer-clearing-json-fixture.js';
import type { ExportDataV2 } from '../src/shared/types.js';

const options={restoreLayout:true,restoreReviewPlan:true};
const legacy=(value=fullExport()):ExportDataV2=>({...value,schemaVersion:2,observations:value.observations.map(row=>{
  assert.equal(typeof row.answer,'string');return {...row,answer:row.answer as string};
})});
function prepared(data=legacy(),namespace=sourceId) {
  const plan=buildImportPlan({data,current:legacy(emptyCurrent()),options,concepts,sourceId:namespace,now});
  assert.equal(plan.preview.canImport,true,JSON.stringify(plan.preview.issues));return plan;
}
function fixture() {
  const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');
  initializeLearningSchemaV2(db,{recordedAt:now});
  for(const ns of [sourceId,'other-source']) {
    db.prepare('INSERT INTO namespaces(namespace,created_at) VALUES (?,?)').run(ns,now);
    db.prepare('INSERT INTO config_history(namespace,revision,model_version,half_life_days,recorded_at) VALUES (?,1,?,7,?)').run(ns,'time-only-v0','2025-12-31T00:00:00.000Z');
  }
  let calls=0;
  const repo=new LearningImportRepository({db,namespace:sourceId,now:()=>{calls++;return new Date(now);}});
  return {db,repo,clockCalls:()=>calls};
}
function snapshot(db:DatabaseSync) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name})=>({name,rows:db.prepare(`SELECT * FROM "${String(name)}" ORDER BY rowid`).all()}));
}
function errorCode(action:()=>unknown,code:string,status:number) {
  assert.throws(action,error=>{assert.ok(error instanceof StoreError);assert.equal(error.code,code);assert.equal(error.status,status);return true;});
}

test('repository persists complete v2 import under caller transaction with original receipts and canonical requests',()=>{
  const {db,repo,clockCalls}=fixture();
  try {
    const plan=prepared();const before=clone(plan);deepFreeze(plan);db.exec('BEGIN IMMEDIATE');
    repo.applyPreparedImport(plan,options);assert.equal(db.isTransaction,true);
    const collections=[['anchors',plan.newAnchors],['observations',plan.newObservations],['observation_revisions',plan.newObservationRevisions],['retentions',plan.newRetentions],['applications',plan.newApplications],['corrections',plan.newCorrections],['relation_reviews',plan.newRelationReviews],['practice_cards',plan.newPracticeCards],['practice_attempts',plan.newPracticeAttempts]] as const;
    for(const [table,events] of collections) {
      const rows=db.prepare(`SELECT * FROM ${table} WHERE namespace=?`).all(sourceId);
      assert.equal(rows.length,events.length,table);assert.equal(rows[0].recorded_at,events[0].recordedAt,table);
      assert.equal(typeof rows[0].request_payload,'string',table);
      assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE namespace=?`).get('other-source')!.count,0,table);
    }
    const anchor=db.prepare('SELECT request_payload FROM anchors WHERE namespace=?').get(sourceId)!;
    assert.equal(Object.hasOwn(JSON.parse(String(anchor.request_payload)),'occurredAt'),false);
    const observation=db.prepare('SELECT request_payload,answer,rating,half_life_days FROM observations WHERE namespace=?').get(sourceId)!;
    assert.equal(observation.answer,plan.newObservations[0].answer);assert.equal(observation.rating,'partial');assert.equal(observation.half_life_days,7);
    assert.equal(JSON.parse(String(observation.request_payload)).answer,plan.newObservations[0].answer);
    assert.equal(db.prepare('SELECT recorded_at FROM config_history WHERE namespace=? AND revision=1').get(sourceId)!.recorded_at,'2025-12-31T00:00:00.000Z');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM import_receipts').get()!.count,0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM identity_bindings').get()!.count,0);
    assert.equal(clockCalls(),2,'layout and review-plan each retain their original clock behavior');
    assert.deepEqual(clone(plan),before);db.exec('COMMIT');assert.equal(db.isTransaction,false);
  } finally {if(db.isTransaction)db.exec('ROLLBACK');db.close();}
});

test('repository enforces transaction and v2/privacy boundary before any writes using the shared StoreError class',()=>{
  const {db,repo}=fixture();
  try {
    const plan=prepared();const before=snapshot(db);
    errorCode(()=>repo.applyPreparedImport(plan,options),'IMPORT_TRANSACTION_REQUIRED',503);assert.deepEqual(snapshot(db),before);
    const changes:Array<(plan:PreparedImport)=>void>=[
      plan=>{plan.normalized.schemaVersion=3 as 2;},
      plan=>{plan.preview.canImport=false;},
      plan=>{plan.preview.sourceId='other-source';},
      plan=>{(plan.normalized.observations[0] as unknown as Record<string,unknown>).answer=null;},
      plan=>{(plan.newObservations[0] as unknown as Record<string,unknown>).answer=null;},
      plan=>{Object.defineProperty(plan.normalized.observations[0],'answerClearing',{value:undefined,enumerable:false});},
      plan=>{(plan.newObservations[0] as unknown as Record<string,unknown>).answerClearing={observationEventId:'observation-alpha',clearedAt:now};},
    ];
    for(const change of changes) {
      const altered=clone(plan);change(altered);db.exec('BEGIN IMMEDIATE');
      errorCode(()=>repo.applyPreparedImport(altered,options),'IMPORT_INVALID_DATA',400);
      assert.equal(db.isTransaction,true);assert.deepEqual(snapshot(db),before);db.exec('ROLLBACK');
    }
  } finally {if(db.isTransaction)db.exec('ROLLBACK');db.close();}
});

test('late persistence failure leaves partial writes within caller transaction for caller-owned rollback',()=>{
  const {db,repo}=fixture();
  try {
    const before=snapshot(db),plan=prepared();
    db.exec("CREATE TEMP TRIGGER fail_final_plan BEFORE INSERT ON review_plans BEGIN SELECT RAISE(ABORT,'late failure'); END; BEGIN IMMEDIATE");
    assert.throws(()=>repo.applyPreparedImport(plan,options));
    assert.equal(db.isTransaction,true);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM observations WHERE namespace=?').get(sourceId)!.count,1);
    db.exec('ROLLBACK');assert.deepEqual(snapshot(db),before);
  } finally {if(db.isTransaction)db.exec('ROLLBACK');db.close();}
});

test('disabled restore flags leave layout and review plan untouched and never read clock',()=>{
  const {db,repo,clockCalls}=fixture();
  try {
    db.exec('BEGIN IMMEDIATE');repo.applyPreparedImport(prepared(),{restoreLayout:false,restoreReviewPlan:false});db.exec('COMMIT');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM layouts').get()!.count,0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM review_plans').get()!.count,0);assert.equal(clockCalls(),0);
  } finally {if(db.isTransaction)db.exec('ROLLBACK');db.close();}
});

test('repository constructor rejects incompatible schemas without registering namespace, touching DDL or owning connection',()=>{
  for(const kind of ['empty','v1','v3','unknown'] as const) {
    const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');
    try {
      if(kind==='v1')createLegacyLearningFixture(db);
      if(kind==='v3'){db.exec('BEGIN IMMEDIATE');initializeAnswerClearingSchemaV3(db,{recordedAt:now});db.exec('COMMIT');}
      if(kind==='unknown')db.exec('CREATE TABLE unrelated(value TEXT)');
      const ddl=db.prepare('SELECT * FROM sqlite_master ORDER BY name').all();const before=snapshot(db);
      assert.throws(()=>new LearningImportRepository({db,namespace:'never-registered'}),error=>{assert.ok(error instanceof StoreError);assert.equal(error.status,503);return true;});
      assert.deepEqual(db.prepare('SELECT * FROM sqlite_master ORDER BY name').all(),ddl);assert.deepEqual(snapshot(db),before);assert.equal(db.isTransaction,false);
      assert.equal(db.prepare('PRAGMA foreign_keys').get()!.foreign_keys,1);assert.equal(db.prepare('SELECT 1 AS alive').get()!.alive,1);
    } finally {db.close();}
  }
});

test('direct lookup preserves all nine occupied event kinds and conflicting imports cannot reuse any of them',()=>{
  const {db,repo}=fixture();
  try {
    const baseline=prepared();db.exec('BEGIN IMMEDIATE');repo.applyPreparedImport(baseline,{restoreLayout:false,restoreReviewPlan:false});db.exec('COMMIT');
    const occupied=[['anchor-alpha','anchor'],['observation-alpha','observation'],['retention-alpha','retention'],['application-alpha','application'],['correction-alpha','correction'],['relation-alpha','relation-review'],['card-alpha','practice-card'],['attempt-alpha','practice-attempt'],['revision-alpha','observation-revision']] as const;
    const other=new LearningImportRepository({db,namespace:'other-source'});
    for(const [id,kind] of occupied) {
      assert.equal(repo.findEvent(id)?.kind,kind);assert.equal(typeof repo.findEvent(id)?.payload,'string');assert.equal(other.findEvent(id),null);
      const plan=prepared();const anchor={...plan.newAnchors[0],eventId:id,sourceRevision:'conflicting-revision'};
      plan.newAnchors=[anchor];plan.anchorRequests={[id]:{eventId:id,conceptId:anchor.conceptId,sourceRevision:anchor.sourceRevision,kind:anchor.kind}};
      plan.newObservations=[];plan.newObservationRevisions=[];plan.newRetentions=[];plan.newApplications=[];plan.newCorrections=[];plan.newRelationReviews=[];plan.newPracticeCards=[];plan.newPracticeAttempts=[];
      const before=snapshot(db);db.exec('BEGIN IMMEDIATE');
      errorCode(()=>repo.applyPreparedImport(plan,{restoreLayout:false,restoreReviewPlan:false}),'IMPORT_CONFLICT',409);
      assert.equal(db.isTransaction,true);db.exec('ROLLBACK');assert.deepEqual(snapshot(db),before);
    }
  } finally {if(db.isTransaction)db.exec('ROLLBACK');db.close();}
});

test('practice writers require caller transaction and validate against referenced historical card rather than latest tail',()=>{
  const {db,repo}=fixture();
  try {
    const base=legacy().practice!;const scenarioCard={...base.cards[0],kind:'scenario' as const,scenario:{caseFamily:'family',structureHint:'structure',nameHint:'name'}};
    errorCode(()=>repo.insertImportedPracticeCard(scenarioCard),'IMPORT_TRANSACTION_REQUIRED',503);
    db.exec('BEGIN IMMEDIATE');repo.insertImportedPracticeCard(scenarioCard);
    const nextCard={...base.cards[0],eventId:'card-next',previousEventId:scenarioCard.eventId,occurredAt:'2026-01-05T01:00:00.000Z',recordedAt:'2026-01-05T01:01:00.000Z'};
    repo.insertImportedPracticeCard(nextCard);
    const attempt={...base.attempts[0],outcome:'unverified' as const,scenario:{caseExposure:'unseen' as const,observedCaseExposure:false,stages:[{stage:'independent' as const,answer:base.attempts[0].answer,answeredAt:base.attempts[0].answeredAt,hintShownAt:null,recallOutcome:'success' as const,applicabilityOutcome:'success' as const}]}};
    repo.insertImportedPracticeAttempt(attempt);
    assert.equal(db.prepare('SELECT card_event_id FROM practice_attempts WHERE namespace=?').get(sourceId)!.card_event_id,scenarioCard.eventId);
    const historical=db.prepare('SELECT scenario_json FROM practice_cards WHERE namespace=? AND event_id=?').get(sourceId,scenarioCard.eventId)!;
    assert.equal(JSON.parse(String(historical.scenario_json)).caseFamily,'family');
    errorCode(()=>repo.insertImportedPracticeCard({...nextCard,eventId:'card-fork',previousEventId:scenarioCard.eventId}),'IMPORT_CONFLICT',409);
    errorCode(()=>repo.insertImportedPracticeAttempt({...attempt,eventId:'attempt-wrong-kind',cardEventId:nextCard.eventId}),'PRACTICE_SCENARIO_MISMATCH',400);
    assert.equal(db.isTransaction,true);db.exec('COMMIT');
    errorCode(()=>repo.insertImportedPracticeAttempt({...attempt,eventId:'outside-txn'}),'IMPORT_TRANSACTION_REQUIRED',503);
  } finally {if(db.isTransaction)db.exec('ROLLBACK');db.close();}
});


test('product Store imports all nine collections through shared repository and preserves retry receipts after reopening',()=>{
  const dataDir=mkdtempSync(join(tmpdir(),'lm-import-repository-product-'));
  let store:Store|undefined;
  try {
    store=new Store({dataDir,namespace:sourceId,now:()=>new Date(now)});
    const data=legacy(),source=data.source;
    const preview=store.previewImport(data,options,source,concepts);
    assert.equal(preview.canImport,true,JSON.stringify(preview.issues));
    const request={data,options,importId:'complete-product-import',previewToken:preview.token,confirmed:true as const};
    let backups=0;
    const backup=()=>{backups++;return 'synthetic-pre-import-backup';};
    const receipt=store.commitImport(request,source,concepts,backup);
    assert.equal(receipt.status,'accepted');assert.equal(backups,1);
    const exported=store.exportData(source,concepts);
    const pairs=[['anchors',exported.anchors,data.anchors],['observations',exported.observations,data.observations],['observationRevisions',exported.observationRevisions,data.observationRevisions],['retentions',exported.retentions!,data.retentions!],['applications',exported.applications!,data.applications!],['corrections',exported.corrections!,data.corrections!],['relationReviews',exported.relationReviews!,data.relationReviews!],['practiceCards',exported.practice!.cards,data.practice!.cards],['practiceAttempts',exported.practice!.attempts,data.practice!.attempts]] as const;
    for(const [kind,actual,expected] of pairs) {
      assert.equal(actual.length,1,kind);assert.equal(actual[0].recordedAt,expected[0].recordedAt,kind);
      assert.deepEqual(clone(actual),clone(expected),kind);
    }
    assert.equal(Object.hasOwn(exported.restoreMetadata!.anchorRequests[0],'occurredAt'),false);
    assert.equal(exported.identityBindings?.length??0,0,'uploaded identity audit must not become authoritative bindings');
    const db=new DatabaseSync(join(dataDir,'living-memory.sqlite'),{readOnly:true});
    try {
      const persisted=db.prepare('SELECT request_payload FROM observations WHERE namespace=? AND event_id=?').get(sourceId,'observation-alpha')!;
      const parsed=JSON.parse(String(persisted.request_payload));
      assert.equal(parsed.answer,data.observations[0].answer);assert.equal(Object.hasOwn(parsed,'recordedAt'),false);
      const anchor=db.prepare('SELECT request_payload FROM anchors WHERE namespace=? AND event_id=?').get(sourceId,'anchor-alpha')!;
      assert.equal(Object.hasOwn(JSON.parse(String(anchor.request_payload)),'occurredAt'),false);
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM import_receipts WHERE namespace=?').get(sourceId)!.count,1);
    } finally {db.close();}
    assert.deepEqual(store.commitImport(request,source,concepts,backup),{...receipt,status:'duplicate'});assert.equal(backups,1);
    store.close();store=undefined;
    store=new Store({dataDir,namespace:sourceId,now:()=>new Date(now)});
    const reopened=store.exportData(source,concepts);
    for(const key of ['anchors','observations','observationRevisions','retentions','applications','corrections','relationReviews','practice'] as const)assert.deepEqual(clone(reopened[key]),clone(exported[key]),key);
    assert.deepEqual(store.commitImport(request,source,concepts,backup),{...receipt,status:'duplicate'});assert.equal(backups,1);
  } finally {store?.close();rmSync(dataDir,{recursive:true,force:true});}
});
