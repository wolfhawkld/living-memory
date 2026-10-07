import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Accounts } from '../src/server/accounts.js';
import { StoreError } from '../src/server/store.js';
import type { FeishuCardStored, FeishuCardNavAction } from '../src/shared/feishu-cards.js';
import type { FeishuReviewSession, FeishuReviewState, FeishuReviewMutation, FeishuReviewWriteIntent } from '../src/shared/feishu-review.js';

const actor = { appId: 'app_synthetic', tenantKey: 'tenant_synthetic', openId: 'open_synthetic' };
const scope = { namespace: 'synthetic-kg', sourceFingerprint: 'a'.repeat(64), originChatId: 'private-chat' };
const id = 'a'.repeat(32);
const front: FeishuReviewState = { domainId: 'Math', conceptId: 'concept-alpha', sourceRevision: 'revision-1', phase: 'front', paused: false, page: 1, frozen: null };
const frozen = { observedAt: '2026-10-07T00:00:00.000Z', configRevision: 1, halfLifeDays: 7, anchorEventId: null };
async function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'lm-feishu-review-accounts-'));
  let now = Date.parse(frozen.observedAt); let counter = 0;
  const options = { dataDir, now: () => new Date(now) };
  let accounts = new Accounts(options);
  const user = await accounts.setup('owner', 'synthetic-review-test-password');
  const browser = accounts.issueSession(user.id);
  function bind() {
    const issued = accounts.issueFeishuBindingRequest(user.id, browser.sessionId, actor);
    assert.equal(accounts.confirmFeishuBinding({ ...actor, code: issued.command.split(' ')[1], eventId: 'bind-event', messageId: 'bind-message', chatId: scope.originChatId }).status, 'confirmed');
    return { userId: user.id, accessRevision: accounts.listUsers()[0]!.accessRevision, bindingId: accounts.getFeishuBindingState(user.id).binding!.id };
  }
  const auth = bind();
  const message = (messageId = `message-${++counter}`) => ({ kind: 'message' as const,
    message: { ...actor, messageId, eventId: `event-${counter}`, chatId: scope.originChatId, text: '知识 复习' } });
  const transition = (mutation: FeishuReviewMutation | null, messageId?: string) => accounts.claimFeishuReviewTransition(actor, auth, message(messageId), scope, () => mutation);
  const create = () => transition({ kind: 'create', id, state: { ...front } })!.session!;
  const update = (state: FeishuReviewState, intent?: FeishuReviewWriteIntent) => transition({ kind: 'update', state, ...(intent ? { intent } : {}) });
  const reveal = (session = create()) => update({ ...session.state, phase: 'revealed', frozen: { ...frozen } })!.session!;
  function card(session: FeishuReviewSession, verb: 'reveal' | 'show' = 'show') {
    const value = accounts.createFeishuCardDraft(actor,auth,{ ...scope, view: { kind: 'review', sessionId: session.id, version: session.version, verb, page: 1 },
      actions: [{ id: 'a0', target: { kind: 'review', sessionId: session.id, version: session.version, verb, page: 1 } }] })!;
    assert.ok(value);
    accounts.activateFeishuCard(value.id,actor,auth,{ messageId: `card-message-${value.id}`, chatId: scope.originChatId });
    return value;
  }
  const action = (card: FeishuCardStored): FeishuCardNavAction => ({ ...actor, cardId: card.id, actionId: 'a0', eventId: 'click', messageId: `card-message-${card.id}`, chatId: scope.originChatId });
  return { get accounts() { return accounts; }, auth, user, browser, options, bind, message, transition, create, update, reveal, card, action,
    advance(ms: number) { now += ms; }, reopen(closed = false) { if (!closed) accounts.close(); accounts = new Accounts(options); },
    cleanup() { accounts.close(); rmSync(dataDir, { recursive: true, force: true }); } };
}
function observation(session: FeishuReviewSession): FeishuReviewWriteIntent {
  return { kind: 'observation', request: { eventId: `feishu-observation:${session.id}`, conceptId: session.state.conceptId,
    sourceRevision: session.state.sourceRevision, observedAt: session.state.frozen!.observedAt,
    configRevision: session.state.frozen!.configRevision, anchorEventId: session.state.frozen!.anchorEventId,
    answer: '', evidenceMode: 'mental', rating: 'clear', exposure: 'unknown', observedExposure: false,
    learning: { task: 'concept', cue: 'unknown', outcome: 'unverified', basis: 'self-check', confidence: null, confidenceAt: null } } };
}
function query(f: Awaited<ReturnType<typeof fixture>>, sql: string) {
  const db = new DatabaseSync(f.accounts.dbPath); try { return db.prepare(sql).all(); } finally { db.close(); }
}

test('additive review tables persist on reopening and 24h sessions are independent of card cleanup', async () => {
  const f = await fixture();
  try {
    const session = f.create();
    assert.equal(Date.parse(session.expiresAt) - Date.parse(session.createdAt), 24 * 60 * 60_000);
    f.card(session);
    f.advance(31 * 60_000); f.reopen();
    assert.deepEqual(f.accounts.getFeishuReviewSession(actor,f.auth,scope.namespace),session);
    assert.ok(f.card(session)); // expired old card is purged, session remains.
    assert.equal(query(f,'SELECT * FROM feishu_card_views').length,1);
    f.advance(24 * 60 * 60_000);
    assert.equal(f.update({ ...session.state, phase: 'revealed', frozen }),null);
    const paused = f.update({ ...session.state, paused: true })!.session!;
    assert.equal(f.accounts.isFeishuReviewVersionAuthorized(id,paused.version,actor,f.auth),true);
    const done = f.update({ ...paused.state, phase: 'finished' })!.session!;
    assert.equal(done.state.phase,'finished');
    assert.equal(f.accounts.getFeishuReviewSession(actor,f.auth,scope.namespace),null);
    assert.ok(f.transition({ kind: 'create', id: 'b'.repeat(32), state: { ...front } }));
    assert.equal(query(f,'SELECT * FROM feishu_review_sessions').length,2);
  } finally { f.cleanup(); }
});

test('full actor, namespace and binding generations reject wrong identity and ABA without receipts', async () => {
  const f = await fixture();
  try {
    const session = f.reveal(); const intent = observation(session); f.update(session.state,intent);
    const before = query(f,'SELECT * FROM feishu_read_receipts').length;
    for (const changed of [{ ...actor, openId: 'other' }, { ...actor, tenantKey: 'other' }, { ...actor, appId: 'other' }]) {
      assert.equal(f.accounts.getFeishuReviewSession(changed,f.auth,scope.namespace),null);
      assert.deepEqual(f.accounts.getFeishuReviewOperations(id,changed,f.auth),[]);
      assert.equal(f.accounts.isFeishuReviewVersionAuthorized(id,3,changed,f.auth),false);
      assert.equal(f.accounts.claimFeishuReviewTransition(changed,f.auth,f.message(),scope,() => ({ kind: 'none' })),null);
    }
    assert.equal(f.accounts.getFeishuReviewSession(actor,{ ...f.auth,userId:'other' },scope.namespace),null);
    assert.equal(f.accounts.getFeishuReviewSession(actor,f.auth,'another-namespace'),null);
    f.accounts.revokeFeishuBinding(f.user.id,f.browser.sessionId,f.auth.bindingId);
    const nextAuth = f.bind();
    assert.equal(f.accounts.getFeishuReviewSession(actor,nextAuth,scope.namespace),null);
    assert.deepEqual(f.accounts.getFeishuReviewOperations(id,actor,nextAuth),[]);
    assert.equal(f.accounts.settleFeishuReviewOperation(intent.request.eventId,actor,nextAuth,{ status:'applied' }),null);
    assert.equal(query(f,'SELECT * FROM feishu_read_receipts').length,before);
  } finally { f.cleanup(); }
});

test('card claim is atomic, rejects forwarding and old versions, and never accepts async reducers', async () => {
  const f = await fixture();
  try {
    const session = f.create(); const card = f.card(session,'reveal'); const action = f.action(card);
    const trigger = { kind: 'card' as const, action };
    const before = query(f,'SELECT * FROM feishu_read_receipts').length;
    for (const changed of [{ chatId:'group' },{ messageId:'forwarded' },{ openId:'other' }]) {
      assert.equal(f.accounts.claimFeishuReviewTransition(actor,f.auth,{ kind:'card',action:{ ...action,...changed } },scope,()=>({ kind:'none' })),null);
    }
    assert.throws(()=>f.accounts.claimFeishuReviewTransition(actor,f.auth,trigger,scope,()=>{ throw new Error('private reducer text'); }),
      (e: unknown)=> e instanceof StoreError && e.code === 'WRITE_FAILED' && !e.message.includes('private reducer text'));
    assert.equal(f.accounts.claimFeishuReviewTransition(actor,f.auth,trigger,scope,
      (async()=>({ kind:'none' })) as unknown as ()=>FeishuReviewMutation),null);
    assert.equal(query(f,'SELECT * FROM feishu_read_receipts').length,before);
    assert.ok(f.accounts.getFeishuCardForAction(action));
    const result = f.accounts.claimFeishuReviewTransition(actor,f.auth,trigger,scope,context=>{
      assert.equal(context.target?.kind,'review');
      return { kind:'update',state:{ ...context.session!.state,phase:'revealed',frozen } };
    })!;
    assert.equal(result.session!.version,2);
    assert.equal(f.accounts.getFeishuCardForAction(action),null);
    assert.equal(f.accounts.claimFeishuReviewTransition(actor,f.auth,trigger,scope,()=>({ kind:'none' })),null);
    const oldCard = f.card(session);
    assert.equal(f.accounts.claimFeishuReviewTransition(actor,f.auth,{ kind:'card',action:f.action(oldCard) },scope,()=>({ kind:'none' })),null);
    assert.ok(f.accounts.getFeishuCardForAction(f.action(oldCard))); // failed claim does not consume.
  } finally { f.cleanup(); }
});

test('frozen evidence and concept identity are immutable and phase transitions are constrained', async () => {
  const f = await fixture();
  try {
    const session = f.create();
    assert.equal(f.update({ ...session.state,phase:'saved' }),null);
    assert.equal(f.update({ ...session.state,frozen }),null);
    const paused = f.update({ ...session.state,paused:true })!.session!;
    assert.equal(f.update({ ...paused.state,paused:false,phase:'revealed',frozen }),null);
    const resumed = f.update({ ...paused.state,paused:false })!.session!;
    const revealed = f.reveal(resumed);
    for (const change of [{ conceptId:'other' },{ domainId:'Other' },{ sourceRevision:'other' },{ phase:'front' as const },{ frozen:null },
      { frozen:{ ...frozen,halfLifeDays:14 } },{ frozen:{ ...frozen,anchorEventId:'other' } },{ frozen:{ ...frozen,configRevision:2 } },
      { frozen:{ ...frozen,observedAt:'2026-10-07T00:00:01.000Z' } }]) {
      assert.equal(f.update({ ...revealed.state,...change }),null);
    }
    assert.deepEqual(f.accounts.getFeishuReviewSession(actor,f.auth,scope.namespace),revealed);
    assert.equal(f.accounts.isFeishuReviewVersionAuthorized(id,1,actor,f.auth),false);
  } finally { f.cleanup(); }
});

test('mental intents have fixed IDs and payloads, pending finish is blocked, settlement is idempotent', async () => {
  const f = await fixture();
  try {
    const session = f.reveal(); const intent = observation(session);
    for (const change of [{ eventId:'wrong' },{ answer:'text' },{ evidenceMode:'written' },{ exposure:'unexposed' },{ observedExposure:true },
      { configRevision:2 },{ anchorEventId:'other' },{ observedAt:'2026-10-07T00:00:01.000Z' },{ sourceRevision:'other' },
      { learning:{ task:'concept',cue:'independent',outcome:'success',basis:'self-check',confidence:null,confidenceAt:null } },{ privateBody:'secret' }]) {
      assert.equal(f.update(session.state,{ ...intent,request:{ ...intent.request,...change } } as FeishuReviewWriteIntent),null);
    }
    const pending = f.update(session.state,intent)!.session!;
    assert.equal(f.update({ ...pending.state,phase:'finished' }),null);
    assert.equal(f.update(pending.state,{ ...intent,request:{ ...intent.request,rating:'blank' } } as FeishuReviewWriteIntent),null);
    const unchanged = f.update(pending.state,intent)!.session!;
    assert.equal(f.accounts.getFeishuReviewOperations(id,actor,f.auth).length,1);
    f.reopen();
    assert.deepEqual(f.accounts.getFeishuReviewOperations(id,actor,f.auth)[0]!.intent,intent);
    const saved = f.accounts.settleFeishuReviewOperation(intent.request.eventId,actor,f.auth,{ status:'applied' })!;
    assert.equal(saved.state.phase,'saved'); assert.equal(saved.version,unchanged.version+1);
    assert.deepEqual(f.accounts.settleFeishuReviewOperation(intent.request.eventId,actor,f.auth,{ status:'applied' }),saved);
    assert.equal(f.accounts.settleFeishuReviewOperation(intent.request.eventId,actor,f.auth,{ status:'conflict',errorCode:'EVENT_CONFLICT' }),null);
    assert.equal(f.update(saved.state,intent),null);
    const review: FeishuReviewWriteIntent = { kind:'review',request:{ eventId:`feishu-review:${id}`,conceptId:front.conceptId,
      sourceRevision:front.sourceRevision,kind:'review',occurredAt:frozen.observedAt } };
    const reviewPending = f.update(saved.state,review)!.session!;
    assert.equal(f.update({ ...reviewPending.state,phase:'finished' }),null);
    const paused = f.update({ ...reviewPending.state,paused:true })!.session!;
    const final = f.accounts.settleFeishuReviewOperation(review.request.eventId,actor,f.auth,{ status:'applied' })!;
    assert.equal(final.state.phase,'saved'); assert.equal(final.state.paused,paused.state.paused);
    assert.equal(f.accounts.getFeishuReviewOperations(id,actor,f.auth).length,2);
    assert.ok(f.update({ ...final.state,phase:'finished' }));
    assert.equal(f.accounts.getFeishuReviewOperations(id,actor,f.auth).length,2);
  } finally { f.cleanup(); }
});

test('conflicts preserve journal, reject raw error codes and permit ending after pending resolves', async () => {
  const f = await fixture();
  try {
    const session = f.reveal(); const intent = observation(session); f.update(session.state,intent);
    assert.equal(f.accounts.settleFeishuReviewOperation(intent.request.eventId,actor,f.auth,{ status:'conflict',errorCode:'raw private secret' }),null);
    assert.equal(f.accounts.settleFeishuReviewOperation(intent.request.eventId,{ ...actor,openId:'other' },f.auth,{ status:'applied' }),null);
    const conflict = f.accounts.settleFeishuReviewOperation(intent.request.eventId,actor,f.auth,{ status:'conflict',errorCode:'ANCHOR_CONFLICT' })!;
    assert.equal(conflict.state.phase,'revealed');
    assert.equal(f.accounts.getFeishuReviewOperations(id,actor,f.auth)[0]!.status,'conflict');
    assert.ok(f.update({ ...conflict.state,phase:'finished' }));
    f.reopen();
    assert.equal(f.accounts.getFeishuReviewOperations(id,actor,f.auth)[0]!.errorCode,'ANCHOR_CONFLICT');
  } finally { f.cleanup(); }
});

test('SQL failure rolls back card consumption, receipt, state version and immutable intent together', async () => {
  const f = await fixture();
  try {
    const session = f.reveal(); const card = f.card(session); const action = f.action(card);
    const before = query(f,'SELECT * FROM feishu_read_receipts').length;
    const db = new DatabaseSync(f.accounts.dbPath);
    db.exec("CREATE TRIGGER reject_review_intent BEFORE INSERT ON feishu_review_operations BEGIN SELECT RAISE(ABORT,'synthetic test rollback'); END"); db.close();
    assert.throws(()=>f.accounts.claimFeishuReviewTransition(actor,f.auth,{ kind:'card',action },scope,
      ()=>({ kind:'update',state:session.state,intent:observation(session) })),(e:unknown)=>e instanceof StoreError && e.code === 'WRITE_FAILED');
    assert.ok(f.accounts.getFeishuCardForAction(action));
    assert.equal(query(f,'SELECT * FROM feishu_read_receipts').length,before);
    assert.deepEqual(f.accounts.getFeishuReviewSession(actor,f.auth,scope.namespace),session);
    assert.deepEqual(f.accounts.getFeishuReviewOperations(id,actor,f.auth),[]);
  } finally { f.cleanup(); }
});


test('opening older Accounts adds review tables without rewriting cards, bindings or receipts', async () => {
  const f = await fixture();
  try {
    const draft = f.accounts.createFeishuCardDraft(actor,f.auth,{ ...scope,view:{ kind:'help' },actions:[] })!;
    const oldCards = query(f,'SELECT * FROM feishu_card_views');
    const bindings = query(f,'SELECT * FROM feishu_bindings');
    f.accounts.claimFeishuRead('c'.repeat(32),actor,f.auth);
    const receipts = query(f,'SELECT * FROM feishu_read_receipts');
    f.accounts.close();
    const db = new DatabaseSync(f.accounts.dbPath);
    db.exec('DROP TABLE feishu_review_operations; DROP TABLE feishu_review_sessions'); db.close();
    f.reopen(true);
    assert.deepEqual(query(f,'SELECT * FROM feishu_card_views'),oldCards);
    assert.deepEqual(query(f,'SELECT * FROM feishu_bindings'),bindings);
    assert.deepEqual(query(f,'SELECT * FROM feishu_read_receipts'),receipts);
    assert.ok(f.accounts.isFeishuCardDraftAuthorized(draft.id,actor,f.auth));
    assert.equal(query(f,'SELECT * FROM feishu_review_sessions').length,0);
    assert.equal(query(f,'SELECT * FROM feishu_review_operations').length,0);
    assert.ok(f.create());
  } finally { f.cleanup(); }
});

test('strict metadata rejects malformed states, review targets and oversized journals before claim', async () => {
  const f = await fixture();
  try {
    const before = query(f,'SELECT * FROM feishu_read_receipts').length;
    for (const change of [{ page:0 },{ phase:'bogus' },{ paused:'false' },{ frozen },{ domainId:'x'.repeat(513) },
      { conceptId:'' },{ rawBody:'secret' },{ sourceRevision:'x'.repeat(257) }]) {
      assert.equal(f.transition({ kind:'create',id,state:{ ...front,...change } } as FeishuReviewMutation),null);
    }
    assert.equal(query(f,'SELECT * FROM feishu_read_receipts').length,before);
    assert.equal(f.accounts.createFeishuCardDraft(actor,f.auth,{ ...scope,view:{ kind:'review',sessionId:id,version:0,verb:'show',page:1 },actions:[] }),null);
    assert.ok(f.create());
    assert.equal(f.transition({ kind:'create',id:'b'.repeat(32),state:{ ...front } }),null);
    const current = f.accounts.getFeishuReviewSession(actor,f.auth,scope.namespace)!;
    assert.equal(f.accounts.claimFeishuReviewTransition(actor,f.auth,{ kind:'message',message:{ ...f.message().message,chatId:'other-private-chat' } },
      { ...scope,originChatId:'other-private-chat' },()=>({ kind:'update',state:current.state })),null);
    assert.deepEqual(f.accounts.getFeishuReviewSession(actor,f.auth,scope.namespace),current);
  } finally { f.cleanup(); }
});

test('changed source rejects reveal and first intents atomically while allowing pause, touch, finish and settlement', async () => {
  const f = await fixture();
  try {
    const changed = { ...scope,sourceFingerprint:'b'.repeat(64) };
    const session = f.create();
    const beforeReveal = query(f,'SELECT * FROM feishu_read_receipts').length;
    const changedCard = f.accounts.createFeishuCardDraft(actor,f.auth,{ ...changed,
      view:{ kind:'review',sessionId:id,version:session.version,verb:'reveal',page:1 },
      actions:[{ id:'a0',target:{ kind:'review',sessionId:id,version:session.version,verb:'reveal',page:1 } }] })!;
    f.accounts.activateFeishuCard(changedCard.id,actor,f.auth,{ messageId:`card-message-${changedCard.id}`,chatId:scope.originChatId });
    const action = f.action(changedCard);
    assert.equal(f.accounts.claimFeishuReviewTransition(actor,f.auth,{ kind:'card',action },changed,
      ()=>({ kind:'update',state:{ ...session.state,phase:'revealed',frozen } })),null);
    assert.equal(query(f,'SELECT * FROM feishu_read_receipts').length,beforeReveal);
    assert.ok(f.accounts.getFeishuCardForAction(action));
    assert.deepEqual(f.accounts.getFeishuReviewSession(actor,f.auth,scope.namespace),session);
    const revealed = f.reveal(session);
    const beforeIntent = query(f,'SELECT * FROM feishu_read_receipts').length;
    const intent = observation(revealed);
    assert.equal(f.accounts.claimFeishuReviewTransition(actor,f.auth,f.message(),changed,
      ()=>({ kind:'update',state:revealed.state,intent })),null);
    assert.equal(query(f,'SELECT * FROM feishu_read_receipts').length,beforeIntent);
    assert.deepEqual(f.accounts.getFeishuReviewOperations(id,actor,f.auth),[]);
    assert.deepEqual(f.accounts.getFeishuReviewSession(actor,f.auth,scope.namespace),revealed);
    const intentCard = f.accounts.createFeishuCardDraft(actor,f.auth,{ ...changed,
      view:{ kind:'review',sessionId:id,version:revealed.version,verb:'rate-clear',page:1 },
      actions:[{ id:'a0',target:{ kind:'review',sessionId:id,version:revealed.version,verb:'rate-clear',page:1 } }] })!;
    f.accounts.activateFeishuCard(intentCard.id,actor,f.auth,{ messageId:`card-message-${intentCard.id}`,chatId:scope.originChatId });
    const intentAction = f.action(intentCard);
    assert.equal(f.accounts.claimFeishuReviewTransition(actor,f.auth,{ kind:'card',action:intentAction },changed,
      ()=>({ kind:'update',state:revealed.state,intent })),null);
    assert.ok(f.accounts.getFeishuCardForAction(intentAction));
    assert.equal(query(f,'SELECT * FROM feishu_read_receipts').length,beforeIntent);
    assert.deepEqual(f.accounts.getFeishuReviewOperations(id,actor,f.auth),[]);
    f.update(revealed.state,intent);
    const paused = f.accounts.claimFeishuReviewTransition(actor,f.auth,f.message(),changed,
      input=>({ kind:'update',state:{ ...input.session!.state,paused:true } }))!.session!;
    assert.equal(paused.state.paused,true);
    const touched = f.accounts.claimFeishuReviewTransition(actor,f.auth,f.message(),changed,
      input=>({ kind:'update',state:input.session!.state }))!.session!;
    assert.equal(touched.version,paused.version+1);
    const saved = f.accounts.settleFeishuReviewOperation(intent.request.eventId,actor,f.auth,{ status:'applied' })!;
    assert.equal(saved.state.phase,'saved');
    const review: FeishuReviewWriteIntent = { kind:'review',request:{ eventId:`feishu-review:${id}`,conceptId:front.conceptId,
      sourceRevision:front.sourceRevision,kind:'review',occurredAt:frozen.observedAt } };
    const resumed = f.update({ ...saved.state,paused:false })!.session!;
    const beforeReview = query(f,'SELECT * FROM feishu_read_receipts').length;
    assert.equal(f.accounts.claimFeishuReviewTransition(actor,f.auth,f.message(),changed,
      ()=>({ kind:'update',state:resumed.state,intent:review })),null);
    assert.equal(query(f,'SELECT * FROM feishu_read_receipts').length,beforeReview);
    assert.equal(f.accounts.getFeishuReviewOperations(id,actor,f.auth).length,1);
    const done = f.accounts.claimFeishuReviewTransition(actor,f.auth,f.message(),changed,
      input=>({ kind:'update',state:{ ...input.session!.state,phase:'finished' } }))!.session!;
    assert.equal(done.state.phase,'finished');
    assert.equal(f.accounts.getFeishuReviewOperations(id,actor,f.auth)[0]!.status,'applied');
  } finally { f.cleanup(); }
});
