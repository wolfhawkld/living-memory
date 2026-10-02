import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Accounts } from '../src/server/accounts.js';
import { StoreError } from '../src/server/store.js';
import type { FeishuCardDraftInput, FeishuCardNavAction, FeishuCardStored } from '../src/shared/feishu-cards.js';
const actor = { appId: 'app_synthetic', tenantKey: 'tenant_synthetic', openId: 'open_synthetic' };
const draft: FeishuCardDraftInput = { namespace: 'kg_synthetic', sourceFingerprint: 'a'.repeat(64), originChatId: 'private_chat',
  view: { kind: 'list', domainId: null, query: '', sort: 'elapsed', page: 1 }, actions: [{ id: 'a0', target: { kind: 'help' } }] };
async function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'lm-feishu-cards-'));
  let now = Date.parse('2026-10-02T00:00:00.000Z');
  const options = { dataDir, now: () => new Date(now) };
  const accounts = new Accounts(options);
  const user = await accounts.setup('owner', 'synthetic-card-test-password');
  const session = accounts.issueSession(user.id);
  function bind() {
    const issued = accounts.issueFeishuBindingRequest(user.id, session.sessionId, actor);
    accounts.confirmFeishuBinding({ ...actor, code: issued.command.split(' ')[1], eventId: 'bind_event', messageId: 'bind_message', chatId: 'private_chat' });
    return { userId: user.id, accessRevision: accounts.listUsers()[0]!.accessRevision, bindingId: accounts.getFeishuBindingState(user.id).binding!.id };
  }
  const auth = bind();
  return { accounts, user, session, auth, bind, options, advance(ms: number) { now += ms; }, cleanup() { try { accounts.close(); } catch { /* reopened */ } rmSync(dataDir, { recursive: true, force: true }); } };
}
function action(card: FeishuCardStored): FeishuCardNavAction { return { ...actor, cardId: card.id, actionId: 'a0', eventId: 'click_event', messageId: 'platform_message', chatId: 'private_chat' }; }
function expected(card: FeishuCardStored) { return { cardId: card.id, namespace: card.namespace, sourceFingerprint: card.sourceFingerprint }; }
function rows(accounts: Accounts, table = 'feishu_card_views') { const db = new DatabaseSync(accounts.dbPath); try { return db.prepare(`SELECT * FROM ${table}`).all(); } finally { db.close(); } }

test('draft activation and action claim persist across additive migration and restart without knowledge bodies', async () => {
  const f = await fixture();
  const learningPath = join(f.options.dataDir, 'synthetic-learning.json'); writeFileSync(learningPath, '{"anchors":[]}');
  f.accounts.close();
  const db = new DatabaseSync(join(f.options.dataDir, 'accounts.sqlite')); db.exec('DROP TABLE feishu_card_views'); db.close();
  let accounts = new Accounts(f.options);
  try {
    const card = accounts.createFeishuCardDraft(actor, f.auth, draft)!;
    assert.match(card.id, /^[a-f0-9]{32}$/);
    assert.equal(Date.parse(card.expiresAt) - Date.parse(card.createdAt), 30 * 60_000);
    assert.equal(accounts.isFeishuCardDraftAuthorized(card.id, actor, f.auth), true);
    assert.equal(accounts.getFeishuCardForAction(action(card)), null);
    assert.equal(accounts.activateFeishuCard(card.id, actor, f.auth, { messageId: 'platform_message', chatId: 'private_chat' }), true);
    accounts.close(); accounts = new Accounts(f.options);
    const claimed = accounts.claimFeishuCardAction(action(card), f.auth, expected(card))!;
    assert.deepEqual(claimed.target, { kind: 'help' });
    const operationId = createHash('sha256').update(JSON.stringify(['feishu-card-click-v1', card.id, 'a0'])).digest('hex').slice(0,32);
    assert.equal(claimed.operationId, operationId);
    accounts.close(); accounts = new Accounts(f.options);
    assert.equal(accounts.claimFeishuCardAction({ ...action(card), eventId: 'new_event' }, f.auth, expected(card)), null);
    assert.equal(rows(accounts, 'feishu_read_receipts')[0]!.operation_id, operationId);
    assert.equal(rows(accounts, 'feishu_read_receipts')[0]!.status, 'attempted');
    assert.equal(readFileSync(learningPath, 'utf8'), '{"anchors":[]}');
    assert.equal(Object.keys(rows(accounts)[0]!).some(key => /body|token|payload|outbox/.test(key)), false);
  } finally { accounts.close(); f.cleanup(); }
});

test('action lookup and claim reject changed actor, scope, chat, message, fingerprint and authorization generation', async () => {
  const f = await fixture();
  try {
    const card = f.accounts.createFeishuCardDraft(actor,f.auth,draft)!;
    f.accounts.activateFeishuCard(card.id,actor,f.auth,{ messageId: 'platform_message', chatId: 'private_chat' });
    for (const change of [{ openId: 'other' }, { appId: 'other' }, { tenantKey: 'other' }, { chatId: 'group_chat' }, { messageId: 'forwarded_message' }, { actionId: 'a15' }]) {
      assert.equal(f.accounts.getFeishuCardForAction({ ...action(card), ...change }), null);
      assert.equal(f.accounts.claimFeishuCardAction({ ...action(card), ...change },f.auth,expected(card)), null);
    }
    assert.equal(f.accounts.claimFeishuCardAction(action(card), { ...f.auth, userId: 'other' }, expected(card)), null);
    assert.equal(f.accounts.claimFeishuCardAction(action(card),f.auth,{ ...expected(card), sourceFingerprint: 'b'.repeat(64) }), null);
    assert.equal(f.accounts.claimFeishuCardAction(action(card),f.auth,{ ...expected(card), namespace: 'other' }), null);
    assert.equal(rows(f.accounts, 'feishu_read_receipts').length, 0);
    f.accounts.revokeFeishuBinding(f.user.id,f.session.sessionId,f.auth.bindingId);
    const nextAuth = f.bind();
    assert.equal(f.accounts.getFeishuCardForAction(action(card)), null);
    assert.equal(f.accounts.claimFeishuCardAction(action(card),nextAuth,expected(card)), null);
    assert.equal(f.accounts.createFeishuCardDraft(actor,f.auth,draft), null);
    const newCard = f.accounts.createFeishuCardDraft(actor,nextAuth,draft)!;
    await f.accounts.updateUser(f.user.id,{ password: 'changed-synthetic-card-password' });
    assert.equal(f.accounts.isFeishuCardDraftAuthorized(newCard.id,actor,nextAuth), false);
    assert.equal(f.accounts.activateFeishuCard(newCard.id,actor,nextAuth,{ messageId:'platform_message',chatId:'private_chat' }), false);
  } finally { f.cleanup(); }
});

test('activation requires accepted trusted chat IDs and consumes the preceding active card atomically', async () => {
  const f = await fixture();
  try {
    const first = f.accounts.createFeishuCardDraft(actor,f.auth,draft)!;
    for (const bad of [{ messageId: '', chatId: 'private_chat' }, { messageId:'platform_message', chatId:'' }, { messageId:'platform_message', chatId:'group' }]) {
      assert.equal(f.accounts.activateFeishuCard(first.id,actor,f.auth,bad),false);
    }
    assert.equal(f.accounts.activateFeishuCard(first.id,actor,f.auth,undefined as unknown as { messageId:string; chatId:string }),false);
    assert.equal(f.accounts.activateFeishuCard(first.id,actor,f.auth,{ messageId:'platform_message',chatId:'private_chat' }),true);
    f.accounts.discardFeishuCard(first.id,actor,f.auth);
    assert.equal(f.accounts.getFeishuCardForAction(action(first))?.id,first.id);
    const second = f.accounts.createFeishuCardDraft(actor,f.auth,draft)!;
    assert.equal(f.accounts.activateFeishuCard(second.id,actor,f.auth,{ messageId:'second_message',chatId:'private_chat' }),true);
    assert.equal(f.accounts.getFeishuCardForAction(action(first)),null);
    assert.equal(f.accounts.activateFeishuCard(first.id,actor,f.auth,{ messageId:'platform_message',chatId:'private_chat' }),false);
    const third = f.accounts.createFeishuCardDraft(actor,f.auth,draft)!;
    f.accounts.discardFeishuCard(third.id,{ ...actor,openId:'other' },f.auth);
    assert.equal(f.accounts.isFeishuCardDraftAuthorized(third.id,actor,f.auth),true);
    f.accounts.discardFeishuCard(third.id,actor,f.auth);
    assert.equal(f.accounts.isFeishuCardDraftAuthorized(third.id,actor,f.auth),false);
    f.advance(30 * 60_000);
    assert.equal(f.accounts.getFeishuCardForAction({ ...action(second), messageId:'second_message' }),null);
  } finally { f.cleanup(); }
});

test('draft storage is capped and expires metadata without deleting persistent read receipts', async () => {
  const f = await fixture();
  try {
    for (let i=0;i<32;i++) assert.ok(f.accounts.createFeishuCardDraft(actor,f.auth,draft));
    assert.equal(f.accounts.createFeishuCardDraft(actor,f.auth,draft),null);
    f.advance(30 * 60_000);
    const card = f.accounts.createFeishuCardDraft(actor,f.auth,draft)!;
    assert.equal(rows(f.accounts).length,1);
    f.accounts.activateFeishuCard(card.id,actor,f.auth,{ messageId:'platform_message',chatId:'private_chat' });
    assert.ok(f.accounts.claimFeishuCardAction(action(card),f.auth,expected(card)));
    assert.ok(f.accounts.createFeishuCardDraft(actor,f.auth,draft));
    assert.equal(rows(f.accounts).length,1);
    assert.equal(rows(f.accounts,'feishu_read_receipts').length,1);
  } finally { f.cleanup(); }
});

test('runtime views, action IDs and metadata budgets reject non-server navigation fields', async () => {
  const f = await fixture();
  try {
    const invalid = [
      { ...draft, namespace:'x'.repeat(257) }, { ...draft, sourceFingerprint:'A'.repeat(64) }, { ...draft, body:'secret' },
      { ...draft, view:{ kind:'help', body:'secret' } }, { ...draft, view:{ kind:'domains', page:100001 } },
      { ...draft, actions:[{ id:'a16',target:{ kind:'help' } }] }, { ...draft, actions:[...draft.actions,...draft.actions] },
      { ...draft, view:{ ...draft.view,query:'x'.repeat(121) } }, { ...draft, view:{ kind:'read',reference:'A'.repeat(12),page:1,revision:'a'.repeat(12),back:draft.view } },
      { ...draft, view:{ kind:'read',reference:'a'.repeat(12),page:1,revision:'a'.repeat(12),back:{ kind:'help' } } },
    ];
    for (const value of invalid) assert.equal(f.accounts.createFeishuCardDraft(actor,f.auth,value as FeishuCardDraftInput),null);
    const large = { ...draft,actions:Array.from({length:16},(_,i)=>({ id:`a${i}`,target:{ kind:'read',reference:'a'.repeat(64),page:1,revision:'a'.repeat(12),back:{kind:'list',domainId:'漢'.repeat(512),query:'漢'.repeat(120),sort:'elapsed',page:1} } })) };
    assert.equal(f.accounts.createFeishuCardDraft(actor,f.auth,large as FeishuCardDraftInput),null);
    assert.equal(rows(f.accounts).length,0);
  } finally { f.cleanup(); }
});

test('failed consumption rolls back both the click receipt and card state', async () => {
  const f = await fixture(); const db = new DatabaseSync(f.accounts.dbPath);
  try {
    const card=f.accounts.createFeishuCardDraft(actor,f.auth,draft)!;
    f.accounts.activateFeishuCard(card.id,actor,f.auth,{messageId:'platform_message',chatId:'private_chat'});
    db.exec(`CREATE TRIGGER synthetic_fail BEFORE UPDATE ON feishu_card_views WHEN NEW.status = 'consumed' BEGIN SELECT RAISE(ABORT,'raw-sensitive-error'); END`);
    assert.throws(()=>f.accounts.claimFeishuCardAction(action(card),f.auth,expected(card)),(error:unknown)=>error instanceof StoreError && error.code==='WRITE_FAILED' && !String(error).includes('raw-sensitive'));
    assert.equal(rows(f.accounts,'feishu_read_receipts').length,0);
    assert.ok(f.accounts.getFeishuCardForAction(action(card)));
    db.exec('DROP TRIGGER synthetic_fail');
    assert.ok(f.accounts.claimFeishuCardAction(action(card),f.auth,expected(card)));
  } finally { db.close(); f.cleanup(); }
});

test('two stores claim one active card once even when callback event IDs differ', async () => {
  const f = await fixture(); const second = new Accounts(f.options);
  try {
    const card=f.accounts.createFeishuCardDraft(actor,f.auth,draft)!;
    f.accounts.activateFeishuCard(card.id,actor,f.auth,{messageId:'platform_message',chatId:'private_chat'});
    const results=await Promise.all([
      Promise.resolve().then(()=>f.accounts.claimFeishuCardAction(action(card),f.auth,expected(card))),
      Promise.resolve().then(()=>second.claimFeishuCardAction({...action(card),eventId:'another_event'},f.auth,expected(card))),
    ]);
    assert.equal(results.filter(Boolean).length,1);
    assert.equal(rows(second,'feishu_read_receipts').length,1);
  } finally { second.close(); f.cleanup(); }
});
