import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, request } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTick } from 'node:timers/promises';
import { createApp } from '../src/server/app.js';
import { createFeishuConnector } from '../src/integrations/feishu-connector.js';
import { FEISHU_SILENT_LOGGER, type FeishuDriverCallbacks, type FeishuSendCard } from '../src/integrations/feishu-sdk-driver.js';
import { createFeishuCardCapabilities, feishuCardSourceFingerprint } from '../src/server/feishu-cards.js';
import { Accounts } from '../src/server/accounts.js';
import type { FeishuReadMessage } from '../src/shared/feishu-reading.js';
import type { FeishuCardNavAction, FeishuCardPayload } from '../src/shared/feishu-cards.js';
import type { Concept } from '../src/shared/types.js';

const scope = { appId: 'cli_0000000000000000', tenantKey: 'synthetic-tenant' };
const ownerActor = { ...scope, openId: 'owner_open' };
const memberActor = { ...scope, openId: 'member_open' };
type Credentials = { cookie: string; headers: Record<string, string> };
function note(root: string, domain: string, name: string, title: string, body: string) {
  mkdirSync(join(root, domain), { recursive: true });
  writeFileSync(join(root, domain, `${name}.md`), `---\ntype: concept\ntitle: ${title}\n---\n${body}`);
}
async function fixture(options: { accountsEnabled?: boolean; configured?: boolean; timeZone?: string } = {}) {
  const temp = mkdtempSync(join(tmpdir(), 'lm-feishu-card-api-'));
  const root = join(temp, 'owner-kg'); const dataDir = join(temp, 'data');
  let instant = Date.parse('2026-10-02T01:00:00Z');
  for (let i = 0; i < 6; i++) note(root, i === 5 ? 'AI' : 'Math', `Owner${i}`, `OwnerOnly${i}`, `Owner-private-body-${i}`);
  const appOptions = { root, dataDir, staticDir: join(temp, 'none'), port: 4317, limit: 1,
    accountsEnabled: options.accountsEnabled !== false, feishuScope: options.configured === false ? null : scope,
    feishuTimeZone: options.timeZone ?? 'Asia/Hong_Kong', now: () => new Date(instant),
    getFeishuChannelState: () => 'connected' as const };
  let app = createApp(appOptions); let server = createServer(app);
  async function listen() { await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); }
  await listen();
  const send = (path: string, input: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) =>
    new Promise<{ status: number; body: any; cookie: string }>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: (server.address() as { port: number }).port, path,
        method: input.method ?? 'GET', headers: { host: '127.0.0.1:4317', 'content-type': 'application/json',
          ...(input.cookie ? { cookie: input.cookie } : {}), ...input.headers } }, res => {
        let text = ''; res.setEncoding('utf8'); res.on('data', chunk => text += chunk);
        res.on('end', () => resolve({ status: res.statusCode!, body: text ? JSON.parse(text) : null,
          cookie: res.headers['set-cookie']?.[0]?.split(';')[0] ?? '' }));
      }); req.on('error', reject); if (input.body !== undefined) req.write(JSON.stringify(input.body)); req.end();
    });
  const credentials = async (cookie: string): Promise<Credentials> => {
    const session = (await send('/api/session', { cookie })).body;
    return { cookie, headers: { 'x-lm-token': session.writeToken, 'x-lm-source-id': session.sourceId } };
  };
  async function bind(credentials: Credentials, actor: typeof ownerActor) {
    const issued = await send('/api/feishu/binding/request', { ...credentials, method: 'POST', body: {} });
    assert.equal(issued.status, 201);
    assert.equal(app.livingMemory.feishuBinding.confirm({ ...actor, code: issued.body.command.split(' ')[1],
      eventId: `bind-${actor.openId}`, messageId: `bind-message-${actor.openId}`, chatId: 'private-chat' }).status, 'confirmed');
  }
  async function users() {
    const setup = await send('/api/auth/setup', { method: 'POST', body: { username: 'owner', password: 'synthetic-owner-password' } });
    assert.equal(setup.status, 201); const owner = await credentials(setup.cookie);
    const created = await send('/api/admin/users', { ...owner, method: 'POST', body: { username: 'member', password: 'synthetic-member-password' } });
    assert.equal(created.status, 201); const memberId: string = created.body.id ?? created.body.user?.id;
    assert.equal(typeof memberId, 'string');
    const memberRoot = join(dataDir, 'users', memberId, 'knowledge');
    note(memberRoot, 'Math', 'Member0', 'MemberOnly0', `Member-private-first\n${'synthetic-details '.repeat(300)}\nMember-private-tail`);
    note(memberRoot, 'Math', 'Member1', 'MemberOnly1', 'Member-second-body');
    const login = await send('/api/auth/login', { method: 'POST', body: { username: 'member', password: 'synthetic-member-password' } });
    const member = await credentials(login.cookie);
    assert.equal((await send('/api/refresh', { ...member, method: 'POST', body: {} })).status, 200);
    await bind(owner, ownerActor); await bind(member, memberActor);
    return { owner, member, memberId, memberRoot };
  }
  async function stopApp() {
    app.livingMemory.closeChanges(); await new Promise<void>(resolve => server.close(() => resolve())); app.livingMemory.close();
  }
  return { get app() { return app; }, root, dataDir, send, bind, users,
    advance: (milliseconds: number) => { instant += milliseconds; },
    reopen: async () => { await stopApp(); app = createApp(appOptions); server = createServer(app); await listen(); },
    close: async () => { await stopApp(); rmSync(temp, { recursive: true, force: true }); } };
}
function input(text: string, messageId: string, actor = memberActor): FeishuReadMessage {
  return { ...actor, text, messageId, eventId: `event-${messageId}`, chatId: 'private-chat' };
}
type Button = { text: { content: string }; behaviors: Array<{ value: { kind: string; cardId: string; actionId: string } }> };
function button(card: FeishuCardPayload, caption: string): Button {
  const elements = (card.body as { elements: Array<Button & { tag: string }> }).elements;
  const found = elements.find(element => element.tag === 'button' && element.text.content === caption);
  assert.ok(found, `missing button ${caption}`); return found;
}
function action(sent: FeishuSendCard, messageId: string, caption: string, actor = memberActor): FeishuCardNavAction {
  const { cardId, actionId } = button(sent.card, caption).behaviors[0].value;
  return { ...actor, eventId: `click-${messageId}-${actionId}`, messageId, chatId: 'private-chat', cardId, actionId };
}
async function channel(f: Awaited<ReturnType<typeof fixture>>) {
  let callbacks!: FeishuDriverCallbacks; let clock = 0;
  const sent: FeishuSendCard[] = []; let accepted = true;
  const connector = createFeishuConnector({ env: { LM_FEISHU_ENABLED: '1', LM_FEISHU_APP_ID: scope.appId,
    LM_FEISHU_APP_SECRET: 'synthetic-secret', LM_FEISHU_TENANT_KEY: scope.tenantKey }, now: () => clock,
    prepareCardMessage: message => f.app.livingMemory.feishuCards.prepareMessage(message),
    prepareCardAction: message => f.app.livingMemory.feishuCards.prepareAction(message),
    driverFactory: async (_config, hooks) => { callbacks = hooks; return { start() {}, close() {},
      async sendCard(message) { assert.equal(message.stillAuthorized(), true); sent.push(message);
        return accepted ? { status: 'platform-accepted', messageId: `platform-${sent.length}`, chatId: 'private-chat' }
          : { status: 'failed-or-unknown' }; } }; } });
  await connector.start(); const sdk = await import('@larksuiteoapi/node-sdk');
  // Actual SDK event projection only; no WSClient, Client or network is constructed.
  const dispatcher = new sdk.EventDispatcher({ logger: FEISHU_SILENT_LOGGER }).register({
    'im.message.receive_v1': (event: unknown) => callbacks.onMessage!(event),
    'card.action.trigger': (event: unknown) => callbacks.onCardAction(event),
  });
  return { connector, sent, fail: () => { accepted = false; },
    message: async (message: FeishuReadMessage, chatType = 'p2p') => {
      clock += 1100;
      await dispatcher.invoke({ schema: '2.0', header: { event_type: 'im.message.receive_v1', event_id: message.eventId, app_id: message.appId, tenant_key: message.tenantKey },
        event: { sender: { sender_type: 'user', tenant_key: message.tenantKey, sender_id: { open_id: message.openId } },
          message: { message_type: 'text', chat_type: chatType, message_id: message.messageId, chat_id: message.chatId,
            content: JSON.stringify({ text: message.text }) } } }, { needCheck: false }); await nextTick();
    },
    click: async (click: FeishuCardNavAction) => {
      clock += 1100;
      const response = await dispatcher.invoke({ schema: '2.0', header: { event_type: 'card.action.trigger', event_id: click.eventId, app_id: click.appId, tenant_key: click.tenantKey },
        event: { operator: { open_id: click.openId, tenant_key: click.tenantKey },
          context: { open_message_id: click.messageId, open_chat_id: click.chatId },
          action: { tag: 'button', value: { kind: 'lm.nav.v1', cardId: click.cardId, actionId: click.actionId } } } }, { needCheck: false });
      await nextTick(); return response;
    } };
}
const learningKeys = ['anchors', 'observations', 'retentions', 'applications', 'corrections', 'practice', 'config', 'configHistory', 'reviewPlan', 'layout', 'restoreMetadata'];

test('SDK card browsing uses each private full index, restores filters and never changes learning data', async () => {
  const f = await fixture(); let c: Awaited<ReturnType<typeof channel>> | undefined;
  try {
    const users = await f.users(); c = await channel(f);
    const before = { owner: (await f.send('/api/export', users.owner)).body, member: (await f.send('/api/export', users.member)).body };
    assert.equal(f.app.livingMemory.getSource().graph.concepts.length, 1);
    await c.message(input('知识 卡片 搜索 OwnerOnly5', 'owner-full', ownerActor));
    assert.match(JSON.stringify(c.sent.at(-1)!.card), /OwnerOnly5/);
    await c.message(input('知识 卡片 搜索 OwnerOnly5', 'member-private'));
    assert.match(JSON.stringify(c.sent.at(-1)!.card), /没有匹配节点/);
    assert.doesNotMatch(JSON.stringify(c.sent.at(-1)!.card), /OwnerOnly|Owner-private|owner-kg/);
    await c.message(input('知识 卡片 列表 域=Math 查=MemberOnly0 序=名称', 'member-filter'));
    const original = c.sent.at(-1)!; const originalMessage = `platform-${c.sent.length}`;
    const readClick = action(original, originalMessage, '阅读 1');
    const response = await c.click(readClick);
    assert.match(JSON.stringify(response), /已收到操作/);
    assert.match(JSON.stringify(c.sent.at(-1)!.card), /Member-private-first/);
    const page = c.sent.at(-1)!;
    await c.click(action(page, `platform-${c.sent.length}`, '下一页'));
    assert.match(JSON.stringify(c.sent.at(-1)!.card), /Member-private-tail/);
    await c.click(action(c.sent.at(-1)!, `platform-${c.sent.length}`, '返回原列表'));
    assert.match(JSON.stringify(c.sent.at(-1)!.card), /1 个节点/);
    assert.match(JSON.stringify(c.sent.at(-1)!.card), /MemberOnly0/);
    const count = c.sent.length;
    await c.click({ ...readClick, eventId: 'repeat-another-event' });
    await c.message(input('知识 卡片', 'unknown', { ...memberActor, openId: 'unbound' }));
    await c.message(input('知识 卡片', 'wrong-tenant', { ...memberActor, tenantKey: 'wrong' }));
    await c.message(input('知识 卡片', 'group'), 'group');
    assert.equal(c.sent.length, count);
    for (const [name, credentials] of Object.entries({ owner: users.owner, member: users.member })) {
      const after = (await f.send('/api/export', credentials)).body;
      for (const key of learningKeys) assert.deepEqual(after[key], before[name as 'owner' | 'member'][key], `${name} read-only ${key}`);
    }
  } finally { await c?.connector.stop(); await f.close(); }
});

test('due cards apply persisted focus, defer, retention, accepted progress and explicit daily time zone', async () => {
  const f = await fixture(); let c: Awaited<ReturnType<typeof channel>> | undefined;
  try {
    const users = await f.users(); const concepts = f.app.livingMemory.getSource().index.concepts;
    const byTitle = (title: string) => concepts.find(concept => concept.title === title)!;
    for (const concept of concepts) {
      assert.equal((await f.send('/api/reviews', { ...users.owner, method: 'POST', body: {
        eventId: `old-${concept.title}`, conceptId: concept.id, sourceRevision: concept.source.revision,
        kind: 'review', occurredAt: '2026-09-01T00:00:00Z' } })).status, 201);
    }
    assert.equal((await f.send('/api/review-plan', { ...users.owner, method: 'PUT', body: { revision: 0, dailyBudget: 3 } })).status, 200);
    const setPreference = (concept: Concept, revision: number, focus: boolean, deferUntil: string | null) => f.send('/api/review-plan', {
      ...users.owner, method: 'PUT', body: { revision, concept: { conceptId: concept.id, sourceRevision: concept.source.revision, focus, deferUntil } } });
    assert.equal((await setPreference(byTitle('OwnerOnly5'), 1, true, null)).status, 200);
    assert.equal((await setPreference(byTitle('OwnerOnly4'), 2, false, '2026-10-03T00:00:00Z')).status, 200);
    const retained = byTitle('OwnerOnly3');
    assert.equal((await f.send('/api/retentions', { ...users.owner, method: 'POST', body: { eventId: 'retained',
      conceptId: retained.id, sourceRevision: retained.source.revision, active: true, previousEventId: null,
      occurredAt: '2026-10-01T00:00:00Z' } })).status, 201);
    const completed = byTitle('OwnerOnly0');
    assert.equal((await f.send('/api/observations', { ...users.owner, method: 'POST', body: { eventId: 'today-concept',
      conceptId: completed.id, sourceRevision: completed.source.revision, configRevision: f.app.livingMemory.store.getConfig().revision,
      observedAt: '2026-10-01T17:00:00Z', anchorEventId: `old-${completed.title}`,
      answer: 'synthetic answer', rating: 'clear', exposure: 'unexposed', observedExposure: false } })).status, 201);
    assert.equal((await f.send('/api/review-plan?timeZone=UTC', users.owner)).body.completedConceptIds.length, 0);
    const before = (await f.send('/api/export', users.owner)).body; c = await channel(f);
    await c.message(input('知识 待复习 量=5', 'due', ownerActor));
    const payload = JSON.stringify(c.sent.at(-1)!.card);
    assert.match(payload, /Asia\/Hong_Kong/); assert.match(payload, /2026-10-02/);
    assert.match(payload, /今日已落库概念回忆 1 项 · 剩余预算 2 项/);
    assert.match(payload, /OwnerOnly5/); assert.doesNotMatch(payload, /OwnerOnly[034]|Owner-private-body/);
    const candidateRows = (c.sent.at(-1)!.card.body as { elements: Array<{ tag: string; content?: string }> }).elements
      .filter(element => element.tag === 'markdown' && /^\d+\. /.test(element.content ?? ''));
    assert.equal(candidateRows.length, 2);
    assert.match(candidateRows[0].content!, /^1\. OwnerOnly5\b/);
    assert.match(candidateRows[1].content!, /^2\. OwnerOnly[12]\b/);
    await c.click(action(c.sent.at(-1)!, `platform-${c.sent.length}`, '阅读 1', ownerActor));
    assert.match(JSON.stringify(c.sent.at(-1)!.card), /Owner-private-body-5/);
    await c.click(action(c.sent.at(-1)!, `platform-${c.sent.length}`, '返回原待复习', ownerActor));
    assert.match(JSON.stringify(c.sent.at(-1)!.card), /剩余预算 2 项/);
    const after = (await f.send('/api/export', users.owner)).body;
    for (const key of learningKeys) assert.deepEqual(after[key], before[key], key);
  } finally { await c?.connector.stop(); await f.close(); }
});

test('live card actions reject forwarded contexts, wrong actors, changed sources, expiry and binding ABA', async () => {
  const f = await fixture();
  try {
    const users = await f.users(); const capabilities = () => f.app.livingMemory.feishuCards;
    const prepared = capabilities().prepareMessage(input('知识 卡片', 'live'))!;
    prepared.settle({ status: 'platform-accepted', messageId: 'platform-live', chatId: 'private-chat' });
    const click = action({ card: prepared.card } as FeishuSendCard, 'platform-live', '阅读 1');
    for (const change of [{ openId: ownerActor.openId }, { openId: 'unbound' }, { chatId: 'forwarded-group' },
      { messageId: 'forwarded-message' }, { actionId: 'a99' }, { tenantKey: 'wrong' }]) {
      assert.equal(capabilities().prepareAction({ ...click, ...change }), null);
    }
    assert.ok(capabilities().prepareAction(click), 'bad actors do not consume the valid card');
    const newer = capabilities().prepareMessage(input('知识 卡片', 'before-refresh'))!;
    newer.settle({ status: 'platform-accepted', messageId: 'platform-newer', chatId: 'private-chat' });
    const stale = action({ card: newer.card } as FeishuSendCard, 'platform-newer', '阅读 1');
    note(users.memberRoot, 'Math', 'Member0', 'MemberOnly0', 'Changed private content');
    assert.equal((await f.send('/api/refresh', { ...users.member, method: 'POST', body: {} })).status, 200);
    assert.equal(capabilities().prepareAction(stale), null);
    const expired = capabilities().prepareMessage(input('知识 卡片', 'before-expiry'))!;
    expired.settle({ status: 'platform-accepted', messageId: 'platform-expired', chatId: 'private-chat' });
    f.advance(30 * 60 * 1000);
    assert.equal(capabilities().prepareAction(action({ card: expired.card } as FeishuSendCard, 'platform-expired', '阅读 1')), null);
    const aba = capabilities().prepareMessage(input('知识 卡片', 'before-aba'))!;
    aba.settle({ status: 'platform-accepted', messageId: 'platform-aba', chatId: 'private-chat' });
    const status = (await f.send('/api/feishu/binding', users.member)).body;
    assert.equal((await f.send('/api/feishu/binding/revoke', { ...users.member, method: 'POST', body: { bindingId: status.binding.id } })).status, 200);
    await f.bind(users.member, memberActor);
    assert.equal(capabilities().prepareAction(action({ card: aba.card } as FeishuSendCard, 'platform-aba', '阅读 1')), null);
    const delayed = capabilities().prepareMessage(input('知识 卡片', 'draft-before-expiry'))!;
    assert.equal(delayed.stillAuthorized(), true); f.advance(30 * 60 * 1000);
    assert.equal(delayed.stillAuthorized(), false);
  } finally { await f.close(); }
});

test('persistent receipts survive app reopening and failed sends never activate or retry old cards', async () => {
  const f = await fixture(); let c: Awaited<ReturnType<typeof channel>> | undefined;
  try {
    await f.users(); c = await channel(f);
    const message = input('知识 卡片', 'persistent');
    await c.message(message); const click = action(c.sent[0], 'platform-1', '阅读 1');
    await c.click(click); assert.equal(c.sent.length, 2);
    await c.connector.stop(); await f.reopen(); c = await channel(f);
    await c.message({ ...message, eventId: 'different-event' });
    await c.click({ ...click, eventId: 'different-click-event' }); assert.equal(c.sent.length, 0);
    // A live, unchanged card also survives reopening and resolves to this user's source.
    const latest = f.app.livingMemory.feishuCards.prepareMessage(input('知识 卡片', 'survive'))!;
    latest.settle({ status: 'platform-accepted', messageId: 'survive-platform', chatId: 'private-chat' });
    await c.connector.stop(); await f.reopen(); c = await channel(f);
    await c.click(action({ card: latest.card } as FeishuSendCard, 'survive-platform', '阅读 1'));
    assert.equal(c.sent.length, 1); assert.match(JSON.stringify(c.sent[0].card), /Member-private-first/);
    c.fail(); const failedMessage = input('知识 卡片', 'failed-new'); await c.message(failedMessage);
    const failedClick = action(c.sent.at(-1)!, `platform-${c.sent.length}`, '阅读 1');
    const count = c.sent.length; await c.click(failedClick); await c.message({ ...failedMessage, eventId: 'failed-redelivery' });
    assert.equal(c.sent.length, count);
  } finally { await c?.connector.stop(); await f.close(); }
});

test('source fingerprints are deterministic across ordering and include namespace and complete source fields', async () => {
  const f = await fixture();
  try {
    const source = f.app.livingMemory.getSource(); const digest = feishuCardSourceFingerprint(source);
    const reordered = { ...source, index: { ...source.index, concepts: [...source.index.concepts].reverse() } };
    assert.equal(feishuCardSourceFingerprint(reordered), digest);
    assert.notEqual(feishuCardSourceFingerprint({ ...source, namespace: 'another-namespace' }), digest);
    const concept = source.index.concepts[0];
    for (const change of [{ title: 'new' }, { aliases: ['new'] }, { domain: 'new' }, { summary: 'new' }, { body: 'new' },
      { source: { ...concept.source, path: 'new/path.md' } }, { source: { ...concept.source, revision: 'new' } }]) {
      assert.notEqual(feishuCardSourceFingerprint({ ...source, index: { ...source.index,
        concepts: [{ ...concept, ...change }, ...source.index.concepts.slice(1)] } }), digest);
    }
    assert.equal(feishuCardSourceFingerprint(source), digest);
  } finally { await f.close(); }
});

test('card capabilities reject unconfigured, local-only and invalid-time-zone modes', async () => {
  for (const options of [{ configured: false }, { accountsEnabled: false }, { timeZone: 'not/a-zone' }]) {
    const f = await fixture(options);
    try { assert.equal(f.app.livingMemory.feishuCards.prepareMessage(input('知识 卡片', 'disabled')), null);
      assert.equal((await f.send('/api/auth/status')).status, 200, 'invalid zone cannot break HTTP'); }
    finally { await f.close(); }
  }
});

test('a failed receipt settlement discards the draft without activation or redelivery', async () => {
  const f = await fixture(); let accounts: Accounts | undefined;
  try {
    await f.users(); accounts = new Accounts({ dataDir: f.dataDir, now: () => new Date('2026-10-02T01:00:00Z') });
    const cards = createFeishuCardCapabilities({ accounts, scope, timeZone: 'UTC', now: () => new Date('2026-10-02T01:00:00Z'),
      contextForUser: () => ({ source: f.app.livingMemory.getSource(), store: f.app.livingMemory.store }) });
    const message = input('知识 卡片', 'finish-failure', ownerActor);
    const prepared = cards.prepareMessage(message)!; assert.ok(prepared); assert.equal(prepared.stillAuthorized(), true);
    const originalFinish = accounts.finishFeishuRead.bind(accounts);
    accounts.finishFeishuRead = () => { throw new Error('synthetic-private-database-error'); };
    assert.throws(() => prepared.settle({ status: 'platform-accepted', messageId: 'settle-platform', chatId: 'private-chat' }),
      /^Error: Feishu card settlement unavailable$/);
    accounts.finishFeishuRead = originalFinish;
    assert.equal(prepared.stillAuthorized(), false);
    assert.equal(cards.prepareAction(action({ card: prepared.card } as FeishuSendCard, 'settle-platform', '阅读 1', ownerActor)), null);
    assert.equal(cards.prepareMessage({ ...message, eventId: 'replayed-failure' }), null);
  } finally { accounts?.close(); await f.close(); }
});
