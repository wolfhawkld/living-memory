import type { FeishuReadCommand } from '../shared/feishu-reading.js';

const PAGE_MAX = 100_000;
function pageOf(value: string): number | null {
  if (!/^[1-9]\d{0,5}$/.test(value)) return null;
  const page = Number(value);
  return page <= PAGE_MAX ? page : null;
}

/** Strict, bounded read-only grammar. Unrecognized input is never a learning action. */
export function parseFeishuReadCommand(text: string): FeishuReadCommand | null {
  if (typeof text !== 'string' || text.length > 4096) return null;
  const input = text.trim();
  if (input === '知识') return { kind: 'list', domainId: null, query: '', sort: 'elapsed', page: 1 };
  if (input === '知识 帮助') return { kind: 'help' };
  if (!/^知识(?:\s|$)/.test(input)) return null;
  const invalid = (): FeishuReadCommand => ({ kind: 'help' });
  const domains = /^知识\s+领域(?:\s+(\S+))?$/.exec(input);
  if (domains) {
    const page = domains[1] === undefined ? 1 : pageOf(domains[1]);
    return page === null ? invalid() : { kind: 'domains', page };
  }
  const read = /^知识\s+阅读\s+([a-f0-9]{12,64})(?:\s+(\S+))?(?:\s+([a-f0-9]{12}))?$/.exec(input);
  if (read) {
    const page = read[2] === undefined ? 1 : pageOf(read[2]);
    const revision = read[3] ?? null;
    return page === null || (page > 1 && revision === null)
      ? invalid() : { kind: 'read', reference: read[1], page, revision };
  }
  const search = /^知识\s+搜索\s+([\s\S]+)$/.exec(input);
  if (search) {
    const query = search[1].trim();
    return query && query.length <= 120
      ? { kind: 'list', domainId: null, query, sort: 'elapsed', page: 1 } : invalid();
  }
  const list = /^知识\s+列表(?:\s+([\s\S]+))?$/.exec(input);
  if (!list) return invalid();
  const fields = new Map<string, string>();
  let remaining = list[1] ?? '';
  while (remaining.length > 0) {
    const field = /^(域|查|序|页)=("(?:[^"\\]|\\.)*"|[^\s"]+)(?:\s+|$)/.exec(remaining);
    if (!field || fields.has(field[1])) return invalid();
    let value = field[2];
    if (value.startsWith('"')) {
      try { value = JSON.parse(value) as string; } catch { return invalid(); }
    }
    fields.set(field[1], value);
    remaining = remaining.slice(field[0].length);
  }
  const domainId = fields.get('域') ?? null;
  const query = fields.get('查') ?? '';
  const sort = fields.get('序') ?? '时间';
  const page = pageOf(fields.get('页') ?? '1');
  if ((domainId !== null && (!domainId || domainId.length > 512))
    || query.length > 120 || !['时间', '名称'].includes(sort) || page === null) return invalid();
  return { kind: 'list', domainId, query, sort: sort === '名称' ? 'title' : 'elapsed', page };
}
