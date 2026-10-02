import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, request } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTick } from 'node:timers/promises';
import { createApp } from '../src/server/app.js';
import { createFeishuConnector } from '../src/integrations/feishu-connector.js';
import { FEISHU_SILENT_LOGGER, type FeishuDriverCallbacks } from '../src/integrations/feishu-sdk-driver.js';
import type { PreparedFeishuReadReply } from '../src/server/feishu-reading.js';
import type { FeishuReadMessage } from '../src/shared/feishu-reading.js';

const scope = { appId: 'cli_0000000000000000', tenantKey: 'synthetic-tenant' };
const ownerActor = { ...scope, openId: 'owner_open' };
const memberActor = { ...scope, openId: 'member_open' };
type Credentials = { cookie: string; headers: Record<string, string> };
function note(root: string, name: string, title: string, body: string) {
  mkdirSync(join(root, 'Math'), { recursive: true });
  writeFileSync(join(root, 'Math', `${name}.md`), `---\ntype: concept\ntitle: ${title}\n---\n${body}`);
}
async function fixture(options: { accountsEnabled?: boolean; configured?: boolean } = {}) {
  const temp = mkdtempSync(join(tmpdir(), 'lm-feishu-reading-api-'));
  const root = join(temp, 'owner-kg');
  const dataDir = join(temp, 'data');
  for (let i = 0; i < 6; i++) note(root, `Owner${i}`, `OwnerOnly${i}`, `Owner-private-body-${i}`);
  const appOptions = { root, dataDir, staticDir: join(temp, 'none'), port: 4317, limit: 1,
    accountsEnabled: options.accountsEnabled !== false, feishuScope: options.configured === false ? null : scope,
    getFeishuChannelState: () => 'connected' as const };
  let app = createApp(appOptions);
  let server = createServer(app);
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
      });
      req.on('error', reject); if (input.body !== undefined) req.write(JSON.stringify(input.body)); req.end();
    });
  const credentials = async (cookie: string): Promise<Credentials> => {
    const session = (await send('/api/session', { cookie })).body;
    return { cookie, headers: { 'x-lm-token': session.writeToken, 'x-lm-source-id': session.sourceId } };
  };
  async function bind(credentials: Credentials, actor: typeof ownerActor) {
    const issued = await send('/api/feishu/binding/request', { ...credentials, method: 'POST', body: {} });
    assert.equal(issued.status, 201);
    assert.equal(app.livingMemory.feishuBinding.confirm({ ...actor, code: issued.body.command.split(' ')[1],
      eventId: `bind-${actor.openId}`, messageId: `bind-message-${actor.openId}`, chatId: 'synthetic-chat' }).status, 'confirmed');
  }
  async function users() {
    const setup = await send('/api/auth/setup', { method: 'POST', body: { username: 'owner', password: 'synthetic-owner-password' } });
    assert.equal(setup.status, 201);
    const owner = await credentials(setup.cookie);
    const created = await send('/api/admin/users', { ...owner, method: 'POST', body: { username: 'member', password: 'synthetic-member-password' } });
    assert.equal(created.status, 201);
    const memberId = created.body.id ?? created.body.user?.id;
    assert.equal(typeof memberId, 'string');
    const memberRoot = join(dataDir, 'users', memberId, 'knowledge');
    note(memberRoot, 'Member0', 'MemberOnly0', `Member-private-first\n${'synthetic-details '.repeat(300)}\nMember-private-tail`);
    note(memberRoot, 'Member1', 'MemberOnly1', 'Member-second-body');
    const login = await send('/api/auth/login', { method: 'POST', body: { username: 'member', password: 'synthetic-member-password' } });
    const member = await credentials(login.cookie);
    assert.equal((await send('/api/refresh', { ...member, method: 'POST', body: {} })).status, 200);
    await bind(owner, ownerActor); await bind(member, memberActor);
    return { owner, member, memberId, memberRoot };
  }
  async function stopApp() {
    app.livingMemory.closeChanges();
    await new Promise<void>(resolve => server.close(() => resolve()));
    app.livingMemory.close();
  }
  return { get app() { return app; }, root, dataDir, send, credentials, bind, users,
    reopen: async () => { await stopApp(); app = createApp(appOptions); server = createServer(app); await listen(); },
    close: async () => { await stopApp(); rmSync(temp, { recursive: true, force: true }); } };
}
function input(text: string, messageId: string, actor = memberActor): FeishuReadMessage {
  return { ...actor, text, messageId, eventId: `event-${messageId}`, chatId: 'private-chat' };
}
function raw(message: FeishuReadMessage, changes: { chatType?: string; senderType?: string } = {}) {
  return { schema: '2.0', header: { event_type: 'im.message.receive_v1', event_id: message.eventId, app_id: message.appId, tenant_key: message.tenantKey },
    event: { sender: { sender_type: changes.senderType ?? 'user', tenant_key: message.tenantKey, sender_id: { open_id: message.openId } },
      message: { message_type: 'text', chat_type: changes.chatType ?? 'p2p', message_id: message.messageId, chat_id: message.chatId,
        content: JSON.stringify({ text: message.text }) } } };
}
async function channel(f: Awaited<ReturnType<typeof fixture>>, prepared?: PreparedFeishuReadReply) {
  let callbacks!: FeishuDriverCallbacks;
  let clock = 0;
  const sent: { openId: string; text: string; uuid: string }[] = [];
  const connector = createFeishuConnector({ env: { LM_FEISHU_ENABLED: '1', LM_FEISHU_APP_ID: scope.appId,
    LM_FEISHU_APP_SECRET: 'synthetic-secret', LM_FEISHU_TENANT_KEY: scope.tenantKey }, now: () => clock,
    prepareReading: message => prepared ?? f.app.livingMemory.feishuReading.prepare(message),
    driverFactory: async (_config, hooks) => { callbacks = hooks; return { start() {}, close() {},
      async sendText(message) { sent.push(message); return 'platform-accepted'; } }; } });
  await connector.start();
  const sdk = await import('@larksuiteoapi/node-sdk');
  // Actual SDK parsing only; no WSClient, Client or network is constructed.
  const dispatcher = new sdk.EventDispatcher({ logger: FEISHU_SILENT_LOGGER }).register({
    'im.message.receive_v1': (event: unknown) => callbacks.onMessage!(event),
  });
  return { connector, sent, invoke: async (message: FeishuReadMessage, changes = {}) => {
    clock += 1100;
    await dispatcher.invoke(raw(message, changes), { needCheck: false });
    await nextTick();
  } };
}
const learningKeys = ['anchors', 'observations', 'retentions', 'applications', 'corrections', 'practice', 'config', 'configHistory', 'reviewPlan', 'layout', 'restoreMetadata'];

test('offline SDK read chain isolates accounts, uses the full index and preserves learning records', async () => {
  const f = await fixture();
  let c: Awaited<ReturnType<typeof channel>> | undefined;
  try {
    const users = await f.users();
    assert.equal(f.app.livingMemory.getSource().graph.concepts.length, 1);
    assert.equal(f.app.livingMemory.getSource().index.concepts.length, 6);
    const before = { owner: (await f.send('/api/export', users.owner)).body, member: (await f.send('/api/export', users.member)).body };
    c = await channel(f);
    await c.invoke(input('知识 搜索 OwnerOnly5', 'owner-full-index', ownerActor));
    assert.match(c.sent.at(-1)!.text, /OwnerOnly5/);
    await c.invoke(input('知识 搜索 OwnerOnly5', 'member-owner-search'));
    assert.match(c.sent.at(-1)!.text, /没有匹配节点/);
    assert.doesNotMatch(c.sent.at(-1)!.text, /OwnerOnly5|Owner-private|owner-kg/);
    await c.invoke(input('知识 搜索 MemberOnly0', 'member-search'));
    const match = /阅读：知识 阅读 ([a-f0-9]{12,64})/.exec(c.sent.at(-1)!.text);
    assert.ok(match, c.sent.at(-1)!.text);
    const reference = match[1];
    await c.invoke(input(`知识 阅读 ${reference}`, 'member-read'));
    assert.match(c.sent.at(-1)!.text, /Member-private-first/);
    assert.doesNotMatch(c.sent.at(-1)!.text, /OwnerOnly|Owner-private|owner-kg/);
    const next = /下一页：(知识 阅读 [a-f0-9]+ \d+ [a-f0-9]+)/.exec(c.sent.at(-1)!.text)![1];
    await c.invoke(input(next, 'member-read-page2'));
    assert.match(c.sent.at(-1)!.text, /Member-private-tail/);
    const ownerId = f.app.livingMemory.getSource().index.concepts[5]!.id;
    const ownerRef = createHash('sha256').update(ownerId).digest('hex').slice(0, 12);
    await c.invoke(input(`知识 阅读 ${ownerRef}`, 'cross-account-reference'));
    assert.match(c.sent.at(-1)!.text, /引用不存在/);
    assert.doesNotMatch(c.sent.at(-1)!.text, /OwnerOnly|Owner-private|owner-kg/);
    const count = c.sent.length;
    await c.invoke(input('知识', 'unknown-actor', { ...memberActor, openId: 'unbound' }));
    await c.invoke(input('知识', 'wrong-tenant', { ...memberActor, tenantKey: 'wrong' }));
    await c.invoke(input('知识', 'group'), { chatType: 'group' });
    await c.invoke(input('知识', 'bot'), { senderType: 'app' });
    assert.equal(c.sent.length, count);
    for (const [user, credentials] of Object.entries({ owner: users.owner, member: users.member })) {
      const after = (await f.send('/api/export', credentials)).body;
      for (const key of learningKeys) assert.deepEqual(after[key], before[user as 'owner' | 'member'][key], `read-only ${user} ${key}`);
    }
  } finally { await c?.connector.stop(); await f.close(); }
});

test('message identity deduplication survives new event IDs, connector replacement and app reopening', async () => {
  const f = await fixture();
  let c: Awaited<ReturnType<typeof channel>> | undefined;
  try {
    await f.users(); c = await channel(f);
    const message = input('知识', 'stable-message');
    await c.invoke(message);
    await c.invoke({ ...message, eventId: 'different-event' });
    assert.equal(c.sent.length, 1);
    await c.connector.stop(); c = await channel(f);
    await c.invoke({ ...message, eventId: 'after-restart' });
    assert.equal(c.sent.length, 0);
    await c.connector.stop(); await f.reopen(); c = await channel(f);
    await c.invoke({ ...message, eventId: 'after-app-reopen' });
    assert.equal(c.sent.length, 0);
    await c.invoke(input('知识', 'new-message'));
    assert.equal(c.sent.length, 1);
  } finally { await c?.connector.stop(); await f.close(); }
});

test('prepared replies invalidate after source refresh, revocation/rebind and password change', async () => {
  const f = await fixture();
  try {
    const users = await f.users();
    const assertNotSent = async (prepared: PreparedFeishuReadReply, messageId: string) => {
      const c = await channel(f, prepared);
      try { await c.invoke(input('知识', messageId)); assert.equal(c.sent.length, 0); }
      finally { await c.connector.stop(); }
    };
    const first = f.app.livingMemory.feishuReading.prepare(input('知识', 'before-source-refresh'))!;
    assert.equal(first.stillAuthorized(), true);
    note(users.memberRoot, 'Member0', 'MemberOnly0', 'Changed member source body');
    const refresh = await f.send('/api/refresh', { ...users.member, method: 'POST', body: {} });
    assert.equal(refresh.status, 200);
    assert.equal(first.stillAuthorized(), false);
    await assertNotSent(first, 'stale-source-not-sent');
    const stale = f.app.livingMemory.feishuReading.prepare(input('知识', 'before-aba'))!;
    const status = (await f.send('/api/feishu/binding', users.member)).body;
    assert.equal((await f.send('/api/feishu/binding/revoke', { ...users.member, method: 'POST', body: { bindingId: status.binding.id } })).status, 200);
    await f.bind(users.member, memberActor);
    assert.equal(stale.stillAuthorized(), false);
    await assertNotSent(stale, 'stale-binding-not-sent');
    const changed = f.app.livingMemory.feishuReading.prepare(input('知识', 'before-password-change'))!;
    assert.equal((await f.send(`/api/admin/users/${users.memberId}`, { ...users.owner, method: 'PUT', body: { password: 'new-synthetic-member-password' } })).status, 200);
    assert.equal(changed.stillAuthorized(), false);
    await assertNotSent(changed, 'stale-account-not-sent');
  } finally { await f.close(); }
});

test('direct preparation rejects wrong scope, disabled configuration and local account mode', async () => {
  const f = await fixture();
  try {
    await f.users();
    assert.equal(f.app.livingMemory.feishuReading.prepare(input('知识', 'wrong-app', { ...memberActor, appId: 'wrong' })), null);
    assert.equal(f.app.livingMemory.feishuReading.prepare(input('知识', 'wrong-tenant', { ...memberActor, tenantKey: 'wrong' })), null);
  } finally { await f.close(); }
  for (const options of [{ configured: false }, { accountsEnabled: false }]) {
    const f = await fixture(options);
    try { assert.equal(f.app.livingMemory.feishuReading.prepare(input('知识', 'not-enabled')), null); }
    finally { await f.close(); }
  }
});
