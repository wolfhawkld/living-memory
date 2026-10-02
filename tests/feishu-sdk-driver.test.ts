import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFeishuConnector } from '../src/integrations/feishu-connector.js';
import {
  createFeishuSdkDriverFactory, FEISHU_SILENT_LOGGER,
  type EnabledFeishuConfig, type FeishuCardResponse, type FeishuDriverCallbacks,
} from '../src/integrations/feishu-sdk-driver.js';

const config: EnabledFeishuConfig = {
  enabled: true, appId: 'cli_0000000000000000', appSecret: 'synthetic-secret', tenantKey: 'synthetic-tenant', timeZone: 'UTC',
};
const response: FeishuCardResponse = { toast: { type: 'info', content: 'Synthetic response' } };

function fakeSdk() {
  const captured: {
    dispatcherOptions?: { logger: typeof FEISHU_SILENT_LOGGER };
    handlers?: Record<string, (event: unknown) => FeishuCardResponse>;
    clientOptions?: Record<string, unknown>;
    startOptions?: { eventDispatcher: unknown };
    closeOptions?: { force: true };
    starts: number;
    closes: number;
  } = { starts: 0, closes: 0 };
  const registeredDispatcher = { syntheticDispatcher: true };
  class EventDispatcher {
    constructor(options: { logger: typeof FEISHU_SILENT_LOGGER }) { captured.dispatcherOptions = options; }
    register(handlers: Record<string, (event: unknown) => FeishuCardResponse>) {
      captured.handlers = handlers;
      return registeredDispatcher;
    }
  }
  class WSClient {
    constructor(options: Record<string, unknown>) { captured.clientOptions = options; }
    async start(options: { eventDispatcher: unknown }) {
      captured.starts += 1;
      captured.startOptions = options;
    }
    async close(options: { force: true }) {
      captured.closes += 1;
      captured.closeOptions = options;
    }
  }
  return { sdk: { EventDispatcher, WSClient }, captured, registeredDispatcher };
}

function callbacks(): FeishuDriverCallbacks {
  return {
    onReady() {}, onError() {}, onReconnecting() {}, onReconnected() {},
    onCardAction() { return response; },
  };
}

test('SDK loader stays dormant until driver creation and constructing a driver never starts networking', async () => {
  const fake = fakeSdk();
  let loads = 0;
  const factory = createFeishuSdkDriverFactory(async () => { loads += 1; return fake.sdk; });
  assert.equal(loads, 0);
  await factory(config, callbacks());
  assert.equal(loads, 1);
  assert.equal(fake.captured.starts, 0);
  assert.equal(fake.captured.closes, 0);
});

test('dispatcher and client share five silent logger methods and only card and message handlers', async () => {
  const fake = fakeSdk();
  await createFeishuSdkDriverFactory(async () => fake.sdk)(config, callbacks());
  assert.deepEqual(Object.keys(fake.captured.handlers!), ['card.action.trigger', 'im.message.receive_v1']);
  assert.equal(fake.captured.dispatcherOptions?.logger, FEISHU_SILENT_LOGGER);
  assert.equal(fake.captured.clientOptions?.logger, FEISHU_SILENT_LOGGER);
  assert.equal(Object.isFrozen(FEISHU_SILENT_LOGGER), true);
  assert.deepEqual(Object.keys(FEISHU_SILENT_LOGGER).sort(), ['debug', 'error', 'info', 'trace', 'warn']);
  const unreadable = new Proxy({}, { get() { throw new Error('Logger must not inspect inputs'); } });
  for (const method of Object.values(FEISHU_SILENT_LOGGER)) {
    assert.equal(method('synthetic-ticket', unreadable), undefined);
  }
  const options = fake.captured.clientOptions!;
  assert.equal(options.appId, config.appId);
  assert.equal(options.appSecret, config.appSecret);
  assert.equal(options.autoReconnect, true);
  assert.equal(options.handshakeTimeoutMs, 15_000);
  assert.equal(Number.isFinite(options.handshakeTimeoutMs), true);
});

test('start uses the registered dispatcher and close forcefully closes the same client', async () => {
  const fake = fakeSdk();
  const driver = await createFeishuSdkDriverFactory(async () => fake.sdk)(config, callbacks());
  await driver.start();
  assert.equal(fake.captured.starts, 1);
  assert.deepEqual(fake.captured.startOptions, { eventDispatcher: fake.registeredDispatcher });
  await driver.close();
  assert.equal(fake.captured.closes, 1);
  assert.deepEqual(fake.captured.closeOptions, { force: true });
});

test('SDK lifecycle callbacks and card action response reach the injected callbacks', async () => {
  const fake = fakeSdk();
  const seen: string[] = [];
  const event = { synthetic: 'event' };
  const handlers: FeishuDriverCallbacks = {
    onReady() { seen.push('ready'); },
    onError() { seen.push('error'); },
    onReconnecting() { seen.push('reconnecting'); },
    onReconnected() { seen.push('reconnected'); },
    onCardAction(input) { assert.equal(input, event); return response; },
    onMessage(input) { assert.equal(input, event); seen.push('message'); },
  };
  await createFeishuSdkDriverFactory(async () => fake.sdk)(config, handlers);
  for (const key of ['onReady', 'onError', 'onReconnecting', 'onReconnected'] as const) {
    const callback = fake.captured.clientOptions![key] as () => void;
    assert.equal(callback, handlers[key]);
    callback();
  }
  assert.deepEqual(seen, ['ready', 'error', 'reconnecting', 'reconnected']);
  assert.equal(fake.captured.handlers!['card.action.trigger'](event), response);
  assert.equal(fake.captured.handlers!['im.message.receive_v1'](event), undefined);
  assert.deepEqual(seen, ['ready', 'error', 'reconnecting', 'reconnected', 'message']);
});

test('missing or malformed SDK exports fail with a fixed error without echoing SDK contents', async () => {
  for (const loaded of [null, undefined, 'synthetic-secret', {}, { WSClient() {} }, { EventDispatcher() {} },
    { WSClient: 'synthetic-secret', EventDispatcher() {} }]) {
    await assert.rejects(createFeishuSdkDriverFactory(async () => loaded)(config, callbacks()), {
      name: 'Error', message: 'Feishu SDK exports unavailable',
    });
  }
});

test('pinned official SDK exposes the adapter lifecycle contract without constructing or starting it', async () => {
  const sdk = await import('@larksuiteoapi/node-sdk');
  assert.equal(typeof sdk.WSClient, 'function');
  assert.equal(typeof sdk.EventDispatcher, 'function');
  assert.equal(typeof sdk.WSClient.prototype.start, 'function');
  assert.equal(typeof sdk.WSClient.prototype.close, 'function');
  assert.equal(typeof sdk.EventDispatcher.prototype.register, 'function');
});

test('actual SDK dispatcher preserves flattened schema and reaches the unavailable-card response offline', async () => {
  const sdk = await import('@larksuiteoapi/node-sdk');
  let driverCallbacks: FeishuDriverCallbacks | undefined;
  const connector = createFeishuConnector({
    env: {
      LM_FEISHU_ENABLED: '1', LM_FEISHU_APP_ID: config.appId,
      LM_FEISHU_APP_SECRET: config.appSecret, LM_FEISHU_TENANT_KEY: config.tenantKey,
    },
    driverFactory: async (_config, injected) => {
      driverCallbacks = injected;
      return { start() {}, close() {} };
    },
  });
  await connector.start();
  assert.ok(driverCallbacks);
  let handled = false;
  // Only EventDispatcher is constructed. No WSClient or network transport exists.
  const dispatcher = new sdk.EventDispatcher({ logger: FEISHU_SILENT_LOGGER }).register({
    'card.action.trigger': (event: unknown) => {
      handled = true;
      const flat = event as Record<string, unknown>;
      assert.equal(flat.schema, '2.0');
      assert.equal(Object.hasOwn(flat, 'header'), false);
      assert.equal(Object.hasOwn(flat, 'event'), false);
      assert.equal(flat.app_id, config.appId);
      assert.equal(flat.event_id, 'synthetic-offline-event');
      return driverCallbacks!.onCardAction(event);
    },
  });
  try {
    const rawSyntheticEnvelope = {
      schema: '2.0',
      header: {
        event_type: 'card.action.trigger', event_id: 'synthetic-offline-event',
        app_id: config.appId, tenant_key: config.tenantKey,
      },
      event: {
        operator: { open_id: 'synthetic-open-id', tenant_key: config.tenantKey },
        context: { open_message_id: 'synthetic-message', open_chat_id: 'synthetic-chat' },
        action: { tag: 'button', value: { accountId: 'ignored-synthetic-owner' } },
      },
    };
    // needCheck:false tests parsing only; this is explicitly not authentication evidence.
    const result = await dispatcher.invoke(rawSyntheticEnvelope, { needCheck: false });
    assert.equal(handled, true);
    assert.deepEqual(result, {
      toast: { type: 'info', content: '知识卡片操作尚未接入，请等待后续功能。' },
    });
  } finally {
    await connector.stop();
  }
});
