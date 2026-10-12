import { FEISHU_CARD_NAV_KIND, type FeishuCardPayload } from '../shared/feishu-cards.js';

/** Presentation only. Callers keep ownership of text sanitization and actions. */
export interface NativeCardElement extends Record<string, unknown> { tag: string }
export interface NativeCardButton extends NativeCardElement {
  tag: 'button';
  type: 'default' | 'primary' | 'primary_filled';
  text: { tag: 'plain_text'; content: string };
  behaviors: Array<{ type: 'callback'; value: { kind: typeof FEISHU_CARD_NAV_KIND; cardId: string; actionId: string } }>;
}
export type FeishuCardTheme = 'blue' | 'turquoise' | 'green' | 'orange' | 'red' | 'grey';

export function cardMarkdown(content: string, size: 'normal' | 'notation' | 'heading' = 'normal'): NativeCardElement {
  return { tag: 'markdown', content, text_size: size, text_align: 'left', margin: '0px' };
}

export function cardDivider(): NativeCardElement {
  return { tag: 'hr', margin: '8px 0' };
}

export function cardButton(cardId: string, actionId: string, caption: string,
  type: NativeCardButton['type'] = 'default'): NativeCardButton {
  return { tag: 'button', text: { tag: 'plain_text', content: caption }, type, size: 'medium', width: 'fill',
    behaviors: [{ type: 'callback', value: { kind: FEISHU_CARD_NAV_KIND, cardId, actionId } }] };
}

/** Long captions and the primary action get a full row; short actions stay adjacent. */
export function cardButtonRows(buttons: readonly NativeCardButton[], maxColumns: 2 | 3 = 2): NativeCardElement[] {
  const rows: NativeCardElement[] = [];
  let pending: NativeCardButton[] = [];
  const flush = () => {
    if (pending.length === 1) rows.push(pending[0]);
    else if (pending.length > 1) rows.push({ tag: 'column_set', flex_mode: 'none', horizontal_spacing: '8px',
      columns: pending.map((button) => ({ tag: 'column', width: 'weighted', weight: 1,
        direction: 'vertical', elements: [button] })) });
    pending = [];
  };
  for (const button of buttons) {
    if (button.type === 'primary_filled' || [...button.text.content].length > 12) {
      flush(); rows.push(button);
    } else {
      pending.push(button);
      if (pending.length === maxColumns) flush();
    }
  }
  flush();
  return rows;
}

export function styledFeishuCard({ title, subtitle, template = 'blue', elements }: {
  title: string; subtitle?: string; template?: FeishuCardTheme; elements: readonly NativeCardElement[];
}): FeishuCardPayload {
  return { schema: '2.0', config: { update_multi: true, enable_forward: false },
    header: { title: { tag: 'plain_text', content: title },
      ...(subtitle ? { subtitle: { tag: 'plain_text', content: subtitle } } : {}), template, padding: '12px' },
    body: { direction: 'vertical', padding: '12px', vertical_spacing: '12px', elements: [...elements] } };
}
