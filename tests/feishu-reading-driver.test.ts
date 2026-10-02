import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { createFeishuSdkDriverFactory, FEISHU_HTTP_TIMEOUT_MS, FEISHU_SILENT_LOGGER,
  type FeishuDriverCallbacks } from '../src/integrations/feishu-sdk-driver.js';

const config = { enabled: true as const, appId: 'cli_1111111111111111', appSecret: 'synthetic-secret', tenantKey: 'synthetic-tenant', timeZone: 'UTC' };
const hooks: FeishuDriverCallbacks = { onReady() {}, onError() {}, onReconnecting() {}, onReconnected() {},
  onCardAction() { return { toast: { type: 'info', content: 'synthetic' } }; } };
const input = { openId: 'synthetic-open-id', text: 'Synthetic knowledge. 数学 🧠', uuid: '1'.repeat(32), stillAuthorized: () => true };

function fixture() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  let clientCount = 0;
  let clientOptions: any;
  let response: unknown = { code: 0, data: { message_id: 'synthetic-message' } };
  let fail = false;
  const http = Object.fromEntries(['request', 'get', 'delete', 'head', 'options', 'post', 'put', 'patch'].map((method) =>
    [method, async (...args: unknown[]) => { calls.push({ method, args }); return { synthetic: true }; }]));
  class Client {
    constructor(options: unknown) { clientCount++; clientOptions = options; }
    im = { message: { create: async (payload: unknown) => {
      calls.push({ method: 'create', args: [payload] });
      if (fail) throw new Error('synthetic-body-and-secret-must-not-escape');
      const request = payload as any;
      await clientOptions.httpInstance.request({ url: 'https://open.feishu.cn/open-apis/im/v1/messages', method: 'POST',
        params: request.params, data: request.data });
      return response;
    } } };
  }
  class EventDispatcher { register() { return this; } }
  class WSClient { start() {} close() {} }
  return { sdk: { Client, EventDispatcher, WSClient, defaultHttpInstance: http }, calls,
    get clientCount() { return clientCount; }, get clientOptions() { return clientOptions; },
    setResponse(value: unknown) { response = value; }, setFailure() { fail = true; } };
}

test('reading sender lazily constructs one silent Client and always creates to explicit open_id with stable UUID', async () => {
  const f = fixture();
  const driver = await createFeishuSdkDriverFactory(async () => f.sdk)(config, hooks);
  assert.equal(f.clientCount, 0);
  await driver.start();
  assert.equal(f.clientCount, 0);
  assert.equal(await driver.sendText!(input), 'platform-accepted');
  assert.equal(await driver.sendText!({ ...input, text: 'Second synthetic message' }), 'platform-accepted');
  assert.equal(f.clientCount, 1);
  assert.equal(f.clientOptions.logger, FEISHU_SILENT_LOGGER);
  assert.equal(f.clientOptions.appId, config.appId);
  assert.equal(f.clientOptions.appSecret, config.appSecret);
  const payload = f.calls[0].args[0] as any;
  assert.deepEqual(payload.params, { receive_id_type: 'open_id' });
  assert.deepEqual(payload.data, { receive_id: input.openId, msg_type: 'text',
    content: JSON.stringify({ text: input.text }), uuid: input.uuid });
  assert.equal(Object.hasOwn(payload, 'path'), false);
  await driver.close();
  assert.equal(await driver.sendText!(input), 'failed-or-unknown');
  assert.equal(f.calls.filter((call) => call.method === 'create').length, 2);
});

test('isolated SDK HTTP wrapper bounds token and create requests without mutating shared defaults', async () => {
  const f = fixture();
  const driver = await createFeishuSdkDriverFactory(async () => f.sdk)(config, hooks);
  await driver.sendText!(input);
  const http = f.clientOptions.httpInstance;
  assert.throws(() => http.request({ data: 'synthetic', timeout: 0 }), /dispatch rejected/);
  for (const method of ['get', 'delete', 'head', 'options']) await http[method]('synthetic-url', { timeout: 0 });
  for (const method of ['post', 'put', 'patch']) await http[method]('synthetic-url', { token: 'synthetic' }, { timeout: 0 });
  for (const call of f.calls.filter((call) => call.method !== 'create')) {
    assert.equal((call.args.at(-1) as any).timeout, FEISHU_HTTP_TIMEOUT_MS);
  }
  assert.notEqual(http, f.sdk.defaultHttpInstance);
  assert.equal(Object.hasOwn(f.sdk.defaultHttpInstance, 'defaults'), false);
  await driver.close();
});

test('only code zero and a valid platform message ID acknowledge delivery; errors are fixed and never retried', async () => {
  const f = fixture();
  const driver = await createFeishuSdkDriverFactory(async () => f.sdk)(config, hooks);
  const malformed = [null, {}, { data: { message_id: 'id' } }, { code: '0', data: { message_id: 'id' } },
    { code: 123, msg: 'synthetic secret', data: { message_id: 'id' } }, { code: 0 }, { code: 0, data: {} },
    { code: 0, data: { message_id: '' } }, { code: 0, data: { message_id: ' id ' } },
    { code: 0, data: { message_id: 'x'.repeat(257) } }];
  for (const response of malformed) {
    f.setResponse(response);
    assert.equal(await driver.sendText!(input), 'failed-or-unknown');
  }
  f.setFailure();
  assert.equal(await driver.sendText!(input), 'failed-or-unknown');
  assert.equal(f.calls.filter((call) => call.method === 'create').length, malformed.length + 1);
  await driver.close();
});

test('invalid destinations, operation IDs and final JSON byte overflow are rejected before Client construction', async () => {
  const f = fixture();
  const driver = await createFeishuSdkDriverFactory(async () => f.sdk)(config, hooks);
  for (const change of [{ openId: '' }, { openId: ' id ' }, { openId: 'x'.repeat(257) },
    { uuid: 'X'.repeat(32) }, { text: '' }, { text: '数'.repeat(5000) }, { text: '"'.repeat(4000) }]) {
    assert.equal(await driver.sendText!({ ...input, ...change }), 'failed-or-unknown');
  }
  assert.equal(f.clientCount, 0);
  assert.equal(f.calls.length, 0);
  await driver.close();
});

test('missing outbound SDK exports produce fixed failure while leaving the legacy WS contract available', async () => {
  const f = fixture();
  const { Client: _client, ...withoutClient } = f.sdk;
  const driver = await createFeishuSdkDriverFactory(async () => withoutClient)(config, hooks);
  await driver.start();
  assert.equal(await driver.sendText!(input), 'failed-or-unknown');
  await driver.close();
});

test('pinned official Client uses bounded synthetic token POST and create request offline', async () => {
  const sdk = await import('@larksuiteoapi/node-sdk');
  const calls: Array<{ method: string; args: any[] }> = [];
  const fakeHttp = Object.fromEntries(['request', 'get', 'delete', 'head', 'options', 'post', 'put', 'patch'].map((method) =>
    [method, async (...args: any[]) => {
      calls.push({ method, args });
      return method === 'post' ? { tenant_access_token: 'synthetic-token', expire: 3600 }
        : { code: 0, data: { message_id: 'synthetic-platform-message' } };
    }]));
  class FakeWSClient { start() {} close() {} }
  const driver = await createFeishuSdkDriverFactory(async () => ({ ...sdk, WSClient: FakeWSClient, defaultHttpInstance: fakeHttp }))(
    { ...config, appId: 'cli_123456789abcdef0' }, hooks);
  try {
    assert.equal(await driver.sendText!(input), 'platform-accepted');
    assert.deepEqual(calls.map((call) => call.method), ['post', 'request']);
    assert.equal(calls[0].args[2].timeout, FEISHU_HTTP_TIMEOUT_MS);
    assert.equal(calls[1].args[0].timeout, FEISHU_HTTP_TIMEOUT_MS);
    assert.match(calls[1].args[0].url, /\/im\/v1\/messages$/);
    assert.equal(calls[1].args[0].data.receive_id, input.openId);
    assert.equal(calls[1].args[0].params.receive_id_type, 'open_id');
  } finally { await driver.close(); }
});

test('real SDK token await cannot dispatch knowledge after authorization loss or close, and active UUIDs stay unique', async () => {
  const sdk = await import('@larksuiteoapi/node-sdk');
  for (const [index, mode] of ['authorization-lost', 'closed', 'normal'].entries()) {
    let release!: () => void;
    const tokenPending = new Promise<void>((resolve) => { release = resolve; });
    let tokenStarted = false;
    let authorized = true;
    const requests: any[] = [];
    const fakeHttp = Object.fromEntries(['request', 'get', 'delete', 'head', 'options', 'post', 'put', 'patch'].map((method) =>
      [method, async (...args: any[]) => {
        if (method === 'post') {
          assert.equal(args[2].timeout, FEISHU_HTTP_TIMEOUT_MS);
          tokenStarted = true; await tokenPending;
          return { tenant_access_token: 'synthetic-delayed-token', expire: 3600 };
        }
        requests.push(args[0]); return { code: 0, data: { message_id: 'synthetic-platform-message' } };
      }]));
    class FakeWSClient { start() {} close() {} }
    const driver = await createFeishuSdkDriverFactory(async () => ({ ...sdk, WSClient: FakeWSClient, defaultHttpInstance: fakeHttp }))(
      { ...config, appId: `cli_999999999999999${index}` }, hooks);
    try {
      const sending = driver.sendText!({ ...input, stillAuthorized: () => authorized });
      await setImmediate(); assert.equal(tokenStarted, true); assert.equal(requests.length, 0);
      assert.equal(await driver.sendText!(input), 'failed-or-unknown', 'same UUID cannot overwrite its in-flight authorization');
      if (mode === 'authorization-lost') authorized = false;
      if (mode === 'closed') await driver.close();
      release();
      assert.equal(await sending, mode === 'normal' ? 'platform-accepted' : 'failed-or-unknown');
      assert.equal(requests.length, mode === 'normal' ? 1 : 0);
      if (mode === 'normal') {
        assert.equal(requests[0].timeout, FEISHU_HTTP_TIMEOUT_MS);
        assert.equal(requests[0].data.uuid, input.uuid);
        assert.equal(requests[0].data.receive_id, input.openId);
        assert.equal(requests[0].data.content, JSON.stringify({ text: input.text }));
      }
    } finally { release(); await driver.close(); }
  }
});
