import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeFeishuCardNavigation } from '../src/integrations/feishu-card-actions.js';
import { normalizeFeishuSdkCardAction } from '../src/integrations/feishu-events.js';

const scope = { appId: 'synthetic-app', tenantKey: 'synthetic-tenant' };
const value = { kind: 'lm.nav.v1', cardId: 'a'.repeat(32), actionId: 'a15' };
function event(payload: unknown = value) {
  return { schema: '2.0', event_type: 'card.action.trigger', event_id: 'synthetic-event', app_id: scope.appId, tenant_key: scope.tenantKey,
    operator: { open_id: 'synthetic-open', tenant_key: scope.tenantKey },
    context: { open_message_id: 'synthetic-message', open_chat_id: 'synthetic-chat' }, action: { tag: 'button', value: payload } };
}
test('navigation projects only the authenticated transport identity and two opaque identifiers', () => {
  assert.deepEqual(normalizeFeishuCardNavigation(event(), scope), { ...scope, eventId: 'synthetic-event', openId: 'synthetic-open',
    messageId: 'synthetic-message', chatId: 'synthetic-chat', cardId: value.cardId, actionId: value.actionId });
  assert.equal(normalizeFeishuCardNavigation({ ...event(), app_id: 'another-app' }, scope), null);
  assert.equal(normalizeFeishuCardNavigation({ ...event(), tenant_key: 'another-tenant' }, scope), null);
  assert.equal(normalizeFeishuCardNavigation({ ...event(), operator: { open_id: 'synthetic-open', tenant_key: 'another-tenant' } }, scope), null);
});
test('malformed, inherited, extra and account claim payload fields never become navigation targets', () => {
  for (const invalid of [null, [], '', 0, { ...value, kind: 'lm.nav.v2' }, { ...value, cardId: 'A'.repeat(32) },
    { ...value, cardId: 'a'.repeat(33) }, { ...value, actionId: 'a16' }, { ...value, actionId: 'a01' },
    { ...value, userId: 'owner' }, { ...value, domainId: 'Private' }, { ...value, target: { kind: 'read' } },
    Object.assign(Object.create({ cardId: value.cardId }), { kind: value.kind, actionId: value.actionId })]) {
    assert.equal(normalizeFeishuCardNavigation(event(invalid), scope), null);
  }
  assert.equal(normalizeFeishuCardNavigation({ ...event(), action: { tag: 'button' } }, scope), null);
  assert.equal(normalizeFeishuCardNavigation({ ...event(), action: { tag: 'button', value: undefined } }, scope), null);
});
test('the legacy identity parser remains independent of button payloads', () => {
  const input = event(); Object.defineProperty(input.action, 'value', { get() { throw new Error('legacy payload must stay unread'); } });
  assert.equal(normalizeFeishuSdkCardAction(input, scope).ok, true);
});
