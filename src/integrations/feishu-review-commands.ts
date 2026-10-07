import type { FeishuReviewCommand } from '../shared/feishu-review.js';

/** Explicit private recall entry points; no concept IDs or free-form answers. */
export function parseFeishuReviewCommand(text: string): FeishuReviewCommand | { kind: 'help' } | null {
  if (typeof text !== 'string' || text.length > 4096) return null;
  const input = text.trim();
  const match = /^知识\s+(复习|继续复习|暂停复习|结束复习)([\s\S]*)$/.exec(input);
  if (!match) return /^知识\s+\S*复习/.test(input) && !/^知识\s+待复习(?:\s|$)/.test(input) ? { kind: 'help' } : null;
  if (match[1] === '复习' && /^\s+[35]$/.test(match[2])) return { kind: 'start', limit: Number(match[2].trim()) as 3 | 5 };
  if (match[2]) return { kind: 'help' };
  const kinds = { 复习: 'start', 继续复习: 'continue', 暂停复习: 'pause', 结束复习: 'finish' } as const;
  return { kind: kinds[match[1] as keyof typeof kinds] };
}
