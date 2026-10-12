import type { FeishuCardPayload } from '../../src/shared/feishu-cards.js';

/** Traverse the native element tree, never action payloads or arbitrary metadata. */
export function cardElements(card: FeishuCardPayload): Array<Record<string, any>> {
  const result: Array<Record<string, any>> = [];
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const element = value as Record<string, any>;
    if (typeof element.tag !== 'string') return;
    result.push(element);
    if (Array.isArray(element.elements)) element.elements.forEach(visit);
    if (Array.isArray(element.columns)) element.columns.forEach(visit);
  };
  const body = card.body as { elements?: unknown[] } | undefined;
  if (Array.isArray(body?.elements)) body.elements.forEach(visit);
  return result;
}

export function cardButtons(card: FeishuCardPayload): Array<Record<string, any>> {
  return cardElements(card).filter((element) => element.tag === 'button');
}
