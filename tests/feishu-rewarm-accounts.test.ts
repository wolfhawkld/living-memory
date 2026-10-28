import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Accounts } from '../src/server/accounts.js';
import { StoreError } from '../src/server/store.js';
import type { FeishuRewarmTarget } from '../src/shared/feishu-rewarm.js';

const actor = { appId:'synthetic-app',tenantKey:'synthetic-tenant',openId:'synthetic-open' };
const scope = { namespace:'synthetic-kg',sourceFingerprint:'a'.repeat(64),originChatId:'private-chat' };
async function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(),'lm-feishu-rewarm-'));
  let now = Date.parse('2026-10-28T00:00:00.000Z'); let count = 0;
  const options = { dataDir,now:()=>new Date(now) }; let accounts = new Accounts(options);
  const user = await accounts.setup('owner','synthetic-rewarm-password'); const browser = accounts.issueSession(user.id);
  function bind() {
    const issued = accounts.issueFeishuBindingRequest(user.id,browser.sessionId,actor);
    assert.equal(accounts.confirmFeishuBinding({ ...actor,code:issued.command.split(' ')[1],eventId:'bind-event',messageId:'bind-message',chatId:scope.originChatId }).status,'confirmed');
    return { userId:user.id,accessRevision:accounts.listUsers()[0]!.accessRevision,bindingId:accounts.getFeishuBindingState(user.id).binding!.id };
  }
  const auth = bind();
  function card(target: FeishuRewarmTarget = { kind:'rewarm-confirm',conceptId:'unknown-concept',sourceRevision:'revision-1' }) {
    const value = accounts.createFeishuCardDraft(actor,auth,{ ...scope,view:{ kind:'help' },actions:[{ id:'a0',target }] })!;
    assert.ok(value); assert.ok(accounts.activateFeishuCard(value.id,actor,auth,{ messageId:`card-${value.id}`,chatId:scope.originChatId }));
    return { kind:'card' as const,action:{ ...actor,cardId:value.id,actionId:'a0',eventId:'click',messageId:`card-${value.id}`,chatId:scope.originChatId } };
  }
  function message(kind:'status'|'retry'='status') {
    const n = ++count;
    return { kind:'message' as const,message:{ ...actor,eventId:`event-${n}`,messageId:`message-${n}`,chatId:scope.originChatId,text:'知识 重温' },command:{ kind } };
  }
  const claim = (trigger = card()) => accounts.claimFeishuRewarmTransition(actor,auth,trigger,scope)!;
  function sql(statement:string) { const db = new DatabaseSync(accounts.dbPath); try { return db.prepare(statement).all(); } finally { db.close(); } }
  function exec(statement:string) { const db = new DatabaseSync(accounts.dbPath); try { db.exec(statement); } finally { db.close(); } }
  return { get accounts(){return accounts;},auth,user,browser,bind,card,message,claim,sql,exec,
    advance(ms:number){now+=ms;},reopen(){accounts.close();accounts=new Accounts(options);},cleanup(){accounts.close();rmSync(dataDir,{ recursive:true,force:true });} };
}

test('confirmation freezes an independent review request, duplicate events and changed event IDs cannot reclaim a card',async()=>{
  const f=await fixture(); try {
    const trigger=f.card(); const first=f.claim(trigger); assert.equal(first.mayApply,true); const intent=first.intent!;
    assert.deepEqual(intent.request,{ eventId:`feishu-rewarm:${intent.id}`,conceptId:'unknown-concept',sourceRevision:'revision-1',kind:'review',occurredAt:'2026-10-28T00:00:00.000Z' });
    assert.equal(f.claim(trigger),null);
    assert.equal(f.claim({ ...trigger,action:{ ...trigger.action,eventId:'different-event' } }),null);
    assert.equal(f.sql('SELECT * FROM feishu_rewarm_intents').length,1);
    assert.equal(f.sql('SELECT * FROM feishu_review_sessions').length,0);
    assert.equal(f.sql('SELECT * FROM feishu_review_operations').length,0);
  } finally {f.cleanup();}
});

test('status never applies and a new confirmation preserves the original pending payload',async()=>{
  const f=await fixture(); try {
    const empty=f.accounts.claimFeishuRewarmTransition(actor,f.auth,f.message(),scope)!;
    assert.equal(empty.intent,null); assert.equal(empty.mayApply,false);
    const first=f.claim().intent!; f.advance(1000);
    const other=f.claim(f.card({ kind:'rewarm-confirm',conceptId:'different',sourceRevision:'revision-2' }));
    assert.deepEqual(other.intent,first); assert.equal(other.mayApply,false);
    const status=f.message(); const result=f.accounts.claimFeishuRewarmTransition(actor,f.auth,status,scope)!;
    assert.deepEqual(result.intent,first); assert.equal(result.mayApply,false);
    assert.equal(f.accounts.claimFeishuRewarmTransition(actor,f.auth,{ ...status,message:{ ...status.message,eventId:'changed' } },scope),null);
    assert.equal(f.sql('SELECT * FROM feishu_rewarm_intents').length,1);
  } finally {f.cleanup();}
});

test('SQL failures roll back receipt, card consumption and intent insertion atomically',async()=>{
  const f=await fixture(); try {
    const trigger=f.card(); const before=f.sql('SELECT * FROM feishu_read_receipts');
    f.exec("CREATE TRIGGER reject_rewarm BEFORE INSERT ON feishu_rewarm_intents BEGIN SELECT RAISE(ABORT,'private synthetic failure'); END");
    assert.throws(()=>f.claim(trigger),(error:unknown)=>error instanceof StoreError && error.code==='WRITE_FAILED' && !error.message.includes('private synthetic failure'));
    assert.deepEqual(f.sql('SELECT * FROM feishu_read_receipts'),before);
    assert.ok(f.accounts.getFeishuCardForAction(trigger.action));
    assert.equal(f.sql('SELECT * FROM feishu_rewarm_intents').length,0);
    f.exec('DROP TRIGGER reject_rewarm'); assert.equal(f.claim(trigger).mayApply,true);
  } finally {f.cleanup();}
});

test('pending survives restart and card cleanup, and explicit retry retains exact request after source changes',async()=>{
  const f=await fixture(); try {
    const first=f.claim().intent!; f.advance(31*60_000); f.reopen();
    f.card(); assert.equal(f.sql('SELECT * FROM feishu_card_views').length,1);
    const changed={ ...scope,sourceFingerprint:'b'.repeat(64) };
    assert.deepEqual(f.accounts.getFeishuRewarmIntent(actor,f.auth,changed),first);
    const retry=f.accounts.claimFeishuRewarmTransition(actor,f.auth,f.message('retry'),changed)!;
    assert.equal(retry.mayApply,true); assert.deepEqual(retry.intent,first);
    assert.equal(f.accounts.settleFeishuRewarmIntent(first.id,actor,f.auth,changed,{ status:'applied' })!.status,'applied');
    assert.equal(f.sql('SELECT * FROM feishu_rewarm_intents').length,1);
  } finally {f.cleanup();}
});

test('card claims validate owner, message, chat, namespace and current stored fingerprint without consuming failed claims',async()=>{
  const f=await fixture(); try {
    const trigger=f.card(); const before=f.sql('SELECT * FROM feishu_read_receipts');
    for(const delta of [{ openId:'other' },{ messageId:'forwarded' },{ chatId:'other-chat' }])
      assert.equal(f.claim({ ...trigger,action:{ ...trigger.action,...delta } }),null);
    for(const changed of [{ ...scope,namespace:'other' },{ ...scope,originChatId:'other-chat' },{ ...scope,sourceFingerprint:'b'.repeat(64) }])
      assert.equal(f.accounts.claimFeishuRewarmTransition(actor,f.auth,trigger,changed),null);
    assert.equal(f.accounts.claimFeishuRewarmTransition(actor,{ ...f.auth,userId:'other' },trigger,scope),null);
    assert.equal(f.accounts.claimFeishuRewarmTransition(actor,{ ...f.auth,accessRevision:f.auth.accessRevision+1 },trigger,scope),null);
    assert.deepEqual(f.sql('SELECT * FROM feishu_read_receipts'),before); assert.ok(f.accounts.getFeishuCardForAction(trigger.action));
  } finally {f.cleanup();}
});

test('retry targets require exact existing IDs and terminal outcomes cannot reopen or change',async()=>{
  const f=await fixture(); try {
    const first=f.claim().intent!;
    assert.equal(f.claim(f.card({ kind:'rewarm',intentId:'f'.repeat(32),verb:'retry' })),null);
    assert.equal(f.claim(f.card({ kind:'rewarm',intentId:first.id,verb:'show' })).mayApply,false);
    assert.equal(f.claim(f.card({ kind:'rewarm',intentId:first.id,verb:'retry' })).mayApply,true);
    assert.equal(f.accounts.settleFeishuRewarmIntent(first.id,actor,f.auth,scope,{ status:'conflict',errorCode:'private raw error' }),null);
    assert.equal(f.accounts.settleFeishuRewarmIntent(first.id,actor,f.auth,scope,{ status:'conflict',errorCode:'WRITE_FAILED' }),null);
    assert.deepEqual(f.accounts.getFeishuRewarmIntent(actor,f.auth,scope,first.id),first);
    assert.equal(f.accounts.claimFeishuRewarmTransition(actor,f.auth,f.message('retry'),scope)!.mayApply,true);
    const conflict=f.accounts.settleFeishuRewarmIntent(first.id,actor,f.auth,scope,{ status:'conflict',errorCode:'SOURCE_CHANGED' })!;
    assert.equal(conflict.status,'conflict');
    assert.deepEqual(f.accounts.settleFeishuRewarmIntent(first.id,actor,f.auth,scope,{ status:'conflict',errorCode:'SOURCE_CHANGED' }),conflict);
    assert.equal(f.accounts.settleFeishuRewarmIntent(first.id,actor,f.auth,scope,{ status:'applied' }),null);
    const retry=f.accounts.claimFeishuRewarmTransition(actor,f.auth,f.message('retry'),scope)!;
    assert.equal(retry.mayApply,false); assert.deepEqual(retry.intent,conflict);
    const next=f.claim().intent!; assert.notEqual(next.id,first.id);
    assert.equal(f.claim(f.card({ kind:'rewarm',intentId:first.id,verb:'retry' })).mayApply,false);
    assert.deepEqual(f.accounts.getFeishuRewarmIntent(actor,f.auth,scope),next);
  } finally {f.cleanup();}
});

test('read and settlement reject wrong scope, actor, access generation and revoked or rebound identities',async()=>{
  const f=await fixture(); try {
    const first=f.claim().intent!;
    for(const changed of [{ ...scope,namespace:'other' },{ ...scope,originChatId:'other-chat' }]) {
      assert.equal(f.accounts.getFeishuRewarmIntent(actor,f.auth,changed,first.id),null);
      assert.equal(f.accounts.settleFeishuRewarmIntent(first.id,actor,f.auth,changed,{ status:'applied' }),null);
    }
    for(const changed of [{ ...actor,appId:'other' },{ ...actor,tenantKey:'other' },{ ...actor,openId:'other' }])
      assert.equal(f.accounts.getFeishuRewarmIntent(changed,f.auth,scope,first.id),null);
    assert.equal(f.accounts.getFeishuRewarmIntent(actor,{ ...f.auth,accessRevision:f.auth.accessRevision+1 },scope,first.id),null);
    f.accounts.revokeFeishuBinding(f.user.id,f.browser.sessionId,f.auth.bindingId); const rebound=f.bind();
    for(const auth of [f.auth,rebound]) {
      assert.equal(f.accounts.getFeishuRewarmIntent(actor,auth,scope,first.id),null);
      assert.equal(f.accounts.settleFeishuRewarmIntent(first.id,actor,auth,scope,{ status:'applied' }),null);
    }
    assert.equal(f.sql("SELECT * FROM feishu_rewarm_intents WHERE status='pending'").length,1);
  } finally {f.cleanup();}
});

test('strict rewarm metadata rejects surplus or malformed targets before persistence',async()=>{
  const f=await fixture(); try {
    for(const target of [{ kind:'rewarm-confirm',conceptId:'',sourceRevision:'r' },{ kind:'rewarm-confirm',conceptId:'c',sourceRevision:'r',privateBody:'secret' },
      { kind:'rewarm',intentId:'invalid',verb:'retry' },{ kind:'rewarm',intentId:'a'.repeat(32),verb:'apply' }])
      assert.equal(f.accounts.createFeishuCardDraft(actor,f.auth,{ ...scope,view:{ kind:'help' },actions:[{ id:'a0',target:target as FeishuRewarmTarget }] }),null);
    assert.equal(f.sql('SELECT * FROM feishu_rewarm_intents').length,0);
  } finally {f.cleanup();}
});
