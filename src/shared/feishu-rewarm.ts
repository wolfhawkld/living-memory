import type { FeishuActor } from './feishu-binding.js';
import type { FeishuCardNavAction } from './feishu-cards.js';
import type { FeishuReadAuthorization, FeishuReadMessage } from './feishu-reading.js';
import type { ReviewRequest } from './types.js';

export type FeishuRewarmTarget =
  | { kind: 'rewarm-confirm'; conceptId: string; sourceRevision: string }
  | { kind: 'rewarm'; intentId: string; verb: 'show' | 'retry' };
export type FeishuRewarmCommand = { kind: 'status' | 'retry' };
export type FeishuRewarmRequest = ReviewRequest & { kind: 'review'; occurredAt: string };
export interface FeishuRewarmScope { namespace: string; sourceFingerprint: string; originChatId: string }
export interface FeishuRewarmIntent extends FeishuRewarmScope {
  id: string;
  actor: FeishuActor;
  authorization: FeishuReadAuthorization;
  request: FeishuRewarmRequest;
  status: 'pending' | 'applied' | 'conflict';
  errorCode: string | null;
  createdAt: string;
  settledAt: string | null;
}
export type FeishuRewarmTrigger =
  | { kind: 'message'; message: FeishuReadMessage; command: FeishuRewarmCommand }
  | { kind: 'card'; action: FeishuCardNavAction };
export interface FeishuRewarmTransitionResult { operationId: string; intent: FeishuRewarmIntent | null; mayApply: boolean }

function keys(value: unknown, expected: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value,key));
}
function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value; }
export function isValidFeishuRewarmTarget(value: unknown): value is FeishuRewarmTarget {
  if (!value || typeof value !== 'object') return false;
  const target = value as Record<string,unknown>;
  return target.kind === 'rewarm-confirm'
    ? keys(value,['kind','conceptId','sourceRevision']) && text(target.conceptId) && text(target.sourceRevision)
    : target.kind === 'rewarm' && keys(value,['kind','intentId','verb']) && typeof target.intentId === 'string'
      && /^[a-f0-9]{32}$/.test(target.intentId) && ['show','retry'].includes(target.verb as string);
}
export function isValidFeishuRewarmRequest(value: unknown, intentId?: string): value is FeishuRewarmRequest {
  if (!keys(value,['eventId','conceptId','sourceRevision','kind','occurredAt']) || value.kind !== 'review'
      || !text(value.conceptId) || !text(value.sourceRevision) || typeof value.eventId !== 'string'
      || !/^feishu-rewarm:[a-f0-9]{32}$/.test(value.eventId) || (intentId !== undefined && value.eventId !== `feishu-rewarm:${intentId}`)
      || typeof value.occurredAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.occurredAt)
      || !Number.isFinite(Date.parse(value.occurredAt))) return false;
  return new Date(value.occurredAt).toISOString() === value.occurredAt;
}
