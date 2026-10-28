import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Accounts } from '../src/server/accounts.js';
import { Store } from '../src/server/store.js';
import type { FeishuRewarmRequest } from '../src/shared/feishu-rewarm.js';
import { backupInstance, restoreInstance, verifyInstanceBundle } from '../src/server/instance-backup.js';
import { digest, instanceFixture, instant, now, tableRows, treeHashes } from './helpers/instance-backup-fixture.js';

type Fixture = Awaited<ReturnType<typeof instanceFixture>>;
function edit(path: string, action: (db: DatabaseSync) => void) {
  const db = new DatabaseSync(path);
  try { action(db); } finally { db.close(); }
}
function seed(f: Fixture) {
  edit(join(f.options.dataDir,'accounts.sqlite'),db=>{
    const insert=db.prepare(`INSERT INTO feishu_rewarm_intents(id,user_id,account_access_revision,binding_id,app_id,tenant_key,open_id,
      namespace,source_fingerprint,origin_chat_id,request_json,status,error_code,created_at,settled_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for(const [index,status] of (['pending','applied','conflict'] as const).entries()) {
      const id=String(index+1).repeat(32);
      const request={eventId:`feishu-rewarm:${id}`,conceptId:f.sources[0].stable.id,sourceRevision:f.sources[0].raw.source.revision,kind:'review',occurredAt:instant};
      insert.run(id,f.auth.userId,f.auth.accessRevision,f.auth.bindingId,f.actor.appId,f.actor.tenantKey,f.actor.openId,
        f.sources[0].source.namespace,'a'.repeat(64),'private',JSON.stringify(request),status,status==='conflict'?'SOURCE_CHANGED':null,instant,status==='pending'?null:instant);
    }
  });
}

// Refresh the synthetic archive's declared checksum and schema metadata after intentional
// corruption. Verification must reject the journal itself, beyond detecting changed bytes.
function refreshAccountsManifest(bundle: string) {
  const manifestPath=join(bundle,'manifest.json');
  const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
  const relativePath='data/accounts.sqlite',path=join(bundle,relativePath);
  const bytes=readFileSync(path);
  const file=manifest.files.find((entry:{path:string})=>entry.path===relativePath);
  file.size=bytes.length;file.sha256=digest(bytes);
  edit(path,db=>{
    const schema=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
    const tables:Record<string,number>=Object.create(null);
    for(const row of schema) if(row.type==='table') {
      const quoted=`"${String(row.name).replaceAll('"','""')}"`;
      tables[String(row.name)]=Number(db.prepare(`SELECT count(*) AS count FROM ${quoted}`).get()!.count);
    }
    const index=manifest.databases.findIndex((entry:{path:string})=>entry.path===relativePath);
    manifest.databases[index]={path:relativePath,userVersion:Number(db.prepare('PRAGMA user_version').get()!.user_version),schemaHash:digest(JSON.stringify(schema)),tables};
  });
  writeFileSync(manifestPath,JSON.stringify(manifest));
}

test('rewarm backup roundtrip preserves frozen requests and terminal intents while quarantining pending intents only in the restore',async()=>{
  const f=await instanceFixture();
  try {
    seed(f);
    const sourceAccounts=tableRows(join(f.options.dataDir,'accounts.sqlite'));
    const sourceLearning=tableRows(join(f.options.dataDir,'living-memory.sqlite'));
    const sourceKnowledge=f.sources.map(source=>treeHashes(source.root));
    const manifest=await backupInstance(f.options);
    assert.deepEqual(verifyInstanceBundle(f.options.output),JSON.parse(JSON.stringify(manifest)));
    const archiveAccounts=tableRows(join(f.options.output,'data/accounts.sqlite'));
    assert.deepEqual(archiveAccounts.feishu_rewarm_intents,sourceAccounts.feishu_rewarm_intents);
    const bundleBefore=treeHashes(f.options.output);
    const report=await restoreInstance({bundle:f.options.output,target:join(f.base,'restored-rewarm'),now});
    assert.equal(report.invalidated.pendingRewarmIntents,1);
    const restored=tableRows(join(report.startup.dataDir,'accounts.sqlite')).feishu_rewarm_intents;
    assert.equal(restored.length,3);
    for(const before of sourceAccounts.feishu_rewarm_intents) {
      const after=restored.find(row=>row.id===before.id)!;
      assert.ok(after);assert.equal(after.request_json,before.request_json);
      if(before.status==='pending') assert.deepEqual(after,{...before,status:'conflict',error_code:'INSTANCE_RESTORED',settled_at:instant});
      else assert.deepEqual(after,before);
    }
    const accounts=new Accounts({dataDir:report.startup.dataDir,now});
    try { assert.deepEqual(tableRows(join(report.startup.dataDir,'accounts.sqlite')).feishu_rewarm_intents,restored); }
    finally { accounts.close(); }
    assert.deepEqual(tableRows(join(report.startup.dataDir,'living-memory.sqlite')),sourceLearning);
    assert.deepEqual(tableRows(join(f.options.dataDir,'accounts.sqlite')),sourceAccounts);
    assert.deepEqual(tableRows(join(f.options.dataDir,'living-memory.sqlite')),sourceLearning);
    assert.deepEqual(f.sources.map(source=>treeHashes(source.root)),sourceKnowledge);
    assert.deepEqual(treeHashes(f.options.output),bundleBefore);
  } finally { f.cleanup(); }
});

test('a review committed before intent settlement survives restore exactly once while its pending intent becomes an unresolved restore conflict',async()=>{
  const f=await instanceFixture();
  try {
    seed(f);
    const accountsPath=join(f.options.dataDir,'accounts.sqlite');
    const pending=tableRows(accountsPath).feishu_rewarm_intents.find(row=>row.status==='pending')!;
    const request=JSON.parse(pending.request_json) as FeishuRewarmRequest;
    const store=new Store({dataDir:f.options.dataDir,namespace:f.sources[0].source.namespace,now});
    try { assert.deepEqual(store.addReview(request),{status:'accepted',eventId:request.eventId}); }
    finally { store.close(); }
    // The learning commit succeeded; Accounts still says pending because settlement never completed.
    assert.deepEqual(tableRows(accountsPath).feishu_rewarm_intents.find(row=>row.id===pending.id),pending);
    const sourceAccounts=tableRows(accountsPath);
    const sourceLearning=tableRows(join(f.options.dataDir,'living-memory.sqlite'));
    const committed=sourceLearning.anchors.filter(row=>row.event_id===request.eventId);
    assert.equal(committed.length,1);
    await backupInstance(f.options);assert.ok(verifyInstanceBundle(f.options.output));
    const report=await restoreInstance({bundle:f.options.output,target:join(f.base,'committed-unsettled-rewarm'),now});
    assert.equal(report.invalidated.pendingRewarmIntents,1);
    const restoredIntent=tableRows(join(report.startup.dataDir,'accounts.sqlite')).feishu_rewarm_intents.find(row=>row.id===pending.id)!;
    assert.deepEqual(restoredIntent,{...pending,status:'conflict',error_code:'INSTANCE_RESTORED',settled_at:instant});
    assert.equal(restoredIntent.request_json,pending.request_json);
    const restoredLearningPath=join(report.startup.dataDir,'living-memory.sqlite');
    assert.deepEqual(tableRows(restoredLearningPath),sourceLearning);
    assert.deepEqual(tableRows(restoredLearningPath).anchors.filter(row=>row.event_id===request.eventId),committed);
    const restoredStore=new Store({dataDir:report.startup.dataDir,namespace:f.sources[0].source.namespace,now});
    try { assert.deepEqual(restoredStore.addReview(request),{status:'duplicate',eventId:request.eventId}); }
    finally { restoredStore.close(); }
    assert.deepEqual(tableRows(restoredLearningPath),sourceLearning);
    assert.deepEqual(tableRows(accountsPath),sourceAccounts);
    assert.deepEqual(tableRows(join(f.options.dataDir,'living-memory.sqlite')),sourceLearning);
  } finally { f.cleanup(); }
});

test('archives predating the optional rewarm table restore successfully and Accounts creates an empty journal on startup',async()=>{
  const f=await instanceFixture();
  try {
    edit(join(f.options.dataDir,'accounts.sqlite'),db=>db.exec('DROP TABLE feishu_rewarm_intents'));
    const sourceAccounts=tableRows(join(f.options.dataDir,'accounts.sqlite'));
    const sourceLearning=tableRows(join(f.options.dataDir,'living-memory.sqlite'));
    await backupInstance(f.options);assert.ok(verifyInstanceBundle(f.options.output));
    const report=await restoreInstance({bundle:f.options.output,target:join(f.base,'legacy-rewarm'),now});
    assert.equal(report.invalidated.pendingRewarmIntents,0);
    assert.equal(Object.hasOwn(tableRows(join(report.startup.dataDir,'accounts.sqlite')),'feishu_rewarm_intents'),false);
    const accounts=new Accounts({dataDir:report.startup.dataDir,now});
    try { assert.deepEqual(tableRows(join(report.startup.dataDir,'accounts.sqlite')).feishu_rewarm_intents,[]); }
    finally { accounts.close(); }
    assert.deepEqual(tableRows(join(f.options.dataDir,'accounts.sqlite')),sourceAccounts);
    assert.deepEqual(tableRows(join(f.options.dataDir,'living-memory.sqlite')),sourceLearning);
  } finally { f.cleanup(); }
});

const corruptions: [string,(db:DatabaseSync)=>void][]=[
  ['schema',db=>db.exec('ALTER TABLE feishu_rewarm_intents RENAME COLUMN request_json TO invalid_request_json')],
  ['request',db=>db.prepare('UPDATE feishu_rewarm_intents SET request_json=? WHERE id=?').run(JSON.stringify({kind:'observation',eventId:`feishu-rewarm:${'1'.repeat(32)}` }),'1'.repeat(32))],
  ['status',db=>{db.exec('PRAGMA ignore_check_constraints=ON');db.prepare('UPDATE feishu_rewarm_intents SET status=? WHERE id=?').run('unknown','1'.repeat(32));}],
  ['pending settlement metadata',db=>db.prepare('UPDATE feishu_rewarm_intents SET settled_at=? WHERE id=?').run(instant,'1'.repeat(32))],
];
for(const [name,corrupt] of corruptions) test(`optional rewarm journal with invalid ${name} is refused by verify and restore`,async()=>{
  const f=await instanceFixture();
  try {
    seed(f);await backupInstance(f.options);
    const sourceAccounts=tableRows(join(f.options.dataDir,'accounts.sqlite'));
    const sourceLearning=tableRows(join(f.options.dataDir,'living-memory.sqlite'));
    edit(join(f.options.output,'data/accounts.sqlite'),corrupt);refreshAccountsManifest(f.options.output);
    assert.throws(()=>verifyInstanceBundle(f.options.output),{code:'INSTANCE_DATABASE_INVALID'});
    const target=join(f.base,'invalid-rewarm-restore');
    await assert.rejects(restoreInstance({bundle:f.options.output,target,now}),{code:'INSTANCE_DATABASE_INVALID'});
    assert.equal(existsSync(target),false);
    assert.deepEqual(tableRows(join(f.options.dataDir,'accounts.sqlite')),sourceAccounts);
    assert.deepEqual(tableRows(join(f.options.dataDir,'living-memory.sqlite')),sourceLearning);
  } finally { f.cleanup(); }
});
