import { createHash } from 'node:crypto';
import type { Concept } from '../shared/types.js';
import type { FeishuCardView } from '../shared/feishu-cards.js';
import type { FeishuRewarmIntent } from '../shared/feishu-rewarm.js';
import { metadata, type FeishuCardViewPlan } from './feishu-card-view.js';
import { cardButton, cardButtonRows, cardMarkdown, styledFeishuCard } from './feishu-card-style.js';

export function planFeishuRewarmView(intent: FeishuRewarmIntent | null, concept: Concept | null, options: { confirmationBlockedByPending?: boolean } = {}): FeishuCardViewPlan & { view: FeishuCardView } {
  const view: FeishuCardView = intent ? { kind: 'rewarm', intentId: intent.id, verb: 'show' } : { kind: 'help' };
  const controls: { caption: string; target: FeishuCardView }[] = [];
  if (intent) {
    controls.push({ caption: '重温状态', target: { kind: 'rewarm', intentId: intent.id, verb: 'show' } });
    if (intent.status === 'pending') controls.push({ caption: '重试原操作', target: { kind: 'rewarm', intentId: intent.id, verb: 'retry' } });
  }
  const list = { kind: 'list', domainId: null, query: '', sort: 'elapsed', page: 1 } as const;
  if (concept) controls.push({ caption: '返回资料', target: { kind: 'read', reference: createHash('sha256').update(concept.id).digest('hex'),
    revision: createHash('sha256').update(concept.source.revision).digest('hex').slice(0, 12), page: 1, back: list } });
  controls.push({ caption: '返回列表', target: list });
  const content = !intent ? '暂无重温操作。请阅读资料后点击“确认已重温”。'
    : intent.status === 'pending' ? '写入结果待确认，请重试原操作'
      : intent.status === 'applied' ? `已确认重温，时间已更新。\n确认时间：${metadata(intent.request.occurredAt)}`
        : intent.errorCode === 'INSTANCE_RESTORED'
          ? '原待确认操作已因实例恢复失效，请查看原学习记录核对。'
          : '资料或记录已变化，本次重温未保存。请重新打开资料后确认。';
  const originalConcept = intent ? `原操作概念：${concept ? metadata(concept.title, 200) : '原版本资料当前不可用'}` : '';
  const blocked = options.confirmationBlockedByPending ? '已有待确认操作，本次未创建新的重温记录。' : '';
  const actions = controls.map((control, index) => ({ id: `a${index}`, target: control.target }));
  return { view, actions, build: cardId => styledFeishuCard({ title: '确认重温', subtitle: '更新时间 · 不代表脑中自评', elements: [
    ...(originalConcept ? [cardMarkdown(originalConcept, 'notation')] : []),
    ...(blocked ? [cardMarkdown(blocked)] : []),
    cardMarkdown(content),
    ...cardButtonRows(controls.map((control, index) => cardButton(cardId, actions[index].id, control.caption))),
    cardMarkdown('确认重温仅更新时间，不代表自评。丢失卡片或重启后，可发送“知识 重温状态”或“知识 重试重温”。', 'notation'),
  ] }) };
}
