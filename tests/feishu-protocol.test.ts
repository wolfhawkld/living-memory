import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildOfflineProbeCard, normalizeFeishuCardAction, resolveSyntheticBinding,
  evaluateOfflineProbeAction, OFFLINE_PROBE_KIND,
  type ExpectedOfflineProbe, type SyntheticBinding,
} from '../src/integrations/feishu-protocol.js';

const expected: ExpectedOfflineProbe = {
  probeId: 'synthetic-probe-1', appId: 'synthetic-app', tenantKey: 'synthetic-tenant',
  openId: 'synthetic-open-id', openChatId: 'synthetic-chat', openMessageId: 'synthetic-message',
};
const binding: SyntheticBinding = {
  appId: expected.appId, tenantKey: expected.tenantKey, openId: expected.openId,
  accountId: '11111111-1111-4111-8111-111111111111', enabled: true,
};
function envelope() {
  return {
    schema: '2.0',
    header: { event_type: 'card.action.trigger', event_id: 'synthetic-event', app_id: expected.appId, tenant_key: expected.tenantKey },
    event: {
      operator: { open_id: expected.openId, tenant_key: expected.tenantKey },
      context: { open_chat_id: expected.openChatId, open_message_id: expected.openMessageId },
      action: { tag: 'button', value: { kind: OFFLINE_PROBE_KIND, probeId: expected.probeId } },
    },
  };
}
function parsed() {
  const result = normalizeFeishuCardAction(envelope(), expected.appId);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('Synthetic fixture failed');
  return result.value;
}

test('card uses schema 2 callback structure and contains only synthetic offline content', () => {
  const card = buildOfflineProbeCard(expected.probeId);
  assert.equal(card.schema, '2.0');
  assert.deepEqual(card.header.title, { tag: 'plain_text', content: '纯离线协议测试卡' });
  const columns = card.body.elements[1].columns!;
  assert.equal(card.body.elements[1].tag, 'column_set');
  assert.equal(columns[0].tag, 'column');
  assert.equal(columns[0].elements[0].tag, 'button');
  assert.deepEqual(columns[0].elements[0].behaviors, [{ type: 'callback', value: { kind: OFFLINE_PROBE_KIND, probeId: expected.probeId } }]);
  const json = JSON.stringify(card);
  for (const forbidden of ['accountId', 'sourceId', 'secret', 'token', binding.accountId, '来源答案']) assert.equal(json.includes(forbidden), false);
  assert.match(json, /离线/);
  for (const invalid of ['', ' ', 'a'.repeat(257), 3, null]) assert.throws(() => buildOfflineProbeCard(invalid as string), /^Error: Invalid offline probe identifier$/);
});

test('normalization projects necessary fields; structural success does not assert transport authentication', () => {
  const input = { ...envelope(), token: 'synthetic-secret-never-project', other: { nested: 'ignored' } };
  const result = normalizeFeishuCardAction(input, expected.appId);
  assert.deepEqual(result, { ok: true, value: {
    eventId: 'synthetic-event', appId: expected.appId, tenantKey: expected.tenantKey,
    openId: expected.openId, openMessageId: expected.openMessageId, openChatId: expected.openChatId,
    value: { kind: OFFLINE_PROBE_KIND, probeId: expected.probeId },
  } });
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.equal(JSON.stringify(result).includes('authenticated'), false);
  assert.equal(JSON.stringify(input).includes('synthetic-secret-never-project'), true);
  const withoutOptionalTenant = envelope();
  delete (withoutOptionalTenant.event.operator as Partial<typeof withoutOptionalTenant.event.operator>).tenant_key;
  assert.equal(normalizeFeishuCardAction(withoutOptionalTenant, expected.appId).ok, true);
  const flattenedSdkShape = { ...input.header, ...input.event };
  assert.deepEqual(normalizeFeishuCardAction(flattenedSdkShape, expected.appId), { ok: false, reason: 'invalid-envelope' });
});

test('malformed required envelope fields and oversized structures fail with fixed errors', () => {
  const paths = [
    ['schema'], ['header'], ['event'], ['header', 'event_type'], ['header', 'event_id'],
    ['header', 'app_id'], ['header', 'tenant_key'], ['event', 'operator'],
    ['event', 'operator', 'open_id'], ['event', 'operator', 'tenant_key'],
    ['event', 'context'], ['event', 'context', 'open_chat_id'], ['event', 'context', 'open_message_id'],
    ['event', 'action'], ['event', 'action', 'tag'],
  ];
  for (const path of paths) {
    for (const invalid of [undefined, null, [], {}, 42, true, '', ' ', 'a'.repeat(257)]) {
      const input = envelope();
      let target = input as unknown as Record<string, unknown>;
      for (const key of path.slice(0, -1)) target = target[key] as Record<string, unknown>;
      target[path.at(-1)!] = invalid;
      assert.deepEqual(normalizeFeishuCardAction(input, expected.appId), { ok: false, reason: 'invalid-envelope' }, `${path.join('.')} invalid`);
    }
  }
  for (const invalid of [null, [], 42, 'raw string']) assert.equal(normalizeFeishuCardAction(invalid, expected.appId).ok, false);
  assert.equal(normalizeFeishuCardAction(envelope(), '').ok, false);
  const oversized = Object.assign(envelope(), Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`extra${index}`, 0])));
  assert.deepEqual(normalizeFeishuCardAction(oversized, expected.appId), { ok: false, reason: 'invalid-envelope' });
  const inheritedSchema = Object.assign(Object.create({ schema: '2.0' }), { header: envelope().header, event: envelope().event });
  assert.equal(normalizeFeishuCardAction(inheritedSchema, expected.appId).ok, false);
});

test('wrong app, operator tenant, tag and event type are rejected', () => {
  assert.deepEqual(normalizeFeishuCardAction(envelope(), 'other-app'), { ok: false, reason: 'unexpected-app' });
  for (const mutate of [
    (input: ReturnType<typeof envelope>) => { input.event.operator.tenant_key = 'other-tenant'; },
    (input: ReturnType<typeof envelope>) => { input.event.action.tag = 'select'; },
    (input: ReturnType<typeof envelope>) => { input.header.event_type = 'im.message.receive_v1'; },
    (input: ReturnType<typeof envelope>) => { input.schema = '1.0'; },
  ]) {
    const input = envelope(); mutate(input);
    assert.deepEqual(normalizeFeishuCardAction(input, expected.appId), { ok: false, reason: 'invalid-envelope' });
  }
});

test('action values reject malformed fields and forged authorization identifiers', () => {
  for (const value of [null, [], 'value', {}, { kind: OFFLINE_PROBE_KIND }, { probeId: expected.probeId },
    { kind: 2, probeId: expected.probeId }, { kind: OFFLINE_PROBE_KIND, probeId: 'a'.repeat(257) },
    ...['accountId', 'sourceId', 'username', 'unknown'].map(key => ({ kind: OFFLINE_PROBE_KIND, probeId: expected.probeId, [key]: binding.accountId })),
  ]) {
    const input = envelope();
    (input.event.action as { value: unknown }).value = value;
    assert.deepEqual(normalizeFeishuCardAction(input, expected.appId), { ok: false, reason: 'invalid-action-value' });
  }
});

test('binding uses enabled app/tenant/open-id tuple only and fails closed on duplicates', () => {
  const action = parsed();
  assert.deepEqual(resolveSyntheticBinding(action, [binding]), { ok: true, value: { accountId: binding.accountId } });
  for (const fixtures of [[], [{ ...binding, enabled: false }], [binding, binding],
    [{ ...binding, appId: 'other-app' }], [{ ...binding, tenantKey: 'other-tenant' }], [{ ...binding, openId: 'other-open-id' }],
  ]) assert.deepEqual(resolveSyntheticBinding(action, fixtures), { ok: false, reason: 'unbound-actor' });
  assert.deepEqual(resolveSyntheticBinding(action, [{ ...binding, accountId: 'not-a-uuid' }]), { ok: false, reason: 'invalid-bindings' });
  const forged = { ...action, openId: 'unbound-open-id', value: { ...action.value, accountId: binding.accountId, sourceId: 'synthetic-source', username: 'owner' } };
  assert.deepEqual(resolveSyntheticBinding(forged, [binding]), { ok: false, reason: 'unbound-actor' });
  assert.deepEqual(resolveSyntheticBinding(action, Array.from({ length: 257 }, () => binding)), { ok: false, reason: 'invalid-bindings' });
});

test('evaluation confirms protocol only and rejects wrong probe, actor, message or chat', () => {
  const action = parsed();
  assert.deepEqual(evaluateOfflineProbeAction(action, expected), {
    ok: true, value: { status: 'offline-protocol-confirmed', toast: { type: 'info', content: '离线协议校验通过；未保存学习记录或完成复习。' } },
  });
  for (const value of [{ ...action.value, kind: 'review' }, { ...action.value, probeId: 'other-probe' }]) {
    assert.deepEqual(evaluateOfflineProbeAction({ ...action, value }, expected), { ok: false, reason: 'unexpected-probe' });
  }
  for (const key of ['appId', 'tenantKey', 'openId'] as const) assert.deepEqual(evaluateOfflineProbeAction({ ...action, [key]: 'other' }, expected), { ok: false, reason: 'unexpected-actor' });
  for (const key of ['openChatId', 'openMessageId'] as const) assert.deepEqual(evaluateOfflineProbeAction({ ...action, [key]: 'other' }, expected), { ok: false, reason: 'unexpected-context' });
  assert.deepEqual(evaluateOfflineProbeAction(action, { ...expected, probeId: '' }), { ok: false, reason: 'invalid-expected-probe' });
  assert.deepEqual(evaluateOfflineProbeAction(action, expected), evaluateOfflineProbeAction(action, expected));
});
