import type { FeishuCardPayload } from '../shared/feishu-cards.js';
import { safeMarkdown } from './feishu-body-text.js';
import type { FeishuExternalReferences } from './feishu-external-references.js';
import { cardDivider, cardMarkdown, cardUrlButton, type NativeCardElement } from './feishu-card-style.js';

function label(value: string): string {
  const safe = safeMarkdown(value).replace(/[\u0000-\u0020\u007f-\u009f]+/g, ' ').trim();
  if (Buffer.byteLength(safe) <= 180) return safe;
  let result = '';
  for (const scalar of safe) {
    if (Buffer.byteLength(result + scalar) > 177) break;
    result += scalar;
  }
  return result + '…';
}

function referenceElements(references: FeishuExternalReferences, count: number): NativeCardElement[] {
  const elements: NativeCardElement[] = count ? [cardDivider(), cardMarkdown('外部参考', 'notation')] : [];
  for (const [index, reference] of references.items.slice(0, count).entries()) {
    elements.push(cardMarkdown(`${index + 1}. ${label(reference.label)}\n${safeMarkdown(reference.hostname)}`, 'notation'),
      cardUrlButton(reference.href, `打开外部参考 ${index + 1}`));
  }
  if (references.hasMore || count < references.items.length) {
    elements.push(cardMarkdown('打开按钮数量有限，其余链接文字保留在正文中。', 'notation'));
  }
  return elements;
}

function fitsCard(card: FeishuCardPayload): boolean {
  return Buffer.byteLength(JSON.stringify(card)) <= 20 * 1024
    && Buffer.byteLength(JSON.stringify({ content: JSON.stringify(card) })) <= 23 * 1024;
}

/** Reserve the real 64-character card ID when selecting optional references once.
 * Mandatory body/navigation and their existing rejection rules remain intact.
 */
export function withExternalReferenceBudget(references: FeishuExternalReferences,
  build: (cardId: string, references: readonly NativeCardElement[]) => FeishuCardPayload,
): (cardId: string) => FeishuCardPayload {
  for (let count = references.items.length; count >= 0; count--) {
    const elements = referenceElements(references, count);
    if (fitsCard(build('x'.repeat(64), elements))) return cardId => build(cardId, elements);
  }
  // Even the omission note may not fit. Preserve the original card for its caller
  // to accept or reject, rather than discarding required content or controls.
  return cardId => build(cardId, []);
}
