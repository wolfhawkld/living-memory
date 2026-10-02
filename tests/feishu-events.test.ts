import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeFeishuSdkCardAction, FEISHU_EVENT_FIELD_MAX_LENGTH, type FeishuExpectedIdentity } from '../src/integrations/feishu-events.js';

const expected: FeishuExpectedIdentity = { appId: 'synthetic-app', tenantKey: 'synthetic-tenant' };
const projected = {
  eventId: 'synthetic-event', appId: expected.appId, tenantKey: expected.tenantKey,
  openId: 'synthetic-open-id', messageId: 'synthetic-message', chatId: 'synthetic-chat',
};
function sdkEvent(): Record<string, unknown> {
  return {
    schema: '2.0',
    event_type: 'card.action.trigger', event_id: projected.eventId, app_id: expected.appId, tenant_key: expected.tenantKey,
    operator: { open_id: projected.openId, tenant_key: expected.tenantKey },
    context: { open_message_id: projected.messageId, open_chat_id: projected.chatId },
    action: { tag: 'button', value: { arbitrary: 'ignored' } },
  };
}
function replace(path: string[], value: unknown): Record<string, unknown> {
  const input = sdkEvent();
  let target = input;
  for (const key of path.slice(0, -1)) target = target[key] as Record<string, unknown>;
  target[path.at(-1)!] = value;
  return input;
}

test('SDK flattened event projects only six fields without asserting authentication or authorization', () => {
  const input = { ...sdkEvent(), token: 'synthetic-token', body: { private: 'synthetic-body' }, permissions: ['owner'], metadata: 'synthetic-metadata' };
  assert.deepEqual(normalizeFeishuSdkCardAction(input, expected), { ok: true, value: projected });
  const withoutOptionalTenant = sdkEvent();
  delete (withoutOptionalTenant.operator as Record<string, unknown>).tenant_key;
  assert.deepEqual(normalizeFeishuSdkCardAction(withoutOptionalTenant, expected), { ok: true, value: projected });
  const withoutSchema = sdkEvent();
  delete withoutSchema.schema;
  assert.deepEqual(normalizeFeishuSdkCardAction(withoutSchema, expected), { ok: true, value: projected });
});

test('raw schema envelopes and mixed envelope shapes are rejected', () => {
  const flat = sdkEvent();
  const { schema: _schema, event_type, event_id, app_id, tenant_key, ...event } = flat;
  const raw = { schema: '2.0', header: { event_type, event_id, app_id, tenant_key }, event };
  assert.deepEqual(normalizeFeishuSdkCardAction(raw, expected), { ok: false, reason: 'invalid-event' });
  for (const key of ['header', 'event']) {
    assert.deepEqual(normalizeFeishuSdkCardAction({ ...flat, [key]: raw[key as keyof typeof raw] }, expected), { ok: false, reason: 'invalid-event' });
  }
  for (const schema of [undefined, null, 2, '1.0', '', ' 2.0 ']) {
    assert.deepEqual(normalizeFeishuSdkCardAction({ ...flat, schema }, expected), { ok: false, reason: 'invalid-event' });
  }
});

test('wrong app, tenant and optional operator tenant each fail closed', () => {
  assert.deepEqual(normalizeFeishuSdkCardAction(replace(['app_id'], 'other-app'), expected), { ok: false, reason: 'unexpected-app' });
  assert.deepEqual(normalizeFeishuSdkCardAction(replace(['tenant_key'], 'other-tenant'), expected), { ok: false, reason: 'unexpected-tenant' });
  assert.deepEqual(normalizeFeishuSdkCardAction(replace(['operator', 'tenant_key'], 'other-tenant'), expected), { ok: false, reason: 'unexpected-operator-tenant' });
  const crossTenant = replace(['tenant_key'], 'other-tenant');
  (crossTenant.operator as Record<string, unknown>).tenant_key = 'other-tenant';
  assert.deepEqual(normalizeFeishuSdkCardAction(crossTenant, expected), { ok: false, reason: 'unexpected-tenant' });
});

test('malformed required fields, event types, tags and context return fixed rejection', () => {
  const paths = [
    ['event_type'], ['event_id'], ['app_id'], ['tenant_key'], ['operator'], ['operator', 'open_id'],
    ['operator', 'tenant_key'], ['context'], ['context', 'open_message_id'], ['context', 'open_chat_id'], ['action'], ['action', 'tag'],
  ];
  for (const path of paths) {
    for (const invalid of [undefined, null, [], {}, 42, true, '', ' \t', 'x'.repeat(FEISHU_EVENT_FIELD_MAX_LENGTH + 1)]) {
      assert.deepEqual(normalizeFeishuSdkCardAction(replace(path, invalid), expected), { ok: false, reason: 'invalid-event' }, path.join('.'));
    }
  }
  for (const [path, invalid] of [[['event_type'], 'im.message.receive_v1'], [['action', 'tag'], 'select']] as const) {
    assert.deepEqual(normalizeFeishuSdkCardAction(replace([...path], invalid), expected), { ok: false, reason: 'invalid-event' });
  }
  for (const invalid of [undefined, null, [], 42, 'raw-input']) {
    assert.deepEqual(normalizeFeishuSdkCardAction(invalid, expected), { ok: false, reason: 'invalid-event' });
  }
});

test('event fields accept exact length limit and preserve identity without trimming', () => {
  for (const path of [['event_id'], ['operator', 'open_id'], ['context', 'open_message_id'], ['context', 'open_chat_id']]) {
    assert.equal(normalizeFeishuSdkCardAction(replace(path, 'x'.repeat(FEISHU_EVENT_FIELD_MAX_LENGTH)), expected).ok, true);
  }
  assert.deepEqual(normalizeFeishuSdkCardAction(replace(['app_id'], ` ${expected.appId} `), expected), { ok: false, reason: 'unexpected-app' });
  assert.deepEqual(normalizeFeishuSdkCardAction(replace(['tenant_key'], ` ${expected.tenantKey} `), expected), { ok: false, reason: 'unexpected-tenant' });
});

test('invalid expected identity cannot bypass application or tenant validation', () => {
  for (const key of ['appId', 'tenantKey']) {
    for (const invalid of [undefined, null, [], {}, 1, '', ' ', 'x'.repeat(FEISHU_EVENT_FIELD_MAX_LENGTH + 1)]) {
      assert.deepEqual(normalizeFeishuSdkCardAction(sdkEvent(), { ...expected, [key]: invalid } as FeishuExpectedIdentity), { ok: false, reason: 'invalid-expected-identity' });
    }
  }
  assert.deepEqual(normalizeFeishuSdkCardAction(sdkEvent(), null as unknown as FeishuExpectedIdentity), { ok: false, reason: 'invalid-expected-identity' });
});

test('payload account, source, username and permission claims cannot replace operator identity', () => {
  const input = replace(['operator', 'open_id'], 'synthetic-unbound-open-id');
  const claims = { accountId: 'synthetic-account', sourceId: 'synthetic-source', username: 'owner', open_id: projected.openId, tenant_key: expected.tenantKey, authorized: true };
  input.action = { tag: 'button', value: claims };
  input.owner = claims;
  input.permissions = ['admin'];
  assert.deepEqual(normalizeFeishuSdkCardAction(input, expected), { ok: true, value: { ...projected, openId: 'synthetic-unbound-open-id' } });
  delete (input.operator as Record<string, unknown>).open_id;
  assert.deepEqual(normalizeFeishuSdkCardAction(input, expected), { ok: false, reason: 'invalid-event' });
  const action = sdkEvent().action as Record<string, unknown>;
  Object.defineProperty(action, 'value', { get() { throw new Error('Action value must never be read'); } });
  assert.deepEqual(normalizeFeishuSdkCardAction({ ...sdkEvent(), action }, expected), { ok: true, value: projected });
});

test('required fields must be own properties and action value is never required', () => {
  const input = sdkEvent();
  const inherited = Object.assign(Object.create({ event_id: projected.eventId }), input);
  delete inherited.event_id;
  assert.deepEqual(normalizeFeishuSdkCardAction(inherited, expected), { ok: false, reason: 'invalid-event' });
  for (const value of [undefined, null, [], '', 42]) {
    assert.deepEqual(normalizeFeishuSdkCardAction(replace(['action', 'value'], value), expected), { ok: true, value: projected });
  }
});
