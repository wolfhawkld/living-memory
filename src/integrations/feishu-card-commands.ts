import { parseFeishuReadCommand } from './feishu-read-commands.js';
import type { FeishuCardView } from '../shared/feishu-cards.js';

/** Explicit card entry points only; text commands never create learning evidence. */
export function parseFeishuCardCommand(text: string): FeishuCardView | null {
  if (typeof text !== 'string' || text.length > 4096) return null;
  const input = text.trim();
  if (/^知识\s+卡片(?:\s|$)/.test(input)) {
    const rest = input.replace(/^知识\s+卡片/, '').trim();
    const parsed = parseFeishuReadCommand(rest ? `知识 ${rest}` : '知识');
    if (!parsed || parsed.kind === 'read') return { kind: 'help' };
    return parsed;
  }
  const due = /^知识\s+待复习(?:\s+([\s\S]+))?$/.exec(input);
  if (!due) return null;
  const parameters = new Map<string, string>();
  let remaining = due[1] ?? '';
  while (remaining) {
    const match = /^(域|量)=("(?:[^"\\]|\\.)*"|[^\s"]+)(?:\s+|$)/.exec(remaining);
    if (!match || parameters.has(match[1])) return { kind: 'help' };
    let value = match[2];
    if (value.startsWith('"')) {
      try { value = JSON.parse(value) as string; } catch { return { kind: 'help' }; }
    }
    parameters.set(match[1], value);
    remaining = remaining.slice(match[0].length);
  }
  const domainId = parameters.get('域') ?? null;
  const amount = parameters.get('量') ?? '3';
  if ((domainId !== null && (!domainId || domainId.length > 512)) || (amount !== '3' && amount !== '5')) return { kind: 'help' };
  return { kind: 'due', domainId, limit: amount === '5' ? 5 : 3 };
}
