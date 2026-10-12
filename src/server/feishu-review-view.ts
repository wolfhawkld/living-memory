import type { Concept } from '../shared/types.js';
import type { FeishuCardActionDefinition, FeishuCardPayload, FeishuCardView } from '../shared/feishu-cards.js';
import type { FeishuReviewOperation, FeishuReviewSession, FeishuReviewTarget } from '../shared/feishu-review.js';
import { feishuReviewCurrentOperations } from '../shared/feishu-review.js';
import { bodyChunks, metadata } from './feishu-card-view.js';
import { cardButton, cardButtonRows, cardDivider, cardMarkdown, styledFeishuCard, type FeishuCardTheme } from './feishu-card-style.js';

export interface FeishuReviewRenderInput {
  session: FeishuReviewSession | null;
  operations: FeishuReviewOperation[];
  concept: Concept | null;
  availability: 'ready' | 'source-changed' | 'expired' | 'no-candidate' | 'no-session' | 'ineligible';
}
interface Control { caption: string; target: FeishuCardView }
const FOOTER = '脑中回忆为自报，不记录原答，不计入独立成功或信心校准。阅读不会更新记忆时间；只有明确确认重温才更新锚点。仅最新卡可操作，未收到新卡请发送“知识 继续复习”。';

/** Pure transient rendering. Only the local transition handler may change state. */
export function planFeishuReviewView(input: FeishuReviewRenderInput): {
  view: FeishuCardView; actions: FeishuCardActionDefinition[]; build: (cardId: string) => FeishuCardPayload;
} {
  const { session, concept } = input;
  const operations = session ? feishuReviewCurrentOperations(session, input.operations) : [];
  const batch = session?.state.batch;
  const view: FeishuCardView = session ? { kind: 'review', sessionId: session.id, version: session.version, verb: 'show', page: session.state.page } : { kind: 'help' };
  const controls: Control[] = [];
  const due = { kind: 'due', domainId: session?.state.domainId ?? null, limit: 3 } as const;
  const add = (caption: string, verb: Extract<FeishuReviewTarget, { kind: 'review' }>['verb'], page = session!.state.page) => {
    if (session) controls.push({ caption, target: { kind: 'review', sessionId: session.id, version: session.version, verb, page } });
  };
  let title = '少量脑中回忆';
  let step = '开始复习';
  let template: FeishuCardTheme = 'turquoise';
  let content = '';
  let body: string | null = null;
  const pending = input.operations.some((operation) => operation.status === 'pending');
  const conflict = operations.some((operation) => operation.status === 'conflict');
  if (session?.state.phase === 'finished') {
    step = '本轮小结';
    if (input.operations.some(operation => operation.status === 'conflict')) template = 'red';
    content = batch ? batchSummary(session, input.operations) : '本次复习已结束。';
    controls.push({ caption: '查看待复习', target: due });
  } else if (input.availability !== 'ready' || !session || !concept) {
    step = input.availability === 'expired' ? '会话已过期' : input.availability === 'source-changed' ? '资料已变化' : input.availability === 'ineligible' ? '候选已变化' : '开始复习';
    template = input.availability === 'expired' || session?.state.paused ? 'grey' : 'orange';
    content = input.availability === 'source-changed' ? '资料或来源已变化，本次复习不可继续。请重新选择候选。'
      : input.availability === 'expired' ? '复习会话已过期，请重新选择候选。'
        : input.availability === 'ineligible' ? batch ? '当前已不在待复习范围，可跳过本条或结束本轮。' : '当前已不在待复习范围，请结束后重新选择。'
          : input.availability === 'no-candidate' ? '当前没有可用候选。浏览不会扣复习预算。'
          : '发送“知识 复习”开始；“知识 继续复习”恢复；“知识 暂停复习”暂停；“知识 结束复习”结束。';
    controls.push({ caption: '查看待复习', target: due });
    if (session) {
      if (pending && session.state.paused) add('继续复习', 'resume');
      else if (pending) { add('重试同步', 'retry'); add('暂停复习', 'pause'); }
      else {
        if (batch && input.availability === 'ineligible' && !session.state.paused) add('跳过资格变化项', 'skip');
        if (batch && input.availability === 'ineligible' && session.state.paused) add('继续复习', 'resume');
        add('结束复习', 'finish');
      }
    }
  } else if (conflict) {
    step = '核对写入冲突'; template = 'red';
    content = '有记录写入冲突，请核对下方状态，结束后检查，不会覆盖已保存记录。';
    if (batch) add(session.state.paused ? '继续复习' : '略过冲突项，继续', session.state.paused ? 'resume' : 'skip');
    add('结束复习', 'finish');
  } else if (session.state.paused) {
    step = '复习已暂停'; template = 'grey';
    content = '复习已暂停，正文暂不展示。';
    add('继续复习', 'resume');
    if (pending) content += '继续复习后恢复待写操作，保存后可再次结束本条。';
    else add('结束复习', 'finish');
  } else if (pending) {
    step = '等待同步'; template = 'orange';
    content = '记录尚未确认写入，请重试同步。不要重复提交新的记录。待写操作恢复保存后，可再次结束本条。';
    add('重试同步', 'retry'); add('暂停复习', 'pause');
  } else if (session.state.phase === 'front') {
    step = '先回忆';
    title = metadata(concept.title, 200);
    content = `先在脑中尝试解释“${metadata(concept.title)}”的原理和应用场景，再查看资料。\n本轮不输入原答，不预测信心，后续清楚/模糊/想不起均为脑中自报。`;
    add('查看资料', 'reveal'); add('暂停复习', 'pause'); add('结束复习', 'finish');
    if (batch) add('跳过本条', 'skip');
  } else if (session.state.phase === 'revealed') {
    step = '对照资料';
    title = metadata(concept.title, 200);
    const chunks = bodyChunks(concept.body);
    if (session.state.page > chunks.length || session.state.page < 1) {
      content = '正文页码超出范围，请返回第一页。'; add('正文第一页', 'show', 1);
    } else {
      content = `资料 ${session.state.page}/${chunks.length} 页。附件、链接以文字展示；公式与 Mermaid 不保证渲染。`;
      body = chunks[session.state.page - 1] || '（正文为空）';
      if (session.state.page > 1) add('上一页', 'show', session.state.page - 1);
      if (session.state.page < chunks.length) add('下一页', 'show', session.state.page + 1);
      if (!operations.length) {
        add('清楚', 'rate-clear'); add('模糊', 'rate-partial'); add('想不起', 'rate-blank');
      }
      add('暂停复习', 'pause'); add('结束复习', 'finish');
      if (batch) add('跳过本条', 'skip');
    }
  } else {
    step = '回忆记录回执';
    const reviewed = operations.some((operation) => operation.intent.kind === 'review' && operation.status === 'applied');
    content = reviewed ? '脑中回忆记录已保存；本次明确确认的重温时间已保存。' : '脑中回忆记录已保存，记忆时间尚未更新。是否已完成重温由你另行确认。';
    if (!operations.some((operation) => operation.intent.kind === 'review')) add('确认已重温，更新时间', 'confirm-review');
    if (batch) add(batch.cursor === batch.items.length - 1 ? '完成本轮' : '下一条', 'next');
    add('结束复习', 'finish');
    content += batch ? '\n如刚恢复待写操作，请再次点击下一条或结束本轮。' : '\n如刚恢复待写操作，请再次点击结束本条。';
  }
  if (batch && session?.state.phase !== 'finished') {
    content = `本轮第 ${batch.cursor + 1}/${batch.items.length} 项（请求 ${batch.requestedSize} 项${batch.items.length < batch.requestedSize ? '，候选或预算不足，按实际数量进行' : ''}）。队列固定，继续不会补位或重排。\n${content}`;
  }
  for (const [kind, label] of [['observation', '脑中自评'], ['review', '确认重温']] as const) {
    const operation = operations.find((entry) => entry.intent.kind === kind);
    if (operation) content += `\n${label}：${operation.status === 'applied' ? '已保存' : operation.status === 'pending' ? '待保存' : '未保存(冲突)'}`;
  }
  const actions = controls.map((control, index) => ({ id: `a${index}`, target: control.target }));
  const subtitle = batch
    ? session?.state.phase === 'finished' ? `实际 ${batch.items.length} 项 · 本轮已结束` : `第 ${batch.cursor + 1}/${batch.items.length} 项 · 固定队列`
    : '少量脑中回忆 · 自主确认重温';
  const build = (cardId: string): FeishuCardPayload => {
    const elements = [cardMarkdown(content)];
    if (body !== null) elements.push(cardDivider(), cardMarkdown(body));
    const buttons = controls.map((control, index) => ({
      control,
      button: cardButton(cardId, actions[index].id, control.caption,
        control.target.kind === 'review' && control.target.verb === 'reveal' ? 'primary_filled' : 'default'),
    }));
    if (buttons.length) elements.push(cardDivider());
    // Keep original control/callback ordering while giving the three self-reports equal weight.
    let ordinary: ReturnType<typeof cardButton>[] = [];
    const flush = () => { elements.push(...cardButtonRows(ordinary)); ordinary = []; };
    for (let index = 0; index < buttons.length; index++) {
      const { control, button } = buttons[index];
      if (control.target.kind === 'review' && control.target.verb === 'rate-clear') {
        flush();
        elements.push(cardMarkdown('评价查看资料前的脑中回忆', 'heading'));
        elements.push(...cardButtonRows(buttons.slice(index, index + 3).map(entry => entry.button), 3));
        index += 2;
      } else if (control.target.kind === 'review' && control.target.verb === 'confirm-review') {
        flush();
        elements.push(button);
      } else ordinary.push(button);
    }
    flush();
    elements.push(cardDivider(), cardMarkdown(FOOTER, 'notation'));
    return styledFeishuCard({ title: metadata(`${step} · ${title}`, 200), subtitle, template, elements });
  };
  return { view, actions, build };
}

function batchSummary(session: FeishuReviewSession, operations: readonly FeishuReviewOperation[]): string {
  const batch = session.state.batch!;
  const observations = operations.filter(operation => operation.intent.kind === 'observation' && operation.status === 'applied');
  const reviews = operations.filter(operation => operation.intent.kind === 'review' && operation.status === 'applied').length;
  const conflicted = (kind: 'observation' | 'review') => operations.filter(operation => operation.intent.kind === kind && operation.status === 'conflict').length;
  const ratingCount = (rating: 'clear' | 'partial' | 'blank') => observations.filter(operation => operation.intent.kind === 'observation' && operation.intent.request.rating === rating).length;
  const count = (disposition: string) => batch.items.filter(item => item.disposition === disposition).length;
  return `本轮复习已结束（请求 ${batch.requestedSize} 项，实际 ${batch.items.length} 项）。\n脑中自评已保存 ${observations.length} 项：清楚 ${ratingCount('clear')}、模糊 ${ratingCount('partial')}、想不起 ${ratingCount('blank')}。这些是自报分布，不是掌握率。\n明确确认重温已保存 ${reviews} 项。\n脑中自评未保存(冲突) ${conflicted('observation')} 项 · 确认重温未保存(冲突) ${conflicted('review')} 项。\n主动跳过 ${count('skipped')} 项 · 资格变化 ${count('ineligible')} 项 · 冲突 ${count('conflict')} 项 · 提前结束未完成 ${count('ended')} 项 · 未开始 ${count('open')} 项。\n仅统计本轮，不代表今日完成数；跳过、阅读和结束均不更新记忆时间。`;
}
