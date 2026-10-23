import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { saveImportBackup } from '../src/server/import-backup.js';
import { initializeAnswerClearingSchemaV3 } from '../src/server/answer-clearing-schema.js';
import type { Concept, ExportDataV1, ExportDataV2, ObservationRequest } from '../src/shared/types.js';
import type { ExportDataV3 } from '../src/shared/answer-clearing-export.js';
import { DEFAULT_IMPORT_OPTIONS } from '../src/shared/import-data.js';

const namespace='synthetic-backup-owner',otherNamespace='synthetic-backup-member';
const instant='2026-01-10T00:00:00.000Z';
const old:Concept={id:'old',title:'Synthetic',aliases:[],domain:'Math',summary:'',body:'',source:{path:'Old.md',revision:'rev-1'}};
const moved:Concept={...old,id:'new',source:{path:'Moved.md',revision:'rev-1'}};
const source={name:'synthetic-backup-source',mode:'local' as const,conceptCount:1,limit:20,diagnostics:[]};
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'lm-v3-write-backup-')),dbPath=join(dir,'learning.sqlite');
  const db=new DatabaseSync(dbPath);
  try{
    db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');initializeAnswerClearingSchemaV3(db,{recordedAt:instant});
    for(const ns of [namespace,otherNamespace]){
      db.prepare('INSERT INTO namespaces(namespace,created_at) VALUES (?,?)').run(ns,instant);
      db.prepare('INSERT INTO config_history(namespace,revision,model_version,half_life_days,recorded_at) VALUES (?,1,?,7,?)').run(ns,'time-only-v0',instant);
    }
    db.exec('COMMIT');
  }finally{if(db.isTransaction)db.exec('ROLLBACK');db.close();}
  const store=new Store({dbPath,namespace,schemaVersion:3,now:()=>new Date(instant)});
  store.rememberConcepts([old]);
  const request:ObservationRequest={eventId:'original',conceptId:old.id,sourceRevision:old.source.revision,observedAt:'2026-01-08T00:00:00.000Z',
    configRevision:1,anchorEventId:null,answer:'SYNTHETIC_REMOVED_BACKUP_ANSWER',evidenceMode:'written',rating:'clear',exposure:'unexposed',observedExposure:false};
  store.addObservation(request,null);const marker=store.clearObservationAnswer({observationEventId:request.eventId});
  return{dir,dbPath,store,marker,close(){store.close();rmSync(dir,{recursive:true,force:true});}};
}
function importRequest(store:Store<3>){
  const data=store.exportData(source,[old]);
  data.observations.push({eventId:'new-observation',conceptId:old.id,sourceRevision:old.source.revision,observedAt:'2026-01-09T00:00:00.000Z',recordedAt:instant,
    configRevision:1,halfLifeDays:7,anchorEventId:null,elapsedDays:null,decay:null,answer:'SYNTHETIC_NEW_IMPORT_ANSWER',evidenceMode:'written',rating:'partial',exposure:'unexposed',observedExposure:false});
  const preview=store.previewImport(data,DEFAULT_IMPORT_OPTIONS,source,[old]);assert.equal(preview.canImport,true);
  return{importId:'import-with-real-backup',data,options:DEFAULT_IMPORT_OPTIONS,previewToken:preview.token,confirmed:true as const};
}
function identityRequest(store:Store<3>){
  const request={fromConceptId:old.id,toConceptId:moved.id};
  const preview=store.previewIdentityLink(request,source,[moved]);assert.equal(preview.canLink,true);
  return{...request,operationId:'identity-with-real-backup',previewToken:preview.token,confirmed:true as const};
}
function readBackup(f:ReturnType<typeof fixture>,purpose:'import'|'identity',backupId:string):ExportDataV3{
  assert.match(backupId,/^[a-f0-9]{24}\/[^/]+\.json$/);
  const path=join(f.dir,`${purpose}-backups`,backupId),raw=readFileSync(path,'utf8');
  assert.doesNotMatch(raw,/SYNTHETIC_REMOVED_BACKUP_ANSWER/);
  if(process.platform!=='win32'){
    assert.equal(statSync(path).mode&0o777,0o600);
    assert.equal(statSync(join(f.dir,`${purpose}-backups`,backupId.split('/')[0])).mode&0o777,0o700);
  }
  const data=JSON.parse(raw) as ExportDataV3;assert.equal(data.schemaVersion,3);
  const parent=data.observations.find(event=>event.eventId==='original')!;assert.equal(parent.answer,null);
  if(parent.answer===null)assert.deepEqual(parent.answerClearing,{observationEventId:'original',clearedAt:f.marker.clearedAt});
  return data;
}

test('real v3 import and identity commits save private pre-write backups with null answers and their first clearing markers',()=>{
  for(const purpose of ['import','identity'] as const){
    const f=fixture();
    try{
      let calls=0,saved:ExportDataV3|undefined;
      const beforeWrite=(data:ExportDataV3)=>{calls++;saved=structuredClone(data);return saveImportBackup(f.dbPath,namespace,data,purpose);};
      const receipt=purpose==='import'
        ?f.store.commitImport(importRequest(f.store),source,[old],beforeWrite)
        :f.store.commitIdentityLink(identityRequest(f.store),source,[moved],beforeWrite);
      assert.equal(receipt.status,'accepted');assert.equal(calls,1);
      const backup=readBackup(f,purpose,receipt.backupId);assert.deepEqual(backup,saved);
      assert.equal(backup.observations.length,1,'backup precedes the import of a second observation');
      if(purpose==='import')assert.equal(f.store.countObservations(),2);
      else assert.equal(f.store.getIdentityBindings().length,1);
      const parent=f.store.getObservations().find(event=>event.eventId==='original')!;assert.equal(parent.answer,null);
    }finally{f.close();}
  }
});

test('a real backup write failure aborts v3 import or identity work without partially committing learning or binding state',()=>{
  for(const purpose of ['import','identity'] as const){
    const f=fixture();
    try{
      const request=purpose==='import'?importRequest(f.store):identityRequest(f.store);
      const before=f.store.exportData(source,[old]);
      writeFileSync(join(f.dir,`${purpose}-backups`),'synthetic non-directory',{mode:0o600});
      const beforeWrite=(data:ExportDataV3)=>saveImportBackup(f.dbPath,namespace,data,purpose);
      assert.throws(()=>purpose==='import'
        ?f.store.commitImport(request as ReturnType<typeof importRequest>,source,[old],beforeWrite)
        :f.store.commitIdentityLink(request as ReturnType<typeof identityRequest>,source,[moved],beforeWrite),
        {code:`${purpose.toUpperCase()}_BACKUP_FAILED`});
      assert.deepEqual(f.store.exportData(source,[old]),before);assert.equal(f.store.getIdentityBindings().length,0);assert.equal(f.store.countObservations(),1);
      const db=new DatabaseSync(f.dbPath,{readOnly:true});
      try{assert.equal(db.prepare('SELECT count(*) AS n FROM import_receipts').get()!.n,0);}finally{db.close();}
    }finally{f.close();}
  }
});

test('backup storage retains v1/v2 compatibility and separates purpose and namespace directories',()=>{
  const f=fixture();
  try{
    const current=f.store.exportData(source,[old]);
    const {observationRevisions:_revisions,...legacyFields}=current;
    const v1:ExportDataV1={...legacyFields,schemaVersion:1,observations:[]};
    const v2:ExportDataV2={...current,schemaVersion:2,observations:[]};
    const one=saveImportBackup(f.dbPath,namespace,v1),two=saveImportBackup(f.dbPath,namespace,v2,'identity');
    assert.deepEqual(JSON.parse(readFileSync(join(f.dir,'import-backups',one),'utf8')),v1);
    assert.deepEqual(JSON.parse(readFileSync(join(f.dir,'identity-backups',two),'utf8')),v2);
    const member=new Store({dbPath:f.dbPath,namespace:otherNamespace,schemaVersion:3,now:()=>new Date(instant)});
    try{
      const data=member.exportData(source,[]),other=saveImportBackup(f.dbPath,otherNamespace,data);
      assert.notEqual(other.split('/')[0],one.split('/')[0]);
      assert.deepEqual(JSON.parse(readFileSync(join(f.dir,'import-backups',other),'utf8')),data);
      assert.equal(data.observations.length,0);assert.equal(readdirSync(join(f.dir,'import-backups')).length,2);
    }finally{member.close();}
  }finally{f.close();}
});
