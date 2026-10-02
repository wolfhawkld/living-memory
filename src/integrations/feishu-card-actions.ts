import type { FeishuScope } from '../shared/feishu-binding.js';
import { FEISHU_CARD_NAV_KIND, type FeishuCardNavAction } from '../shared/feishu-cards.js';
import { normalizeFeishuSdkCardAction } from './feishu-events.js';

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Structural projection only; use inside the authenticated SDK transport. */
export function normalizeFeishuCardNavigation(input: unknown, expected: FeishuScope): FeishuCardNavAction | null {
  const identity = normalizeFeishuSdkCardAction(input, expected);
  if (!identity.ok || !record(input) || !record(input.action) || !Object.hasOwn(input.action, 'value')) return null;
  const value = input.action.value;
  if (!record(value)) return null;
  let count = 0;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    if (++count > 3 || !['kind', 'cardId', 'actionId'].includes(key)) return null;
  }
  if (count !== 3 || !Object.hasOwn(value, 'kind') || value.kind !== FEISHU_CARD_NAV_KIND
    || !Object.hasOwn(value, 'cardId') || typeof value.cardId !== 'string' || !/^[a-f0-9]{32}$/.test(value.cardId)
    || !Object.hasOwn(value, 'actionId') || typeof value.actionId !== 'string' || !/^a(?:[0-9]|1[0-5])$/.test(value.actionId)) return null;
  return { ...identity.value, cardId: value.cardId, actionId: value.actionId };
}
