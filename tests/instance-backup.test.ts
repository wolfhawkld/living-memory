import assert from 'node:assert/strict';
import fs from 'node:fs';
import childProcess, { type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import { unlinkSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, copyFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { backupInstance, restoreInstance, verifyInstanceBundle, activateRestoredConnectors } from '../src/server/instance-backup.js';
import { acquireDataDirectoryLock } from '../src/server/data-directory-lock.js';
import { readInstanceId,isRestoreQuarantined } from '../src/server/instance-state.js';
import { resolveSourceIdentity } from '../src/server/source-identities.js';
import { loadKnowledgeGraph } from '../src/server/kg.js';
import { Accounts } from '../src/server/accounts.js';
import { Store } from '../src/server/store.js';
import { applyIdentityBindings } from '../src/server/identity-source.js';
import { parseFeishuConfig } from '../src/integrations/feishu-config.js';
import { digest,instanceFixture,instant,now,tableRows,treeHashes } from './helpers/instance-backup-fixture.js';

test('two-user full instance roundtrip preserves stable/raw identities, all learning tables, activity, files and account audits',async()=>{
  const f=await instanceFixture();
  try {
    const learningBefore=tableRows(join(f.options.dataDir,'living-memory.sqlite'));
    const accountsBefore=tableRows(join(f.options.dataDir,'accounts.sqlite'));
    const sourceBytes=treeHashes(f.options.kgRoot),memberBytes=treeHashes(f.sources[1].root);
    const dataBefore=treeHashes(f.options.dataDir);
    const manifest=await backupInstance(f.options);
    assert.equal(manifest.instanceId,'legacy');assert.equal(manifest.sources.length,2);
    assert.equal(manifest.browserState,'not-included');
    assert.ok(manifest.excluded.includes('data/unknown-private.bin'));
    assert.equal(existsSync(join(f.options.output,'data/unknown-private.bin')),false);
    assert.deepEqual(verifyInstanceBundle(f.options.output),JSON.parse(JSON.stringify(manifest)));
    assert.deepEqual(treeHashes(f.options.kgRoot),sourceBytes);assert.deepEqual(treeHashes(f.sources[1].root),memberBytes);
    assert.deepEqual(treeHashes(f.options.dataDir,new Set(['runtime-lease.sqlite'])),dataBefore);
    assert.equal(manifest.files.find(file=>file.path==='knowledge/owner/image.bin')?.sha256,digest(readFileSync(join(f.options.kgRoot,'image.bin'))));
    const target=join(f.base,'a-different-physical-root');
    const report=await restoreInstance({bundle:f.options.output,target,now});
    assert.notEqual(report.instanceId,'legacy');assert.match(report.instanceId,/^[a-f0-9-]{36}$/);
    assert.equal(readInstanceId(report.startup.dataDir),report.instanceId);
    assert.deepEqual(tableRows(join(report.startup.dataDir,'living-memory.sqlite')),learningBefore);
    for(const [index,source] of f.sources.entries()) {
      const root=index===0 ? report.startup.kgRoot:join(report.startup.dataDir,'users',f.member.id,'knowledge');
      const identity=resolveSourceIdentity(report.startup.dataDir,root);
      assert.equal(identity.identityHash,source.identity.identityHash);
      assert.notEqual(identity.sourceRootFingerprint,source.identity.sourceRootFingerprint);
      const restored=loadKnowledgeGraph({root,identityHash:identity.identityHash,displayName:identity.displayName});
      assert.equal(restored.namespace,source.source.namespace);
      assert.deepEqual(restored.index.concepts,source.source.index.concepts);
      assert.equal(identity.displayName,source.identity.displayName);
      const store=new Store({dataDir:report.startup.dataDir,namespace:restored.namespace,now});
      try {
        assert.equal(applyIdentityBindings(restored,store.getIdentityBindings()).index.concepts.find(concept=>concept.source.path==='Math/Alpha.md')?.id,source.stable.id);
        assert.deepEqual(store.getReviewPlan(),{revision:1,dailyBudget:0,concepts:{}});
        assert.equal(store.getRetentions()[0].active,true);
        assert.equal(store.activity.export().events[0].event.occurredAt,instant);
      } finally {store.close();}
      assert.deepEqual(treeHashes(root),index===0?sourceBytes:memberBytes);
    }
    const after=tableRows(join(report.startup.dataDir,'accounts.sqlite'));
    for(const table of ['accounts','meta','feishu_bindings']) assert.deepEqual(after[table],accountsBefore[table]);
    assert.equal(after.sessions.length,0);assert.equal(accountsBefore.sessions.length,2);
    assert.equal(after.feishu_binding_requests.length,2);
    assert.equal(after.feishu_binding_requests.find(row=>row.user_id===f.member.id)?.status,'invalidated');
    assert.equal(after.feishu_binding_requests.find(row=>row.user_id===f.owner.id)?.status,'confirmed');
    assert.equal(after.feishu_card_views.length,2);
    for(const card of after.feishu_card_views){assert.equal(card.status,'consumed');assert.equal(card.expires_at,instant);}
    const review=after.feishu_review_sessions[0];
    assert.equal(review.phase,'finished');assert.equal(JSON.parse(review.state_json).phase,'finished');
    assert.equal(review.version,f.review.version+1);
    const originalReview=accountsBefore.feishu_review_sessions[0];
    const restoredState=JSON.parse(review.state_json);
    assert.equal('version' in restoredState,false);
    assert.deepEqual(Object.keys(restoredState).sort(),Object.keys(JSON.parse(originalReview.state_json)).sort());
    assert.equal(restoredState.batch.items[restoredState.batch.cursor].disposition,'conflict');
    assert.deepEqual(restoredState.batch.items.slice(1),JSON.parse(originalReview.state_json).batch.items.slice(1));
    const restoredAccounts=new Accounts({dataDir:report.startup.dataDir,now});
    try {assert.equal(restoredAccounts.getFeishuReviewOperations(f.review.id,f.actor,f.auth).length,2);}
    finally {restoredAccounts.close();}
    const operations=after.feishu_review_operations;
    assert.equal(operations.length,2);
    for(const before of accountsBefore.feishu_review_operations){
      const current=operations.find(row=>row.id===before.id)!;
      if(before.status==='applied')assert.deepEqual(current,before);
      else {assert.equal(current.status,'conflict');assert.equal(current.error_code,'INSTANCE_RESTORED');assert.equal(current.intent_json,before.intent_json);}
    }
    assert.equal(after.feishu_read_receipts[0].status,'failed-or-unknown');
    assert.deepEqual(treeHashes(report.startup.cliStateDir),treeHashes(f.options.cliStateDir));
    assert.equal(readFileSync(join(target,'config/environment.env'),'utf8'),readFileSync(f.options.envFile,'utf8'));
    assert.equal(statSync(join(target,'config/environment.env')).mode&0o777,0o600);
    assert.equal(readFileSync(join(target,'config/cli-session-metadata.json'),'utf8').includes('synthetic-device-secret'),false);
    assert.equal(existsSync(join(report.startup.dataDir,'cli-session.json')),false);
    assert.equal(report.invalidated.sessions,2);assert.equal(report.invalidated.pendingReviewIntents,1);
    assert.deepEqual(treeHashes(f.options.kgRoot),sourceBytes);
    assert.deepEqual(tableRows(join(f.options.dataDir,'accounts.sqlite')),accountsBefore);
    assert.equal(isRestoreQuarantined(report.startup.dataDir),true);
    const connectorEnv=isRestoreQuarantined(report.startup.dataDir)?{LM_FEISHU_ENABLED:'0'}:{LM_FEISHU_ENABLED:'1'};
    assert.deepEqual(parseFeishuConfig(connectorEnv),{ok:true,value:{enabled:false}});
    await assert.rejects(activateRestoredConnectors(report.startup.dataDir,false),{code:'CONNECTOR_CONFIRMATION_REQUIRED'});
    assert.equal(isRestoreQuarantined(report.startup.dataDir),true);
    const lease=acquireDataDirectoryLock(report.startup.dataDir);
    try {await assert.rejects(activateRestoredConnectors(report.startup.dataDir,true,{procRoot:f.options.procRoot}),{code:'DATA_DIRECTORY_BUSY'});}
    finally {lease.release();}
    await activateRestoredConnectors(report.startup.dataDir,true,{procRoot:f.options.procRoot});
    assert.equal(isRestoreQuarantined(report.startup.dataDir),false);
    await assert.rejects(activateRestoredConnectors(report.startup.dataDir,true,{procRoot:f.options.procRoot}),{code:'RESTORE_QUARANTINE_NOT_PRESENT'});
  } finally {f.cleanup();}
});

test('bundle verification rejects tampering, unsafe paths, duplicate manifests and incomplete database/source mappings',async t=>{
  const f=await instanceFixture();
  try {
    const manifest=await backupInstance(f.options);
    const path=join(f.options.output,'manifest.json');
    const original=readFileSync(path);
    const cases:[string,(value:typeof manifest)=>void][]=[
      ['unknown format',value=>{value.format='unknown' as typeof value.format;}],
      ['unknown version',value=>{value.version=3 as 2;}],
      ['traversal',value=>{value.files[0].path='../outside';}],
      ['absolute path',value=>{value.files[0].path='/outside';}],
      ['duplicate file path',value=>{value.files.push({...value.files[0]});}],
      ['missing accounts DB metadata',value=>{value.databases=value.databases.filter(entry=>entry.path!=='data/accounts.sqlite');}],
      ['duplicate DB metadata',value=>{value.databases.push({...value.databases[0]});}],
      ['omitted member mapping',value=>{value.sources=value.sources.filter(source=>source.role==='owner');}],
      ['raw ID seed collision across distinct namespaces',value=>{
        value.sources[0].identityHash='a'.repeat(24)+'1'.repeat(40);value.sources[1].identityHash='a'.repeat(24)+'2'.repeat(40);
        for(const source of value.sources)source.namespace='kg_'+source.identityHash.slice(0,48);
      }],
      ['namespace collision across distinct full hashes',value=>{
        value.sources[0].identityHash='a'.repeat(48)+'1'.repeat(16);value.sources[1].identityHash='a'.repeat(48)+'2'.repeat(16);
        value.sources[0].namespace=value.sources[1].namespace='kg_'+'a'.repeat(48);
      }],
      ['duplicate source identity',value=>{value.sources[1].identityHash=value.sources[0].identityHash;value.sources[1].namespace=value.sources[0].namespace;}],
    ];
    for(const [name,mutate] of cases) await t.test(name,async()=>{
      const changed=JSON.parse(original.toString()) as typeof manifest;mutate(changed);
      writeFileSync(path,JSON.stringify(changed));
      try {
        assert.throws(()=>verifyInstanceBundle(f.options.output));
        const target=join(f.base,'invalid-manifest-target');
        await assert.rejects(restoreInstance({bundle:f.options.output,target,now}));
        assert.equal(existsSync(target),false);
      }
      finally {writeFileSync(path,original);}
    });
    await t.test('modified attachment bytes',()=>{
      const attachment=join(f.options.output,'knowledge/owner/image.bin'),bytes=readFileSync(attachment);
      writeFileSync(attachment,Buffer.from([9,9,9]));
      try {assert.throws(()=>verifyInstanceBundle(f.options.output),{code:'INSTANCE_HASH_MISMATCH'});}
      finally {writeFileSync(attachment,bytes);}
    });
    await t.test('attachment replaced with symlink',()=>{
      const attachment=join(f.options.output,'knowledge/owner/image.bin'),bytes=readFileSync(attachment);
      const external=join(f.base,'external.bin');writeFileSync(external,bytes);
      // A symlink with matching content/hash is still not a valid ordinary bundle file.
      unlinkSync(attachment);symlinkSync(external,attachment);
      try {assert.throws(()=>verifyInstanceBundle(f.options.output),{code:'UNSAFE_INSTANCE_FILE'});}
      finally {unlinkSync(attachment);writeFileSync(attachment,bytes,{mode:0o600});}
    });
  } finally {f.cleanup();}
});

test('backup and restore reject nonempty targets, source overlap and held runtime lease without modifying source',async()=>{
  const f=await instanceFixture();
  try {
    const sourceBefore=treeHashes(f.options.kgRoot),dataBefore=tableRows(join(f.options.dataDir,'living-memory.sqlite'));
    const held=acquireDataDirectoryLock(f.options.dataDir);
    try {await assert.rejects(backupInstance(f.options),{code:'DATA_DIRECTORY_BUSY'});}
    finally {held.release();}
    assert.equal(existsSync(f.options.output),false);
    await assert.rejects(backupInstance({...f.options,output:join(f.options.kgRoot,'backup')}),{code:'UNSAFE_INSTANCE_PATH'});
    const output=join(f.base,'occupied');mkdirSync(output);writeFileSync(join(output,'keep'),'unchanged');
    await assert.rejects(backupInstance({...f.options,output}),{code:'INSTANCE_TARGET_EXISTS'});
    assert.equal(readFileSync(join(output,'keep'),'utf8'),'unchanged');
    await backupInstance(f.options);
    await assert.rejects(restoreInstance({bundle:f.options.output,target:f.options.output,now}),{code:'UNSAFE_INSTANCE_PATH'});
    await assert.rejects(restoreInstance({bundle:f.options.output,target:output,now}),{code:'INSTANCE_TARGET_EXISTS'});
    // Existing source is never an implicit restore destination, even when unrelated to bundle root.
    await assert.rejects(restoreInstance({bundle:f.options.output,target:f.options.kgRoot,now}),{code:'INSTANCE_TARGET_EXISTS'});
    assert.deepEqual(treeHashes(f.options.kgRoot),sourceBefore);
    assert.deepEqual(tableRows(join(f.options.dataDir,'living-memory.sqlite')),dataBefore);
  } finally {f.cleanup();}
});

test('source symlink and concurrent source modification fail before bundle publication',async t=>{
  const f=await instanceFixture();
  try {
    const file=join(f.options.kgRoot,'Math/Alpha.md');
    symlinkSync(file,join(f.options.kgRoot,'linked.md'));
    await assert.rejects(backupInstance(f.options),{code:'UNSAFE_INSTANCE_FILE'});
    assert.equal(existsSync(f.options.output),false);
    unlinkSync(join(f.options.kgRoot,'linked.md'));
    const originalRead=fs.readFileSync;let reads=0;
    t.mock.method(fs,'readFileSync',(...args:Parameters<typeof fs.readFileSync>)=>{
      if(String(args[0])===file && ++reads===2)writeFileSync(file,originalRead(file,'utf8')+'\nconcurrent synthetic edit\n');
      return originalRead(...args);
    });
    syncBuiltinESMExports();
    t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
    await assert.rejects(backupInstance(f.options),{code:'INSTANCE_SOURCE_CHANGED'});
    assert.equal(reads,2);
    t.mock.restoreAll();syncBuiltinESMExports();
    const afterOwnEdit=treeHashes(f.options.kgRoot);
    assert.equal(existsSync(f.options.output),false);
    assert.deepEqual(treeHashes(f.options.kgRoot),afterOwnEdit);
  } finally {f.cleanup();}
});

test('UUID source instance gets a distinct restored UUID and private environment archive never restores device secret',async()=>{
  const f=await instanceFixture();
  try {
    const original='12345678-1234-4234-8234-123456789abc';
    writeFileSync(join(f.options.dataDir,'instance-identity.json'),JSON.stringify({format:'living-memory-instance-identity',version:1,instanceId:original}),{mode:0o600});
    const sourceBytes=digest(readFileSync(join(f.options.dataDir,'instance-identity.json')));
    const manifest=await backupInstance(f.options);
    assert.equal(manifest.instanceId,original);
    const report=await restoreInstance({bundle:f.options.output,target:join(f.base,'uuid-restored'),now});
    assert.notEqual(report.instanceId,original);
    assert.equal(digest(readFileSync(join(f.options.dataDir,'instance-identity.json'))),sourceBytes);
    assert.equal(isRestoreQuarantined(report.startup.dataDir),true);
    const archive=JSON.parse(readFileSync(join(f.options.output,'config/cli-session-metadata.json'),'utf8'));
    assert.deepEqual(archive,{version:1,credentialArchived:false});
    assert.equal(statSync(f.options.output).mode&0o777,0o700);
    for(const file of manifest.files)assert.equal(statSync(join(f.options.output,file.path)).mode&0o777,0o600);
  } finally {f.cleanup();}
});

test('never-initialized member keeps stable empty knowledge identity without backup creating its source directory',async()=>{
  const f=await instanceFixture();
  try {
    const accounts=new Accounts({dataDir:f.options.dataDir,now});
    let emptyMember;
    try {emptyMember=await accounts.createUser('uninitialized-member','synthetic-empty-member-password');}
    finally {accounts.close();}
    const originalFutureRoot=join(f.options.dataDir,'users',emptyMember.id,'knowledge');
    assert.equal(existsSync(originalFutureRoot),false);
    const sourceBytes=treeHashes(f.options.dataDir);
    const manifest=await backupInstance(f.options);
    assert.equal(existsSync(originalFutureRoot),false);
    assert.deepEqual(treeHashes(f.options.dataDir,new Set(['runtime-lease.sqlite'])),sourceBytes);
    const mapping=manifest.sources.find(source=>source.userId===emptyMember.id);
    assert.ok(mapping);
    assert.equal(mapping.identityHash,digest(originalFutureRoot));
    assert.equal(manifest.sources.length,3);
    const report=await restoreInstance({bundle:f.options.output,target:join(f.base,'empty-member-restored'),now});
    const restoredRoot=join(report.startup.dataDir,'users',emptyMember.id,'knowledge');
    assert.equal(existsSync(restoredRoot),true);
    assert.deepEqual(treeHashes(restoredRoot),{});
    assert.equal(resolveSourceIdentity(report.startup.dataDir,restoredRoot).identityHash,mapping.identityHash);
    const source=loadKnowledgeGraph({root:restoredRoot,identityHash:mapping.identityHash,displayName:mapping.displayName});
    assert.equal(source.namespace,mapping.namespace);assert.equal(source.index.concepts.length,0);
    const manifestPath=join(f.options.output,'manifest.json');
    writeFileSync(manifestPath,JSON.stringify({...manifest,sources:manifest.sources.filter(entry=>entry.userId!==emptyMember.id)}));
    assert.throws(()=>verifyInstanceBundle(f.options.output));
    const invalidTarget=join(f.base,'missing-empty-member-target');
    await assert.rejects(restoreInstance({bundle:f.options.output,target:invalidTarget,now}));
    assert.equal(existsSync(invalidTarget),false);
  } finally {f.cleanup();}
});

function syntheticProcess(procRoot:string, database?:string) {
  const pid=join(procRoot,'12345');mkdirSync(join(pid,'fd'),{recursive:true});
  const uid=process.getuid!();writeFileSync(join(pid,'status'),`Name:\tsynthetic\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`);
  if(database)symlinkSync(database,join(pid,'fd','3'));
  return pid;
}
function assertNoBackupStage(base:string,output:string) {
  assert.equal(existsSync(output),false);
  assert.deepEqual(readdirSync(base).filter(name=>name.startsWith('.bundle.lm-') && name.endsWith('.tmp')),[]);
}
function assertLeaseReleased(dataDir:string) {
  const lease=acquireDataDirectoryLock(dataDir);lease.release();
}

test('initial native scan rejects open or unknown processes before staging and releases the lease',async()=>{
  for(const kind of ['open','unknown'] as const){
    const f=await instanceFixture();
    try {
      const before=treeHashes(f.options.kgRoot);
      const pid=syntheticProcess(f.options.procRoot,kind==='open'?join(f.options.dataDir,'living-memory.sqlite'):undefined);
      if(kind==='unknown')unlinkSync(join(pid,'status'));
      await assert.rejects(backupInstance(f.options),{code:kind==='open'?'DATABASE_OPEN':'OFFLINE_CHECK_UNAVAILABLE'});
      assertNoBackupStage(f.base,f.options.output);assertLeaseReleased(f.options.dataDir);
      assert.deepEqual(treeHashes(f.options.kgRoot),before);
    } finally {f.cleanup();}
  }
});

test('final native scan detects a newly opened source database and never publishes the staged bundle',async()=>{
  const f=await instanceFixture();
  try {
    const before=treeHashes(f.options.kgRoot);
    let reached=false;
    await assert.rejects(backupInstance({...f.options,now:()=>{
      reached=true;syntheticProcess(f.options.procRoot,join(f.options.dataDir,'accounts.sqlite'));return now();
    }}),{code:'DATABASE_OPEN'});
    assert.equal(reached,true);assertNoBackupStage(f.base,f.options.output);assertLeaseReleased(f.options.dataDir);
    assert.deepEqual(treeHashes(f.options.kgRoot),before);
  } finally {f.cleanup();}
});

test('source main database inode replacement after copying is refused even when replacement bytes are identical',async()=>{
  const f=await instanceFixture();
  try {
    const path=join(f.options.dataDir,'living-memory.sqlite'),original=readFileSync(path),inode=statSync(path).ino;
    await assert.rejects(backupInstance({...f.options,now:()=>{
      const replacement=join(f.options.dataDir,'replacement.sqlite');copyFileSync(path,replacement);renameSync(replacement,path);return now();
    }}),{code:'INSTANCE_SOURCE_CHANGED'});
    assert.notEqual(statSync(path).ino,inode);assert.deepEqual(readFileSync(path),original);
    assertNoBackupStage(f.base,f.options.output);assertLeaseReleased(f.options.dataDir);
  } finally {f.cleanup();}
});

test('activation with an open or unknown process preserves quarantine bytes and releases its lease',async()=>{
  const f=await instanceFixture();
  try {
    await backupInstance(f.options);
    for (const version of [2,3] as const) {
      const restored=await restoreInstance({bundle:f.options.output,target:join(f.base,`restore-scan-${version}`),now,
        ...(version===3?{targetLearningSchemaVersion:3 as const}:{})});
      const path=join(restored.startup.dataDir,'restore-quarantine.json'),before=readFileSync(path);
      for(const kind of ['open','unknown'] as const){
        const pid=syntheticProcess(f.options.procRoot,kind==='open'?join(restored.startup.dataDir,'living-memory.sqlite'):undefined);
        if(kind==='unknown')unlinkSync(join(pid,'status'));
        await assert.rejects(activateRestoredConnectors(restored.startup.dataDir,true,{procRoot:f.options.procRoot,
          ...(version===3?{learningSchemaVersion:3 as const}:{})}),
          {code:kind==='open'?'DATABASE_OPEN':'OFFLINE_CHECK_UNAVAILABLE'});
        assert.deepEqual(readFileSync(path),before);assert.equal(isRestoreQuarantined(restored.startup.dataDir),true);
        assertLeaseReleased(restored.startup.dataDir);rmSync(pid,{recursive:true});
      }
    }
  } finally {f.cleanup();}
});

test('sudo helper close failure blocks publication and activation without masking an earlier scan error',async t=>{
  for(const phase of ['init','close','scan-and-close','activate-close'] as const){
    const f=await instanceFixture();
    try {
      let restored:string|undefined;
      if(phase==='activate-close'){
        await backupInstance(f.options);
        restored=(await restoreInstance({bundle:f.options.output,target:join(f.base,'sudo-activation'),now})).startup.dataDir;
      }
      const child=new EventEmitter() as ChildProcess,stdout=new PassThrough();
      let exited=false,scans=0;const messages:Record<string,unknown>[]=[];
      const exit=()=>{if(!exited){exited=true;child.emit('close',0,null);}};
      const stdin=new Writable({write(chunk,_encoding,done){
        const message=JSON.parse(String(chunk));messages.push(message);
        const scan=message.type==='scan'?++scans:0;
        const code=phase==='init'&&message.type==='init'?'AUTH_REQUIRED'
          :phase==='scan-and-close'&&scan===2?'DATABASE_OPEN'
          :message.type==='close'?'UNAVAILABLE':'OK';
        queueMicrotask(()=>stdout.write(JSON.stringify({version:1,nonce:message.nonce,sequence:message.sequence,code})+'\n'));
        done();
      },final(done){queueMicrotask(exit);done();}});
      Object.assign(child,{stdin,stdout,kill:()=>{exit();return true;}});
      let spawned=0;
      t.mock.method(childProcess,'spawn',(command:unknown)=>{assert.equal(command,'/usr/bin/sudo');spawned++;return child;});
      try {
        if(restored){
          const path=join(restored,'restore-quarantine.json'),before=readFileSync(path);
          await assert.rejects(activateRestoredConnectors(restored,true,{offlineCheck:'sudo'}),{code:'OFFLINE_SCAN_UNAVAILABLE'});
          assert.deepEqual(readFileSync(path),before);assert.equal(isRestoreQuarantined(restored),true);
        } else {
          const {procRoot:_unused,...options}=f.options;
          await assert.rejects(backupInstance({...options,offlineCheck:'sudo'}),
            {code:phase==='init'?'OFFLINE_SCAN_AUTH_REQUIRED':phase==='scan-and-close'?'DATABASE_OPEN':'OFFLINE_SCAN_UNAVAILABLE'});
          assertNoBackupStage(f.base,f.options.output);
        }
        assert.equal(spawned,1);assert.equal(exited,true);assert.equal(stdin.writableEnded,true);
        assert.equal(messages[0].type,'init');
        if(phase==='close'||phase==='activate-close')assert.deepEqual(messages.map(message=>message.type),['init','scan','scan','close']);
        assertLeaseReleased(restored??f.options.dataDir);
      } finally {t.mock.restoreAll();}
    } finally {f.cleanup();}
  }
});
