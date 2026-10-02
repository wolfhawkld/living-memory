import { createHash } from 'node:crypto';
import { domainIdOf, listDomains } from '../core/domain-view.js';
import type { FeishuReadCommand } from '../shared/feishu-reading.js';
import type { AnchorEvent, Concept, MemoryState } from '../shared/types.js';

export interface FeishuReadContext {
  concepts: readonly Concept[];
  states: Readonly<Record<string, MemoryState>>;
  anchors: readonly AnchorEvent[];
  asOf: string;
}

const STATUS: Record<MemoryState['status'], string> = {
  unknown: '尚无时间锚点', recent: '近期时间记录', revisit: '建议重温', stale: '时间记录较久',
  pending: '版本或时间待确认', retained: '人工长期保持',
};
const HELP = [
  '知识查看（只读）', '知识（全部节点）', '知识 领域 [页码]', '知识 列表 [域="目录域"] [查="关键词"] [序=时间|名称] [页=1]',
  '知识 搜索 关键词', '知识 阅读 引用 [页码] [版本token]',
  '时间排序按有效的距锚点天数降序；无有效时间的节点放在后面。',
  '时间状态是管理提示，不代表实测记忆能力。浏览、搜索和翻页不会更新记忆。',
  '正文为纯文本 Markdown；图片、公式、Mermaid 不在聊天中渲染。正文按页提供，不截掉后文。',
].join('\n');

function sha(value: string): string { return createHash('sha256').update(value).digest('hex'); }

/** Pure reference allocation; production digests are always SHA-256 of concept IDs. */
export function buildFeishuReadReferences(entries: readonly { id: string; digest: string }[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const { digest } of entries) counts.set(digest.slice(0, 12), (counts.get(digest.slice(0, 12)) ?? 0) + 1);
  return new Map(entries.map(({ id, digest }) => [id, counts.get(digest.slice(0, 12)) === 1 ? digest.slice(0, 12) : digest]));
}

/** Feishu text treats angle-bracket sequences specially. Keep content readable and inert. */
function safeText(value: string): string {
  return [...value].map((character) => {
    if (character === '<') return '＜';
    if (character === '>') return '＞';
    const code = character.codePointAt(0)!;
    return code >= 0xd800 && code <= 0xdfff ? '\ufffd' : character;
  }).join('');
}

function bounded(value: string, bytes: number): string {
  const safe = safeText(value).replace(/[\r\n\t]/g, ' ');
  if (Buffer.byteLength(safe, 'utf8') <= bytes) return safe;
  let result = '';
  let size = 0;
  for (const character of safe) {
    const next = Buffer.byteLength(character, 'utf8');
    if (size + next > bytes - 3) break;
    result += character; size += next;
  }
  return `${result}…`;
}

function bodyPages(body: string): string[] {
  const pages: string[] = [];
  let page = '';
  let bytes = 0;
  const emptySerializedBytes = serializedBytes('');
  let wireBytes = emptySerializedBytes;
  for (const character of safeText(body)) {
    const size = Buffer.byteLength(character, 'utf8');
    const wireSize = serializedBytes(character) - emptySerializedBytes;
    // JSON escaping is additive per Unicode scalar. Reserve 4000 bytes for bounded metadata.
    if (bytes + size > 3000 || wireBytes + wireSize > 7000) {
      pages.push(page); page = ''; bytes = 0; wireBytes = emptySerializedBytes;
    }
    page += character; bytes += size; wireBytes += wireSize;
  }
  pages.push(page);
  return pages;
}

function listCommand(command: Extract<FeishuReadCommand, { kind: 'list' }>, page: number): string {
  return ['知识 列表', command.domainId === null ? '' : `域=${quote(command.domainId)}`,
    command.query ? `查=${quote(command.query)}` : '', `序=${command.sort === 'title' ? '名称' : '时间'}`, `页=${page}`]
    .filter(Boolean).join(' ');
}

function quote(value: string): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e');
}

function normalized(value: string): string { return value.normalize('NFKC').toLocaleLowerCase(); }

function confirmedReview(concept: Concept, context: FeishuReadContext): string {
  const asOf = Date.parse(context.asOf);
  const candidates = context.anchors.filter((anchor) => anchor.conceptId === concept.id
    && anchor.kind === 'review' && anchor.sourceRevision === concept.source.revision
    && Number.isFinite(Date.parse(anchor.occurredAt)) && Date.parse(anchor.occurredAt) <= asOf
    && Number.isFinite(Date.parse(anchor.recordedAt)) && Date.parse(anchor.recordedAt) <= asOf);
  candidates.sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt)
    || Date.parse(b.recordedAt) - Date.parse(a.recordedAt) || a.eventId.localeCompare(b.eventId));
  return candidates[0] ? bounded(candidates[0].occurredAt, 100) : '无确认重温记录';
}

function stateText(state: MemoryState | undefined): string { return STATUS[state?.status ?? 'unknown']; }
function elapsed(state: MemoryState | undefined): number {
  const value = state?.elapsedDays;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : -1;
}

function elapsedText(state: MemoryState | undefined): string {
  const value = elapsed(state);
  if (value < 0) return '无有效时间记录';
  const label = state?.anchor?.kind === 'estimated' ? '距估算时间锚点' : '距时间锚点';
  return `${label} ${value.toFixed(1)} 天`;
}

/** Render only the authorized account's full concept index. Does not mutate any inputs. */
export function renderFeishuReadReply(command: FeishuReadCommand, context: FeishuReadContext): string {
  if (command.kind === 'help') return HELP;
  const entries = context.concepts.map((concept) => ({ id: concept.id, digest: sha(concept.id) }));
  const references = buildFeishuReadReferences(entries);
  if (command.kind === 'domains') {
    const domains = listDomains({ concepts: [...context.concepts], links: [], source: {
      name: '', mode: 'local', conceptCount: context.concepts.length, limit: context.concepts.length, diagnostics: [],
    } });
    const groups: string[][] = [[]];
    for (const domain of domains) {
      const action = domain.id.length <= 512
        ? `查看：知识 列表 域=${quote(domain.id)}`
        : '此目录域超过 512 字元，本通道暂不支持直接筛选；可用知识搜索查找节点。';
      const row = `${bounded(domain.label, 120)} · ${domain.conceptCount} 节点\n目录域：${bounded(domain.id, 400)}\n${action}`;
      let current = groups.at(-1)!;
      // Stable greedy grouping reserves enough space for the actual page header and footer.
      const reserve = '知识领域 · 第 100000/100000 页（1000000000 个）\n\n下一页：知识 领域 100000';
      if (current.length >= 10 || !fits([reserve, ...current, row].join('\n\n'))) {
        groups.push([]); current = groups.at(-1)!;
      }
      current.push(row);
    }
    const pages = groups.length;
    if (command.page > pages) return '领域页码超出范围。发送「知识 领域」重新查看。';
    const lines = [`知识领域 · 第 ${command.page}/${pages} 页（${domains.length} 个）`, ...groups[command.page - 1]];
    if (command.page < pages) lines.push(`下一页：知识 领域 ${command.page + 1}`);
    return fitReply(lines);
  }
  if (command.kind === 'read') {
    const matches = entries.filter(({ digest }) => digest.startsWith(command.reference));
    if (matches.length !== 1) return '节点引用不存在或不唯一。请重新列表或搜索，使用完整节点引用。';
    const concept = context.concepts.find(({ id }) => id === matches[0].id)!;
    const revision = sha(concept.source.revision).slice(0, 12);
    const reference = references.get(concept.id)!;
    if ((command.page > 1 && !command.revision) || (command.revision !== null && command.revision !== revision)) {
      return `资料已变化或分页标识失效，请重新打开第一页：知识 阅读 ${reference}`;
    }
    const pages = bodyPages(concept.body);
    if (command.page > pages.length) return `正文页码超出范围。重新阅读：知识 阅读 ${reference}`;
    const lines = [bounded(concept.title, 200), `目录域：${bounded(domainIdOf(concept), 400)}`,
      `时间状态：${stateText(context.states[concept.id])} · ${elapsedText(context.states[concept.id])}`, `最近确认重温：${confirmedReview(concept, context)}`,
      `正文第 ${command.page}/${pages.length} 页 · 纯文本 Markdown（不渲染图片、公式、Mermaid）`,
      '浏览不会更新记忆。尖括号以全角显示。', pages[command.page - 1] || '（正文为空）'];
    if (command.page < pages.length) lines.push(`下一页：知识 阅读 ${reference} ${command.page + 1} ${revision}`);
    return fitReply(lines);
  }
  const query = normalized(command.query);
  const concepts = context.concepts.filter((concept) => (command.domainId === null || domainIdOf(concept) === command.domainId)
    && (!query || [concept.title, ...concept.aliases].some((value) => normalized(value).includes(query))));
  concepts.sort((a, b) => (command.sort === 'title'
    ? a.title.localeCompare(b.title, 'zh-Hans-CN') : elapsed(context.states[b.id]) - elapsed(context.states[a.id]))
    || a.id.localeCompare(b.id));
  const pages = Math.max(1, Math.ceil(concepts.length / 5));
  if (command.page > pages) return '列表页码超出范围。请从第一页重新列表或搜索。';
  const header = [`知识列表 · 第 ${command.page}/${pages} 页（${concepts.length} 节点）`,
    '时间状态仅作管理提示；浏览不会更新记忆。'];
  const selected = concepts.slice((command.page - 1) * 5, command.page * 5);
  const footer = command.page < pages ? [`下一页：${listCommand(command, command.page + 1)}`] : [];
  for (const metadataBytes of [200, 100, 30]) {
    const lines = [...header];
    for (const concept of selected) {
      lines.push(`${bounded(concept.title, metadataBytes)}\n目录域：${bounded(domainIdOf(concept), metadataBytes * 2)}\n时间状态：${stateText(context.states[concept.id])} · ${elapsedText(context.states[concept.id])}\n最近确认重温：${confirmedReview(concept, context)}\n阅读：知识 阅读 ${references.get(concept.id)}`);
    }
    if (!concepts.length) lines.push('没有匹配节点。');
    lines.push(...footer);
    const reply = lines.join('\n\n');
    if (fits(reply)) return reply;
  }
  return '展示参数过长，请使用较短的目录域或查询词重新查看。';
}

function serializedBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify({ content: JSON.stringify({ text }) }), 'utf8');
}

function fits(text: string): boolean { return Buffer.byteLength(text, 'utf8') <= 8000 && serializedBytes(text) <= 11000; }

function fitReply(lines: string[]): string {
  const reply = lines.join('\n\n');
  // All body pages and metadata are bounded independently; never truncate a body page.
  if (!fits(reply)) return '展示参数过长，请使用较短的目录域或查询词重新查看。';
  return reply;
}
