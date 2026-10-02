import { createHash } from 'node:crypto';
import type { FeishuActor } from '../shared/feishu-binding.js';
import type { FeishuDeliveryResult } from '../shared/feishu-reading.js';

/** Server-only capability; never serialized to cards, HTTP or the browser. */
export interface PreparedFeishuReadReply {
  operationId: string;
  actor: FeishuActor;
  text: string;
  stillAuthorized: () => boolean;
  settle: (result: FeishuDeliveryResult) => void;
}

/** Event IDs may change on delivery retries; the incoming message ID is stable. */
export function feishuReadOperationId(actor: FeishuActor, messageId: string): string {
  return createHash('sha256').update(JSON.stringify([
    'feishu-read-v1', actor.appId, actor.tenantKey, actor.openId, messageId,
  ])).digest('hex').slice(0, 32);
}
