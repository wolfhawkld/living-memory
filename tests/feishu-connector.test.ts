import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFeishuConnector, type FeishuConnectorStatus } from '../src/integrations/feishu-connector.js';
import type { FeishuDriver, FeishuDriverCallbacks } from '../src/integrations/feishu-sdk-driver.js';

const enabledEnv = {
  LM_FEISHU_ENABLED: '1', LM_FEISHU_APP_ID: 'cli_0000000000000000',
  LM_FEISHU_APP_SECRET: 'synthetic-secret', LM_FEISHU_TENANT_KEY: 'synthetic-tenant',
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function action() {
  return {
    schema: '2.0', event_type: 'card.action.trigger', event_id: 'synthetic-event',
    app_id: 'cli_0000000000000000', tenant_key: 'synthetic-tenant',
    operator: { open_id: 'synthetic-actor' },
    context: { open_message_id: 'synthetic-message', open_chat_id: 'synthetic-chat' },
    action: { tag: 'button', value: { owner: true, userId: 'untrusted-user', conceptId: 'untrusted-concept' } },
  };
}
function fixture(implementation: Partial<FeishuDriver> = {}) {
  let callbacks!: FeishuDriverCallbacks;
  let starts = 0;
  let closes = 0;
  let factories = 0;
  const statuses: Readonly<FeishuConnectorStatus>[] = [];
  const connector = createFeishuConnector({
    env: enabledEnv, onStatus: (status) => statuses.push(status),
    driverFactory: async (config, hooks) => {
      factories++;
      assert.equal(config.appSecret, 'synthetic-secret');
      callbacks = hooks;
      return {
        start: () => { starts++; return implementation.start?.(); },
        close: () => { closes++; return implementation.close?.(); },
      };
    },
  });
  return { connector, statuses, callbacks: () => callbacks, counts: () => ({ factories, starts, closes }) };
}

test('default-disabled connector never loads a driver or emits status logs', async () => {
  for (const flag of [undefined, '0']) {
    let calls = 0;
    const connector = createFeishuConnector({
      env: { LM_FEISHU_ENABLED: flag },
      driverFactory: async () => { calls++; throw new Error('must not load'); },
      onStatus: () => { calls++; },
    });
    await connector.start();
    await connector.stop();
    await connector.start();
    assert.equal(calls, 0);
    assert.deepEqual(connector.getStatus(), { state: 'disabled' });
  }
});

test('invalid configuration is absorbed as a fixed code without loading SDK', async () => {
  const statuses: Readonly<FeishuConnectorStatus>[] = [];
  const connector = createFeishuConnector({
    env: { ...enabledEnv, LM_FEISHU_APP_ID: '' }, onStatus: (status) => statuses.push(status),
    driverFactory: async () => { assert.fail('must not load'); },
  });
  await assert.doesNotReject(connector.start());
  assert.deepEqual(statuses, [{ state: 'error', code: 'invalid-app-id' }]);
  assert.equal(JSON.stringify(statuses).includes('synthetic-secret'), false);
  await connector.stop();
});

test('start is idempotent and its return does not imply a ready connection', async () => {
  const f = fixture();
  const first = f.connector.start();
  assert.strictEqual(first, f.connector.start());
  await first;
  assert.deepEqual(f.counts(), { factories: 1, starts: 1, closes: 0 });
  assert.deepEqual(f.connector.getStatus(), { state: 'starting' });
  f.callbacks().onReady();
  f.callbacks().onReady();
  assert.deepEqual(f.statuses, [{ state: 'starting' }, { state: 'connected' }]);
  await f.connector.stop();
});

test('SDK callbacks govern disconnect and reconnect states without wrapper retries', async () => {
  const f = fixture();
  await f.connector.start();
  f.callbacks().onReady();
  f.callbacks().onReconnecting();
  assert.deepEqual(f.connector.getStatus(), { state: 'reconnecting' });
  f.callbacks().onError();
  assert.deepEqual(f.connector.getStatus(), { state: 'error', code: 'sdk-connection-error' });
  f.callbacks().onReconnected();
  assert.deepEqual(f.connector.getStatus(), { state: 'connected' });
  assert.equal(f.counts().factories, 1);
  assert.equal(f.counts().starts, 1);
  await f.connector.stop();
});

test('factory and start failures are redacted and do not reject local startup', async () => {
  for (const phase of ['init', 'start'] as const) {
    const statuses: Readonly<FeishuConnectorStatus>[] = [];
    const connector = createFeishuConnector({
      env: enabledEnv, onStatus: (status) => statuses.push(status),
      driverFactory: async () => {
        if (phase === 'init') throw new Error('synthetic-secret ticket://private');
        return { start: () => { throw new Error('synthetic-secret raw-event'); }, close: () => {} };
      },
    });
    await assert.doesNotReject(connector.start());
    assert.deepEqual(connector.getStatus(), { state: 'error', code: `sdk-${phase}-failed` });
    assert.equal(JSON.stringify(statuses).includes('synthetic-secret'), false);
    assert.equal(JSON.stringify(statuses).includes('private'), false);
    await connector.stop();
  }
});

test('all valid cards return the same unavailable-card toast regardless of payload claims', async () => {
  const f = fixture();
  await f.connector.start();
  const event = action();
  Object.defineProperty(event.action, 'value', { get() { throw new Error('claims must not be read'); } });
  const response = f.callbacks().onCardAction(event);
  assert.deepEqual(response, { toast: { type: 'info', content: '知识卡片操作尚未接入，请等待后续功能。' } });
  const other = action();
  other.operator.open_id = 'another-synthetic-actor';
  assert.deepEqual(f.callbacks().onCardAction(other), response);
  assert.deepEqual(f.connector.getStatus(), { state: 'starting' });
  await f.connector.stop();
});

test('failed SDK start closes once, ignores late ready and is not closed again by stop', async () => {
  const f = fixture({ start: () => { throw new Error('synthetic-secret failed start'); } });
  await f.connector.start();
  assert.deepEqual(f.counts(), { factories: 1, starts: 1, closes: 1 });
  f.callbacks().onReady();
  f.callbacks().onReconnected();
  assert.deepEqual(f.connector.getStatus(), { state: 'error', code: 'sdk-start-failed' });
  assert.equal(f.callbacks().onCardAction(action()).toast.type, 'error');
  await f.connector.stop();
  assert.equal(f.counts().closes, 1);
});

test('malformed and cross-application or cross-tenant cards return a fixed denial', async () => {
  const f = fixture();
  await f.connector.start();
  for (const event of [null, {}, { ...action(), app_id: 'different-app' },
    { ...action(), tenant_key: 'different-tenant' }, { ...action(), operator: { open_id: 'actor', tenant_key: 'other' } }]) {
    assert.deepEqual(f.callbacks().onCardAction(event), { toast: { type: 'error', content: '当前无法处理此卡片操作。' } });
  }
  await f.connector.stop();
});

test('stop is idempotent, ignores late callbacks and prevents restart on the same connector', async () => {
  const f = fixture();
  await f.connector.start();
  f.callbacks().onReady();
  const first = f.connector.stop();
  assert.strictEqual(first, f.connector.stop());
  await first;
  f.callbacks().onReady();
  f.callbacks().onError();
  f.callbacks().onReconnecting();
  f.callbacks().onReconnected();
  await f.connector.start();
  assert.deepEqual(f.counts(), { factories: 1, starts: 1, closes: 1 });
  assert.deepEqual(f.connector.getStatus(), { state: 'stopped' });
  assert.equal(f.callbacks().onCardAction(action()).toast.type, 'error');
});

test('stop before the first start microtask prevents driver creation entirely', async () => {
  const f = fixture();
  const starting = f.connector.start();
  await f.connector.stop();
  await starting;
  assert.deepEqual(f.counts(), { factories: 0, starts: 0, closes: 0 });
});

test('stop during asynchronous SDK loading closes a late driver without starting it', async () => {
  const loaded = deferred<FeishuDriver>();
  const entered = deferred<void>();
  let starts = 0;
  let closes = 0;
  const connector = createFeishuConnector({
    env: enabledEnv,
    driverFactory: async (_config, callbacks) => {
      callbacks.onReady(); // Even a premature driver callback cannot mark connected.
      entered.resolve();
      return loaded.promise;
    },
  });
  const starting = connector.start();
  await entered.promise;
  assert.deepEqual(connector.getStatus(), { state: 'starting' });
  await connector.stop();
  loaded.resolve({ start: () => { starts++; }, close: () => { closes++; } });
  await starting;
  assert.equal(starts, 0);
  assert.equal(closes, 1);
  assert.deepEqual(connector.getStatus(), { state: 'stopped' });
});

test('stop during pending SDK start closes promptly and ignores later failure and callbacks', async () => {
  const pending = deferred<void>();
  const entered = deferred<void>();
  const f = fixture({ start: () => { entered.resolve(); return pending.promise; } });
  const starting = f.connector.start();
  await entered.promise;
  await f.connector.stop();
  f.callbacks().onReady();
  pending.reject(new Error('synthetic-secret late failure'));
  await starting;
  assert.deepEqual(f.connector.getStatus(), { state: 'stopped' });
  assert.equal(f.counts().closes, 1);
});

test('stop failure is reported only as a fixed cleanup code', async () => {
  const f = fixture({ close: () => { throw new Error('synthetic-secret URL ticket'); } });
  await f.connector.start();
  await assert.doesNotReject(f.connector.stop());
  assert.deepEqual(f.connector.getStatus(), { state: 'stopped', code: 'sdk-stop-failed' });
  assert.equal(JSON.stringify(f.statuses).includes('synthetic-secret'), false);
});

test('status observers cannot mutate internal state or break connector lifecycle', async () => {
  let callbacks!: FeishuDriverCallbacks;
  const connector = createFeishuConnector({
    env: enabledEnv,
    onStatus: (status) => { assert.equal(Object.isFrozen(status), true); throw new Error('observer failure'); },
    driverFactory: async (_config, value) => { callbacks = value; return { start: () => {}, close: () => {} }; },
  });
  await connector.start();
  const copy = connector.getStatus();
  copy.state = 'error';
  assert.deepEqual(connector.getStatus(), { state: 'starting' });
  callbacks.onReady();
  assert.deepEqual(connector.getStatus(), { state: 'connected' });
  await connector.stop();
});

test('only parsed private user confirmation commands reach the narrow binding capability', async () => {
  let callbacks!: FeishuDriverCallbacks;
  const calls: unknown[] = [];
  const connector = createFeishuConnector({
    env: enabledEnv,
    driverFactory: async (_config, hooks) => { callbacks = hooks; return { start() {}, close() {} }; },
    confirmBinding: (input) => { calls.push(input); return { status: 'confirmed' }; },
  });
  await connector.start();
  const message = {
    schema: '2.0', event_type: 'im.message.receive_v1', event_id: 'synthetic-event',
    app_id: enabledEnv.LM_FEISHU_APP_ID, tenant_key: enabledEnv.LM_FEISHU_TENANT_KEY,
    sender: { sender_type: 'user', sender_id: { open_id: 'synthetic-actor' } },
    message: { chat_type: 'p2p', message_type: 'text', message_id: 'synthetic-message', chat_id: 'synthetic-chat',
      content: JSON.stringify({ text: `确认绑定 LM-${'a'.repeat(22)}` }) },
  };
  callbacks.onMessage!(null);
  callbacks.onMessage!({ ...message, sender: { ...message.sender, sender_type: 'bot' } });
  assert.equal(calls.length, 0);
  callbacks.onMessage!(message);
  assert.deepEqual(calls, [{ appId: enabledEnv.LM_FEISHU_APP_ID, tenantKey: enabledEnv.LM_FEISHU_TENANT_KEY,
    openId: 'synthetic-actor', eventId: 'synthetic-event', messageId: 'synthetic-message', chatId: 'synthetic-chat', code: `LM-${'a'.repeat(22)}` }]);
  await connector.stop();
  callbacks.onMessage!(message);
  assert.equal(calls.length, 1);
});

test('binding capability failure never escapes into SDK callbacks or status logs', async () => {
  let callbacks!: FeishuDriverCallbacks;
  const statuses: Readonly<FeishuConnectorStatus>[] = [];
  const connector = createFeishuConnector({
    env: enabledEnv, onStatus: (status) => statuses.push(status),
    driverFactory: async (_config, hooks) => { callbacks = hooks; return { start() {}, close() {} }; },
    confirmBinding: () => { throw new Error('synthetic-secret private-message-and-code'); },
  });
  await connector.start();
  assert.doesNotThrow(() => callbacks.onMessage!({
    event_type: 'im.message.receive_v1', event_id: 'event', app_id: enabledEnv.LM_FEISHU_APP_ID,
    tenant_key: enabledEnv.LM_FEISHU_TENANT_KEY, sender: { sender_type: 'user', sender_id: { open_id: 'actor' } },
    message: { chat_type: 'p2p', message_type: 'text', message_id: 'message', chat_id: 'chat',
      content: JSON.stringify({ text: `确认绑定 LM-${'a'.repeat(22)}` }) },
  }));
  assert.deepEqual(statuses, [{ state: 'starting' }]);
  await connector.stop();
});
