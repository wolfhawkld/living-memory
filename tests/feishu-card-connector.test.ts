import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { createFeishuConnector } from '../src/integrations/feishu-connector.js';
import { FEISHU_SILENT_LOGGER, type FeishuDriverCallbacks, type FeishuSendCard } from '../src/integrations/feishu-sdk-driver.js';
import type { PreparedFeishuCardReply } from '../src/server/feishu-cards.js';
import type { FeishuActor } from '../src/shared/feishu-binding.js';
import type { FeishuCardDelivery } from '../src/shared/feishu-cards.js';

const scope = { appId: 'cli_0000000000000000', tenantKey: 'synthetic-tenant' };
const env = { LM_FEISHU_ENABLED: '1', LM_FEISHU_APP_ID: scope.appId, LM_FEISHU_APP_SECRET: 'synthetic-secret', LM_FEISHU_TENANT_KEY: scope.tenantKey };
const accepted: FeishuCardDelivery = { status: 'platform-accepted', messageId: 'new-card-message', chatId: 'synthetic-chat' };
function action(openId = 'actor', eventId = 'synthetic-action') {
  return { schema: '2.0', event_type: 'card.action.trigger', event_id: eventId, app_id: scope.appId, tenant_key: scope.tenantKey,
    operator: { open_id: openId, tenant_key: scope.tenantKey }, context: { open_message_id: 'old-card-message', open_chat_id: 'synthetic-chat' },
    action: { tag: 'button', value: { kind: 'lm.nav.v1', cardId: 'a'.repeat(32), actionId: 'a0' } } };
}
function message(openId = 'actor', text = '知识 卡片', id = 'synthetic-message') {
  return { schema: '2.0', event_type: 'im.message.receive_v1', event_id: `event-${id}`, app_id: scope.appId, tenant_key: scope.tenantKey,
    sender: { sender_type: 'user', sender_id: { open_id: openId }, tenant_key: scope.tenantKey },
    message: { chat_type: 'p2p', message_type: 'text', message_id: id, chat_id: 'synthetic-chat', content: JSON.stringify({ text }) } };
}
function prepared(actor: FeishuActor, changes: Partial<PreparedFeishuCardReply> = {}): PreparedFeishuCardReply {
  return { actor: { appId: actor.appId, tenantKey: actor.tenantKey, openId: actor.openId }, operationId: 'b'.repeat(32),
    card: { schema: '2.0', body: { elements: [{ tag: 'markdown', content: 'Synthetic new knowledge card' }] } },
    expectedChatId: 'synthetic-chat', stillAuthorized: () => true, settle() {}, ...changes };
}

test('SDK callback returns a fixed immediate toast, then asynchronously sends and settles a new private card', async () => {
  let hooks!: FeishuDriverCallbacks; let prepares = 0;
  const sent: FeishuSendCard[] = []; const settled: FeishuCardDelivery[] = [];
  const connector = createFeishuConnector({ env, prepareCardAction(input) { prepares++; return prepared(input, { settle: (result) => { settled.push(result); } }); },
    driverFactory: async (_config, callbacks) => { hooks = callbacks; return { start() {}, close() {}, async sendCard(input) { sent.push(input); return accepted; } }; } });
  try {
    await connector.start(); hooks.onReady();
    const toast = hooks.onCardAction(action());
    assert.deepEqual(toast, { toast: { type: 'info', content: '已收到操作；无新卡时请发送「知识 卡片」。' } });
    assert.equal(prepares, 0); assert.equal(sent.length, 0);
    await setImmediate(); assert.equal(prepares, 1); assert.equal(sent.length, 1);
    assert.equal(sent[0].openId, 'actor'); assert.equal(sent[0].expectedChatId, 'synthetic-chat');
    assert.equal(sent[0].uuid, 'b'.repeat(32)); assert.equal(sent[0].card.schema, '2.0'); assert.equal(sent[0].stillAuthorized(), true);
    assert.deepEqual(settled, [accepted]); assert.equal(connector.getStatus().state, 'connected');
  } finally { await connector.stop(); }
});

test('pinned SDK dispatcher acknowledges the callback before the next macrotask starts card preparation', async () => {
  const sdk = await import('@larksuiteoapi/node-sdk');
  let hooks!: FeishuDriverCallbacks; let prepares = 0; let sends = 0;
  const connector = createFeishuConnector({ env, prepareCardAction(input) { prepares++; return prepared(input); },
    driverFactory: async (_config, callbacks) => { hooks = callbacks; return { start() {}, close() {}, async sendCard() { sends++; return accepted; } }; } });
  try {
    await connector.start();
    const dispatcher = new sdk.EventDispatcher({ logger: FEISHU_SILENT_LOGGER });
    // Pinned runtime supports callbacks; its exported IHandles lists event subscriptions only.
    dispatcher.register({ 'card.action.trigger': (input: unknown) => hooks.onCardAction(input) } as unknown as Parameters<typeof dispatcher.register>[0]);
    const { schema, event_type, event_id, app_id, tenant_key, ...event } = action();
    const toast = await dispatcher.invoke({ schema, header: { event_type, event_id, app_id, tenant_key }, event }, { needCheck: false });
    assert.deepEqual(toast, { toast: { type: 'info', content: '已收到操作；无新卡时请发送「知识 卡片」。' } });
    assert.equal(prepares, 0, 'SDK invoke must return its ACK before any local database preparation');
    assert.equal(sends, 0);
    await setImmediate(); assert.equal(prepares, 1); assert.equal(sends, 1);
  } finally { await connector.stop(); }
});

test('stop waits for an admitted pending macrotask but prevents it from starting card preparation', async () => {
  let hooks!: FeishuDriverCallbacks; let prepares = 0; let sends = 0;
  const connector = createFeishuConnector({ env, prepareCardAction(input) { prepares++; return prepared(input); },
    driverFactory: async (_config, callbacks) => { hooks = callbacks; return { start() {}, close() {}, async sendCard() { sends++; return accepted; } }; } });
  await connector.start();
  hooks.onCardAction(action());
  let stopped = false;
  const stopping = connector.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false, 'the already-admitted next-turn promise is tracked until it finishes');
  assert.equal(prepares, 0);
  await stopping;
  assert.equal(stopped, true); assert.equal(prepares, 0); assert.equal(sends, 0);
});

test('card message entry bypasses plain reading while recognized invalid card syntax receives the card help path', async () => {
  let hooks!: FeishuDriverCallbacks; let cards = 0; let reads = 0; const sent: FeishuSendCard[] = [];
  const connector = createFeishuConnector({ env, prepareCardMessage(input) { cards++; return prepared(input); }, prepareReading() { reads++; return null; },
    driverFactory: async (_config, callbacks) => { hooks = callbacks; return { start() {}, close() {}, async sendCard(input) { sent.push(input); return accepted; } }; } });
  try {
    await connector.start();
    assert.equal(hooks.onMessage!(message('card-user')), undefined);
    hooks.onMessage!(message('due-user', '知识 待复习 量=5', 'due'));
    hooks.onMessage!(message('bad-card-user', '知识 卡片 列表 owner=me', 'help'));
    hooks.onMessage!(message('plain-user', '知识 列表', 'plain'));
    await setImmediate(); assert.equal(cards, 3); assert.equal(reads, 1); assert.equal(sent.length, 3);
  } finally { await connector.stop(); }
});

test('explicit review lifecycle commands use the private card capability through authenticated message projection', async () => {
  let hooks!: FeishuDriverCallbacks; let instant = 0; let reads = 0;
  const received: string[] = []; const sent: FeishuSendCard[] = [];
  const connector = createFeishuConnector({ env, now: () => instant,
    prepareCardMessage(input) { received.push(input.text); return prepared(input); },
    prepareReading() { reads++; return null; },
    driverFactory: async (_config, callbacks) => { hooks = callbacks; return { start() {}, close() {},
      async sendCard(input) { sent.push(input); return accepted; } }; } });
  try {
    await connector.start();
    const commands = ['知识 复习', '知识 暂停复习', '知识 继续复习', '知识 结束复习', '知识 复习 conceptId=forged'];
    for (const [index, text] of commands.entries()) {
      instant += 1100; hooks.onMessage!(message('review-user', text, `review-${index}`));
      await setImmediate();
    }
    assert.deepEqual(received, commands); assert.equal(reads, 0); assert.equal(sent.length, commands.length);
    const otherTenant = { ...message('review-user', '知识 复习', 'wrong-tenant'), tenant_key: 'other' };
    instant += 1100; hooks.onMessage!(otherTenant); await setImmediate();
    assert.equal(received.length, commands.length);
  } finally { await connector.stop(); }
});

test('revocation, actor mismatch, absent sender and thrown/failed sends settle safely without changing connection state', async () => {
  for (const mode of ['revoked', 'wrong-actor', 'wrong-scope', 'no-sender', 'send-throw', 'send-failed', 'settle-throw']) {
    let hooks!: FeishuDriverCallbacks; let sends = 0; const settled: FeishuCardDelivery[] = [];
    const connector = createFeishuConnector({ env, prepareCardAction(input) { return prepared(input, {
      stillAuthorized: () => mode !== 'revoked',
      ...(mode === 'wrong-actor' ? { actor: { ...scope, openId: 'other-user' } } : {}),
      ...(mode === 'wrong-scope' ? { actor: { ...scope, tenantKey: 'other-tenant', openId: input.openId } } : {}),
      settle: (result) => { settled.push(result); if (mode === 'settle-throw') throw new Error('synthetic secret'); },
    }); }, driverFactory: async (_config, callbacks) => { hooks = callbacks; return { start() {}, close() {},
      ...(mode === 'no-sender' ? {} : { async sendCard() { sends++; if (mode === 'send-throw') throw new Error('synthetic secret'); return mode === 'send-failed' ? { status: 'failed-or-unknown' as const } : accepted; } }),
    }; } });
    try {
      await connector.start(); hooks.onReady(); hooks.onCardAction(action()); await setImmediate();
      assert.equal(sends, ['revoked', 'wrong-actor', 'wrong-scope', 'no-sender'].includes(mode) ? 0 : 1);
      assert.deepEqual(settled, [mode === 'settle-throw' ? accepted : { status: 'failed-or-unknown' }]);
      assert.equal(connector.getStatus().state, 'connected');
    } finally { await connector.stop(); }
  }
});

test('invalid scope, envelopes and forged action values are denied before capability preparation', async () => {
  let hooks!: FeishuDriverCallbacks; let prepares = 0;
  const connector = createFeishuConnector({ env, prepareCardAction() { prepares++; return null; },
    driverFactory: async (_config, callbacks) => { hooks = callbacks; return { start() {}, close() {} }; } });
  try {
    await connector.start();
    const valid = action();
    const invalid = [null, {}, { ...valid, app_id: undefined }, { ...valid, tenant_key: undefined },
      { ...valid, app_id: 'other-app' }, { ...valid, tenant_key: 'other-tenant' }, { ...valid, header: {} },
      { ...valid, action: { ...valid.action, value: { ...valid.action.value, userId: 'owner' } } },
      { ...valid, action: { ...valid.action, value: { ...valid.action.value, kind: 'learning.review' } } },
      { ...valid, action: { ...valid.action, value: { ...valid.action.value, actionId: 'a16' } } },
      { ...valid, action: { ...valid.action, value: { ...valid.action.value, cardId: 'not-a-card-id' } } },
      { ...valid, action: { tag: 'button' } }, { ...valid, action: { ...valid.action, value: Object.create(valid.action.value) } },
      { ...valid, operator: { ...valid.operator, tenant_key: 'other-tenant' } }];
    for (const event of invalid) assert.deepEqual(hooks.onCardAction(event), { toast: { type: 'error', content: '当前无法处理此卡片操作。' } });
    await setImmediate(); assert.equal(prepares, 0);
    // A structurally valid opaque ID still needs account/store authorization.
    assert.equal(hooks.onCardAction(valid).toast.type, 'info'); await setImmediate(); assert.equal(prepares, 1);
  } finally { await connector.stop(); }
});

test('one admission limiter bounds combined text, card entry and card callback concurrency and actor cooldown', async () => {
  let hooks!: FeishuDriverCallbacks; let instant = 0; let prepares = 0; let sends = 0; let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const connector = createFeishuConnector({ env, now: () => instant,
    prepareReading(input) { prepares++; return { actor: input, operationId: 'c'.repeat(32), text: 'synthetic text', stillAuthorized: () => true, settle() {} }; },
    prepareCardMessage(input) { prepares++; return prepared(input); }, prepareCardAction(input) { prepares++; return prepared(input); },
    driverFactory: async (_config, callbacks) => { hooks = callbacks; return { start() {}, close() {},
      async sendText() { sends++; await pending; return 'platform-accepted'; }, async sendCard() { sends++; await pending; return accepted; } }; } });
  try {
    await connector.start();
    hooks.onMessage!(message('actor-0', '知识', 'text-0'));
    hooks.onMessage!(message('actor-1', '知识 卡片', 'card-1'));
    assert.equal(hooks.onCardAction(action('actor-2', 'card-2')).toast.type, 'info');
    hooks.onMessage!(message('actor-3', '知识', 'text-3'));
    assert.equal(hooks.onCardAction(action('actor-4', 'overflow')).toast.type, 'error');
    assert.equal(hooks.onCardAction(action('actor-0', 'actor-overlap')).toast.type, 'error');
    await setImmediate(); assert.equal(prepares, 4); assert.equal(sends, 4);
    release(); await setImmediate();
    assert.equal(hooks.onCardAction(action('actor-0', 'cooldown')).toast.type, 'error');
    instant = 1000; assert.equal(hooks.onCardAction(action('actor-0', 'after-cooldown')).toast.type, 'info');
    await setImmediate(); assert.equal(prepares, 5); assert.equal(sends, 5);
  } finally { release(); await connector.stop(); }
});

test('stop closes transport, waits for tracked card work to settle and rejects scheduled or late card callbacks', async () => {
  let hooks!: FeishuDriverCallbacks; let prepares = 0; let settles = 0; let closes = 0; let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const connector = createFeishuConnector({ env, prepareCardAction(input) { prepares++; return prepared(input, { settle() { settles++; } }); },
    driverFactory: async (_config, callbacks) => { hooks = callbacks; return { start() {}, close() { closes++; }, async sendCard(input) {
      await pending; assert.equal(input.stillAuthorized(), false); return { status: 'failed-or-unknown' };
    } }; } });
  await connector.start(); hooks.onCardAction(action()); await setImmediate();
  let stopped = false; const stopping = connector.stop().then(() => { stopped = true; });
  assert.equal(hooks.onCardAction(action('late-actor', 'late')).toast.type, 'error');
  await setImmediate(); assert.equal(closes, 1); assert.equal(stopped, false); assert.equal(settles, 0); assert.equal(prepares, 1);
  release(); await stopping; assert.equal(settles, 1); assert.equal(stopped, true);

  const scheduled = createFeishuConnector({ env, prepareCardAction() { throw new Error('Must not prepare a scheduled card after stop'); },
    driverFactory: async (_config, callbacks) => { hooks = callbacks; return { start() {}, close() {} }; } });
  await scheduled.start(); hooks.onCardAction(action()); await scheduled.stop();
});
