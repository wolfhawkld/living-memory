/** Pure SDK event projection; no transport, account binding, storage, or learning actions. */
export const FEISHU_EVENT_FIELD_MAX_LENGTH = 256;
export interface FeishuExpectedIdentity { appId: string; tenantKey: string }
export interface NormalizedFeishuSdkCardAction {
  eventId: string;
  appId: string;
  tenantKey: string;
  openId: string;
  messageId: string;
  chatId: string;
}
export type FeishuEventRejection =
  | 'invalid-event' | 'invalid-expected-identity'
  | 'unexpected-app' | 'unexpected-tenant' | 'unexpected-operator-tenant';
export type FeishuEventResult =
  | { ok: true; value: NormalizedFeishuSdkCardAction }
  | { ok: false; reason: FeishuEventRejection };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
function own(value: Record<string, unknown>, key: string): unknown {
  return hasOwn(value, key) ? value[key] : undefined;
}
function validString(value: unknown): value is string {
  return typeof value === 'string' && value.length <= FEISHU_EVENT_FIELD_MAX_LENGTH && value.trim().length > 0;
}
function reject(reason: FeishuEventRejection): FeishuEventResult {
  return { ok: false, reason };
}

/**
 * Structural validation does not authenticate the platform or authorize the actor.
 * Call only inside an authenticated official SDK WebSocket transport, never from a
 * public HTTP route. Input must be SDK JSON-like data, not executable getters/proxies.
 * Accepts the SDK handler's flattened header + event shape, retaining schema 2.0
 * when supplied, not raw schema envelopes.
 * action.value and all payload permission/identity claims are ignored, never read.
 */
export function normalizeFeishuSdkCardAction(
  input: unknown, expected: FeishuExpectedIdentity,
): FeishuEventResult {
  if (!record(expected) || !validString(own(expected, 'appId')) || !validString(own(expected, 'tenantKey'))) {
    return reject('invalid-expected-identity');
  }
  if (!record(input) || (hasOwn(input, 'schema') && own(input, 'schema') !== '2.0')
    || hasOwn(input, 'header') || hasOwn(input, 'event')
    || own(input, 'event_type') !== 'card.action.trigger') return reject('invalid-event');
  const eventId = own(input, 'event_id');
  const appId = own(input, 'app_id');
  const tenantKey = own(input, 'tenant_key');
  if (!validString(eventId) || !validString(appId) || !validString(tenantKey)) return reject('invalid-event');
  if (appId !== expected.appId) return reject('unexpected-app');
  if (tenantKey !== expected.tenantKey) return reject('unexpected-tenant');
  const operator = own(input, 'operator');
  const context = own(input, 'context');
  const action = own(input, 'action');
  if (!record(operator) || !record(context) || !record(action) || own(action, 'tag') !== 'button') return reject('invalid-event');
  const openId = own(operator, 'open_id');
  const messageId = own(context, 'open_message_id');
  const chatId = own(context, 'open_chat_id');
  if (!validString(openId) || !validString(messageId) || !validString(chatId)) return reject('invalid-event');
  if (hasOwn(operator, 'tenant_key')) {
    const operatorTenant = own(operator, 'tenant_key');
    if (!validString(operatorTenant)) return reject('invalid-event');
    if (operatorTenant !== tenantKey) return reject('unexpected-operator-tenant');
  }
  return { ok: true, value: { eventId, appId, tenantKey, openId, messageId, chatId } };
}
