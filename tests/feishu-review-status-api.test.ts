import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, request } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTick } from 'node:timers/promises';
import { createApp } from '../src/server/app.js';
import { Accounts } from '../src/server/accounts.js';
import { Store } from '../src/server/store.js';
import { createFeishuConnector } from '../src/integrations/feishu-connector.js';
import { FEISHU_SILENT_LOGGER, type FeishuDriverCallbacks } from '../src/integrations/feishu-sdk-driver.js';
import type { PreparedFeishuCardReply } from '../src/server/feishu-cards.js';
import type { PreparedFeishuReadReply } from '../src/server/feishu-reading.js';
import type { FeishuReadMessage } from '../src/shared/feishu-reading.js';
import type { FeishuCardNavAction } from '../src/shared/feishu-cards.js';
import type { FeishuReviewSession } from '../src/shared/feishu-review.js';
import { initializeAppV3 } from './helpers/app-v3-fixture.js';
import { cardButtons } from './helpers/feishu-card-elements.js';

const scope = { appId: 'cli_0000000000000000', tenantKey: 'status-synthetic-tenant' };
const actor = { ...scope, openId: 'status-member' };
const ownerActor = { ...scope, openId: 'status-owner' };
type Credentials = { cookie: string; headers: Record<string, string> };
function note(root: string, name: string, title: string, body = 'STATUS_BODY_SECRET') {
  mkdirSync(join(root, 'Math'), { recursive: true });
  writeFileSync(join(root, 'Math', `${name}.md`), `---\ntype: concept\ntitle: ${title}\nsummary: STATUS_SUMMARY_SECRET\n---\n${body}`);
}
function rows(path: string, sql: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return db.prepare(sql).all(); } finally { db.close(); }
}
function databaseSnapshot(path: string, omit: string[] = []) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON; BEGIN');
    const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    const tables = Object.fromEntries(names.filter(row => !omit.includes(String(row.name))).map(row => {
      const name = String(row.name); return [name, db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all()];
    }));
    return { schema, tables };
  } finally { db.close(); }
}
async function fixture(version: 2 | 3) {
  const temp = mkdtempSync(join(tmpdir(), 'lm-review-status-api-'));
  const root = join(temp, 'owner-knowledge'); const dataDir = join(temp, 'data');
  let instant = Date.parse('2026-10-07T01:00:00.000Z'); let sequence = 0;
  for (let i = 0; i < 3; i++) note(root, `Owner${i}`, `OWNER_ONLY_${i}`, 'OWNER_BODY_SECRET');
  if (version === 3) { mkdirSync(dataDir, { recursive: true }); initializeAppV3(join(dataDir, 'living-memory.sqlite')); }
  const options = { root, dataDir, staticDir: join(temp, 'none'), port: 4317, limit: 1, accountsEnabled: true,
    learningSchemaVersion: version, feishuScope: scope, feishuTimeZone: 'UTC', now: () => new Date(instant),
    getFeishuChannelState: () => 'connected' as const };
  let app = createApp(options); let server = createServer(app);
  const listen = () => new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  await listen();
  async function send(path: string, input: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) {
    return await new Promise<{ status: number; body: any; cookie: string }>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: (server.address() as { port: number }).port, path,
        method: input.method ?? 'GET', headers: { host: '127.0.0.1:4317', 'content-type': 'application/json', 'X-LM-Learning-Protocol': String(version), ...(input.cookie ? { cookie: input.cookie } : {}), ...input.headers } }, response => {
        let text = ''; response.setEncoding('utf8'); response.on('data', chunk => text += chunk);
        response.on('end', () => resolve({ status: response.statusCode!, body: text ? JSON.parse(text) : null, cookie: response.headers['set-cookie']?.[0]?.split(';')[0] ?? '' }));
      });
      req.on('error', reject); if (input.body !== undefined) req.write(JSON.stringify(input.body)); req.end();
    });
  }
  async function credentials(cookie: string): Promise<Credentials> {
    const current = (await send('/api/session', { cookie })).body;
    return { cookie, headers: { 'x-lm-token': current.writeToken, 'x-lm-source-id': current.sourceId, 'x-lm-instance-id': current.instanceId } };
  }
  async function bind(user: Credentials, identity = actor) {
    const issued = await send('/api/feishu/binding/request', { ...user, method: 'POST', body: {} }); assert.equal(issued.status, 201);
    assert.equal(app.livingMemory.feishuBinding.confirm({ ...identity, code: issued.body.command.split(' ')[1], eventId: `bind-${++sequence}`, messageId: `binding-${sequence}`, chatId: 'private-chat' }).status, 'confirmed');
  }
  const setup = await send('/api/auth/setup', { method: 'POST', body: { username: 'owner', password: 'synthetic-owner-status-password' } }); assert.equal(setup.status, 201);
  const owner = await credentials(setup.cookie);
  const created = await send('/api/admin/users', { ...owner, method: 'POST', body: { username: 'member', password: 'synthetic-member-status-password' } }); assert.equal(created.status, 201);
  const memberId = created.body.id ?? created.body.user.id;
  const memberRoot = join(dataDir, 'users', memberId, 'knowledge');
  for (let i = 0; i < 3; i++) note(memberRoot, `Member${i}`, `STATUS_CONCEPT_${i}`);
  const login = await send('/api/auth/login', { method: 'POST', body: { username: 'member', password: 'synthetic-member-status-password' } });
  const member = await credentials(login.cookie);
  assert.equal((await send('/api/refresh', { ...member, method: 'POST', body: {} })).status, 200);
  await bind(owner, ownerActor); await bind(member);
  let memberConcepts: Array<{ id: string; title: string }> = [];
  for (const user of [owner, member]) {
    const concepts = (await send('/api/snapshot?scope=all', user)).body.concepts;
    if (user === member) memberConcepts = concepts;
    for (const concept of concepts) assert.equal((await send('/api/reviews', { ...user, method: 'POST', body: {
      eventId: `old-${++sequence}`, conceptId: concept.id, sourceRevision: concept.source.revision, kind: 'review', occurredAt: '2026-09-01T01:00:00.000Z',
    } })).status, 201);
  }
  const accounts = new Accounts({ dataDir, now: options.now });
  const learningPath = join(dataDir, 'living-memory.sqlite');
  const message = (text = '知识 复习状态', identity = actor, messageId = `message-${++sequence}`): FeishuReadMessage => ({ ...identity, text, messageId, eventId: `event-${messageId}`, chatId: 'private-chat' });
  const accept = (reply: PreparedFeishuCardReply | null) => { assert.ok(reply); assert.equal(reply.stillAuthorized(), true); reply.settle({ status: 'platform-accepted', messageId: `platform-${reply.operationId}`, chatId: 'private-chat' }); return reply; };
  const action = (reply: PreparedFeishuCardReply, caption: string): FeishuCardNavAction => {
    const button = cardButtons(reply.card).find(button => button.text.content === caption); assert.ok(button, caption);
    return { ...actor, ...button.behaviors[0].value, eventId: `click-${++sequence}`, messageId: `platform-${reply.operationId}`, chatId: 'private-chat' };
  };
  const card = (text = '知识 复习 3') => accept(app.livingMemory.feishuCards.prepareMessage(message(text)));
  const click = (reply: PreparedFeishuCardReply, caption: string) => accept(app.livingMemory.feishuCards.prepareAction(action(reply, caption)));
  const session = () => {
    const row = rows(accounts.dbPath, `SELECT state_json,id FROM feishu_review_sessions WHERE user_id='${memberId}' AND phase!='finished'`)[0];
    if (!row) return null;
    const binding = accounts.getFeishuBindingState(memberId).binding!;
    const user = accounts.resolveFeishuAccount(actor)!;
    const namespace = String(rows(accounts.dbPath, `SELECT namespace FROM feishu_review_sessions WHERE id='${row.id}'`)[0].namespace);
    return accounts.getFeishuReviewSession(actor, { userId: memberId, bindingId: binding.id, accessRevision: user.accessRevision }, namespace)!;
  };
  const snapshot = () => ({ learning: databaseSnapshot(learningPath), accounts: databaseSnapshot(accounts.dbPath, ['feishu_read_receipts']) });
  const receipts = () => rows(accounts.dbPath, 'SELECT * FROM feishu_read_receipts ORDER BY operation_id');
  const sql = (path: string, text: string) => { const db = new DatabaseSync(path); try { db.exec(text); } finally { db.close(); } };
  const closeApp = async () => { app.livingMemory.closeChanges(); await new Promise<void>(resolve => server.close(() => resolve())); app.livingMemory.close(); };
  return { get app() { return app; }, accounts, dataDir, learningPath, owner, member, memberId, memberRoot, memberConcepts, send, bind, message, card, click, action, session, snapshot, receipts,
    learningSql: (text: string) => sql(learningPath, text), accountsSql: (text: string) => sql(accounts.dbPath, text),
    advance(ms: number) { instant += ms; },
    async reopen() { await closeApp(); app = createApp(options); server = createServer(app); await listen(); },
    async close() { accounts.close(); await closeApp(); rmSync(temp, { recursive: true, force: true }); } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function channel(f: Fixture, prepared?: PreparedFeishuReadReply) {
  let hooks!: FeishuDriverCallbacks; let clock = 0; let cardPreparations = 0;
  const texts: string[] = []; let cards = 0;
  const connector = createFeishuConnector({ env: { LM_FEISHU_ENABLED: '1', LM_FEISHU_APP_ID: scope.appId, LM_FEISHU_APP_SECRET: 'synthetic-only', LM_FEISHU_TENANT_KEY: scope.tenantKey }, now: () => clock,
    prepareReading: message => prepared ?? f.app.livingMemory.feishuReading.prepare(message),
    prepareCardMessage: message => { cardPreparations++; return f.app.livingMemory.feishuCards.prepareMessage(message); },
    prepareCardAction: message => f.app.livingMemory.feishuCards.prepareAction(message),
    driverFactory: async (_config, callbacks) => { hooks = callbacks; return { start() {}, close() {},
      async sendText(message) { assert.equal(message.stillAuthorized(), true); texts.push(message.text); return 'platform-accepted'; },
      async sendCard() { cards++; return { status: 'failed-or-unknown' }; } }; } });
  await connector.start();
  const sdk = await import('@larksuiteoapi/node-sdk');
  const dispatcher = new sdk.EventDispatcher({ logger: FEISHU_SILENT_LOGGER }).register({ 'im.message.receive_v1': event => hooks.onMessage!(event) });
  return { connector, texts, get cards() { return cards; }, get cardPreparations() { return cardPreparations; },
    async invoke(message: FeishuReadMessage) {
      clock += 1100;
      await dispatcher.invoke({ schema: '2.0', header: { event_type: 'im.message.receive_v1', event_id: message.eventId, app_id: message.appId, tenant_key: message.tenantKey },
        event: { sender: { sender_type: 'user', tenant_key: message.tenantKey, sender_id: { open_id: message.openId } },
          message: { message_type: 'text', chat_type: 'p2p', message_id: message.messageId, chat_id: message.chatId, content: JSON.stringify({ text: message.text }) } } }, { needCheck: false });
      await nextTick();
    } };
}
function mutationWatch() {
  const calls: string[] = []; const restore: Array<() => void> = [];
  function watch(target: object, name: string) {
    const object = target as Record<string, (...args: any[]) => unknown>; const original = object[name];
    object[name] = function (this: unknown, ...args: any[]) { calls.push(name); return original.apply(this, args); };
    restore.push(() => { object[name] = original; });
  }
  for (const name of ['claimFeishuReviewTransition', 'settleFeishuReviewOperation', 'createFeishuCardDraft', 'activateFeishuCard']) watch(Accounts.prototype, name);
  for (const name of ['addObservation', 'addReview', 'rememberConcepts']) watch(Store.prototype, name);
  return { calls, close() { restore.reverse().forEach(fn => fn()); } };
}
function assertPrivate(text: string, session?: FeishuReviewSession | null, concepts: Array<{ id: string; title: string }> = []) {
  assert.doesNotMatch(text, /STATUS_BODY_SECRET|STATUS_SUMMARY_SECRET|OWNER_ONLY|OWNER_BODY_SECRET|sourceRevision|operationId|STATUS_PRIVATE_ANSWER/);
  if (session) for (const secret of [session.id, session.namespace, session.sourceFingerprint, session.state.conceptId, session.state.sourceRevision, ...session.state.batch!.items.slice(1).map(item => item.conceptId)]) assert.ok(!text.includes(secret), 'status excludes raw private identifiers');
  for (const concept of concepts) if (concept.id !== session?.state.conceptId) assert.ok(!text.includes(concept.title), 'future concept titles stay hidden');
  assert.ok(Buffer.byteLength(text) <= 12 * 1024);
}
async function readOnlyStatus(f: Fixture, expected: RegExp) {
  const before = f.snapshot(); const receiptCount = f.receipts().length; const session = f.session();
  const watch = mutationWatch(); const c = await channel(f);
  try {
    await c.invoke(f.message()); assert.equal(c.texts.length, 1); assert.match(c.texts[0], expected); assertPrivate(c.texts[0], session, f.memberConcepts);
    assert.equal(c.cards, 0); assert.equal(c.cardPreparations, 0); assert.deepEqual(watch.calls, []);
    assert.deepEqual(f.snapshot(), before, 'all learning/schema/session/operation/card/account tables remain unchanged');
    assert.equal(f.receipts().length, receiptCount + 1);
    return c.texts[0];
  } finally { watch.close(); await c.connector.stop(); }
}

for (const version of [2, 3] as const) {
  test(`v${version} status uses only text, preserves the live three-item card and deduplicates through app reopening`, async () => {
    const f = await fixture(version); let c: Awaited<ReturnType<typeof channel>> | undefined;
    try {
      const front = f.card(); const session = f.session()!; assert.equal(session.state.batch!.items.length, 3);
      const original = f.action(front, '查看资料'); assert.ok(f.accounts.getFeishuCardForAction(original));
      const before = f.snapshot(); assert.ok(Object.hasOwn(before.learning.tables, 'activity_events')); assert.ok(Object.hasOwn(before.learning.tables, 'activity_deliveries'));
      if (version === 3) assert.equal(Object.keys(before.learning.tables).length, 23);
      const message = f.message('  知识\t复习状态  '); const receipts = f.receipts().length;
      assert.equal(f.app.livingMemory.feishuCards.prepareMessage(message), null);
      c = await channel(f); const watch = mutationWatch();
      try {
        await c.invoke(message); assert.equal(c.texts.length, 1); assert.match(c.texts[0], /1\s*\/\s*3|第\s*1.*3/); assertPrivate(c.texts[0], session, f.memberConcepts); assert.match(c.texts[0], /阶段：待回忆/);
        assert.equal(c.cards, 0); assert.equal(c.cardPreparations, 0); assert.deepEqual(watch.calls, []); assert.deepEqual(f.snapshot(), before);
      } finally { watch.close(); }
      assert.ok(f.accounts.getFeishuCardForAction(original)); assert.equal(f.receipts().length, receipts + 1);
      await c.invoke({ ...message, eventId: 'different-status-event' }); assert.equal(c.texts.length, 1);
      await c.invoke(f.message('知识 复习状态', ownerActor)); assert.equal(c.texts.length, 2); assert.doesNotMatch(c.texts[1], /STATUS_CONCEPT|1\s*\/\s*3/);
      assert.equal(f.app.livingMemory.feishuReading.prepare(f.message('知识 复习状态', { ...actor, openId: 'unbound' })), null);
      assert.equal(f.app.livingMemory.feishuReading.prepare(f.message('知识 复习状态', { ...actor, tenantKey: 'wrong' })), null);
      await c.connector.stop(); c = undefined; await f.reopen();
      const afterReopen = f.snapshot(); c = await channel(f); await c.invoke({ ...message, eventId: 'status-after-app-reopen' }); assert.equal(c.texts.length, 0); assert.deepEqual(f.snapshot(), afterReopen);
      assert.ok(f.accounts.getFeishuCardForAction(original));
      const next = f.app.livingMemory.feishuCards.prepareAction(original); assert.ok(next, 'the original callback remains usable after status');
      next.settle({ status: 'platform-accepted', messageId: `platform-${next.operationId}`, chatId: 'private-chat' }); assert.equal(f.session()!.state.phase, 'revealed');
      await c.connector.stop(); c = undefined; f.click(next, '结束复习');
      await readOnlyStatus(f, /当前没有未结束的复习会话/);
    } finally { await c?.connector.stop(); await f.close(); }
  });

  test(`v${version} paused, recoverable pending, conflicted, changed and expired status never resumes or writes learning`, async () => {
    const f = await fixture(version);
    try {
      const front = f.card(); const revealed = f.click(front, '查看资料');
      f.learningSql("CREATE TRIGGER status_reject_observation BEFORE INSERT ON observations BEGIN SELECT RAISE(ABORT,'synthetic status write unavailable'); END");
      const pending = f.click(revealed, '清楚');
      assert.equal(rows(f.accounts.dbPath, "SELECT * FROM feishu_review_operations WHERE status='pending'").length, 1);
      f.learningSql('DROP TRIGGER status_reject_observation');
      await readOnlyStatus(f, /本轮脑中自评：已保存\s*0；待确认\s*1；冲突\s*0/);
      const paused = f.click(pending, '暂停复习'); assert.equal(f.session()!.state.paused, true);
      const pausedText = await readOnlyStatus(f, /复习状态：已暂停/);
      assert.match(pausedText, /本轮脑中自评：已保存\s*0；待确认\s*1；冲突\s*0/); assert.equal(f.session()!.state.paused, true);
      const pendingRow = rows(f.accounts.dbPath, "SELECT id FROM feishu_review_operations WHERE status='pending'")[0];
      const current = f.session()!; const user = f.accounts.resolveFeishuAccount(actor)!; const binding = f.accounts.getFeishuBindingState(user.id).binding!;
      f.accounts.settleFeishuReviewOperation(String(pendingRow.id), actor, { userId: user.id, accessRevision: user.accessRevision, bindingId: binding.id }, { status: 'conflict', errorCode: 'EVENT_CONFLICT' });
      await readOnlyStatus(f, /本轮脑中自评：已保存\s*0；待确认\s*0；冲突\s*1/);
      note(f.memberRoot, 'Member0', 'STATUS_CONCEPT_0', 'CHANGED_BODY_SECRET');
      assert.equal((await f.send('/api/refresh', { ...f.member, method: 'POST', body: {} })).status, 200);
      const changed = await readOnlyStatus(f, /会话时间与资料：资料已变化/); assert.doesNotMatch(changed, /CHANGED_BODY_SECRET/);
      f.advance(25 * 60 * 60_000); await readOnlyStatus(f, /会话时间与资料：已过期/);
      assert.ok(paused);
    } finally { await f.close(); }
  });

  test(`v${version} a fresh cold-member status reads changed source without remembering concepts and rejects later context replacement`, async () => {
    const f = await fixture(version);
    try {
      f.card(); const original = f.session()!;
      note(f.memberRoot, 'Member0', 'COLD_NEW_SECRET_TITLE', 'COLD_NEW_SECRET_BODY');
      await f.reopen();
      // No member HTTP request, refresh or warm context access after reopening.
      const before = f.snapshot();
      assert.ok(Object.hasOwn(before.learning.tables, 'identity_catalog'));
      const text = await readOnlyStatus(f, /会话时间与资料：资料已变化/);
      assert.doesNotMatch(text, /COLD_NEW_SECRET_TITLE|COLD_NEW_SECRET_BODY/);
      assert.deepEqual(f.snapshot(), before);
      assert.deepEqual(f.session(), original);

      const beforePrepare = f.snapshot(); const watch = mutationWatch();
      let prepared: PreparedFeishuReadReply;
      try {
        const reply = f.app.livingMemory.feishuReading.prepare(f.message()); assert.ok(reply); prepared = reply;
        assert.equal(prepared.stillAuthorized(), true);
        assert.doesNotMatch(prepared.text, /COLD_NEW_SECRET_TITLE|COLD_NEW_SECRET_BODY/);
        assert.deepEqual(watch.calls, []);
        assert.deepEqual(f.snapshot(), beforePrepare);
      } finally { watch.close(); }
      // A normal request is intentionally allowed to create the regular context.
      const warm = await f.send('/api/snapshot?scope=all', f.member); assert.equal(warm.status, 200);
      assert.ok(warm.body.concepts.some((concept: { title: string }) => concept.title === 'COLD_NEW_SECRET_TITLE'));
      assert.equal(prepared.stillAuthorized(), false, 'cold prepared text cannot survive installation of a normal member context');
    } finally { await f.close(); }
  });

}

test('v3 already-committed pending journals remain pending and frozen during status inspection', async () => {
  const f = await fixture(3);
  try {
    const revealed = f.click(f.card(), '查看资料');
    f.accountsSql("CREATE TRIGGER status_reject_settlement BEFORE UPDATE ON feishu_review_operations BEGIN SELECT RAISE(ABORT,'synthetic status settlement unavailable'); END");
    f.click(revealed, '清楚');
    assert.equal(rows(f.learningPath, 'SELECT * FROM observations').length, 1);
    assert.equal(rows(f.accounts.dbPath, "SELECT * FROM feishu_review_operations WHERE status='pending'").length, 1);
    f.accountsSql('DROP TRIGGER status_reject_settlement');
    await readOnlyStatus(f, /本轮脑中自评：已保存\s*0；待确认\s*1；冲突\s*0/);
    assert.equal(rows(f.learningPath, 'SELECT * FROM observations').length, 1);
    assert.equal(rows(f.accounts.dbPath, "SELECT * FROM feishu_review_operations WHERE status='pending'").length, 1);
  } finally { await f.close(); }
});

test('status send guards reject newly created sessions, version changes, source refresh and authorization replacement', async () => {
  const f = await fixture(3);
  try {
    const rejectAtSend = async (prepared: PreparedFeishuReadReply) => {
      assert.equal(prepared.stillAuthorized(), false);
      const c = await channel(f, prepared);
      try { await c.invoke(f.message()); assert.deepEqual(c.texts, []); assert.equal(c.cards, 0); }
      finally { await c.connector.stop(); }
    };
    const none = f.app.livingMemory.feishuReading.prepare(f.message())!; assert.ok(none); assert.equal(none.stillAuthorized(), true);
    const front = f.card(); await rejectAtSend(none);
    const version = f.app.livingMemory.feishuReading.prepare(f.message())!; assert.equal(version.stillAuthorized(), true);
    f.click(front, '查看资料'); await rejectAtSend(version);
    f.card('知识 结束复习'); f.card(); const previousSession = f.session()!;
    const replaced = f.app.livingMemory.feishuReading.prepare(f.message())!;
    f.card('知识 结束复习'); f.card();
    assert.notEqual(f.session()!.id, previousSession.id); assert.equal(f.session()!.version, previousSession.version); await rejectAtSend(replaced);
    const source = f.app.livingMemory.feishuReading.prepare(f.message())!;
    assert.equal((await f.send('/api/refresh', { ...f.member, method: 'POST', body: {} })).status, 200); await rejectAtSend(source);
    const binding = f.app.livingMemory.feishuReading.prepare(f.message())!;
    const bindingId = (await f.send('/api/feishu/binding', f.member)).body.binding.id;
    assert.equal((await f.send('/api/feishu/binding/revoke', { ...f.member, method: 'POST', body: { bindingId } })).status, 200);
    await f.bind(f.member); await rejectAtSend(binding);
    const access = f.app.livingMemory.feishuReading.prepare(f.message())!;
    assert.equal((await f.send(`/api/admin/users/${f.memberId}`, { ...f.owner, method: 'PUT', body: { password: 'changed-synthetic-status-password' } })).status, 200); await rejectAtSend(access);
  } finally { await f.close(); }
});
