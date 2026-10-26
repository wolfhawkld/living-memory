import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { inspectAnswerClearingSchemaV3 } from '../src/server/answer-clearing-schema.js';
import { AnswerClearingStore, ANSWER_CLEARING_RETIRED_CREDENTIAL } from '../src/server/answer-clearing-store.js';
import { activateRestoredConnectors, backupInstance, restoreInstance, verifyInstanceBundle,
  type RestoreReport } from '../src/server/instance-backup.js';
import { previewSourceReconnect } from '../src/integrations/source-reconnect-preview.js';
import { isRestoreQuarantined, readInstanceId } from '../src/server/instance-state.js';
import { assertLearningDatabaseReady, Store } from '../src/server/store.js';
import { digest, instanceFixture, tableRows, treeHashes } from './helpers/instance-backup-fixture.js';

const now=()=>new Date('2026-10-22T00:00:00.000Z');
const clearedAt='2026-10-22T01:00:00.000Z';
const oldBundle=resolve('tests/fixtures/compat-b16-instance-v1/bundle');
type Tables=ReturnType<typeof tableRows>;

function inspection(path:string) {
  const db=new DatabaseSync(path,{readOnly:true});
  try {return inspectAnswerClearingSchemaV3(db);} finally {db.close();}
}
function assertUpgradedRows(before:Tables,after:Tables) {
  for(const [table,records] of Object.entries(before)) {
    if(table==='learning_schema_metadata') continue;
    assert.deepEqual(after[table],table==='observations' ? records.map(record=>({...record,answer_cleared_at:null})) : records,table);
  }
  assert.equal(after.learning_schema_metadata.length,1);
  assert.equal(after.learning_schema_metadata[0].schema_version,3);
  assert.equal(after.learning_schema_metadata[0].minimum_reader_version,3);
}
function candidateOptions(report:RestoreReport,procRoot:string,output:string) {
  return {dataDir:report.startup.dataDir,kgRoot:report.startup.kgRoot,cliStateDir:report.startup.cliStateDir,
    ...(report.startup.envArchive ? {envFile:report.startup.envArchive} : {}),procRoot,output,now};
}
function assertReconnectVersion(report: RestoreReport) {
  const root = dirname(report.startup.dataDir), before = treeHashes(root);
  const preview = previewSourceReconnect({ instanceRoot: root, kgRoot: report.startup.kgRoot, serverUrl: 'http://127.0.0.1:4317' });
  assert.equal(preview.runtime.LM_LEARNING_SCHEMA_VERSION, '3');
  assert.equal(preview.runtime.LM_FEISHU_ENABLED, '0');
  assert.ok(preview.limitations.includes('STATIC_BUILD_COMPATIBILITY_NOT_CHECKED'));
  assert.deepEqual(treeHashes(root), before, 'reconnect only reads the real restored report and knowledge');
}
function assertNoTarget(base:string,target:string) {
  assert.equal(existsSync(target),false);
  assert.equal(readdirSync(base).some(name=>name.startsWith(`.${target.slice(target.lastIndexOf('/')+1)}.lm-`)),false);
}

test('offline v2 to v3 candidate, clear, v3 backup and explicit v3 restore preserve evidence, namespaces and first privacy marker',async()=>{
  const f=await instanceFixture();
  try {
    const sourcePath=join(f.options.dataDir,'living-memory.sqlite');
    for(const [index,source] of f.sources.entries()) {
      const store=new Store({dbPath:sourcePath,namespace:source.source.namespace,now});
      try {
        store.observationRevisions.append({eventId:`revision-${index}`,observationEventId:`observation-${index}`,previousEventId:null,
          occurredAt:'2026-10-21T00:00:00.000Z',action:'withdraw',reason:'other',note:`Independent namespace ${index} note`});
        // Use the existing v2 writer to generate real legacy answer-derived import credentials.
        const concepts=source.source.index.concepts.map(concept=>concept.id===source.raw.id?{...concept,id:source.stable.id}:concept);
        const data=store.exportData(source.source.index.source,concepts),options={restoreLayout:false,restoreReviewPlan:false};
        const preview=store.previewImport(data,options,source.source.index.source,concepts);
        assert.equal(preview.canImport,true,JSON.stringify(preview.issues));
        store.commitImport({importId:`bundle-import-${index}`,data,options,previewToken:preview.token,confirmed:true},
          source.source.index.source,concepts,()=>`synthetic-import-backup-${index}`);
      } finally {store.close();}
    }
    const sourceRows=tableRows(sourcePath),sourceBytes=digest(readFileSync(sourcePath));
    for(const table of ['import_receipts','identity_bindings']) {
      assert.equal(sourceRows[table].length,2);
      for(const row of sourceRows[table]) assert.match(row.request_hash,/^[a-f0-9]{64}$/);
    }
    const sourceAccounts=tableRows(join(f.options.dataDir,'accounts.sqlite'));
    const manifest2=await backupInstance(f.options);
    assert.equal(manifest2.version,2); assert.equal(manifest2.learningSchemaVersion,2);
    const bundle2Before=treeHashes(f.options.output);
    const candidate=await restoreInstance({bundle:f.options.output,target:join(f.base,'candidate-v3'),now,targetLearningSchemaVersion:3});
    assert.deepEqual(candidate.learningSchemaCandidate,{schemaVersion:3,runtimeReady:true});
    assert.deepEqual(candidate.schemaMigrations,['learning-schema-v3']);
    assert.equal(candidate.startup.learningSchemaVersion,3);assertReconnectVersion(candidate);
    const path=join(candidate.startup.dataDir,'living-memory.sqlite');
    assert.deepEqual(inspection(path),{kind:'current-v3',schemaVersion:3,minimumReaderVersion:3});
    assertUpgradedRows(sourceRows,tableRows(path));
    assert.equal(isRestoreQuarantined(candidate.startup.dataDir),true);
    assert.notEqual(readInstanceId(candidate.startup.dataDir),manifest2.instanceId);
    assert.equal(candidate.invalidated.sessions,sourceAccounts.sessions.length);
    const candidateAccounts=tableRows(join(candidate.startup.dataDir,'accounts.sqlite'));
    assert.equal(candidateAccounts.sessions.length,0);
    for(const table of ['accounts','meta','feishu_bindings']) assert.deepEqual(candidateAccounts[table],sourceAccounts[table]);
    assert.throws(()=>assertLearningDatabaseReady(path),{code:'LEARNING_SCHEMA_UNSUPPORTED_VERSION'});
    assert.throws(()=>new Store({dbPath:path,namespace:f.sources[0].source.namespace}),{code:'LEARNING_SCHEMA_UNSUPPORTED_VERSION'});
    const db=new DatabaseSync(path);
    try {
      db.exec('PRAGMA foreign_keys=ON');
      const clearing=new AnswerClearingStore({db,namespace:f.sources[0].source.namespace,now:()=>new Date(clearedAt)});
      assert.deepEqual(clearing.prepareReplayPrivacy(),{status:'already-ready',retiredImportCredentials:0,retiredIdentityCredentials:0});
      assert.deepEqual(clearing.clear({observationEventId:'observation-0'}),{status:'accepted',observationEventId:'observation-0',clearedAt});
      assert.deepEqual(clearing.getReplayPrivacyStatus(),{status:'ready',clearedObservations:1,activeImportCredentials:0,safeImportCredentials:0,
        activeIdentityCredentials:0,safeIdentityCredentials:0,retiredImportCredentials:1,retiredIdentityCredentials:1});
    } finally {db.close();}
    const clearedRows=tableRows(path);
    for(const [table,records] of Object.entries(tableRows(join(f.options.output,'data/living-memory.sqlite')))) {
      if(table==='observations'||table==='learning_schema_metadata') continue;
      assert.deepEqual(clearedRows[table],table==='import_receipts'||table==='identity_bindings'
        ? records.map(record=>record.namespace===f.sources[0].source.namespace
          ? {...record,request_hash:ANSWER_CLEARING_RETIRED_CREDENTIAL}:record) : records,table);
    }
    assert.equal(clearedRows.observations.length,sourceRows.observations.length);
    for(const original of sourceRows.observations) {
      const actual=clearedRows.observations.find(row=>row.namespace===original.namespace&&row.event_id===original.event_id)!;
      const target=original.namespace===f.sources[0].source.namespace&&original.event_id==='observation-0';
      assert.deepEqual(actual,{...original,...(target?{answer:null,request_payload:null,answer_cleared_at:clearedAt}:{answer_cleared_at:null})});
    }
    const bundle3=join(f.base,'bundle-v3'),manifest3=await backupInstance(candidateOptions(candidate,f.options.procRoot,bundle3));
    assert.equal(manifest3.version,2);assert.equal(manifest3.learningSchemaVersion,3);
    assert.deepEqual(verifyInstanceBundle(bundle3),JSON.parse(JSON.stringify(manifest3)));
    const bundle3Before=treeHashes(bundle3);
    const restored=await restoreInstance({bundle:bundle3,target:join(f.base,'roundtrip-v3'),now,targetLearningSchemaVersion:3});
    assert.deepEqual(restored.learningSchemaCandidate,{schemaVersion:3,runtimeReady:true});assert.deepEqual(restored.schemaMigrations,[]);
    assert.equal(restored.startup.learningSchemaVersion,3);assertReconnectVersion(restored);
    const reportPath=join(dirname(restored.startup.dataDir),'restore-report.json'),reportBytes=readFileSync(reportPath);
    try {
      const historical=JSON.parse(reportBytes.toString('utf8'));historical.learningSchemaCandidate.runtimeReady=false;delete historical.startup.learningSchemaVersion;
      writeFileSync(reportPath,JSON.stringify(historical));assertReconnectVersion(historical);
      assert.equal(JSON.parse(readFileSync(reportPath,'utf8')).learningSchemaCandidate.runtimeReady,false);
    } finally {writeFileSync(reportPath,reportBytes);}
    assert.deepEqual(tableRows(join(restored.startup.dataDir,'living-memory.sqlite')),clearedRows);
    const restoredDb=new DatabaseSync(join(restored.startup.dataDir,'living-memory.sqlite'));
    try {
      restoredDb.exec('PRAGMA foreign_keys=ON');
      const clearing=new AnswerClearingStore({db:restoredDb,namespace:f.sources[0].source.namespace,now:()=>{throw new Error('no clock on replay');}});
      assert.equal(clearing.getReplayPrivacyStatus().status,'ready');
      assert.deepEqual(clearing.prepareReplayPrivacy(),{status:'already-ready',retiredImportCredentials:0,retiredIdentityCredentials:0});
      restoredDb.exec('BEGIN IMMEDIATE');
      assert.throws(()=>clearing.assertOperationReplayAllowed('import','bundle-import-0'),{code:'ANSWER_CLEARING_OPERATION_RETIRED'});
      assert.throws(()=>clearing.assertOperationReplayAllowed('identity','move-0'),{code:'ANSWER_CLEARING_OPERATION_RETIRED'});
      const member=new AnswerClearingStore({db:restoredDb,namespace:f.sources[1].source.namespace});
      assert.equal(member.getReplayPrivacyStatus().clearedObservations,0);
      member.assertOperationReplayAllowed('import','bundle-import-1');member.assertOperationReplayAllowed('identity','move-1');
      restoredDb.exec('ROLLBACK');
    } finally {if(restoredDb.isTransaction)restoredDb.exec('ROLLBACK');restoredDb.close();}
    assert.equal(isRestoreQuarantined(restored.startup.dataDir),true);
    assert.notEqual(restored.instanceId,candidate.instanceId);
    assert.equal(tableRows(join(restored.startup.dataDir,'accounts.sqlite')).sessions.length,0);
    assert.deepEqual(treeHashes(bundle3),bundle3Before);assert.deepEqual(treeHashes(f.options.output),bundle2Before);
    assert.equal(digest(readFileSync(sourcePath)),sourceBytes);assert.deepEqual(tableRows(sourcePath),sourceRows);
    const activationAccounts=tableRows(join(restored.startup.dataDir,'accounts.sqlite')),activationReport=readFileSync(reportPath);
    await assert.rejects(activateRestoredConnectors(restored.startup.dataDir,true,{procRoot:f.options.procRoot}),{code:'INSTANCE_RUNTIME_UNSUPPORTED'});
    assert.equal(isRestoreQuarantined(restored.startup.dataDir),true);
    await assert.rejects(activateRestoredConnectors(restored.startup.dataDir,true,{procRoot:f.options.procRoot,learningSchemaVersion:2}),{code:'INSTANCE_RUNTIME_UNSUPPORTED'});
    assert.equal(isRestoreQuarantined(restored.startup.dataDir),true);
    await activateRestoredConnectors(restored.startup.dataDir,true,{procRoot:f.options.procRoot,learningSchemaVersion:3});
    assert.equal(isRestoreQuarantined(restored.startup.dataDir),false);
    assert.deepEqual(tableRows(join(restored.startup.dataDir,'living-memory.sqlite')),clearedRows);
    assert.deepEqual(tableRows(join(restored.startup.dataDir,'accounts.sqlite')),activationAccounts);
    assert.deepEqual(readFileSync(reportPath),activationReport);
    for(const [label,options] of [ ['default',{}],['target2',{targetLearningSchemaVersion:2 as const}],['legacy',{preserveLegacyLearningSchema:true}] ] as const) {
      const target=join(f.base,`refused-${label}`);
      await assert.rejects(restoreInstance({bundle:bundle3,target,now,...options}),
        {code:label==='legacy'?'INVALID_INSTANCE_ARGUMENT':'INSTANCE_SCHEMA_TARGET_REQUIRED'});assertNoTarget(f.base,target);
    }
  } finally {f.cleanup();}
});

test('the real b16 v1 bundle can explicitly produce a quarantined v3 candidate without changing source bytes',async()=>{
  const base=mkdtempSync(join(tmpdir(),'lm-b16-answer-clear-'));
  try {
    const bytes=treeHashes(oldBundle),source=tableRows(join(oldBundle,'data/living-memory.sqlite'));
    const manifest=verifyInstanceBundle(oldBundle);
    const report=await restoreInstance({bundle:oldBundle,target:join(base,'v3'),now,targetLearningSchemaVersion:3});
    assert.deepEqual(report.learningSchemaCandidate,{schemaVersion:3,runtimeReady:true});
    assert.deepEqual(report.schemaMigrations,['learning-schema-v2','learning-schema-v3']);
    assert.equal(report.startup.learningSchemaVersion,3);assertReconnectVersion(report);
    const path=join(report.startup.dataDir,'living-memory.sqlite');
    assert.equal(inspection(path).kind,'current-v3');assertUpgradedRows(source,tableRows(path));
    assert.equal(isRestoreQuarantined(report.startup.dataDir),true);assert.notEqual(report.instanceId,manifest.instanceId);
    assert.equal(tableRows(join(report.startup.dataDir,'accounts.sqlite')).sessions.length,0);
    assert.deepEqual(treeHashes(oldBundle),bytes);
    for(const legacy of [true,false]) {
      const target=join(base,`conflicting-${legacy}`);
      await assert.rejects(restoreInstance({bundle:oldBundle,target,now,targetLearningSchemaVersion:3,preserveLegacyLearningSchema:legacy}),{code:'INVALID_INSTANCE_ARGUMENT'});
      assertNoTarget(base,target);
    }
  } finally {rmSync(base,{recursive:true,force:true});}
});

test('a v3 copy constraint failure cleans its unpublished stage and does not mutate the source bundle or v2 database',async()=>{
  const f=await instanceFixture();
  try {
    const path=join(f.options.dataDir,'living-memory.sqlite'),db=new DatabaseSync(path);
    try {
      // SQLite permits BLOB in a v2 TEXT NOT NULL column; v3 deliberately requires saved text.
      db.prepare('UPDATE observations SET answer=? WHERE event_id=?').run(Buffer.from('synthetic-invalid-type'),'observation-0');
      assert.equal(Object.values(db.prepare('PRAGMA integrity_check').get()!)[0],'ok');
    } finally {db.close();}
    const original=digest(readFileSync(path));await backupInstance(f.options);
    const bundleBefore=treeHashes(f.options.output),target=join(f.base,'failed-v3-copy');
    await assert.rejects(restoreInstance({bundle:f.options.output,target,now,targetLearningSchemaVersion:3}),{code:'INSTANCE_DATABASE_INVALID'});
    assertNoTarget(f.base,target);assert.deepEqual(treeHashes(f.options.output),bundleBefore);
    assert.equal(digest(readFileSync(path)),original);
    assert.equal(verifyInstanceBundle(f.options.output).learningSchemaVersion,2);
  } finally {f.cleanup();}
});

test('manifest schema lies and future schema declarations cannot be verified or published as restored instances',async()=>{
  const f=await instanceFixture();
  try {
    const manifest=await backupInstance(f.options),manifestPath=join(f.options.output,'manifest.json');
    const original=readFileSync(manifestPath),bytes=treeHashes(f.options.output);
    for(const version of [1,3,4,99]) {
      try {
        writeFileSync(manifestPath,JSON.stringify({...manifest,learningSchemaVersion:version}));
        assert.throws(()=>verifyInstanceBundle(f.options.output));
        const target=join(f.base,`false-schema-${version}`);
        await assert.rejects(restoreInstance({bundle:f.options.output,target,now,targetLearningSchemaVersion:3}));assertNoTarget(f.base,target);
      } finally {writeFileSync(manifestPath,original);}
    }
    assert.deepEqual(treeHashes(f.options.output),bytes);
  } finally {f.cleanup();}
});


test('activation rejects invalid schema options before locking and explicit v3 cannot authorize a v2 instance', async () => {
  const f = await instanceFixture();
  try {
    const missing = join(f.base, 'must-not-create');
    for (const schema of [null, '3', 0, 4]) {
      await assert.rejects(activateRestoredConnectors(missing, true, { learningSchemaVersion: schema as 3 }), { code: 'INSTANCE_RUNTIME_UNSUPPORTED' });
      assert.equal(existsSync(missing), false);
    }
    await backupInstance(f.options);
    const restored = await restoreInstance({ bundle: f.options.output, target: join(f.base, 'v2-activation'), now });
    assert.equal(Object.hasOwn(restored.startup, 'learningSchemaVersion'), false, 'v2 reports retain their old shape');
    const marker = join(restored.startup.dataDir, 'restore-quarantine.json'), before = readFileSync(marker);
    await assert.rejects(activateRestoredConnectors(restored.startup.dataDir, true, { procRoot: f.options.procRoot, learningSchemaVersion: 3 }), { code: 'INSTANCE_RUNTIME_UNSUPPORTED' });
    assert.deepEqual(readFileSync(marker), before);
    await activateRestoredConnectors(restored.startup.dataDir, true, { procRoot: f.options.procRoot, learningSchemaVersion: 2 });
    assert.equal(isRestoreQuarantined(restored.startup.dataDir), false);
  } finally { f.cleanup(); }
});
