import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { createFeishuConnector } from '../src/integrations/feishu-connector.js';
import { normalizeFeishuReadMessage } from '../src/integrations/feishu-messages.js';
import type { FeishuDriverCallbacks, FeishuSendText } from '../src/integrations/feishu-sdk-driver.js';
import type { FeishuReadMessage } from '../src/shared/feishu-reading.js';
import type { PreparedFeishuReadReply } from '../src/server/feishu-reading.js';

const scope = { appId: 'cli_0000000000000000', tenantKey: 'synthetic-tenant' };
const env = { LM_FEISHU_ENABLED: '1', LM_FEISHU_APP_ID: scope.appId,
  LM_FEISHU_APP_SECRET: 'synthetic-secret', LM_FEISHU_TENANT_KEY: scope.tenantKey };
function event(openId = 'actor', messageId = 'message', text = '知识') {
  return { schema: '2.0', event_type: 'im.message.receive_v1', event_id: `event-${messageId}`, app_id: scope.appId, tenant_key: scope.tenantKey,
    sender: { sender_type: 'user', sender_id: { open_id: openId }, tenant_key: scope.tenantKey },
    message: { chat_type: 'p2p', message_type: 'text', message_id: messageId, chat_id: 'chat', content: JSON.stringify({ text }) } };
}
function prepared(input: FeishuReadMessage, options: Partial<PreparedFeishuReadReply> = {}): PreparedFeishuReadReply {
  return { actor: { ...scope, openId: input.openId }, operationId: 'a'.repeat(32), text: 'Synthetic body',
    stillAuthorized: () => true, settle() {}, ...options };
}

test('reading message projection rejects group, bot, wrong scope and raw envelopes and retains only bounded command data', () => {
  const valid = event();
  assert.deepEqual(normalizeFeishuReadMessage({ ...valid, accountId: 'ignored-owner', permissions: ['admin'] }, scope),
    { ...scope, openId: 'actor', messageId: 'message', eventId: 'event-message', chatId: 'chat', text: '知识' });
  const invalid = [{ ...valid, app_id: 'other-app' }, { ...valid, tenant_key: 'other-tenant' },
    { ...valid, sender: { ...valid.sender, sender_type: 'bot' } }, { ...valid, sender: { ...valid.sender, tenant_key: 'other' } },
    { ...valid, message: { ...valid.message, chat_type: 'group' } }, { ...valid, schema: '1.0' },
    { ...valid, header: {} }, { ...valid, event: {} }, event('actor', 'message', '你好'),
    event('actor', 'message', '知识库'), event('actor', 'message', '知识 ' + 'x'.repeat(4096))];
  for (const item of invalid) assert.equal(normalizeFeishuReadMessage(item, scope), null);
  assert.equal(normalizeFeishuReadMessage(event('actor', 'message', '知识 ' + 'x'.repeat(3000)), scope)?.text.length, 3003);
  assert.equal(normalizeFeishuReadMessage({ ...valid, message: { ...valid.message,
    content: JSON.stringify({ text: '知识', filler: 'x'.repeat(16384) }) } }, scope), null);
});

test('binding stays synchronous while reading is acknowledged promptly and sent only to the authorized actor', async () => {
  let hooks!: FeishuDriverCallbacks;
  const sent: FeishuSendText[] = [];
  const settled: string[] = [];
  let bindings = 0;
  const connector = createFeishuConnector({ env, confirmBinding: () => { bindings++; return { status: 'confirmed' }; },
    prepareReading: (input) => prepared(input, { settle: (value) => { settled.push(value); } }),
    driverFactory: async (_config, callbacks) => { hooks = callbacks; return { start() {}, close() {},
      async sendText(input) { sent.push(input); return 'platform-accepted'; } }; } });
  try {
    await connector.start(); hooks.onReady();
    assert.equal(hooks.onMessage!(event('actor', 'binding', `确认绑定 LM-${'a'.repeat(22)}`)), undefined);
    assert.equal(bindings, 1);
    assert.equal(hooks.onMessage!(event()), undefined);
    await setImmediate();
    assert.deepEqual(sent.map(({ stillAuthorized, ...value }) => {
      assert.equal(stillAuthorized(), true); return value;
    }), [{ openId: 'actor', text: 'Synthetic body', uuid: 'a'.repeat(32) }]);
    assert.deepEqual(settled, ['platform-accepted']);
    assert.equal(connector.getStatus().state, 'connected');
  } finally { await connector.stop(); }
});

test('revoked authorization, destination mismatch, missing sender and failed sender settle without leaking or changing WS state', async () => {
  for (const mode of ['revoked', 'wrong-actor', 'missing-sender', 'send-throw', 'send-fail', 'settle-throw']) {
    let hooks!: FeishuDriverCallbacks;
    let sent = 0;
    const receipts: string[] = [];
    const connector = createFeishuConnector({ env,
      prepareReading: (input) => prepared(input, {
        stillAuthorized: () => mode !== 'revoked',
        ...(mode === 'wrong-actor' ? { actor: { ...scope, openId: 'another-user' } } : {}),
        settle: (result) => { receipts.push(result); if (mode === 'settle-throw') throw new Error('synthetic secret'); },
      }),
      driverFactory: async (_config, callbacks) => { hooks = callbacks; return { start() {}, close() {},
        ...(mode === 'missing-sender' ? {} : { async sendText() {
          sent++; if (mode === 'send-throw') throw new Error('synthetic secret');
          return mode === 'send-fail' ? 'failed-or-unknown' as const : 'platform-accepted' as const;
        } }),
      }; } });
    try {
      await connector.start(); hooks.onReady(); hooks.onMessage!(event()); await setImmediate();
      assert.equal(sent, ['revoked', 'wrong-actor', 'missing-sender'].includes(mode) ? 0 : 1);
      assert.deepEqual(receipts, [mode === 'settle-throw' ? 'platform-accepted' : 'failed-or-unknown']);
      assert.equal(connector.getStatus().state, 'connected');
    } finally { await connector.stop(); }
  }
});

test('stop rejects scheduled and late reads and waits for an already sent request to settle before completing', async () => {
  let hooks!: FeishuDriverCallbacks;
  let release!: () => void;
  let prepareCount = 0;
  let settles = 0;
  let closes = 0;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const connector = createFeishuConnector({ env,
    prepareReading: (input) => { prepareCount++; return prepared(input, { settle: () => { settles++; } }); },
    driverFactory: async (_config, callbacks) => { hooks = callbacks; return { start() {}, close() { closes++; },
      async sendText() { await pending; return 'platform-accepted'; } }; } });
  await connector.start(); hooks.onMessage!(event()); await setImmediate();
  let stopped = false;
  const stopping = connector.stop().then(() => { stopped = true; });
  hooks.onMessage!(event('another-actor', 'late'));
  await setImmediate();
  assert.equal(closes, 1); assert.equal(stopped, false); assert.equal(settles, 0); assert.equal(prepareCount, 1);
  release(); await stopping;
  assert.equal(settles, 1); assert.equal(stopped, true);

  const scheduled = createFeishuConnector({ env, prepareReading: () => { throw new Error('Must not prepare after stop'); },
    driverFactory: async (_config, callbacks) => { hooks = callbacks; return { start() {}, close() {} }; } });
  await scheduled.start(); hooks.onMessage!(event()); await scheduled.stop();
});

test('read admission bounds global concurrency and actor rate without queuing overflow', async () => {
  let hooks!: FeishuDriverCallbacks;
  let instant = 0;
  let release!: () => void;
  let prepares = 0;
  let sends = 0;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const connector = createFeishuConnector({ env, now: () => instant,
    prepareReading: (input) => { prepares++; return prepared(input); },
    driverFactory: async (_config, callbacks) => { hooks = callbacks; return { start() {}, close() {},
      async sendText() { sends++; await pending; return 'platform-accepted'; } }; } });
  try {
    await connector.start();
    for (let i = 0; i < 5; i++) hooks.onMessage!(event(`actor-${i}`, `message-${i}`));
    hooks.onMessage!(event('actor-0', 'same-actor-new-message'));
    await setImmediate(); assert.equal(prepares, 4); assert.equal(sends, 4);
    release(); await setImmediate();
    hooks.onMessage!(event('actor-0', 'cooldown')); await setImmediate(); assert.equal(prepares, 4);
    instant = 1000;
    hooks.onMessage!(event('actor-0', 'after-cooldown')); await setImmediate(); assert.equal(prepares, 5);
  } finally { release(); await connector.stop(); }
});

test('actor cooldown memory stays bounded and safely expires; invalid clocks do not escape SDK callback', async () => {
  let hooks!: FeishuDriverCallbacks;
  let instant = 0;
  let prepares = 0;
  const connector = createFeishuConnector({ env, now: () => instant,
    prepareReading: (input) => { prepares++; return prepared(input); },
    driverFactory: async (_config, callbacks) => { hooks = callbacks; return { start() {}, close() {},
      async sendText() { return 'platform-accepted'; } }; } });
  try {
    await connector.start();
    for (let i = 0; i < 257; i++) { hooks.onMessage!(event(`actor-${i}`, `msg-${i}`)); await setImmediate(); }
    assert.equal(prepares, 256);
    instant = 1000; hooks.onMessage!(event('new-actor', 'fresh')); await setImmediate(); assert.equal(prepares, 257);
    instant = Number.NaN; assert.doesNotThrow(() => hooks.onMessage!(event('invalid-clock', 'clock')));
    await setImmediate(); assert.equal(prepares, 257);
  } finally { await connector.stop(); }
});
