import type { FeishuActor } from './feishu-binding.js';
import type { FeishuReadAuthorization } from './feishu-reading.js';

export const FEISHU_CARD_NAV_KIND = 'lm.nav.v1' as const;
export type FeishuCardCollection =
  | { kind: 'domains'; page: number }
  | { kind: 'list'; domainId: string | null; query: string; sort: 'elapsed' | 'title'; page: number }
  | { kind: 'due'; domainId: string | null; limit: 3 | 5 };
export type FeishuCardView = FeishuCardCollection
  | { kind: 'help' }
  | { kind: 'read'; reference: string; page: number; revision: string; back: Exclude<FeishuCardCollection, { kind: 'domains' }> };

export interface FeishuCardNavAction extends FeishuActor {
  eventId: string;
  messageId: string;
  chatId: string;
  cardId: string;
  actionId: string;
}
export interface FeishuCardActionDefinition {
  id: string;
  target: FeishuCardView;
}
export interface FeishuCardStored {
  id: string;
  actor: FeishuActor;
  authorization: FeishuReadAuthorization;
  namespace: string;
  sourceFingerprint: string;
  originChatId: string;
  view: FeishuCardView;
  actions: FeishuCardActionDefinition[];
  createdAt: string;
  expiresAt: string;
  messageId: string | null;
  chatId: string | null;
  status: 'draft' | 'active' | 'consumed';
}
export interface FeishuCardDraftInput {
  namespace: string;
  sourceFingerprint: string;
  originChatId: string;
  view: FeishuCardView;
  actions: FeishuCardActionDefinition[];
}
export type FeishuCardDelivery =
  | { status: 'platform-accepted'; messageId: string; chatId: string }
  | { status: 'failed-or-unknown' };

/** The rendered card is transient; persisted navigation metadata never contains its body. */
export type FeishuCardPayload = Record<string, unknown>;
