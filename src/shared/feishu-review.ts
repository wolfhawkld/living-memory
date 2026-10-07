import type { FeishuActor } from './feishu-binding.js';
import type { FeishuCardNavAction } from './feishu-cards.js';
import type { FeishuReadAuthorization, FeishuReadMessage } from './feishu-reading.js';
import type { ObservationRequest, ReviewRequest } from './types.js';

export type FeishuReviewTarget =
  | { kind: 'review-start'; reference: string; revision: string; domainId: string | null }
  | { kind: 'review'; sessionId: string; version: number; verb: 'show' | 'reveal' | 'rate-clear' | 'rate-partial' | 'rate-blank' | 'confirm-review' | 'pause' | 'resume' | 'finish' | 'retry'; page: number };

export interface FeishuReviewFrozen {
  observedAt: string;
  configRevision: number;
  halfLifeDays: number;
  anchorEventId: string | null;
}
export interface FeishuReviewState {
  domainId: string | null;
  conceptId: string;
  sourceRevision: string;
  phase: 'front' | 'revealed' | 'saved' | 'finished';
  paused: boolean;
  page: number;
  frozen: FeishuReviewFrozen | null;
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
  intent: FeishuReviewWriteIntent;
  status: 'pending' | 'applied' | 'conflict';
  errorCode: string | null;
  createdAt: string;
  settledAt: string | null;
}
export type FeishuReviewCommand = { kind: 'start' | 'continue' | 'pause' | 'finish' };
export type FeishuReviewTrigger =
  | { kind: 'message'; message: FeishuReadMessage }
  | { kind: 'card'; action: FeishuCardNavAction };
export type FeishuReviewMutation =
  | { kind: 'create'; id: string; state: FeishuReviewState }
  | { kind: 'update'; state: FeishuReviewState; intent?: FeishuReviewWriteIntent }
  | { kind: 'none' };
export interface FeishuReviewTransitionContext {
  session: FeishuReviewSession | null;
  operations: FeishuReviewOperation[];
  target: FeishuReviewTarget | null;
}
export interface FeishuReviewTransitionResult {
  operationId: string;
  session: FeishuReviewSession | null;
  operations: FeishuReviewOperation[];
}
