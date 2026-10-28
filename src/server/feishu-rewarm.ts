import type { FeishuActor } from '../shared/feishu-binding.js';
import type { FeishuReadAuthorization } from '../shared/feishu-reading.js';
import type { FeishuRewarmTrigger } from '../shared/feishu-rewarm.js';
import type { Accounts } from './accounts.js';
import type { KnowledgeSource } from './kg.js';
import { StoreError } from './store.js';
import type { FeishuReviewContext } from './feishu-review.js';
import { planFeishuRewarmView } from './feishu-rewarm-view.js';

const CONFLICTS = new Set(['EVENT_CONFLICT', 'ANCHOR_CONFLICT', 'SOURCE_CHANGED', 'SOURCE_MISMATCH', 'FUTURE_EVENT', 'FUTURE_OBSERVATION', 'CONFIG_CONFLICT', 'CONFIG_REVISION_UNKNOWN', 'STATE_CONFLICT', 'CONCEPT_NOT_FOUND']);
export function createFeishuRewarmController(options: { accounts: Accounts; fingerprint: (source: KnowledgeSource) => string;
  authorized: (actor: FeishuActor, authorization: FeishuReadAuthorization) => boolean }) {
  const { accounts, fingerprint, authorized } = options;
  return { prepare(actor: FeishuActor, authorization: FeishuReadAuthorization, trigger: FeishuRewarmTrigger, context: FeishuReviewContext) {
    const scope = { namespace: context.source.namespace, sourceFingerprint: fingerprint(context.source),
      originChatId: trigger.kind === 'message' ? trigger.message.chatId : trigger.action.chatId };
    let isConfirmation = false;
    if (trigger.kind === 'card') {
      const stored = accounts.getFeishuCardForAction(trigger.action);
      const target = stored?.actions.find(action => action.id === trigger.action.actionId)?.target;
      if (!stored || !target || !['rewarm-confirm', 'rewarm'].includes(target.kind)) return null;
      isConfirmation = target.kind === 'rewarm-confirm';
      if (target.kind === 'rewarm-confirm' && (stored.namespace !== scope.namespace || stored.sourceFingerprint !== scope.sourceFingerprint
        || !context.source.index.concepts.some(concept => concept.id === target.conceptId && concept.source.revision === target.sourceRevision))) return null;
    }
    const claimed = accounts.claimFeishuRewarmTransition(actor, authorization, trigger, scope);
    if (!claimed) return null;
    let intent = claimed.intent;
    if (intent?.status === 'pending' && claimed.mayApply && authorized(actor, authorization)
      && context.source.namespace === intent.namespace && context.store.namespace === intent.namespace) {
      let committed = false;
      try {
        const exists = context.store.hasEvent(intent.request.eventId);
        if (!exists && (fingerprint(context.source) !== intent.sourceFingerprint
          || !context.source.index.concepts.some(concept => concept.id === intent!.request.conceptId && concept.source.revision === intent!.request.sourceRevision))) {
          throw new StoreError('SOURCE_CHANGED', '资料已变化。', 409);
        }
        const receipt = context.store.addReview(intent.request);
        if (exists && receipt.status !== 'duplicate') throw new StoreError('EVENT_CONFLICT', '原事件不匹配。', 409);
        committed = true;
      } catch (error) {
        if (error instanceof StoreError && CONFLICTS.has(error.code)) {
          try { intent = accounts.settleFeishuRewarmIntent(intent.id, actor, authorization, intent, { status: 'conflict', errorCode: error.code }) ?? intent; }
          catch { /* Immutable pending remains recoverable. */ }
        }
      }
      if (committed) {
        try { context.publish?.('review'); } catch { /* A notification cannot change the committed event. */ }
        try { intent = accounts.settleFeishuRewarmIntent(intent.id, actor, authorization, intent, { status: 'applied' }) ?? intent; }
        catch { /* An explicit retry verifies the exact duplicate request. */ }
      }
    }
    const concept = intent ? context.source.index.concepts.find(concept => concept.id === intent!.request.conceptId
      && concept.source.revision === intent!.request.sourceRevision) ?? null : null;
    return { operationId: claimed.operationId, plan: planFeishuRewarmView(intent, concept, { confirmationBlockedByPending: isConfirmation && !claimed.mayApply && intent?.status === 'pending' }), stillAuthorized: () => authorized(actor, authorization) };
  } };
}
