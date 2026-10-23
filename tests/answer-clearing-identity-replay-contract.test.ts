import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { buildSafeIdentityReceiptEnvelope, encodeSafeIdentityReceiptEnvelope, parseSafeIdentityReceiptEnvelope,
  safeIdentityReplayMatches, SAFE_IDENTITY_CREDENTIAL } from '../src/server/answer-clearing-identity-replay-contract.js';
import { AnswerClearingStoreError } from '../src/server/answer-clearing-store-error.js';
import { AnswerClearingStore, ANSWER_CLEARING_RETIRED_CREDENTIAL } from '../src/server/answer-clearing-store.js';
import { SAFE_IMPORT_CREDENTIAL } from '../src/server/answer-clearing-replay-contract.js';
import { initializeAnswerClearingSchemaV3 } from '../src/server/answer-clearing-schema.js';
import type { IdentityBinding, IdentityLinkReceipt } from '../src/shared/identity.js';

const namespace='owner', operationId='identity-1', confirmedAt='2026-10-23T01:00:00.000Z';
const request={namespace,operationId,fromConceptId:'stable',toConceptId:'raw'};
const receipt:IdentityLinkReceipt={status:'accepted',operationId,sourceId:namespace,conceptId:'stable',linkedPath:'New.md',confirmedAt,backupId:'backup-1'};
const binding:IdentityBinding={operationId,rawConceptId:'raw',conceptId:'stable',fromPath:'Old.md',toPath:'New.md',sourceRevision:'rev-1',confirmedAt,backupId:'backup-1'};
const expected={namespace,operationId};
const invalidCode='ANSWER_CLEARING_IDENTITY_REPLAY_DATA_INVALID';
const clone=<T>(value:T):T=>JSON.parse(JSON.stringify(value)) as T;
function invalid(error:unknown):boolean {
  assert.ok(error instanceof AnswerClearingStoreError);assert.equal(error.code,invalidCode);assert.equal(error.message,invalidCode);assert.equal(error.status,503);return true;
}

test('safe identity receipt preserves the semantic request and immutable receipt without tokens, exports or body hashes',()=>{
  const envelope=buildSafeIdentityReceiptEnvelope(receipt,request);
  assert.deepEqual(envelope,{version:1,...request,receipt});
  assert.equal(safeIdentityReplayMatches(envelope,{fromConceptId:'stable',toConceptId:'raw'},binding),true);
  const encoded=encodeSafeIdentityReceiptEnvelope(receipt,request);
  assert.deepEqual(parseSafeIdentityReceiptEnvelope(JSON.parse(encoded),expected),envelope);
  assert.deepEqual(Object.keys(envelope).sort(),['fromConceptId','namespace','operationId','receipt','toConceptId','version']);
  for(const key of ['previewToken','requestHash','digest','answer','current','exportedAt'])assert.equal(encoded.includes(key),false,key);
  assert.equal(/^[a-f0-9]{64}$/.test(SAFE_IDENTITY_CREDENTIAL),false);
  assert.equal(SAFE_IDENTITY_CREDENTIAL,'answer-clearing:safe-identity-replay:v1');
  envelope.receipt.linkedPath='detached';assert.equal(receipt.linkedPath,'New.md');assert.equal(binding.toPath,'New.md');
});

test('stored envelope and receipt use strict own-data whitelists without invoking getters or serializers',()=>{
  const envelope=buildSafeIdentityReceiptEnvelope(receipt,request);let reads=0;
  const getter=()=>{reads++;throw new Error('PRIVATE_ACCESSOR_MUST_NOT_RUN');};
  const candidates:unknown[]=[null,[],new Date(),{...envelope,previewToken:'PRIVATE_TOKEN'},
    {...envelope,answer:'PRIVATE_ANSWER'},{...envelope,requestHash:'PRIVATE_DIGEST'},
    {...envelope,receipt:{...receipt,previewToken:'PRIVATE_TOKEN'}},
    {...envelope,receipt:{...receipt,answer:'PRIVATE_ANSWER'}},Object.assign(Object.create({}),envelope),
    {...envelope,receipt:Object.assign(Object.create({}),receipt)}];
  const access=clone(envelope);Object.defineProperty(access,'namespace',{get:getter,enumerable:true});candidates.push(access);
  const receiptAccess=clone(envelope);Object.defineProperty(receiptAccess.receipt,'linkedPath',{get:getter,enumerable:true});candidates.push(receiptAccess);
  const hidden=clone(envelope);Object.defineProperty(hidden,'namespace',{value:namespace,enumerable:false});candidates.push(hidden);
  const symbol=clone(envelope);Object.defineProperty(symbol,Symbol('private'),{value:'PRIVATE_SYMBOL'});candidates.push(symbol);
  const serializer=clone(envelope);Object.defineProperty(serializer,'toJSON',{value:getter,enumerable:true});candidates.push(serializer);
  for(const candidate of candidates)assert.throws(()=>parseSafeIdentityReceiptEnvelope(candidate,expected),invalid);
  assert.equal(reads,0);
});

test('identity envelopes reject mismatched scope, versions, duplicate receipts and unbounded fields',()=>{
  const envelope=buildSafeIdentityReceiptEnvelope(receipt,request);
  for(const change of [
    {...envelope,version:2},{...envelope,namespace:'other'},{...envelope,operationId:'other-op'},
    {...envelope,fromConceptId:'other-stable'},{...envelope,toConceptId:'stable'},
    {...envelope,receipt:{...receipt,status:'duplicate'}},{...envelope,receipt:{...receipt,sourceId:'other'}},
    {...envelope,receipt:{...receipt,operationId:'other-op'}},{...envelope,receipt:{...receipt,conceptId:'other'}},
    {...envelope,receipt:{...receipt,confirmedAt:'invalid'}},{...envelope,receipt:{...receipt,backupId:'a'.repeat(4097)}},
    {...envelope,fromConceptId:'a'.repeat(513)},{...envelope,namespace:'a\nprivate'},
    {...envelope,operationId:'../private'},{...envelope,receipt:{...receipt,linkedPath:' padded '}},
  ])assert.throws(()=>parseSafeIdentityReceiptEnvelope(change,expected),invalid);
});

test('semantic replay rejects changed IDs or immutable binding fields, independent of the original preview',()=>{
  const envelope=buildSafeIdentityReceiptEnvelope(receipt,request);
  for(const candidate of [{fromConceptId:'different',toConceptId:'raw'},{fromConceptId:'stable',toConceptId:'different'}]) {
    assert.equal(safeIdentityReplayMatches(envelope,candidate,binding),false);
  }
  const changes:Array<Partial<IdentityBinding>>=[{operationId:'other-op'},{rawConceptId:'other-raw'},{conceptId:'other-stable'},
    {toPath:'Other.md'},{confirmedAt:'2026-10-23T02:00:00.000Z'},{backupId:'other-backup'}];
  for(const change of changes)assert.equal(safeIdentityReplayMatches(envelope,{fromConceptId:'stable',toConceptId:'raw'},{...binding,...change}),false);
  assert.equal(safeIdentityReplayMatches(envelope,{fromConceptId:'stable',toConceptId:'raw'},{...binding,fromPath:null}),true);
  assert.throws(()=>safeIdentityReplayMatches(envelope,{fromConceptId:'different',toConceptId:'raw'},{...binding,confirmedAt:'invalid'}),invalid);
  assert.throws(()=>safeIdentityReplayMatches(envelope,{fromConceptId:'a'.repeat(513),toConceptId:'raw'},binding),invalid);
  assert.throws(()=>safeIdentityReplayMatches(envelope,{fromConceptId:'stable',toConceptId:'raw',previewToken:'PRIVATE'} as never,binding),invalid);
  assert.throws(()=>safeIdentityReplayMatches(envelope,{fromConceptId:'stable',toConceptId:'raw'},{...binding,request_hash:'PRIVATE'} as never),invalid);
});

test('identity paths and revisions preserve the 4096-character boundary through multibyte receipt roundtrips and replay',()=>{
  const path='知'.repeat(4096),revision='版'.repeat(4096);
  const accepted={...receipt,linkedPath:path};
  const envelope=parseSafeIdentityReceiptEnvelope(JSON.parse(encodeSafeIdentityReceiptEnvelope(accepted,request)),expected);
  assert.equal(envelope.receipt.linkedPath,path);
  const original={...binding,fromPath:path,toPath:path,sourceRevision:revision};
  assert.equal(safeIdentityReplayMatches(envelope,{fromConceptId:'stable',toConceptId:'raw'},original),true);
  const tooLongPath=path+'知',tooLongRevision=revision+'版';
  assert.throws(()=>encodeSafeIdentityReceiptEnvelope({...receipt,linkedPath:tooLongPath},request),invalid);
  for(const change of [{fromPath:tooLongPath},{toPath:tooLongPath},{sourceRevision:tooLongRevision}]) {
    assert.throws(()=>safeIdentityReplayMatches(envelope,{fromConceptId:'stable',toConceptId:'raw'},{...original,...change}),invalid);
  }
  // Unrelated fields retain their stricter existing byte limits.
  assert.throws(()=>encodeSafeIdentityReceiptEnvelope({...accepted,backupId:'备'.repeat(1366)},request),invalid);
});

function kernelFixture() {
  const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
  initializeAnswerClearingSchemaV3(db,{recordedAt:confirmedAt});db.exec('COMMIT');
  for(const ns of [namespace,'other']) {
    db.prepare('INSERT INTO namespaces(namespace,created_at) VALUES (?,?)').run(ns,confirmedAt);
    db.prepare('INSERT INTO config_history(namespace,revision,model_version,half_life_days,recorded_at) VALUES (?,1,?,7,?)').run(ns,'time-only-v0',confirmedAt);
    db.prepare(`INSERT INTO observations(namespace,event_id,concept_id,source_revision,observed_at,recorded_at,config_revision,half_life_days,
      anchor_event_id,elapsed_days,decay,answer,rating,exposure,observed_exposure,learning_json,evidence_mode,request_payload)
      VALUES (?,'parent','stable','rev-1',?,?,1,7,NULL,NULL,NULL,'SYNTHETIC_PRIVATE_ANSWER','clear','unexposed',0,NULL,'written','SYNTHETIC_PRIVATE_REQUEST')`)
      .run(ns,confirmedAt,confirmedAt);
    for(const [id,credential] of [['safe',SAFE_IDENTITY_CREDENTIAL],['unsafe','LEGACY_ANSWER_DERIVED_DIGEST']] as const) {
      db.prepare(`INSERT INTO identity_bindings(namespace,operation_id,raw_concept_id,concept_id,from_path,to_path,source_revision,confirmed_at,backup_id,request_hash,receipt_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(ns,id,`raw-${id}`,`stable-${id}`,null,`${id}.md`,'rev-1',confirmedAt,`backup-${id}`,credential,'{}');
      db.prepare('INSERT INTO import_receipts(namespace,import_id,request_hash,receipt_json) VALUES (?,?,?,?)')
        .run(ns,id,id==='safe'?SAFE_IMPORT_CREDENTIAL:'LEGACY_ANSWER_DERIVED_DIGEST','{}');
    }
  }
  return {db,store:new AnswerClearingStore({db,namespace,now:()=>new Date('2026-10-23T02:00:00.000Z')})};
}
function credentials(db:DatabaseSync) {
  return {imports:db.prepare('SELECT namespace,import_id,request_hash FROM import_receipts ORDER BY namespace,import_id').all(),
    identities:db.prepare('SELECT namespace,operation_id,request_hash FROM identity_bindings ORDER BY namespace,operation_id').all()};
}

test('safe identity credentials are counted separately and survive atomic unsafe-only retirement after an imported marker',()=>{
  const {db,store}=kernelFixture();
  try {
    const initial=store.getReplayPrivacyStatus();
    assert.equal(initial.activeIdentityCredentials,1);assert.equal(initial.safeIdentityCredentials,1);assert.equal(initial.status,'ready');
    const before=credentials(db);db.exec('BEGIN IMMEDIATE');
    db.prepare('UPDATE observations SET answer=NULL,request_payload=NULL,answer_cleared_at=? WHERE namespace=?').run('2026-10-23T02:00:00.000Z',namespace);
    assert.equal(store.getReplayPrivacyStatus().status,'repair-required');
    assert.deepEqual(store.retireLegacyReplayCredentials(),{retiredImportCredentials:1,retiredIdentityCredentials:1});
    const ready=store.getReplayPrivacyStatus();assert.equal(ready.status,'ready');assert.equal(ready.activeIdentityCredentials,0);
    assert.equal(ready.safeIdentityCredentials,1);assert.equal(ready.safeImportCredentials,1);
    store.assertOperationReplayAllowed('identity','safe');store.assertOperationReplayAllowed('import','safe');
    assert.throws(()=>store.assertOperationReplayAllowed('identity','unsafe'),{code:'ANSWER_CLEARING_OPERATION_RETIRED'});
    db.exec('ROLLBACK');assert.deepEqual(credentials(db),before);
    db.exec('BEGIN IMMEDIATE');
    db.prepare('UPDATE observations SET answer=NULL,request_payload=NULL,answer_cleared_at=? WHERE namespace=?').run('2026-10-23T02:00:00.000Z',namespace);
    store.retireLegacyReplayCredentials();db.exec('COMMIT');
    assert.deepEqual(store.prepareReplayPrivacy(),{status:'already-ready',retiredImportCredentials:0,retiredIdentityCredentials:0});
    assert.equal(new AnswerClearingStore({db,namespace:'other'}).getReplayPrivacyStatus().activeIdentityCredentials,1);
  } finally {if(db.isTransaction)db.exec('ROLLBACK');db.close();}
});

test('local clear, duplicate clear and explicit repair retire safe identity credentials conservatively',()=>{
  for(const mode of ['first','duplicate','repair'] as const) {
    const {db,store}=kernelFixture();
    try {
      if(mode!=='first')db.prepare('UPDATE observations SET answer=NULL,request_payload=NULL,answer_cleared_at=? WHERE namespace=?').run('2026-10-23T02:00:00.000Z',namespace);
      if(mode==='repair')assert.equal(store.prepareReplayPrivacy().status,'prepared');
      else assert.equal(store.clear({observationEventId:'parent'}).status,mode==='first'?'accepted':'duplicate');
      const status=store.getReplayPrivacyStatus();assert.equal(status.status,'ready');assert.equal(status.safeIdentityCredentials,0);
      assert.equal(status.retiredIdentityCredentials,2);assert.equal(status.safeImportCredentials,0);assert.equal(status.retiredImportCredentials,2);
      const rows=db.prepare('SELECT request_hash FROM identity_bindings WHERE namespace=?').all(namespace);
      assert.deepEqual(rows.map(row=>row.request_hash),[ANSWER_CLEARING_RETIRED_CREDENTIAL,ANSWER_CLEARING_RETIRED_CREDENTIAL]);
      assert.equal(new AnswerClearingStore({db,namespace:'other'}).getReplayPrivacyStatus().safeIdentityCredentials,1);
    } finally {db.close();}
  }
});
