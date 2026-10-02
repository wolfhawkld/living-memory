/** Pure offline protocol helpers; no transport, credentials, storage, or learning actions. */
export const OFFLINE_PROBE_KIND = 'lm-feishu-offline-probe';
const MAX_STRING_LENGTH = 256;
const MAX_OBJECT_KEYS = 32;

export type ProtocolRejection =
  | 'invalid-envelope' | 'unexpected-app' | 'invalid-action-value'
  | 'invalid-bindings' | 'unbound-actor' | 'invalid-expected-probe'
  | 'unexpected-probe' | 'unexpected-context' | 'unexpected-actor';
export type ProtocolResult<T> = { ok: true; value: T } | { ok: false; reason: ProtocolRejection };
export interface NormalizedFeishuCardAction {
  eventId: string;
  appId: string;
  tenantKey: string;
  openId: string;
  openMessageId: string;
  openChatId: string;
  value: { kind: string; probeId: string };
}
/** Only synthetic fixtures belong here; this is not a production account registry. */
export interface SyntheticBinding {
  appId: string;
  tenantKey: string;
  openId: string;
  accountId: string;
  enabled: boolean;
}
export interface ExpectedOfflineProbe {
  probeId: string;
  appId: string;
  tenantKey: string;
  openId: string;
  openMessageId: string;
  openChatId: string;
}
export interface OfflineProbeConfirmation {
  status: 'offline-protocol-confirmed';
  toast: { type: 'info'; content: string };
}

function reject(reason: ProtocolRejection): { ok: false; reason: ProtocolRejection } {
  return { ok: false, reason };
}
function validString(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_STRING_LENGTH && value.trim().length > 0;
}
function record(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  // Inspect at most MAX_OBJECT_KEYS + 1 own enumerable fields; never serialize raw input.
  let count = 0;
  for (const key in value) {
    if (Object.prototype.hasOwnProperty.call(value, key) && ++count > MAX_OBJECT_KEYS) return false;
  }
  return true;
}
function own(object: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(object, key) ? object[key] : undefined;
}
function identityValid(value: { appId: unknown; tenantKey: unknown; openId: unknown }): boolean {
  return validString(value.appId) && validString(value.tenantKey) && validString(value.openId);
}

export function buildOfflineProbeCard(probeId: string) {
  if (!validString(probeId)) throw new Error('Invalid offline probe identifier');
  return {
    schema: '2.0',
    header: { title: { tag: 'plain_text', content: '纯离线协议测试卡' } },
    body: {
      elements: [
        { tag: 'markdown', content: '合成测试内容：仅用于离线校验卡片回调协议。不会展示真实知识、保存记录或完成复习。' },
        {
          tag: 'column_set',
          columns: [{
            tag: 'column', width: 'weighted', weight: 1,
            elements: [{
              tag: 'button', text: { tag: 'plain_text', content: '确认离线协议' },
              behaviors: [{ type: 'callback', value: { kind: OFFLINE_PROBE_KIND, probeId } }],
            }],
          }],
        },
      ],
    },
  };
}

/**
 * Structural validation is NOT transport authentication. Production may call this only
 * through an authenticated official transport, never directly from a public HTTP route.
 * Accepts raw schema envelopes only. SDK handlers flatten header + event; a future
 * runtime adapter must normalize that shape before invoking this function.
 * Unknown envelope metadata is ignored and omitted. Unknown action.value keys are rejected.
 * Callers supply JSON-like data, not objects with executable getters/proxies.
 */
export function normalizeFeishuCardAction(
  rawEnvelope: unknown, expectedAppId: string,
): ProtocolResult<NormalizedFeishuCardAction> {
  if (!validString(expectedAppId) || !record(rawEnvelope) || own(rawEnvelope, 'schema') !== '2.0') return reject('invalid-envelope');
  const header = own(rawEnvelope, 'header');
  const event = own(rawEnvelope, 'event');
  if (!record(header) || !record(event) || own(header, 'event_type') !== 'card.action.trigger') return reject('invalid-envelope');
  const eventId = own(header, 'event_id');
  const appId = own(header, 'app_id');
  const tenantKey = own(header, 'tenant_key');
  if (!validString(eventId) || !validString(appId) || !validString(tenantKey)) return reject('invalid-envelope');
  if (appId !== expectedAppId) return reject('unexpected-app');
  const operator = own(event, 'operator');
  const context = own(event, 'context');
  const action = own(event, 'action');
  if (!record(operator) || !record(context) || !record(action) || own(action, 'tag') !== 'button') return reject('invalid-envelope');
  const openId = own(operator, 'open_id');
  const operatorTenant = own(operator, 'tenant_key');
  const openMessageId = own(context, 'open_message_id');
  const openChatId = own(context, 'open_chat_id');
  if (!validString(openId) || !validString(openMessageId) || !validString(openChatId)
    || (Object.prototype.hasOwnProperty.call(operator, 'tenant_key') && operatorTenant !== tenantKey)) return reject('invalid-envelope');
  const value = own(action, 'value');
  if (!record(value) || Object.keys(value).some(key => key !== 'kind' && key !== 'probeId')) return reject('invalid-action-value');
  const kind = own(value, 'kind');
  const probeId = own(value, 'probeId');
  if (!validString(kind) || !validString(probeId)) return reject('invalid-action-value');
  return { ok: true, value: { eventId, appId, tenantKey, openId, openMessageId, openChatId, value: { kind, probeId } } };
}

export function resolveSyntheticBinding(
  action: NormalizedFeishuCardAction, fixtureBindings: readonly SyntheticBinding[],
): ProtocolResult<{ accountId: string }> {
  if (!identityValid(action) || !Array.isArray(fixtureBindings) || fixtureBindings.length > 256) return reject('invalid-bindings');
  const matches = fixtureBindings.filter(binding => binding && binding.appId === action.appId
    && binding.tenantKey === action.tenantKey && binding.openId === action.openId);
  // Duplicate or disabled bindings fail closed; payload identifiers never enter this lookup.
  if (matches.length !== 1 || matches[0].enabled !== true) return reject('unbound-actor');
  const accountId = matches[0].accountId;
  if (typeof accountId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(accountId)) return reject('invalid-bindings');
  return { ok: true, value: { accountId } };
}

export function evaluateOfflineProbeAction(
  parsed: NormalizedFeishuCardAction, expectedProbe: ExpectedOfflineProbe,
): ProtocolResult<OfflineProbeConfirmation> {
  if (!identityValid(expectedProbe) || !validString(expectedProbe.probeId)
    || !validString(expectedProbe.openMessageId) || !validString(expectedProbe.openChatId)) return reject('invalid-expected-probe');
  if (parsed.value.kind !== OFFLINE_PROBE_KIND || parsed.value.probeId !== expectedProbe.probeId) return reject('unexpected-probe');
  if (parsed.appId !== expectedProbe.appId || parsed.tenantKey !== expectedProbe.tenantKey || parsed.openId !== expectedProbe.openId) return reject('unexpected-actor');
  if (parsed.openMessageId !== expectedProbe.openMessageId || parsed.openChatId !== expectedProbe.openChatId) return reject('unexpected-context');
  return { ok: true, value: { status: 'offline-protocol-confirmed', toast: { type: 'info', content: '离线协议校验通过；未保存学习记录或完成复习。' } } };
}
