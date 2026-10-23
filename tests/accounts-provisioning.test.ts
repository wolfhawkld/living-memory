import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Accounts } from '../src/server/accounts.js';
import { StoreError } from '../src/server/store-error.js';
import { initializeAnswerClearingSchemaV3 } from '../src/server/answer-clearing-schema.js';
import { ensureLearningNamespaceV3 } from '../src/server/learning-namespace-v3.js';
import type { AccountUser } from '../src/shared/accounts.js';

const ownerPassword='synthetic-owner-provisioning-password';
const memberPassword='synthetic-member-provisioning-password';
const instant='2026-10-23T00:00:00.000Z';
async function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'lm-accounts-provisioning-'));
  const accounts=new Accounts({dataDir:dir,now:()=>new Date(instant)});
  const owner=await accounts.setup('owner',ownerPassword);
  const db=(accounts as unknown as {db:DatabaseSync}).db;
  return{dir,accounts,owner,db,close(){if(db.isTransaction)db.exec('ROLLBACK');accounts.close();rmSync(dir,{recursive:true,force:true});}};
}
function failed(error:unknown):boolean{
  assert.ok(error instanceof StoreError);assert.equal(error.code,'WRITE_FAILED');assert.equal(error.status,503);
  assert.doesNotMatch(error.message,/SYNTHETIC_PRIVATE_CALLBACK_ERROR|synthetic-member-provisioning-password/);return true;
}

test('account provisioning receives only a frozen public user inside its transaction before another connection can observe the new account',async()=>{
  const f=await fixture(),observer=new DatabaseSync(f.accounts.dbPath,{readOnly:true});
  try{
    let calls=0,seen:Readonly<AccountUser>|undefined;
    const member=await f.accounts.createUser(' New.Member ',memberPassword,user=>{
      calls++;seen=user;assert.equal(f.db.isTransaction,true);assert.equal(Object.isFrozen(user),true);
      assert.deepEqual(Object.keys(user).sort(),['accessRevision','enabled','id','role','username']);
      assert.equal(user.username,'new.member');assert.equal(user.role,'member');assert.equal(user.accessRevision,1);
      assert.equal(f.db.prepare('SELECT id FROM accounts WHERE id=?').get(user.id)!.id,user.id);
      assert.equal(observer.prepare('SELECT id FROM accounts WHERE id=?').get(user.id),undefined);
      assert.equal(observer.prepare('SELECT count(*) AS n FROM accounts').get()!.n,1);
      assert.doesNotMatch(JSON.stringify(user),/password|hash|salt|digest|synthetic-member-provisioning-password/);
      assert.throws(()=>{(user as {username:string}).username='changed';},TypeError);
    });
    assert.equal(calls,1);assert.deepEqual(member,seen);assert.equal(f.db.isTransaction,false);
    assert.equal(observer.prepare('SELECT username FROM accounts WHERE id=?').get(member.id)!.username,'new.member');
    assert.deepEqual(f.accounts.listUsers(),[f.owner,member].sort((a,b)=>a.id.localeCompare(b.id)));
  }finally{observer.close();f.close();}
});

test('a failed provisioning callback rolls back the new account while an existing owner and duplicate-name rules remain intact',async()=>{
  const f=await fixture();
  try{
    let calls=0;
    await assert.rejects(f.accounts.createUser('member',memberPassword,()=>{calls++;throw new Error('SYNTHETIC_PRIVATE_CALLBACK_ERROR');}),failed);
    assert.equal(calls,1);assert.equal(f.db.isTransaction,false);assert.equal(f.accounts.ownerId(),f.owner.id);assert.deepEqual(f.accounts.listUsers(),[f.owner]);
    const member=await f.accounts.createUser('member',memberPassword);
    await assert.rejects(f.accounts.createUser(' MEMBER ',memberPassword,()=>{calls++;}),{code:'ACCOUNT_EXISTS',status:409});
    assert.equal(calls,1,'duplicate usernames are rejected before the provisioning callback');
    assert.deepEqual(f.accounts.listUsers(),[f.owner,member].sort((a,b)=>a.id.localeCompare(b.id)));
  }finally{f.close();}
});

test('provisioning must synchronously return undefined and no other return value can commit an account',async()=>{
  const f=await fixture();
  try{
    let calls=0;
    for(const [index,value] of [null,0,{},Promise.resolve(undefined)].entries()){
      await assert.rejects(f.accounts.createUser(`member${index}`,memberPassword,()=>{calls++;return value;}),failed);
      assert.equal(f.db.isTransaction,false);assert.deepEqual(f.accounts.listUsers(),[f.owner]);
    }
    assert.equal(calls,4);
  }finally{f.close();}
});

test('failed nested account BEGIN leaves the caller transaction and its pending account changes owned by the caller',async()=>{
  const f=await fixture();
  try{
    f.db.exec('BEGIN IMMEDIATE');f.db.prepare('UPDATE accounts SET access_revision=7 WHERE id=?').run(f.owner.id);
    let calls=0;
    await assert.rejects(f.accounts.createUser('member',memberPassword,()=>{calls++;}),failed);
    assert.equal(calls,0);assert.equal(f.db.isTransaction,true);
    assert.equal(f.db.prepare('SELECT access_revision FROM accounts WHERE id=?').get(f.owner.id)!.access_revision,7);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM accounts').get()!.n,1);
    f.db.exec('ROLLBACK');assert.deepEqual(f.accounts.listUsers(),[f.owner]);
  }finally{f.close();}
});

test('a successful separate namespace preparation survives account COMMIT failure while the account and its uncommitted rows roll back',async()=>{
  const f=await fixture(),learningPath=join(f.dir,'learning.sqlite');
  const learning=new DatabaseSync(learningPath);
  try{
    learning.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');initializeAnswerClearingSchemaV3(learning,{recordedAt:instant});learning.exec('COMMIT');
    // A real deferred FK failure occurs at account COMMIT, after namespace provisioning has returned.
    f.db.exec(`CREATE TEMP TABLE provisioning_parent(id TEXT PRIMARY KEY);
      CREATE TEMP TABLE provisioning_child(id TEXT PRIMARY KEY,parent_id TEXT,
        FOREIGN KEY(parent_id) REFERENCES provisioning_parent(id) DEFERRABLE INITIALLY DEFERRED);`);
    let preparedNamespace='',callbackReturned=false;
    await assert.rejects(f.accounts.createUser('member',memberPassword,user=>{
      preparedNamespace=`member-${user.id}`;
      assert.deepEqual(ensureLearningNamespaceV3({dbPath:learningPath,namespace:preparedNamespace,now:()=>new Date(instant)}),
        {status:'created',namespace:preparedNamespace});
      assert.equal(learning.prepare('SELECT namespace FROM namespaces WHERE namespace=?').get(preparedNamespace)!.namespace,preparedNamespace);
      f.db.prepare('INSERT INTO provisioning_child(id,parent_id) VALUES (?,?)').run(user.id,'missing-parent');
      assert.equal(f.db.prepare('SELECT count(*) AS n FROM provisioning_child').get()!.n,1);
      callbackReturned=true;
    }),failed);
    assert.equal(callbackReturned,true);assert.equal(f.db.isTransaction,false);assert.deepEqual(f.accounts.listUsers(),[f.owner]);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM provisioning_child').get()!.n,0);
    assert.ok(preparedNamespace);assert.equal(learning.prepare('SELECT count(*) AS n FROM namespaces WHERE namespace=?').get(preparedNamespace)!.n,1);
    assert.equal(learning.prepare('SELECT count(*) AS n FROM config_history WHERE namespace=?').get(preparedNamespace)!.n,1);
    assert.deepEqual(ensureLearningNamespaceV3({dbPath:learningPath,namespace:preparedNamespace}),{status:'already-ready',namespace:preparedNamespace});
  }finally{if(learning.isTransaction)learning.exec('ROLLBACK');learning.close();f.close();}
});

test('the original two-argument createUser path remains compatible without requiring any provisioning callback',async()=>{
  const f=await fixture();
  try{
    const member=await f.accounts.createUser('member',memberPassword);
    assert.equal(member.username,'member');assert.equal(member.role,'member');assert.equal(member.enabled,true);assert.equal(member.accessRevision,1);
    assert.deepEqual(f.accounts.listUsers(),[f.owner,member].sort((a,b)=>a.id.localeCompare(b.id)));assert.equal(f.db.isTransaction,false);
  }finally{f.close();}
});
