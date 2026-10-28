import assert from 'node:assert/strict';
import { cardButtons } from './helpers/feishu-card-elements.js';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Accounts } from '../src/server/accounts.js';
import { Store, StoreError } from '../src/server/store.js';
import { loadKnowledgeGraph } from '../src/server/kg.js';
import { createFeishuCardCapabilities, type PreparedFeishuCardReply } from '../src/server/feishu-cards.js';
import { selectFeishuReviewCandidates } from '../src/server/feishu-card-view.js';
import { summarizeLearning } from '../src/core/learning-evidence.js';
import type { FeishuCardNavAction } from '../src/shared/feishu-cards.js';

const actor = { appId: 'synthetic-app', tenantKey: 'synthetic-tenant', openId: 'synthetic-owner' };
async function fixture(extraCandidates = false, mixedDomains = false, initialAnchor = true) {
  const dir = mkdtempSync(join(tmpdir(), 'lm-review-capability-'));
  const root = join(dir, 'kg'); mkdirSync(join(root, 'Math'), { recursive: true });
  function note(body: string) { writeFileSync(join(root, 'Math', 'Alpha.md'), `---\ntype: concept\ntitle: Synthetic Alpha\nsummary: SECRET_SUMMARY\n---\n${body}`); }
  note(`SECRET_BODY_START\n${'synthetic paragraph details '.repeat(400)}\nSECRET_BODY_END`);
  if (extraCandidates) for (let index = 0; index < 6; index++) {
    writeFileSync(join(root, 'Math', `Other${index}.md`), `---\ntype: concept\ntitle: Synthetic Other ${index}\n---\nOTHER_BODY_${index}`);
  }
  if (mixedDomains) {
    mkdirSync(join(root, 'Interest'));
    writeFileSync(join(root, 'Interest', 'Other.md'), '---\ntype: concept\ntitle: Synthetic Interest\n---\nINTEREST_BODY');
  }
  let source = loadKnowledgeGraph({ root });
  let instant = Date.parse('2026-10-07T01:00:00Z'); let sequence = 0;
  const now = () => new Date(instant);
  let accounts = new Accounts({ dataDir: dir, now });
  const user = await accounts.setup('synthetic', 'synthetic-integration-password');
  const browser = accounts.issueSession(user.id);
  const bind = () => {
    const issued = accounts.issueFeishuBindingRequest(user.id, browser.sessionId, actor);
    assert.equal(accounts.confirmFeishuBinding({ ...actor, code: issued.command.split(' ')[1], eventId: `bind-${++sequence}`, messageId: `binding-${sequence}`, chatId: 'private-chat' }).status, 'confirmed');
    return { userId: user.id, accessRevision: user.accessRevision, bindingId: accounts.getFeishuBindingState(user.id).binding!.id };
  };
  let auth = bind();
  const dbPath = join(dir, 'learning.sqlite');
  const openStore = () => new Store({ dbPath, namespace: source.namespace, now });
  let store = openStore();
  let storeOpen = true; let accountsOpen = true;
  const concept = source.index.concepts.find(item => item.title === 'Synthetic Alpha')!;
  if (initialAnchor) store.addReview({ eventId: 'original-anchor', conceptId: concept.id, sourceRevision: concept.source.revision, kind: 'review', occurredAt: '2026-09-30T01:00:00Z' });
  if (extraCandidates) for (const item of source.index.concepts.filter(item => item.id !== concept.id)) {
    store.addReview({ eventId: `old-${item.title.replaceAll(' ', '-')}`, conceptId: item.id, sourceRevision: item.source.revision, kind: 'review', occurredAt: '2026-09-30T01:00:00Z' });
  }
  let cards = capabilities();
  function capabilities() { return createFeishuCardCapabilities({ accounts, scope: actor, timeZone: 'UTC', now,
    contextForUser: id => { assert.equal(id, user.id); return { source, store }; } }); }
  function message(text: string, id = `message-${++sequence}`) { return { ...actor, text, messageId: id, eventId: `event-${id}`, chatId: 'private-chat' }; }
  function accept(reply: PreparedFeishuCardReply) {
    assert.equal(reply.stillAuthorized(), true);
    reply.settle({ status: 'platform-accepted', messageId: `platform-${reply.operationId}`, chatId: 'private-chat' });
    return reply;
  }
  function action(reply: PreparedFeishuCardReply, caption: string): FeishuCardNavAction {
    const button = cardButtons(reply.card).find(item => item.text?.content === caption);
    assert.ok(button, `missing ${caption}: ${JSON.stringify(reply.card)}`);
    const value = button.behaviors![0].value;
    return { ...actor, ...value, eventId: `click-${++sequence}`, messageId: `platform-${reply.operationId}`, chatId: 'private-chat' };
  }
  function send(text: string) { const reply = cards.prepareMessage(message(text)); assert.ok(reply); return accept(reply); }
  function click(reply: PreparedFeishuCardReply, caption: string) { const next = cards.prepareAction(action(reply, caption)); assert.ok(next); return accept(next); }
  const session = () => accounts.getFeishuReviewSession(actor, auth, source.namespace)!;
  const operations = (sessionId?: string) => accounts.getFeishuReviewOperations(sessionId ?? session().id, actor, auth);
  function sql(statement: string) { const db = new DatabaseSync(dbPath); try { db.exec(statement); } finally { db.close(); } }
  return { get accounts() { return accounts; }, get store() { return store; }, get cards() { return cards; },
    get source() { return source; }, concept, message, accept, action, send, click, session, operations, sql,
    payload: (reply: PreparedFeishuCardReply) => JSON.stringify(reply.card),
    export: () => store.exportData(source.index.source, source.index.concepts),
    advance(ms: number) { instant += ms; },
    changeSource() { note('NEW_SECRET_BODY'); source = loadKnowledgeGraph({ root }); },
    rebind() { accounts.revokeFeishuBinding(user.id, browser.sessionId, auth.bindingId); auth = bind(); },
    reopen(beforeOpen?: () => void) {
      store.close(); storeOpen = false; accounts.close(); accountsOpen = false;
      beforeOpen?.(); accounts = new Accounts({ dataDir: dir, now }); accountsOpen = true;
      store = openStore(); storeOpen = true; cards = capabilities();
    },
    cleanup() { if (storeOpen) store.close(); if (accountsOpen) accounts.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('ordinary reading and paging create no learning event; explicit rewarm works without an existing anchor', async () => {
  const f = await fixture(false, false, false); try {
    const reading = f.click(f.send('知识 卡片'), '阅读 1');
    const before = f.export();
    const next = f.click(reading, '下一页');
    assert.deepEqual(f.export().anchors, before.anchors);
    const saved = f.click(next, '确认已重温');
    assert.match(f.payload(saved), /已确认重温，时间已更新/);
    const after = f.export();
    assert.equal(after.anchors.length, before.anchors.length + 1);
    assert.deepEqual(after.observations, before.observations);
    assert.deepEqual(after.config, before.config);
    assert.deepEqual(after.retentions, before.retentions);
    assert.match(after.anchors.at(-1)!.eventId, /^feishu-rewarm:/);
  } finally { f.cleanup(); }
});

test('zero budget and retention do not block an explicit reading rewarm', async () => {
 const f = await fixture(); try {
  f.store.updateReviewPlan({ revision: f.store.getReviewPlan().revision, dailyBudget: 0 });
  f.store.addRetention({ eventId: 'retained', conceptId: f.concept.id, sourceRevision: f.concept.source.revision,
    active: true, previousEventId: null, occurredAt: '2026-10-07T01:00:00Z' }, null);
  const before = f.export(); const plan = f.store.getReviewPlan();
  f.click(f.click(f.send('知识 卡片'), '阅读 1'), '确认已重温');
  assert.equal(f.export().anchors.length, before.anchors.length + 1);
  assert.deepEqual(f.export().retentions, before.retentions);
  assert.deepEqual(f.store.getReviewPlan(), plan);
  assert.equal(f.store.countObservations(), 0);
 } finally { f.cleanup(); }
});

test('pending status never retries; restart retry preserves the original timestamp and detects changed source', async () => {
 const f = await fixture(); try {
  const reading = f.click(f.send('知识 卡片'), '阅读 1');
  const originalAdd = f.store.addReview.bind(f.store);
  f.store.addReview = () => { throw new Error('synthetic unavailable'); };
  const pending = f.click(reading, '确认已重温');
  assert.match(f.payload(pending), /写入结果待确认，请重试原操作/);
  f.store.addReview = originalAdd;
  const before = f.export();
  f.send('知识 重温状态'); assert.deepEqual(f.export().anchors, before.anchors);
  f.advance(60000); f.reopen();
  const recovered = f.send('知识 重试重温');
  assert.match(f.payload(recovered), /已确认重温/);
  const anchor = f.export().anchors.find(a => a.eventId.startsWith('feishu-rewarm:'))!;
  assert.equal(anchor.occurredAt, '2026-10-07T01:00:00.000Z');
 } finally { f.cleanup(); }
 const f2 = await fixture(); try {
  const reading = f2.click(f2.send('知识 卡片'), '阅读 1');
  f2.store.addReview = () => { throw new Error('synthetic unavailable'); };
  f2.click(reading, '确认已重温'); f2.reopen(); f2.changeSource();
  const before = f2.export().anchors;
  assert.match(f2.payload(f2.send('知识 重试重温')), /本次重温未保存/);
  assert.deepEqual(f2.export().anchors, before);
 } finally { f2.cleanup(); }
});

test('a committed review with failed settlement recovers after source change via exact duplicate validation', async () => {
 const f = await fixture(); try {
  const original = f.accounts.settleFeishuRewarmIntent.bind(f.accounts);
  f.accounts.settleFeishuRewarmIntent = () => { throw new Error('synthetic settlement unavailable'); };
  const pending = f.click(f.click(f.send('知识 卡片'), '阅读 1'), '确认已重温');
  assert.match(f.payload(pending), /写入结果待确认/);
  const before = f.export().anchors;
  f.accounts.settleFeishuRewarmIntent = original;
  f.changeSource();
  assert.match(f.payload(f.send('知识 重试重温')), /已确认重温/);
  assert.deepEqual(f.export().anchors, before);
 } finally { f.cleanup(); }
});

test('reading rewarm preserves an existing batch queue and operations', async () => {
 const f = await fixture(true); try {
  f.send('知识 复习 3'); const session = structuredClone(f.session()); const operations = structuredClone(f.operations());
  f.click(f.click(f.send('知识 卡片'), '阅读 1'), '确认已重温');
  assert.deepEqual(f.session(), session); assert.deepEqual(f.operations(), operations);
 } finally { f.cleanup(); }
});

test('fresh confirmation with an existing pending intent never retries or changes its original time', async () => {
 const f = await fixture(); try {
  const add = f.store.addReview.bind(f.store);
  f.store.addReview = () => { throw new Error('synthetic unavailable'); };
  f.click(f.click(f.send('知识 卡片'), '阅读 1'), '确认已重温');
  const before = f.export().anchors;
  f.store.addReview = add; f.advance(60000);
  assert.match(f.payload(f.click(f.click(f.send('知识 卡片'), '阅读 1'), '确认已重温')), /写入结果待确认/);
  assert.deepEqual(f.export().anchors, before);
  f.send('知识 重试重温');
  assert.equal(f.export().anchors.find(a => a.eventId.startsWith('feishu-rewarm:'))!.occurredAt, '2026-10-07T01:00:00.000Z');
 } finally { f.cleanup(); }
});

test('old source, forwarded messages and replaced bindings cannot confirm a reading card', async () => {
 for (const reason of ['source', 'forward', 'binding'] as const) {
  const f = await fixture(); try {
   const reading = f.click(f.send('知识 卡片'), '阅读 1'); const action = f.action(reading, '确认已重温');
   if (reason === 'source') f.changeSource();
   if (reason === 'forward') action.messageId = 'forwarded-message';
   if (reason === 'binding') f.rebind();
   const before = f.export().anchors;
   assert.equal(f.cards.prepareAction(action), null);
   assert.deepEqual(f.export().anchors, before);
  } finally { f.cleanup(); }
 }
});

test('confirming concept B while A is pending names A and retries only the original A request', async () => {
 const f = await fixture(true); try {
  const first = f.click(f.send('知识 卡片 搜索 Synthetic Alpha'), '阅读 1');
  const add = f.store.addReview.bind(f.store);
  f.store.addReview = () => { throw new Error('synthetic unavailable'); };
  const initial = f.click(first, '确认已重温');
  assert.doesNotMatch(f.payload(initial), /本次未创建新的重温记录/);
  f.store.addReview = add;
  const before = f.export().anchors;
  const second = f.click(f.send('知识 卡片 搜索 Synthetic Other 0'), '阅读 1');
  const blocked = f.click(second, '确认已重温');
  assert.match(f.payload(blocked), /已有待确认操作，本次未创建新的重温记录/);
  assert.match(f.payload(blocked), /原操作概念：Synthetic Alpha/);
  assert.doesNotMatch(f.payload(blocked), /Synthetic Other 0/);
  assert.deepEqual(f.export().anchors, before);
  const recovered = f.click(blocked, '重试原操作');
  assert.match(f.payload(recovered), /已确认重温/);
  const added = f.export().anchors.filter(a => a.eventId.startsWith('feishu-rewarm:'));
  assert.equal(added.length, 1); assert.equal(added[0].conceptId, f.concept.id);
 } finally { f.cleanup(); }
});
