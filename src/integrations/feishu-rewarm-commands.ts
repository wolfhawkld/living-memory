import type { FeishuRewarmCommand } from '../shared/feishu-rewarm.js';

/** Exact recovery commands; never accepts a caller-supplied concept or timestamp. */
export function parseFeishuRewarmCommand(text: string): FeishuRewarmCommand | null {
  if (text === '知识 重温状态') return { kind: 'status' };
  if (text === '知识 重试重温') return { kind: 'retry' };
  return null;
}
