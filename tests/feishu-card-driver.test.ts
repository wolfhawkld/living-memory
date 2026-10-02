import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { createFeishuSdkDriverFactory, FEISHU_HTTP_TIMEOUT_MS, type FeishuDriverCallbacks, type FeishuSendCard } from '../src/integrations/feishu-sdk-driver.js';

const callbacks: FeishuDriverCallbacks = { onReady() {}, onError() {}, onReconnecting() {}, onReconnected() {},
  onCardAction() { return { toast: { type: 'info', content: 'Synthetic acknowledgment' } }; } };
const card = { schema: '2.0', config: { update_multi: true, enable_forward: false },
  header: { title: { tag: 'plain_text', content: '数学 🧠' } }, body: { elements: [{ tag: 'markdown', content: 'Synthetic knowledge' }] } };
const input: FeishuSendCard = { openId: 'synthetic-open-id', expectedChatId: 'synthetic-chat', card, uuid: 'a'.repeat(32), stillAuthorized: () => true };
let fixtureIndex = 0;

async function fixture(delayed = false, observeDispatch = false) {
  const sdk = await import('@larksuiteoapi/node-sdk');
  const calls: Array<{ method: string; args: any[] }> = [];
  let response: unknown = { code: 0, data: { message_id: 'synthetic-message', chat_id: input.expectedChatId } };
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let tokenStarted = false;
  let dispatcher: any;
  let closes = 0;
  let dispatchBoundary: any;
  const fakeHttp = Object.fromEntries(['request', 'get', 'delete', 'head', 'options', 'post', 'put', 'patch'].map((method) =>
    [method, async (...args: any[]) => {
      calls.push({ method, args });
      if (method === 'post') {
        tokenStarted = true;
        if (delayed) await pending;
        return { tenant_access_token: 'synthetic-token', expire: 3600 };
      }
      return response;
    }]));
  class FakeWSClient { start(options: any) { dispatcher = options.eventDispatcher; } close() { closes++; } }
  // Preserve the real SDK implementation while exposing its injected HTTP boundary.
  class ObservedClient extends sdk.Client {
    constructor(options: ConstructorParameters<typeof sdk.Client>[0]) {
      super(options); dispatchBoundary = options.httpInstance;
    }
  }
  const config = { enabled: true as const, appId: `cli_777777777777${(++fixtureIndex).toString(16).padStart(4, '0')}`,
    appSecret: 'synthetic-secret', tenantKey: 'synthetic-tenant', timeZone: 'UTC' };
  const driver = await createFeishuSdkDriverFactory(async () => ({ ...sdk, ...(observeDispatch ? { Client: ObservedClient } : {}), WSClient: FakeWSClient, defaultHttpInstance: fakeHttp }))(config, callbacks);
  return { driver, calls, config, release, get tokenStarted() { return tokenStarted; }, get closes() { return closes; },
    get dispatcher() { return dispatcher; }, get dispatchBoundary() { return dispatchBoundary; }, setResponse(value: unknown) { response = value; } };
}

test('pinned real SDK creates interactive V2 JSON to open_id with UUID, bounded HTTP, and trusted dual response IDs', async () => {
  const f = await fixture();
  try {
    await f.driver.start(); assert.equal(f.calls.length, 0);
    const delivery = await f.driver.sendCard!(input);
    assert.deepEqual(delivery, { status: 'platform-accepted', messageId: 'synthetic-message', chatId: 'synthetic-chat' });
    assert.deepEqual(f.calls.map((call) => call.method), ['post', 'request']);
    assert.equal(f.calls[0].args[2].timeout, FEISHU_HTTP_TIMEOUT_MS);
    const request = f.calls[1].args[0];
    assert.equal(request.timeout, FEISHU_HTTP_TIMEOUT_MS);
    assert.equal(request.url, 'https://open.feishu.cn/open-apis/im/v1/messages');
    assert.equal(request.method, 'POST');
    assert.deepEqual(request.params, { receive_id_type: 'open_id' });
    assert.deepEqual(request.data, { receive_id: input.openId, msg_type: 'interactive', content: JSON.stringify(card), uuid: input.uuid });
    assert.equal(JSON.parse(request.data.content).schema, '2.0');
    const toast = await f.dispatcher.invoke({ schema: '2.0', header: { event_type: 'card.action.trigger', event_id: 'synthetic-action' }, event: {} }, { needCheck: false });
    assert.deepEqual(toast, { toast: { type: 'info', content: 'Synthetic acknowledgment' } });
  } finally { await f.driver.close(); }
});

test('card acceptance requires code zero, message ID, and exact trusted chat ID without retries', async () => {
  const f = await fixture();
  const malformed = [null, {}, { code: '0', data: { message_id: 'message', chat_id: input.expectedChatId } },
    { code: 1, msg: 'synthetic secret', data: { message_id: 'message', chat_id: input.expectedChatId } },
    { code: 0, data: { chat_id: input.expectedChatId } }, { code: 0, data: { message_id: 'message' } },
    { code: 0, data: { message_id: 'message', chat_id: 'untrusted-chat' } },
    { code: 0, data: { message_id: ' message ', chat_id: input.expectedChatId } },
    { code: 0, data: { message_id: 'message', chat_id: '' } },
    { code: 0, data: { message_id: 'x'.repeat(257), chat_id: input.expectedChatId } }];
  try {
    for (const response of malformed) {
      f.setResponse(response);
      assert.deepEqual(await f.driver.sendCard!(input), { status: 'failed-or-unknown' });
    }
    assert.equal(f.calls.filter((call) => call.method === 'request').length, malformed.length);
  } finally { await f.driver.close(); }
});

test('invalid card arguments, JSON cycles, content bytes and final wire overflow fail before any SDK HTTP', async () => {
  const f = await fixture();
  const cycle: any = { schema: '2.0' }; cycle.body = cycle;
  const invalid = [{ openId: '' }, { openId: ' actor ' }, { openId: 'x'.repeat(257) }, { expectedChatId: '' },
    { expectedChatId: ' chat ' }, { expectedChatId: 'x'.repeat(257) }, { uuid: 'A'.repeat(32) },
    { card: {} }, { card: { schema: '1.0' } }, { card: cycle }, { card: { schema: '2.0', body: 1n } },
    { card: { schema: '2.0', body: '数'.repeat(7000) } },
    { card: { schema: '2.0', body: '\\'.repeat(6500) } }];
  assert.ok(Buffer.byteLength(JSON.stringify(invalid.at(-1)!.card)) < 20 * 1024, 'last case isolates wire escaping overflow');
  try {
    for (const change of invalid) assert.deepEqual(await f.driver.sendCard!({ ...input, ...change }), { status: 'failed-or-unknown' });
    assert.deepEqual(await f.driver.sendCard!({ ...input, stillAuthorized: () => false }), { status: 'failed-or-unknown' });
    assert.deepEqual(await f.driver.sendCard!({ ...input, stillAuthorized() { throw new Error('synthetic secret'); } }), { status: 'failed-or-unknown' });
    assert.equal(f.calls.length, 0);
  } finally { await f.driver.close(); }
});

test('token await rechecks authorization and closure at actual dispatch; in-flight UUID cannot be reused by card or text', async () => {
  for (const mode of ['authorization-lost', 'closed', 'normal']) {
    const f = await fixture(true);
    let authorized = true;
    try {
      const originalCard = structuredClone(card);
      const sending = f.driver.sendCard!({ ...input, card: originalCard, stillAuthorized: () => authorized });
      await setImmediate(); assert.equal(f.tokenStarted, true);
      assert.equal(f.calls.filter((call) => call.method === 'request').length, 0);
      assert.deepEqual(await f.driver.sendCard!(input), { status: 'failed-or-unknown' });
      assert.equal(await f.driver.sendText!({ openId: input.openId, uuid: input.uuid, text: 'cannot replace a pending card', stillAuthorized: () => true }), 'failed-or-unknown');
      originalCard.body.elements[0].content = 'Changed after token request';
      if (mode === 'authorization-lost') authorized = false;
      if (mode === 'closed') await f.driver.close();
      f.release();
      const delivery = await sending;
      assert.equal(delivery.status, mode === 'normal' ? 'platform-accepted' : 'failed-or-unknown');
      const requests = f.calls.filter((call) => call.method === 'request');
      assert.equal(requests.length, mode === 'normal' ? 1 : 0);
      if (mode === 'normal') {
        assert.equal(requests[0].args[0].data.msg_type, 'interactive');
        assert.equal(requests[0].args[0].data.content, JSON.stringify(card));
        assert.equal(requests[0].args[0].data.uuid, input.uuid);
        assert.equal(requests[0].args[0].data.receive_id, input.openId);
      }
    } finally { f.release(); await f.driver.close(); }
  }
});

test('actual SDK HTTP boundary binds a pending card UUID to its destination, interactive type and exact serialized content', async () => {
  const f = await fixture(true, true);
  try {
    const sending = f.driver.sendCard!(input);
    await setImmediate(); assert.equal(f.tokenStarted, true);
    const request = { url: 'https://open.feishu.cn/open-apis/im/v1/messages', method: 'POST', params: { receive_id_type: 'open_id' },
      data: { receive_id: input.openId, msg_type: 'interactive', content: JSON.stringify(card), uuid: input.uuid } };
    for (const data of [
      { ...request.data, msg_type: 'text' }, { ...request.data, content: JSON.stringify({ schema: '2.0', body: 'forged-content' }) },
      { ...request.data, receive_id: 'another-open-id' }, { ...request.data, uuid: 'f'.repeat(32) },
    ]) assert.throws(() => f.dispatchBoundary.request({ ...request, data }), /dispatch rejected/);
    assert.throws(() => f.dispatchBoundary.request({ ...request, params: { receive_id_type: 'chat_id' } }), /dispatch rejected/);
    assert.equal(f.calls.filter((call) => call.method === 'request').length, 0);
    f.release(); assert.equal((await sending).status, 'platform-accepted');
    assert.equal(f.calls.filter((call) => call.method === 'request').length, 1);
  } finally { f.release(); await f.driver.close(); }
});
