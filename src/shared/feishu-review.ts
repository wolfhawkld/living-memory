import type { FeishuActor } from './feishu-binding.js';
import type { FeishuCardNavAction } from './feishu-cards.js';
import type { FeishuReadAuthorization, FeishuReadMessage } from './feishu-reading.js';
import type { ObservationRequest, ReviewRequest } from './types.js';

export type FeishuReviewTarget =
  | { kind: 'review-start'; reference: string; revision: string; domainId: string | null }
  | { kind: 'review-batch-start' }
  | { kind: 'review'; sessionId: string; version: number; verb: 'show' | 'reveal' | 'rate-clear' | 'rate-partial' | 'rate-blank' | 'confirm-review' | 'pause' | 'resume' | 'finish' | 'retry' | 'next' | 'skip'; page: number };

export type FeishuReviewResolvedTarget = Exclude<FeishuReviewTarget, { kind: 'review-batch-start' }>
  | { kind: 'review-batch-start'; domainId: string | null; limit: 3 | 5 };

export interface FeishuReviewFrozen {
  observedAt: string;
  configRevision: number;
  halfLifeDays: number;
  anchorEventId: string | null;
}
export type FeishuReviewItemDisposition = 'open' | 'completed' | 'skipped' | 'ineligible' | 'conflict' | 'ended';
export interface FeishuReviewBatchItem {
  id: string;
  conceptId: string;
  sourceRevision: string;
  frozen: FeishuReviewFrozen | null;
  disposition: FeishuReviewItemDisposition;
}
export interface FeishuReviewBatch {
  requestedSize: 3 | 5;
  cursor: number;
  items: FeishuReviewBatchItem[];
}
export interface FeishuReviewState {
  domainId: string | null;
  conceptId: string;
  sourceRevision: string;
  phase: 'front' | 'revealed' | 'saved' | 'finished';
  paused: boolean;
  page: number;
  frozen: FeishuReviewFrozen | null;
  batch?: FeishuReviewBatch;
}
export interface FeishuReviewSession {
  id: string;
  actor: FeishuActor;
  authorization: FeishuReadAuthorization;
  namespace: string;
  sourceFingerprint: string;
  originChatId: string;
  createdAt: string;
  expiresAt: string;
  version: number;
  state: FeishuReviewState;
}
export type FeishuReviewWriteIntent =
  | { kind: 'observation'; request: ObservationRequest }
  | { kind: 'review'; request: ReviewRequest };
export interface FeishuReviewOperation {
  id: string;
  sessionId: string;
  itemId: string;
  intent: FeishuReviewWriteIntent;
  status: 'pending' | 'applied' | 'conflict';
  errorCode: string | null;
  createdAt: string;
  settledAt: string | null;
}
export type FeishuReviewCommand = { kind: 'start'; limit?: 3 | 5 } | { kind: 'continue' | 'pause' | 'finish' };
export type FeishuReviewTrigger =
  | { kind: 'message'; message: FeishuReadMessage }
  | { kind: 'card'; action: FeishuCardNavAction };
export type FeishuReviewMutation =
  | { kind: 'create'; id: string; state: FeishuReviewState }
  | { kind: 'update'; state: FeishuReviewState; intent?: FeishuReviewWriteIntent }
  | { kind: 'advance'; disposition: 'completed' | 'skipped' | 'ineligible' | 'conflict' }
  | { kind: 'finish' }
  | { kind: 'none' };
export interface FeishuReviewTransitionContext {
  session: FeishuReviewSession | null;
  operations: FeishuReviewOperation[];
  target: FeishuReviewResolvedTarget | null;
}
export interface FeishuReviewTransitionResult {
  operationId: string;
  session: FeishuReviewSession | null;
  operations: FeishuReviewOperation[];
}

/** Legacy sessions retain their original single-item identity. */
export function feishuReviewItemId(session: FeishuReviewSession): string {
  return session.state.batch ? session.state.batch.items[session.state.batch.cursor]!.id : session.id;
}
export function feishuReviewEventId(session: FeishuReviewSession, kind: 'observation' | 'review'): string {
  return `feishu-${kind}:${session.id}${session.state.batch ? `:${feishuReviewItemId(session)}` : ''}`;
}
export function feishuReviewCurrentOperations(session: FeishuReviewSession, operations: readonly FeishuReviewOperation[]): FeishuReviewOperation[] {
  const itemId = feishuReviewItemId(session);
  return operations.filter(operation => operation.itemId === itemId);
}
/** Freeze only the current item; phase and all other queue items stay unchanged. */
export function withFeishuReviewFrozen(state: FeishuReviewState, frozen: FeishuReviewFrozen): FeishuReviewState {
  return { ...state, frozen: { ...frozen }, ...(state.batch ? { batch: { ...state.batch,
    items: state.batch.items.map((item,index) => index === state.batch!.cursor ? { ...item,frozen: { ...frozen } } : item) } } : {}) };
}
