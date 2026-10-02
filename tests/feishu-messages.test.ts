import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeFeishuBindingMessage } from '../src/integrations/feishu-messages.js';

const scope = { appId: 'cli_0000000000000000', tenantKey: 'synthetic-tenant' };
const code = `LM-${'a'.repeat(22)}`;
function message() {
  return {
    schema: '2.0', event_type: 'im.message.receive_v1', event_id: 'synthetic-event',
    app_id: scope.appId, tenant_key: scope.tenantKey,
    sender: { sender_type: 'user', tenant_key: scope.tenantKey, sender_id: { open_id: 'synthetic-actor', user_id: 'ignored-user' } },
    message: { chat_type: 'p2p', message_type: 'text', message_id: 'synthetic-message', chat_id: 'synthetic-chat',
      content: JSON.stringify({ text: `确认绑定 ${code}`, accountId: 'ignored-account', owner: true }) },
  };
}

test('binding message projects only authenticated event identity and an exact confirmation command', () => {
  assert.deepEqual(normalizeFeishuBindingMessage(message(), scope), {
    ...scope, openId: 'synthetic-actor', eventId: 'synthetic-event',
    messageId: 'synthetic-message', chatId: 'synthetic-chat', code,
  });
  const event = message();
  event.message.content = JSON.stringify({ text: `  确认绑定 ${code}\n` });
  assert.equal(normalizeFeishuBindingMessage(event, scope)?.code, code);
});

test('bot, group, nontext and unrelated messages are ignored', () => {
  for (const change of [
    (event: ReturnType<typeof message>) => { event.sender.sender_type = 'bot'; },
    (event: ReturnType<typeof message>) => { event.message.chat_type = 'group'; },
    (event: ReturnType<typeof message>) => { event.message.message_type = 'interactive'; },
    (event: ReturnType<typeof message>) => { event.message.content = JSON.stringify({ text: '阅读一些知识' }); },
    (event: ReturnType<typeof message>) => { event.event_type = 'another.event'; },
  ]) {
    const event = message(); change(event);
    assert.equal(normalizeFeishuBindingMessage(event, scope), null);
  }
});

test('message identity must match app and tenant and cannot fall back to user or payload claims', () => {
  for (const event of [
    { ...message(), app_id: 'other-app' }, { ...message(), tenant_key: 'other-tenant' },
    { ...message(), sender: { ...message().sender, tenant_key: 'other-tenant' } },
    { ...message(), sender: { sender_type: 'user', sender_id: { user_id: 'synthetic-actor', open_id: '' } } },
    { ...message(), app_id: undefined }, { ...message(), tenant_key: undefined },
  ]) assert.equal(normalizeFeishuBindingMessage(event, scope), null);
});

test('malformed JSON, overlong input and nonexact command forms cannot create a claim', () => {
  const values: unknown[] = [
    null, {}, 'not-json', JSON.stringify([]), JSON.stringify({ text: null }),
    JSON.stringify({ text: 'a'.repeat(257) }), ' '.repeat(4097),
    JSON.stringify({ text: `绑定 ${code}` }), JSON.stringify({ text: `确认绑定  ${code}` }),
    JSON.stringify({ text: `确认绑定 ${code} extra` }), JSON.stringify({ text: `确认绑定 LM-${'a'.repeat(21)}` }),
    JSON.stringify({ text: `确认绑定 LM-${'!'.repeat(22)}` }),
  ];
  for (const content of values) {
    assert.equal(normalizeFeishuBindingMessage({ ...message(), message: { ...message().message, content } }, scope), null);
  }
});

test('only SDK flat JSON fields are accepted and raw envelopes or inherited identity are rejected', () => {
  const event = message();
  for (const invalid of [null, [], {}, { schema: '2.0', header: event, event: {} },
    { ...event, header: {} }, { ...event, event: {} }, { ...event, schema: '1.0' },
    Object.create(event), { ...event, sender: Object.create(event.sender) },
  ]) assert.equal(normalizeFeishuBindingMessage(invalid, scope), null);
  const { schema: _schema, ...withoutSchema } = event;
  assert.ok(normalizeFeishuBindingMessage(withoutSchema, scope));
});

test('invalid expected scope or missing and oversized identifiers fail closed', () => {
  for (const expected of [{ appId: '', tenantKey: scope.tenantKey }, { appId: scope.appId, tenantKey: '' }, null]) {
    assert.equal(normalizeFeishuBindingMessage(message(), expected as typeof scope), null);
  }
  for (const invalid of ['', ' ', 1, null, 'x'.repeat(257)]) {
    assert.equal(normalizeFeishuBindingMessage({ ...message(), event_id: invalid }, scope), null);
    assert.equal(normalizeFeishuBindingMessage({ ...message(), message: { ...message().message, chat_id: invalid } }, scope), null);
    assert.equal(normalizeFeishuBindingMessage({ ...message(), sender: { ...message().sender, sender_id: { open_id: invalid } } }, scope), null);
  }
});
