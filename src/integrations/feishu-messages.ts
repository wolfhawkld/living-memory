import type { FeishuBindingConfirmation, FeishuScope } from '../shared/feishu-binding.js';

const MAX_ID_LENGTH = 256;
const MAX_CONTENT_LENGTH = 4096;
const BINDING_COMMAND = /^确认绑定 (LM-[A-Za-z0-9_-]{22})$/;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function own(value: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(value, key) ? value[key] : undefined;
}
function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_ID_LENGTH && value.trim().length > 0;
}

/**
 * Project a binding command only inside the authenticated official SDK transport.
 * This structural parser does not authenticate anyone. It accepts SDK JSON data,
 * not executable getters/proxies, and never retains the original message body.
 */
export function normalizeFeishuBindingMessage(
  input: unknown, expected: FeishuScope,
): FeishuBindingConfirmation | null {
  if (!record(expected) || !validId(own(expected, 'appId')) || !validId(own(expected, 'tenantKey'))) return null;
  if (!record(input) || Object.hasOwn(input, 'header') || Object.hasOwn(input, 'event')
    || (Object.hasOwn(input, 'schema') && own(input, 'schema') !== '2.0')
    || own(input, 'event_type') !== 'im.message.receive_v1') return null;
  const eventId = own(input, 'event_id');
  const appId = own(input, 'app_id');
  const tenantKey = own(input, 'tenant_key');
  if (!validId(eventId) || appId !== expected.appId || tenantKey !== expected.tenantKey) return null;
  const sender = own(input, 'sender');
  const message = own(input, 'message');
  if (!record(sender) || own(sender, 'sender_type') !== 'user' || !record(message)
    || own(message, 'chat_type') !== 'p2p' || own(message, 'message_type') !== 'text') return null;
  if (Object.hasOwn(sender, 'tenant_key') && own(sender, 'tenant_key') !== tenantKey) return null;
  const senderId = own(sender, 'sender_id');
  if (!record(senderId)) return null;
  const openId = own(senderId, 'open_id');
  const messageId = own(message, 'message_id');
  const chatId = own(message, 'chat_id');
  const content = own(message, 'content');
  if (!validId(openId) || !validId(messageId) || !validId(chatId)
    || typeof content !== 'string' || content.length > MAX_CONTENT_LENGTH) return null;
  let decoded: unknown;
  try { decoded = JSON.parse(content); } catch { return null; }
  if (!record(decoded)) return null;
  const text = own(decoded, 'text');
  if (typeof text !== 'string' || text.length > 256) return null;
  const command = text.trim().match(BINDING_COMMAND);
  if (!command) return null;
  return { appId: expected.appId, tenantKey: expected.tenantKey, openId, eventId, messageId, chatId, code: command[1] };
}
