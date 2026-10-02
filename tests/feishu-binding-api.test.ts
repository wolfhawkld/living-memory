import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, request } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server/app.js';
import { createFeishuConnector } from '../src/integrations/feishu-connector.js';
import { FEISHU_SILENT_LOGGER, type FeishuDriverCallbacks } from '../src/integrations/feishu-sdk-driver.js';
import type { FeishuBindingIssued, FeishuBindingStatus, FeishuChannelState } from '../src/shared/feishu-binding.js';

const scope = { appId: 'cli_0000000000000000', tenantKey: 'synthetic-tenant' };
const prefix = '/api/feishu/binding';
type Credentials = { cookie: string; headers: Record<string, string> };
async function fixture(options: { accountsEnabled?: boolean; configured?: boolean } = {}) {
  const temp = mkdtempSync(join(tmpdir(), 'lm-feishu-api-'));
  const root = join(temp, 'synthetic-kg');
  const dataDir = join(temp, 'data');
  mkdirSync(join(root, 'Math'), { recursive: true });
  writeFileSync(join(root, 'Math', 'Test.md'), '---\ntype: concept\ntitle: Synthetic concept\n---\nSynthetic body.');
  let channelState: FeishuChannelState = 'connected';
  const app = createApp({ root, dataDir, staticDir: join(temp, 'none'), port: 4317,
    accountsEnabled: options.accountsEnabled !== false,
    feishuScope: options.configured === false ? null : scope, getFeishuChannelState: () => channelState });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const send = (path: string, input: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) =>
    new Promise<{ status: number; body: any; cookie: string; text: string }>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port, path, method: input.method ?? 'GET', headers: {
        host: '127.0.0.1:4317', 'content-type': 'application/json', ...(input.cookie ? { cookie: input.cookie } : {}), ...input.headers,
      } }, (res) => {
        let text = ''; res.setEncoding('utf8'); res.on('data', (chunk) => text += chunk);
        res.on('end', () => resolve({ status: res.statusCode!, body: text ? JSON.parse(text) : null,
          cookie: res.headers['set-cookie']?.[0]?.split(';')[0] ?? '', text }));
      });
      req.on('error', reject);
      if (input.body !== undefined) req.write(JSON.stringify(input.body));
      req.end();
    });
  const credentials = async (cookie: string): Promise<Credentials> => {
    const session = (await send('/api/session', { cookie })).body;
    return { cookie, headers: { 'x-lm-token': session.writeToken, 'x-lm-source-id': session.sourceId } };
  };
  const owner = async () => {
    const response = await send('/api/auth/setup', { method: 'POST', body: { username: 'owner', password: 'synthetic-owner-password' } });
    assert.equal(response.status, 201);
    return credentials(response.cookie);
  };
  return { app, dataDir, send, owner, credentials, setChannel: (state: FeishuChannelState) => { channelState = state; },
    close: async () => {
      app.livingMemory.closeChanges();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      app.livingMemory.close(); rmSync(temp, { recursive: true, force: true });
    } };
}

test('binding APIs require a browser account and CSRF and never accept payload account or scope', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.send(prefix)).status, 401);
    const owner = await f.owner();
    assert.equal((await f.send(`${prefix}/request`, { method: 'POST', cookie: owner.cookie, body: {} })).status, 401);
    for (const body of [{ accountId: 'another-account' }, { appId: scope.appId }, { tenantKey: scope.tenantKey }, null, []]) {
      assert.equal((await f.send(`${prefix}/request`, { ...owner, method: 'POST', body })).status, 400);
    }
    assert.equal((await f.send(`${prefix}/cancel`, { ...owner, method: 'POST', body: {} })).status, 400);
    assert.equal((await f.send(`${prefix}/revoke`, { ...owner, method: 'POST', body: { bindingId: 1 } })).status, 400);
    const device = JSON.parse(readFileSync(join(f.dataDir, 'cli-session.json'), 'utf8'));
    const bearer = { authorization: `Bearer ${device.sessionToken}` };
    const deviceSession = (await f.send('/api/session', { headers: bearer })).body;
    for (const [path, method, body] of [[prefix, 'GET', undefined], [`${prefix}/request`, 'POST', {}],
      [`${prefix}/cancel`, 'POST', { requestId: 'synthetic-id' }], [`${prefix}/revoke`, 'POST', { bindingId: 'synthetic-id' }]] as const) {
      assert.equal((await f.send(path, { method, body, headers: { ...bearer, 'x-lm-token': deviceSession.writeToken } })).status, 403);
    }
    const issued = await f.send(`${prefix}/request`, { ...owner, method: 'POST', body: {} });
    assert.equal(issued.status, 201);
    assert.match(issued.body.command, /^确认绑定 LM-[A-Za-z0-9_-]{22}$/);
    const status = await f.send(prefix, owner);
    assert.equal(status.body.request.id, issued.body.request.id);
    assert.equal(status.text.includes(issued.body.command), false);
    assert.doesNotMatch(status.text, /code_hash|command|sessionId|password/);
    f.setChannel('disabled');
    assert.equal((await f.send(`${prefix}/request`, { ...owner, method: 'POST', body: {} })).status, 409);
    assert.equal((await f.send(`${prefix}/cancel`, { ...owner, method: 'POST', body: { requestId: issued.body.request.id } })).body.request.status, 'cancelled');
  } finally { await f.close(); }
});

test('real offline SDK message parsing reaches temporary Accounts and preserves account isolation and learning state', async () => {
  const f = await fixture();
  let connector: ReturnType<typeof createFeishuConnector> | undefined;
  try {
    const owner = await f.owner();
    const created = await f.send('/api/admin/users', { ...owner, method: 'POST', body: { username: 'member', password: 'synthetic-member-password' } });
    assert.equal(created.status, 201);
    const login = await f.send('/api/auth/login', { method: 'POST', body: { username: 'member', password: 'synthetic-member-password' } });
    const member = await f.credentials(login.cookie);
    const issue = await f.send(`${prefix}/request`, { ...owner, method: 'POST', body: {} });
    const issued = issue.body as FeishuBindingIssued;
    const memberIssue = (await f.send(`${prefix}/request`, { ...member, method: 'POST', body: {} })).body as FeishuBindingIssued;
    const beforeLearning = (await f.send('/api/export', owner)).body;
    let callbacks!: FeishuDriverCallbacks;
    connector = createFeishuConnector({ env: { LM_FEISHU_ENABLED: '1', LM_FEISHU_APP_ID: scope.appId,
      LM_FEISHU_APP_SECRET: 'synthetic-secret', LM_FEISHU_TENANT_KEY: scope.tenantKey },
      driverFactory: async (_config, hooks) => { callbacks = hooks; return { start() {}, close() {} }; },
      confirmBinding: (input) => f.app.livingMemory.feishuBinding.confirm(input),
    });
    await connector.start();
    const sdk = await import('@larksuiteoapi/node-sdk');
    // Actual parser, synthetic driver and real isolated Accounts. Never construct/start WSClient.
    const dispatcher = new sdk.EventDispatcher({ logger: FEISHU_SILENT_LOGGER }).register({
      'im.message.receive_v1': (input: unknown) => {
        const flat = input as Record<string, unknown>;
        assert.equal(flat.schema, '2.0');
        assert.equal(Object.hasOwn(flat, 'header'), false);
        assert.equal(Object.hasOwn(flat, 'event'), false);
        callbacks.onMessage!(input);
      },
    });
    const raw = (command: string, openId: string, eventId = 'synthetic-event') => ({
      schema: '2.0', header: { event_type: 'im.message.receive_v1', event_id: eventId, app_id: scope.appId, tenant_key: scope.tenantKey },
      event: { sender: { sender_type: 'user', tenant_key: scope.tenantKey, sender_id: { open_id: openId } },
        message: { message_type: 'text', chat_type: 'p2p', message_id: `message-${eventId}`, chat_id: 'synthetic-chat',
          content: JSON.stringify({ text: command }) } },
    });
    // needCheck:false verifies only offline parsing, not platform authentication.
    await dispatcher.invoke(raw(issued.command, 'synthetic-owner-actor'), { needCheck: false });
    const bound = (await f.send(prefix, owner)).body as FeishuBindingStatus;
    assert.equal(bound.request?.status, 'confirmed');
    assert.equal(bound.binding?.openId, 'synthetic-owner-actor');
    const bindingId = bound.binding!.id;
    await dispatcher.invoke(raw(issued.command, 'synthetic-owner-actor', 'synthetic-repeat'), { needCheck: false });
    assert.equal((await f.send(prefix, owner)).body.binding.id, bindingId);
    const otherStatus = (await f.send(prefix, member)).body as FeishuBindingStatus;
    assert.equal(otherStatus.binding, null);
    assert.equal(otherStatus.request?.id, memberIssue.request.id);
    assert.equal((await f.send(`${prefix}/revoke`, { ...member, method: 'POST', body: { bindingId } })).status, 404);
    await dispatcher.invoke(raw(memberIssue.command, 'synthetic-owner-actor', 'member-attempt'), { needCheck: false });
    assert.equal((await f.send(prefix, member)).body.binding, null, 'same actor cannot be silently moved to another account');
    const afterLearning = (await f.send('/api/export', owner)).body;
    for (const key of ['anchors', 'observations', 'retentions', 'applications']) {
      assert.deepEqual(afterLearning[key], beforeLearning[key], 'binding is not learning evidence');
    }
    f.setChannel('disabled');
    const revoke = await f.send(`${prefix}/revoke`, { ...owner, method: 'POST', body: { bindingId } });
    assert.equal(revoke.status, 200);
    assert.equal(revoke.body.binding, null);
    await dispatcher.invoke(raw(issued.command, 'synthetic-owner-actor', 'late-old-message'), { needCheck: false });
    assert.equal((await f.send(prefix, owner)).body.binding, null);
    f.setChannel('connected');
    const next = (await f.send(`${prefix}/request`, { ...owner, method: 'POST', body: {} })).body as FeishuBindingIssued;
    assert.equal((await f.send(`${prefix}/revoke`, { ...owner, method: 'POST', body: { bindingId } })).status, 200);
    assert.equal((await f.send(prefix, owner)).body.request.id, next.request.id);
    assert.equal((await f.send(prefix, owner)).body.request.status, 'pending', 'old revoke retry cannot invalidate a new request');
  } finally { await connector?.stop(); await f.close(); }
});

test('disabled configuration and local mode cannot issue or confirm bindings', async () => {
  for (const options of [{ configured: false }, { accountsEnabled: false }]) {
    const f = await fixture(options);
    try {
      const credentials = options.accountsEnabled === false ? undefined : await f.owner();
      const status = await f.send(prefix, credentials);
      assert.equal(status.status, options.accountsEnabled === false ? 404 : 200);
      if (credentials) assert.equal(status.body.scope, null);
      assert.deepEqual(f.app.livingMemory.feishuBinding.confirm({ ...scope, openId: 'synthetic-actor',
        code: `LM-${'a'.repeat(22)}`, eventId: 'synthetic-event', messageId: 'synthetic-message', chatId: 'synthetic-chat' }), { status: 'rejected' });
      if (credentials) {
        assert.equal((await f.send(`${prefix}/request`, { ...credentials, method: 'POST', body: {} })).status, 409);
      }
    } finally { await f.close(); }
  }
});

test('internal confirmation capability rechecks app and tenant even if caller bypasses the parser', async () => {
  const f = await fixture();
  try {
    const owner = await f.owner();
    const issued = (await f.send(`${prefix}/request`, { ...owner, method: 'POST', body: {} })).body as FeishuBindingIssued;
    const input = { ...scope, openId: 'synthetic-actor', code: issued.command.split(' ')[1],
      eventId: 'synthetic-event', messageId: 'synthetic-message', chatId: 'synthetic-chat' };
    for (const change of [{ appId: 'other-app' }, { tenantKey: 'other-tenant' }]) {
      assert.deepEqual(f.app.livingMemory.feishuBinding.confirm({ ...input, ...change }), { status: 'rejected' });
    }
    assert.equal((await f.send(prefix, owner)).body.request.status, 'pending');
    assert.deepEqual(f.app.livingMemory.feishuBinding.confirm(input), { status: 'confirmed' });
  } finally { await f.close(); }
});
