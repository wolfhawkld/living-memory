import assert from 'node:assert/strict';
import { test } from 'node:test';
import { feishuSendFailureDiagnostic, notifyFeishuSendDiagnostic, type FeishuSendDiagnostic } from '../src/integrations/feishu-send-diagnostic.js';
import { createFeishuSdkDriverFactory, type FeishuDriverCallbacks } from '../src/integrations/feishu-sdk-driver.js';

const input = { openId: 'private-actor', expectedChatId: 'private-chat', uuid: 'a'.repeat(32), stillAuthorized: () => true,
  card: { schema: '2.0', body: { elements: [{ tag: 'markdown', content: 'PRIVATE_BODY' }] } } };
let index = 0;
async function fixture(outcome: () => unknown, observer?: (value: FeishuSendDiagnostic) => void) {
  const sdk = await import('@larksuiteoapi/node-sdk');
  const diagnostics: FeishuSendDiagnostic[] = []; let requests = 0;
  const http = Object.fromEntries(['request', 'get', 'delete', 'head', 'options', 'post', 'put', 'patch'].map(method =>
    [method, async () => {
      if (method === 'post') return { tenant_access_token: 'private-token', expire: 3600 };
      requests++; return outcome();
    }]));
  class WSClient { start() {} close() {} }
  const callbacks: FeishuDriverCallbacks = { onReady() {}, onError() {}, onReconnecting() {}, onReconnected() {},
    onCardAction: () => ({ toast: { type: 'info', content: 'ack' } }),
    onSendDiagnostic(value) { diagnostics.push(value); observer?.(value); } };
  const driver = await createFeishuSdkDriverFactory(async () => ({ ...sdk, WSClient, defaultHttpInstance: http }))({
    enabled: true, appId: 'cli_diagnostic_' + ++index, appSecret: 'private-secret', tenantKey: 'private-tenant', timeZone: 'UTC',
  }, callbacks);
  return { driver, diagnostics, get requests() { return requests; } };
}

test('diagnostic notifier copies only immutable fixed stages and bounded numeric fields', () => {
  const values: FeishuSendDiagnostic[] = [];
  notifyFeishuSendDiagnostic(value => values.push(value), { stage: 'platform-rejected', code: 230099, httpStatus: 400,
    msg: 'PRIVATE_MSG', error: { message: 'PRIVATE_ERROR' }, payload: input });
  assert.deepEqual(values, [{ stage: 'platform-rejected', code: 230099, httpStatus: 400 }]);
  assert.ok(Object.isFrozen(values[0]));
  for (const invalid of [-1, Infinity, NaN, 0.5, Number.MAX_SAFE_INTEGER + 1, '123']) {
    notifyFeishuSendDiagnostic(value => values.push(value), { stage: 'send-failed', code: invalid, httpStatus: invalid });
    assert.deepEqual(values.at(-1), { stage: 'send-failed' });
  }
  for (const invalid of [99, 600, 200.5, '400']) {
    notifyFeishuSendDiagnostic(value => values.push(value), { stage: 'send-failed', httpStatus: invalid });
    assert.deepEqual(values.at(-1), { stage: 'send-failed' });
  }
  const count = values.length;
  notifyFeishuSendDiagnostic(value => values.push(value), { stage: 'PRIVATE_UNKNOWN_STAGE' });
  notifyFeishuSendDiagnostic(value => values.push(value), { get stage() { throw new Error('PRIVATE_GETTER'); } });
  notifyFeishuSendDiagnostic(value => values.push(value), { stage: 'send-failed', get code() { throw new Error('PRIVATE_GETTER'); } });
  assert.equal(values.length, count);
  assert.doesNotThrow(() => notifyFeishuSendDiagnostic(() => { throw new Error('PRIVATE_OBSERVER'); }, { stage: 'send-failed' }));
  assert.doesNotMatch(JSON.stringify(values), /PRIVATE/);
});

test('error extraction reads only response numeric fields and tolerates hostile getters', () => {
  assert.deepEqual(feishuSendFailureDiagnostic({ response: { status: 403, data: { code: 230099, msg: 'PRIVATE_MSG' } }, message: 'PRIVATE_ERROR' }),
    { stage: 'platform-rejected', code: 230099, httpStatus: 403 });
  assert.deepEqual(feishuSendFailureDiagnostic({ response: { status: 503, data: { code: '230099' } } }), { stage: 'send-failed', httpStatus: 503 });
  assert.deepEqual(feishuSendFailureDiagnostic({ get response() { throw new Error('PRIVATE_GETTER'); } }), { stage: 'send-failed' });
  assert.deepEqual(feishuSendFailureDiagnostic(new Error('PRIVATE_ERROR')), { stage: 'send-failed' });
});

test('real SDK return rejection and throw diagnostics contain no response text and cause no retries', async () => {
  const cases: [() => unknown, FeishuSendDiagnostic][] = [
    [() => ({ code: 230099, msg: 'PRIVATE_MSG', data: { private: input } }), { stage: 'platform-rejected', code: 230099 }],
    [() => { throw { response: { status: 400, data: { code: 230099, msg: 'PRIVATE_MSG' } }, message: 'PRIVATE_ERROR' }; },
      { stage: 'platform-rejected', code: 230099, httpStatus: 400 }],
    [() => { throw { response: { status: 502, data: { code: '123', msg: 'PRIVATE_MSG' } } }; }, { stage: 'send-failed', httpStatus: 502 }],
    [() => ({ code: '0' }), { stage: 'response-invalid' }],
    [() => ({ code: 0, data: { message_id: 'private-message', chat_id: 'other-private-chat' } }), { stage: 'chat-mismatch' }],
  ];
  for (const [outcome, expected] of cases) {
    const f = await fixture(outcome, () => { throw new Error('PRIVATE_OBSERVER'); });
    try {
      assert.deepEqual(await f.driver.sendCard!(input), { status: 'failed-or-unknown' });
      assert.deepEqual(f.diagnostics, [expected]); assert.equal(f.requests, 1);
      assert.doesNotMatch(JSON.stringify(f.diagnostics), /PRIVATE|private-/);
    } finally { await f.driver.close(); }
  }
});

test('success has no failure diagnostic; local authorization, budget and arguments have one fixed diagnostic', async () => {
  const f = await fixture(() => ({ code: 0, data: { message_id: 'private-message', chat_id: input.expectedChatId } }));
  try {
    assert.equal((await f.driver.sendCard!(input)).status, 'platform-accepted'); assert.deepEqual(f.diagnostics, []);
    const cases = [
      [{ ...input, stillAuthorized: () => false }, 'authorization-rejected'],
      [{ ...input, stillAuthorized: () => { throw new Error('PRIVATE_GUARD'); } }, 'authorization-rejected'],
      [{ ...input, card: { schema: '2.0', body: '数'.repeat(7000) } }, 'local-budget'],
      [{ ...input, uuid: 'invalid' }, 'request-invalid'],
    ] as const;
    for (const [value, stage] of cases) {
      f.diagnostics.length = 0;
      assert.deepEqual(await f.driver.sendCard!(value), { status: 'failed-or-unknown' });
      assert.deepEqual(f.diagnostics, [{ stage }]);
    }
    assert.equal(f.requests, 1);
  } finally { await f.driver.close(); }
});
