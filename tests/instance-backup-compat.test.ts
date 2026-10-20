import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,readdirSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { backupInstance,restoreInstance,verifyInstanceBundle } from '../src/server/instance-backup.js';
import { inspectLearningSchema,migrateLearningSchemaV1ToV2 } from '../src/server/learning-schema.js';
import { Store } from '../src/server/store.js';
import { isRestoreQuarantined,readInstanceId } from '../src/server/instance-state.js';
import { runInstanceBackupCli } from '../scripts/instance-backup.js';
import { createLegacyLearningFixture,type LegacyLearningVariant } from './helpers/legacy-learning-schema.js';
import { treeHashes,tableRows,digest } from './helpers/instance-backup-fixture.js';

const oldBundle=resolve('tests/fixtures/compat-b16-instance-v1/bundle');
const now=()=>new Date('2026-10-19T00:00:00.000Z');
function inspect(path:string){const db=new DatabaseSync(path,{readOnly:true});try{return inspectLearningSchema(db);}finally{db.close();}}
function legacy(variant:LegacyLearningVariant='current'){
  const base=mkdtempSync(join(tmpdir(),'lm-bundle-compat-'));
  const dataDir=join(base,'data'),kgRoot=join(base,'knowledge'),cliStateDir=join(base,'cli'),procRoot=join(base,'proc');
  for(const path of [dataDir,kgRoot,cliStateDir,procRoot])mkdirSync(path);
  writeFileSync(join(kgRoot,'Concept.md'),'---\ntype: concept\ntitle: Synthetic Concept\n---\n# Definition\nSynthetic body.\n');
  const path=join(dataDir,'living-memory.sqlite'),db=new DatabaseSync(path);db.exec('PRAGMA foreign_keys=ON');
  try{createLegacyLearningFixture(db,variant);}finally{db.close();}
  return {base,path,options:{dataDir,kgRoot,cliStateDir,procRoot,output:join(base,'bundle'),now},cleanup:()=>rmSync(base,{recursive:true,force:true})};
}

test('actual b16 v1 bundle verifies and restores to v2 only in a new quarantined instance without changing source bytes',async()=>{
  const base=mkdtempSync(join(tmpdir(),'lm-b16-default-'));
  const before=treeHashes(oldBundle),sourceLearning=tableRows(join(oldBundle,'data/living-memory.sqlite'));
  const sourceAccounts=tableRows(join(oldBundle,'data/accounts.sqlite'));
  try{
    const manifest=verifyInstanceBundle(oldBundle);assert.equal(manifest.version,1);assert.equal(manifest.applicationVersion,'0.0.1-preview.1');
    assert.equal(Object.hasOwn(manifest,'learningSchemaVersion'),false);
    const report=await restoreInstance({bundle:oldBundle,target:join(base,'new'),now});
    assert.equal(inspect(join(report.startup.dataDir,'living-memory.sqlite')).kind,'current-v2');
    assert.deepEqual(report.schemaMigrations,['learning-schema-v2']);assert.equal(report.version,1);
    assert.notEqual(readInstanceId(report.startup.dataDir),manifest.instanceId);assert.equal(isRestoreQuarantined(report.startup.dataDir),true);
    const restored=tableRows(join(report.startup.dataDir,'living-memory.sqlite'));
    for(const [table,rows] of Object.entries(sourceLearning))assert.deepEqual(restored[table],rows);
    assert.deepEqual(restored.observation_revisions,[]);assert.equal(restored.learning_schema_metadata[0].schema_version,2);
    const accounts=tableRows(join(report.startup.dataDir,'accounts.sqlite'));
    assert.equal(accounts.sessions.length,0);assert.ok(sourceAccounts.sessions.length>0);
    for(const table of ['accounts','meta','feishu_bindings'])assert.deepEqual(accounts[table],sourceAccounts[table]);
    assert.deepEqual(treeHashes(oldBundle),before);
  }finally{rmSync(base,{recursive:true,force:true});}
});

test('explicit legacy preservation uses the real v1 bundle but still changes instance and revokes active sessions',async()=>{
  const base=mkdtempSync(join(tmpdir(),'lm-b16-preserve-'));
  try{
    const manifest=verifyInstanceBundle(oldBundle),before=treeHashes(oldBundle);
    const report=await restoreInstance({bundle:oldBundle,target:join(base,'legacy'),now,preserveLegacyLearningSchema:true});
    assert.equal(inspect(join(report.startup.dataDir,'living-memory.sqlite')).kind,'legacy-v1');
    assert.deepEqual(report.schemaMigrations,[]);
    assert.deepEqual(tableRows(join(report.startup.dataDir,'living-memory.sqlite')),tableRows(join(oldBundle,'data/living-memory.sqlite')));
    assert.notEqual(report.instanceId,manifest.instanceId);assert.equal(isRestoreQuarantined(report.startup.dataDir),true);
    assert.equal(tableRows(join(report.startup.dataDir,'accounts.sqlite')).sessions.length,0);
    assert.deepEqual(treeHashes(oldBundle),before);
    assert.deepEqual(await runInstanceBackupCli(['verify','--bundle',oldBundle]),{format:'living-memory-instance',version:1,learningSchemaVersion:1,status:'verified',files:manifest.files.length,sources:manifest.sources.length});
  }finally{rmSync(base,{recursive:true,force:true});}
});

test('new tools back up a legacy source as manifest v2/schema1 without mutating it and normalize missing activity only in the restore stage',async()=>{
  for(const variant of ['current','activity-none','altered-column-order','pre-scenario'] as const){
    const f=legacy(variant);
    try{
      const before=digest(readFileSync(f.path)),rows=tableRows(f.path);
      const manifest=await backupInstance(f.options);
      assert.equal(manifest.version,2);assert.equal(manifest.applicationVersion,'0.0.1-preview.2');assert.equal(manifest.learningSchemaVersion,1);
      assert.equal(inspect(f.path).kind,'legacy-v1');assert.equal(digest(readFileSync(f.path)),before);
      const report=await restoreInstance({bundle:f.options.output,target:join(f.base,'new'),now});
      const restoredPath=join(report.startup.dataDir,'living-memory.sqlite');assert.equal(inspect(restoredPath).kind,'current-v2');
      const restored=tableRows(restoredPath);
      for(const [table,records] of Object.entries(rows)){
        // Known normalizations only add nullable columns; every preexisting cell stays byte-identical.
        assert.deepEqual(restored[table].map(row=>Object.fromEntries(Object.keys(records[0]??{}).map(key=>[key,row[key]]))),records);
      }
      if(variant==='activity-none')for(const table of ['activity_events','activity_settings','activity_deliveries','activity_deletions'])assert.deepEqual(restored[table],[]);
      assert.deepEqual(report.schemaMigrations,['learning-schema-v2']);assert.equal(digest(readFileSync(f.path)),before);
    }finally{f.cleanup();}
  }
});

test('unknown, partial or future source schemas are refused before any backup stage is made',async()=>{
  for(const variant of ['activity-partial','bad-check','unknown-extra','ancient-five-table','future','marked-partial'] as const){
    const f=legacy(variant==='future'||variant==='marked-partial'?'current':variant);
    try{
      if(variant==='future'||variant==='marked-partial'){
        const db=new DatabaseSync(f.path);try{
          db.exec('PRAGMA foreign_keys=ON');
          if(variant==='future')db.exec('PRAGMA user_version=99');
          else{migrateLearningSchemaV1ToV2(db,{recordedAt:now().toISOString()});db.exec('DROP TABLE learning_schema_metadata');}
        }finally{db.close();}
      }
      const before=digest(readFileSync(f.path));
      await assert.rejects(backupInstance(f.options),{code:'INSTANCE_DATABASE_INVALID'});
      assert.equal(existsSync(f.options.output),false);assert.equal(readdirSync(f.base).some(name=>name.startsWith('.bundle.lm-')),false);
      assert.equal(digest(readFileSync(f.path)),before);
    }finally{f.cleanup();}
  }
});

test('declared learning schema and application version must match actual bundle contents and v2 cannot request legacy downgrade',async()=>{
  const f=legacy();
  try{
    const db=new DatabaseSync(f.path);try{db.exec('PRAGMA foreign_keys=ON');migrateLearningSchemaV1ToV2(db,{recordedAt:now().toISOString()});}finally{db.close();}
    const marker=tableRows(f.path).learning_schema_metadata;
    const manifest=await backupInstance(f.options);assert.equal(manifest.learningSchemaVersion,2);
    const manifestPath=join(f.options.output,'manifest.json'),bytes=readFileSync(manifestPath);
    for(const change of [{learningSchemaVersion:1},{learningSchemaVersion:3},{learningSchemaVersion:undefined},{applicationVersion:'0.0.1-preview.1'},{version:3}]){
      writeFileSync(manifestPath,JSON.stringify({...manifest,...change}));
      try{assert.throws(()=>verifyInstanceBundle(f.options.output));const target=join(f.base,'bad-target');await assert.rejects(restoreInstance({bundle:f.options.output,target,now}));assert.equal(existsSync(target),false);}
      finally{writeFileSync(manifestPath,bytes);}
    }
    const target=join(f.base,'no-downgrade');await assert.rejects(restoreInstance({bundle:f.options.output,target,now,preserveLegacyLearningSchema:true}),{code:'INVALID_INSTANCE_ARGUMENT'});
    assert.equal(existsSync(target),false);
    const report=await restoreInstance({bundle:f.options.output,target:join(f.base,'v2'),now});
    assert.deepEqual(report.schemaMigrations,[]);assert.deepEqual(tableRows(join(report.startup.dataDir,'living-memory.sqlite')).learning_schema_metadata,marker);
  }finally{f.cleanup();}
});


test('schema2 backup and restore preserve nonempty revision chains, original receipts and independent namespace adoption states', async () => {
  const f = legacy();
  const assessment = { rating: 'clear' as const, learning: { outcome: 'success' as const, basis: 'self-check' as const } };
  const states: Record<string, ReturnType<Store['observationRevisions']['readHistory']>['state']> = {};
  try {
    const db = new DatabaseSync(f.path);
    try { db.exec('PRAGMA foreign_keys=ON'); migrateLearningSchemaV1ToV2(db, { recordedAt: '2026-10-18T00:05:00.000Z' }); }
    finally { db.close(); }
    const originalObservations = tableRows(f.path).observations;
    for (const namespace of ['legacy-a', 'legacy-b']) {
      // Use the real ledger on valid parents; all connections close before the offline backup.
      const store = new Store({ dbPath: f.path, namespace, now });
      try {
        store.addRetention({ eventId: 'retention-original', conceptId: 'concept-original', sourceRevision: 'revision-original', occurredAt: '2026-10-18T00:05:00.000Z', active: true, previousEventId: null }, null);
        const ledger = store.observationRevisions;
        const common = { observationEventId: 'observation-original', reason: 'input-error' as const };
        ledger.append({ ...common, eventId: 'revise-original', previousEventId: null, occurredAt: '2026-10-18T00:06:00.000Z', action: 'revise', assessment, note: '  synthetic original note  ' });
        ledger.append({ ...common, eventId: 'withdraw-original', previousEventId: 'revise-original', occurredAt: '2026-10-18T00:07:00.000Z', action: 'withdraw' });
        if (namespace === 'legacy-a') ledger.append({ ...common, eventId: 'reinstate-original', previousEventId: 'withdraw-original', occurredAt: '2026-10-18T00:08:00.000Z', action: 'reinstate', note: '' });
        states[namespace] = ledger.readHistory('observation-original').state;
      } finally { store.close(); }
    }
    assert.equal(states['legacy-a'].status, 'active');
    assert.deepEqual(states['legacy-a'].currentAssessment, assessment);
    assert.equal(states['legacy-b'].status, 'withdrawn');
    const before = tableRows(f.path), sourceBytes = digest(readFileSync(f.path));
    assert.equal(before.observation_revisions.length, 5);
    assert.deepEqual(before.observations, originalObservations);
    assert.equal(before.retentions.length, 2);
    assert.ok(before.observation_revisions.every(row => row.recorded_at === now().toISOString()));
    assert.equal(before.review_plans.length, 2);
    assert.ok(before.review_plans.every(row => row.daily_budget === 0));
    const manifest = await backupInstance(f.options);
    assert.equal(manifest.version, 2); assert.equal(manifest.learningSchemaVersion, 2);
    assert.deepEqual(verifyInstanceBundle(f.options.output), JSON.parse(JSON.stringify(manifest)));
    const report = await restoreInstance({ bundle: f.options.output, target: join(f.base, 'nonempty-v2'), now });
    const restoredPath = join(report.startup.dataDir, 'living-memory.sqlite');
    const restored = tableRows(restoredPath);
    for (const table of ['observation_revisions', 'observations', 'review_plans', 'retentions', 'anchors', 'learning_schema_metadata']) {
      // Includes exact request_payload, assessment_json, raw answers and original recorded_at.
      assert.deepEqual(restored[table], before[table], table);
    }
    assert.deepEqual(report.schemaMigrations, []);
    assert.equal(isRestoreQuarantined(report.startup.dataDir), true);
    for (const namespace of ['legacy-a', 'legacy-b']) {
      const store = new Store({ dbPath: restoredPath, namespace, now });
      try {
        assert.deepEqual(store.observationRevisions.readHistory('observation-original').state, states[namespace]);
        assert.equal(store.observationRevisions.getRevisionCount(), namespace === 'legacy-a' ? 3 : 2);
      } finally { store.close(); }
    }
    assert.equal(digest(readFileSync(f.path)), sourceBytes);
  } finally { f.cleanup(); }
});

test('legacy restoration preserves legal independent rating and outcome pairs, exact original retries and JSON2 evidence', async () => {
  // Match the actual legacy writer's byte-canonical request payload, without
  // changing the fixed historical artifact or the independent DDL fixture.
  const canonical = (value: unknown): string => {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  };
  const f = legacy();
  const expected = new Map<string, Parameters<Store['addObservation']>[0]>();
  try {
    const db = new DatabaseSync(f.path);
    try {
      for (const [namespace, rating, outcome] of [
        ['legacy-a', 'clear', 'unverified'], ['legacy-b', 'blank', 'success'],
      ] as const) {
        const row = db.prepare('SELECT request_payload FROM observations WHERE namespace=? AND event_id=?')
          .get(namespace, 'observation-original')!;
        const original = JSON.parse(String(row.request_payload)) as Parameters<Store['addObservation']>[0];
        assert.ok(original.learning);
        const request = { ...original, rating, learning: { ...original.learning, outcome } };
        const payload = canonical(request);
        assert.deepEqual(JSON.parse(payload), request);
        db.prepare('UPDATE observations SET rating=?,learning_json=?,request_payload=? WHERE namespace=? AND event_id=?')
          .run(rating, JSON.stringify(request.learning), payload, namespace, request.eventId);
        expected.set(namespace, request);
      }
    } finally { db.close(); }
    assert.equal(inspect(f.path).kind, 'legacy-v1');
    const before = tableRows(f.path), sourceHash = digest(readFileSync(f.path));
    const manifest = await backupInstance(f.options);
    assert.equal(manifest.version, 2); assert.equal(manifest.learningSchemaVersion, 1);
    const report = await restoreInstance({ bundle: f.options.output, target: join(f.base, 'independent-pairs'), now });
    const restoredPath = join(report.startup.dataDir, 'living-memory.sqlite');
    assert.equal(inspect(restoredPath).kind, 'current-v2');
    assert.deepEqual(tableRows(restoredPath).observations, before.observations);
    assert.notEqual(report.instanceId, manifest.instanceId);
    assert.equal(isRestoreQuarantined(report.startup.dataDir), true);
    for (const [namespace, request] of expected) {
      const store = new Store({ dbPath: restoredPath, namespace, now });
      try {
        const raw = store.getObservations();
        assert.equal(raw.length, 1);
        assert.equal(raw[0].rating, request.rating);
        assert.deepEqual(raw[0].learning, request.learning);
        assert.deepEqual(store.observationRevisions.readHistory(request.eventId).state.currentAssessment,
          { rating: request.rating, learning: { outcome: request.learning!.outcome, basis: request.learning!.basis } });
        assert.equal(store.addObservation(request, request.anchorEventId).status, 'duplicate');
        const exported = store.exportData({ name: 'synthetic', mode: 'local', conceptCount: 0, limit: 10, diagnostics: [] }, []);
        assert.equal(exported.schemaVersion, 2);
        assert.deepEqual(exported.observations, raw);
        assert.deepEqual(exported.observationRevisions, []);
      } finally { store.close(); }
    }
    assert.deepEqual(tableRows(restoredPath).observations, before.observations);
    assert.equal(digest(readFileSync(f.path)), sourceHash);
  } finally { f.cleanup(); }
});
