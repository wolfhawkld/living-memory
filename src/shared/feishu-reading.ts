import type { FeishuActor } from './feishu-binding.js';

/** Minimal projection from an authenticated SDK private-message event. */
export interface FeishuReadMessage extends FeishuActor {
  eventId: string;
  messageId: string;
  chatId: string;
  text: string;
}

export type FeishuReadCommand =
  | { kind: 'help' }
  | { kind: 'domains'; page: number }
  | { kind: 'list'; domainId: string | null; query: string; sort: 'elapsed' | 'title'; page: number }
  | { kind: 'read'; reference: string; page: number; revision: string | null };

/** Acceptance acknowledges the messaging API, not that the user read the message. */
export type FeishuDeliveryResult = 'platform-accepted' | 'failed-or-unknown';

/** Authorization generation captured and rechecked by the local server. */
export interface FeishuReadAuthorization {
  userId: string;
  accessRevision: number;
  bindingId: string;
}
