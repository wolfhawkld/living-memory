import { selectBriefReviewCandidates, type BriefReviewCandidate } from '../core/brief-review.js';
import { listDomains } from '../core/domain-view.js';
import type { ReviewPlanResponse } from '../shared/review-plan.js';
import type { Snapshot } from '../shared/types.js';
import { createHash } from 'node:crypto';
import { domainIdOf } from '../core/domain-view.js';
import { buildFeishuReadReferences, type FeishuReadContext } from './feishu-read-view.js';
import { FEISHU_CARD_NAV_KIND, type FeishuCardActionDefinition, type FeishuCardPayload, type FeishuCardView } from '../shared/feishu-cards.js';

export interface FeishuReviewCandidates {
  candidates: BriefReviewCandidate[];
  completedCount: number;
  remaining: number;
  timeZone: string;
  dayKey: string;
}

/** Read-only selection using the account's complete index and persisted daily progress. */
export function selectFeishuReviewCandidates(
  snapshot: Snapshot,
  plan: ReviewPlanResponse,
  domainId: string | null,
  limit: 3 | 5,
): FeishuReviewCandidates {
  const completed = new Set(plan.completedConceptIds);
  const remaining = Math.max(0, plan.plan.dailyBudget - completed.size);
  const options = {
    limit: Math.min(limit, remaining), excludedIds: completed,
    preferences: plan.plan.concepts, asOf: plan.asOf,
  };
  let candidates: BriefReviewCandidate[] = [];
  if (options.limit > 0) {
    if (domainId !== null) candidates = selectBriefReviewCandidates(snapshot, domainId, options);
    else {
      // The global cap is five. A domain's sixth-ranked item cannot enter that
      // global top five because five better-ranked items already precede it.
      const pool = listDomains(snapshot).flatMap((domain) => selectBriefReviewCandidates(snapshot, domain.id, {
        ...options, limit: 5,
      }));
      pool.sort((left, right) => Number(right.focus === true) - Number(left.focus === true)
        || right.elapsedDays - left.elapsedDays
        || (left.conceptId === right.conceptId ? 0 : left.conceptId < right.conceptId ? -1 : 1));
      const unique = new Map<string, BriefReviewCandidate>();
      for (const candidate of pool) if (!unique.has(candidate.conceptId)) unique.set(candidate.conceptId, candidate);
      candidates = [...unique.values()].slice(0, options.limit);
    }
  }
  return { candidates, completedCount: completed.size, remaining, timeZone: plan.timeZone, dayKey: plan.dayKey };
}

interface CardRow { content: string; caption?: string; target?: FeishuCardView }
interface CardControl { caption: string; target: FeishuCardView }
export interface FeishuCardViewPlan {
  actions: FeishuCardActionDefinition[];
  build: (cardId: string) => FeishuCardPayload;
}

const READ_ONLY = '只读浏览不扣复习预算、不更新学习或记忆。只有最新卡可操作；点击后请看新卡，未收到新卡时重新发送入口命令。';
const DEFAULT_LIST = { kind: 'list', domainId: null, query: '', sort: 'elapsed', page: 1 } as const;
const STATES = { unknown: '尚无时间锚点', recent: '近期时间记录', revisit: '建议重温', stale: '时间记录较久', pending: '版本或时间待确认', retained: '人工长期保持' };
function hash(value: string) { return createHash('sha256').update(value).digest('hex'); }

/** Deliberately conservative: bracket links/images and XML become inert visible text. */
function safeMarkdown(value: string): string {
  return [...value].map((character) => {
    if (character === '<') return '＜';
    if (character === '>') return '＞';
    if (character === '[') return '［';
    if (character === ']') return '］';
    const code = character.codePointAt(0)!;
    return code >= 0xd800 && code <= 0xdfff ? '\ufffd' : character;
  }).join('');
}

function metadata(value: string, maxBytes = 180): string {
  const safe = safeMarkdown(value).replace(/[\r\n\t]/g, ' ');
  if (Buffer.byteLength(safe) <= maxBytes) return safe;
  let result = ''; let size = 0;
  for (const character of safe) {
    const bytes = Buffer.byteLength(character);
    if (size + bytes > maxBytes - 3) break;
    result += character; size += bytes;
  }
  return `${result}…`;
}

function bodyChunks(body: string): string[] {
  const chunks: string[] = []; let current = ''; let bytes = 0; let wireBytes = 0;
  const base = Buffer.byteLength(JSON.stringify({ content: JSON.stringify({ text: '' }) }));
  for (const character of safeMarkdown(body)) {
    const size = Buffer.byteLength(character);
    const wireSize = Buffer.byteLength(JSON.stringify({ content: JSON.stringify({ text: character }) })) - base;
    if (bytes + size > 3000 || wireBytes + wireSize > 7000) {
      chunks.push(current); current = ''; bytes = 0; wireBytes = 0;
    }
    current += character; bytes += size; wireBytes += wireSize;
  }
  chunks.push(current);
  return chunks;
}

function createPlan(title: string, content: string, rows: CardRow[], controls: CardControl[]): FeishuCardViewPlan {
  const navigation = [...rows.filter((row): row is CardRow & { caption: string; target: FeishuCardView } => !!row.caption && !!row.target), ...controls];
  const actions = navigation.map((item, index) => ({ id: `a${index}`, target: item.target }));
  return { actions, build: (cardId) => ({
    schema: '2.0', config: { update_multi: true, enable_forward: false },
    header: { title: { tag: 'plain_text', content: metadata(title, 200) }, template: 'blue' },
    body: { elements: [
      { tag: 'markdown', content }, ...rows.map((row) => ({ tag: 'markdown', content: row.content })),
      ...navigation.map((item, index) => ({ tag: 'button', text: { tag: 'plain_text', content: metadata(item.caption, 80) }, type: 'default',
        behaviors: [{ type: 'callback', value: { kind: FEISHU_CARD_NAV_KIND, cardId, actionId: actions[index].id } }] })),
      { tag: 'markdown', content: READ_ONLY },
    ] },
  }) };
}

function fitsPlan(view: FeishuCardView, plan: FeishuCardViewPlan): boolean {
  const card = plan.build('x'.repeat(64));
  return plan.actions.length <= 16
    // Accounts budgets the complete draft at 16 KiB. Reserve four KiB for
    // namespace, source fingerprint and trusted chat ID, including escaping.
    && Buffer.byteLength(JSON.stringify({ view, actions: plan.actions })) <= 12 * 1024
    && Buffer.byteLength(JSON.stringify(card)) <= 20 * 1024
    && Buffer.byteLength(JSON.stringify({ content: JSON.stringify(card) })) <= 23 * 1024;
}

function errorPlan(message: string): FeishuCardViewPlan {
  return createPlan('知识卡片', message, [], [{ caption: '全部节点', target: DEFAULT_LIST }, { caption: '知识领域', target: { kind: 'domains', page: 1 } }]);
}

function elapsedValue(context: FeishuReadContext, id: string): number {
  const value = context.states[id]?.elapsedDays;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : -1;
}

function timeText(context: FeishuReadContext, id: string): string {
  const state = context.states[id]; const elapsed = elapsedValue(context, id);
  return `${STATES[state?.status ?? 'unknown']} · ${elapsed < 0 ? '无有效时间记录' : `${state?.anchor?.kind === 'estimated' ? '距估算锚点' : '距时间锚点'} ${elapsed.toFixed(1)} 天`}`;
}

function confirmed(context: FeishuReadContext, id: string, revision: string): string {
  const asOf = Date.parse(context.asOf);
  const anchors = context.anchors.filter((anchor) => anchor.kind === 'review' && anchor.conceptId === id && anchor.sourceRevision === revision
    && Date.parse(anchor.occurredAt) <= asOf && Date.parse(anchor.recordedAt) <= asOf);
  anchors.sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt) || Date.parse(b.recordedAt) - Date.parse(a.recordedAt));
  return anchors[0] ? metadata(anchors[0].occurredAt, 100) : '无确认重温记录';
}

function collectionControls(view: Extract<FeishuCardView, { kind: 'list' | 'domains' }>, page: number, pages: number): CardControl[] {
  const controls: CardControl[] = [];
  if (page > 1) controls.push({ caption: '上一页', target: { ...view, page: page - 1 } });
  if (page < pages) controls.push({ caption: '下一页', target: { ...view, page: page + 1 } });
  controls.push({ caption: '全部节点', target: DEFAULT_LIST });
  if (view.kind === 'list') {
    controls.push({ caption: '知识领域', target: { kind: 'domains', page: 1 } },
      { caption: view.sort === 'elapsed' ? '按名称排序' : '按时间排序', target: { ...view, sort: view.sort === 'elapsed' ? 'title' : 'elapsed', page: 1 } },
      { caption: '本范围待复习', target: { kind: 'due', domainId: view.domainId, limit: 3 } });
  } else controls.push({ caption: '全部待复习', target: { kind: 'due', domainId: null, limit: 3 } });
  return controls;
}

/** Transient card body plus fixed navigation targets; no body or account claims are persisted. */
export function planFeishuCardView(view: FeishuCardView, context: FeishuReadContext, reviewPlan: ReviewPlanResponse): FeishuCardViewPlan {
  if ((view.kind === 'read' || view.kind === 'list' || view.kind === 'domains')
    && (!Number.isSafeInteger(view.page) || view.page < 1 || view.page > 100000)) return errorPlan('页码超出范围，请重新进入知识卡片。');
  const digests = context.concepts.map((concept) => ({ id: concept.id, digest: hash(concept.id) }));
  const references = buildFeishuReadReferences(digests);
  const toRead = (id: string, revision: string, back: Extract<FeishuCardView, { kind: 'list' | 'due' }>): FeishuCardView => ({
    kind: 'read', reference: references.get(id)!, page: 1, revision: hash(revision).slice(0, 12), back,
  });
  if (view.kind === 'help') return errorPlan('知识 卡片：全部节点\n知识 卡片 领域 ［页码］\n知识 卡片 搜索 关键词\n知识 卡片 列表 域="目录域" 查="关键词" 序=时间|名称 页=1\n知识 待复习 ［域="目录域"］ ［量=3|5］\n时间状态仅作管理提示，不代表实测记忆能力。');
  if (view.kind === 'read') {
    if (!/^[a-f0-9]{12,64}$/.test(view.reference) || !/^[a-f0-9]{12}$/.test(view.revision)) return errorPlan('节点引用或分页标识失效，请重新列表或搜索。');
    const matches = digests.filter((entry) => entry.digest.startsWith(view.reference));
    if (matches.length !== 1) return errorPlan('节点引用不存在或不唯一，请重新列表或搜索。');
    const concept = context.concepts.find((item) => item.id === matches[0].id)!;
    if (hash(concept.source.revision).slice(0, 12) !== view.revision) return errorPlan('资料已变化或分页标识失效，请重新打开第一页。');
    const chunks = bodyChunks(concept.body);
    if (view.page < 1 || view.page > chunks.length) return errorPlan('正文页码超出范围，请重新打开节点。');
    const controls: CardControl[] = [];
    if (view.page > 1) controls.push({ caption: '上一页', target: { ...view, page: view.page - 1 } });
    if (view.page < chunks.length) controls.push({ caption: '下一页', target: { ...view, page: view.page + 1 } });
    controls.push({ caption: view.back.kind === 'due' ? '返回原待复习' : '返回原列表', target: view.back });
    const plan = createPlan(metadata(concept.title, 200), `目录域：${metadata(domainIdOf(concept), 300)}\n${timeText(context, concept.id)}\n最近确认重温：${confirmed(context, concept.id, concept.source.revision)}\n正文 ${view.page}/${chunks.length} 页。附件/链接以文字展示，Mermaid、公式不保证渲染。`,
      [{ content: chunks[view.page - 1] || '（正文为空）' }], controls);
    return fitsPlan(view, plan) ? plan : errorPlan('当前正文或导航参数超过展示限制，请重新列表或搜索。');
  }
  if (view.kind === 'due') {
    const snapshot: Snapshot = { concepts: [...context.concepts], states: { ...context.states }, asOf: context.asOf, links: [], observationsCount: 0,
      config: { modelVersion: 'time-only-v0', revision: 0, halfLifeDays: 7 }, source: { name: '', mode: 'local', conceptCount: context.concepts.length, limit: context.concepts.length, diagnostics: [] } };
    const result = selectFeishuReviewCandidates(snapshot, reviewPlan, view.domainId, view.limit);
    const rows: CardRow[] = result.candidates.map((candidate, index) => {
      const concept = context.concepts.find((item) => item.id === candidate.conceptId)!;
      return { content: `${index + 1}. ${metadata(concept.title)}\n目录域：${metadata(domainIdOf(concept), 240)}\n${candidate.focus ? '重点 · ' : ''}${candidate.estimated ? '估算锚点 · ' : ''}距锚点 ${candidate.elapsedDays.toFixed(1)} 天`, caption: `阅读 ${index + 1}`, target: toRead(concept.id, concept.source.revision, view) };
    });
    const intro = `时间提示候选（非记忆能力测量）\n日期：${metadata(result.dayKey, 60)} · 时区：${metadata(result.timeZone, 100)}\n今日已落库概念回忆 ${result.completedCount} 项 · 剩余预算 ${result.remaining} 项\n不计场景记录；浏览器待同步/已访问信息在聊天中不可见。${rows.length ? '' : '\n当前没有可用候选。'}`;
    const controls: CardControl[] = [{ caption: view.limit === 3 ? '查看 5 项' : '查看 3 项', target: { ...view, limit: view.limit === 3 ? 5 : 3 } },
      { caption: '全部领域候选', target: { ...view, domainId: null } }, { caption: '知识领域', target: { kind: 'domains', page: 1 } },
      { caption: '本领域全部节点', target: { ...DEFAULT_LIST, domainId: view.domainId } }];
    const plan = createPlan('少量复习候选', intro, rows, controls);
    return fitsPlan(view, plan) ? plan : errorPlan('当前候选导航参数超过展示限制，请查看 3 项或全部领域候选。');
  }
  const isDomains = view.kind === 'domains';
  const normalizedQuery = isDomains ? '' : view.query.normalize('NFKC').toLocaleLowerCase();
  const concepts = isDomains ? [] : context.concepts.filter((concept) => (view.domainId === null || domainIdOf(concept) === view.domainId)
    && (!normalizedQuery || [concept.title, ...concept.aliases].some((value) => value.normalize('NFKC').toLocaleLowerCase().includes(normalizedQuery))));
  if (!isDomains) concepts.sort((a, b) => (view.sort === 'title' ? a.title.localeCompare(b.title, 'zh-Hans-CN') : elapsedValue(context, b.id) - elapsedValue(context, a.id)) || a.id.localeCompare(b.id));
  const domains = isDomains ? listDomains({ concepts: [...context.concepts], links: [], source: { name: '', mode: 'local', conceptCount: context.concepts.length, limit: context.concepts.length, diagnostics: [] } }) : [];
  const count = isDomains ? domains.length : concepts.length;
  const groups: number[][] = [[]];
  const makeRows = (indices: number[], back: typeof view): CardRow[] => indices.map((index) => {
    if (isDomains) {
      const domain = domains[index];
      return { content: `${metadata(domain.label)} · ${domain.conceptCount} 节点\n目录域：${metadata(domain.id, 300)}${domain.id.length > 512 ? '\n目录域超过 512 字元，本通道暂不支持直接筛选；可搜索节点。' : ''}`,
        ...(domain.id.length <= 512 ? { caption: `查看领域 ${index + 1}`, target: { ...DEFAULT_LIST, domainId: domain.id } } : {}) };
    }
    const concept = concepts[index];
    return { content: `${metadata(concept.title)}\n目录域：${metadata(domainIdOf(concept), 300)}\n${timeText(context, concept.id)}\n最近确认重温：${confirmed(context, concept.id, concept.source.revision)}`,
      caption: `阅读 ${index + 1}`, target: toRead(concept.id, concept.source.revision, back as Extract<FeishuCardView, { kind: 'list' }>) };
  });
  for (let index = 0; index < count; index++) {
    let current = groups.at(-1)!;
    const probeView = { ...view, page: 100000 };
    const proposed = [...current, index];
    const probe = createPlan('知识卡片 · 第 100000/100000 页', '时间状态仅作管理提示。', makeRows(proposed, probeView), collectionControls(probeView, 2, 3));
    if (current.length >= 5 || !fitsPlan(probeView, probe)) { groups.push([]); current = groups.at(-1)!; }
    current.push(index);
  }
  if (view.page < 1 || view.page > groups.length) return errorPlan('页码超出范围，请重新进入知识卡片或领域。');
  const rows = makeRows(groups[view.page - 1], view);
  const plan = createPlan(`${isDomains ? '知识领域' : '知识列表'} · ${view.page}/${groups.length} 页`,
    `${count} ${isDomains ? '个领域' : '个节点'}。时间状态仅作管理提示，不代表实测记忆能力。${rows.length ? '' : '\n没有匹配节点。'}`,
    rows, collectionControls(view, view.page, groups.length));
  return fitsPlan(view, plan) ? plan : errorPlan('当前导航参数超过展示限制，请重新列表或搜索。');
}
