import type { FeishuReviewSession } from '../shared/feishu-review.js';

export interface FeishuReviewStatusOperation {
  kind: 'observation' | 'review';
  status: 'applied' | 'pending' | 'conflict';
}

export interface FeishuReviewStatusInput {
  session: Pick<FeishuReviewSession, 'state' | 'expiresAt'> | null;
  operations: readonly FeishuReviewStatusOperation[];
  sourceMatches: boolean;
  asOf: string;
  conceptTitle?: string;
}

const INVALID = '复习状态暂无法确认：状态或时间信息无效。请按原复习流程处理；本次查询不会写入或重试。';
const NO_SESSION = '当前没有未结束的复习会话；这不表示没有已保存记录';
const PHASE = { front: '待回忆', revealed: '资料对照阶段', saved: '自评回执' } as const;

/** Accept explicit ISO instants only; Date.parse alone also accepts invalid calendar days. */
function instant(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, zone] = match;
  const days = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > days
    || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59
    || (zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59))) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function shortTitle(value: string): string {
  if (/(?:https?:\/\/|www\.)/iu.test(value)) return '';
  const safe = value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replaceAll('<', '＜').replaceAll('>', '＞').replace(/\s+/gu, ' ').trim();
  let title = '';
  let bytes = 0;
  for (const scalar of safe) {
    const code = scalar.codePointAt(0)!;
    const character = code >= 0xd800 && code <= 0xdfff ? '\ufffd' : scalar;
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > 197) return `${title}…`;
    title += character;
    bytes += size;
  }
  return title;
}

/** Pure projection: never reads write intents, identifiers, bodies, or future item names. */
export function renderFeishuReviewStatus(input: FeishuReviewStatusInput): string {
  if (!input || typeof input !== 'object') return INVALID;
  const asOf = instant(input.asOf);
  if (asOf === null || typeof input.sourceMatches !== 'boolean' || !Array.isArray(input.operations)
    || (input.conceptTitle !== undefined && typeof input.conceptTitle !== 'string')) return INVALID;
  const header = ['复习状态（只读）', `查询时点：${new Date(asOf).toISOString()}`];
  if (input.session === null) return [...header, NO_SESSION, '本次查询不会写入、重试或延长会话有效期。'].join('\n');
  const session = input.session;
  if (!session || typeof session !== 'object' || !session.state || typeof session.state !== 'object') return INVALID;
  const { state } = session;
  if (state.phase === 'finished') return [...header, NO_SESSION, '本次查询不会写入、重试或延长会话有效期。'].join('\n');
  if (!Object.hasOwn(PHASE, state.phase) || typeof state.paused !== 'boolean') return INVALID;
  const expiresAt = instant(session.expiresAt);
  if (expiresAt === null) return INVALID;
  let position = '第 1/1 项';
  if (state.batch !== undefined) {
    const batch = state.batch;
    if (!batch || !Array.isArray(batch.items) || ![3, 5].includes(batch.requestedSize)
      || batch.items.length < 1 || batch.items.length > batch.requestedSize
      || !Number.isInteger(batch.cursor) || batch.cursor < 0 || batch.cursor >= batch.items.length) return INVALID;
    position = `第 ${batch.cursor + 1}/${batch.items.length} 项`;
  }
  const counts = {
    observation: { applied: 0, pending: 0, conflict: 0 },
    review: { applied: 0, pending: 0, conflict: 0 },
  };
  for (const operation of input.operations as readonly FeishuReviewStatusOperation[]) {
    if (!operation || !Object.hasOwn(counts, operation.kind)
      || !Object.hasOwn(counts[operation.kind], operation.status)) return INVALID;
    counts[operation.kind][operation.status] += 1;
  }
  const expired = expiresAt <= asOf;
  const available = !expired && input.sourceMatches;
  const availability = [expired ? '已过期' : '', input.sourceMatches ? '' : '资料已变化'].filter(Boolean).join('；') || '有效';
  const lines = [...header, `会话时间与资料：${availability}`, `复习状态：${state.paused ? '已暂停' : '进行中'}`,
    `阶段：${PHASE[state.phase as keyof typeof PHASE]}`, `进度：${position}`];
  if (input.sourceMatches && input.conceptTitle) {
    const title = shortTitle(input.conceptTitle);
    if (title) lines.push(`当前概念：${title}`);
  }
  lines.push(`本轮脑中自评：已保存 ${counts.observation.applied}；待确认 ${counts.observation.pending}；冲突 ${counts.observation.conflict}`,
    `本轮明确重温：已保存 ${counts.review.applied}；待确认 ${counts.review.pending}；冲突 ${counts.review.conflict}`,
    '脑中自评已保存不表示已重温或已掌握；资料对照阶段不表示已阅读。');
  if (counts.observation.pending + counts.review.pending > 0) {
    lines.push('继续复习会尝试恢复原待写操作；本次查询不会重试。');
  }
  lines.push(available ? '可发送“知识 继续复习”或“知识 结束复习”。'
    : '会话当前不可正常继续；请按原流程处理，或发送“知识 结束复习”。',
  '本次查询不会写入或延长会话有效期。');
  const text = lines.join('\n');
  return Buffer.byteLength(text, 'utf8') <= 8 * 1024
    && Buffer.byteLength(JSON.stringify({ text }), 'utf8') <= 11 * 1024 ? text : INVALID;
}
