import { createHash } from 'node:crypto';
import type { FeishuActor, FeishuScope } from '../shared/feishu-binding.js';
import type { FeishuBrowseView, FeishuCardDelivery, FeishuCardNavAction, FeishuCardPayload, FeishuCardStored, FeishuCardView } from '../shared/feishu-cards.js';
import type { FeishuReadAuthorization, FeishuReadMessage } from '../shared/feishu-reading.js';
import type { Accounts } from './accounts.js';
import type { KnowledgeSource } from './kg.js';
import type { Store } from './store.js';
import { reviewDayKey } from '../shared/review-plan.js';
import { parseFeishuCardCommand } from '../integrations/feishu-card-commands.js';
import { parseFeishuReviewCommand } from '../integrations/feishu-review-commands.js';
import { planFeishuCardView, type FeishuCardViewPlan } from './feishu-card-view.js';
import { createFeishuReviewController } from './feishu-review.js';
import { feishuReadOperationId } from './feishu-reading.js';

export interface PreparedFeishuCardReply {
  operationId: string;
  actor: FeishuActor;
  card: FeishuCardPayload;
  expectedChatId: string;
  stillAuthorized: () => boolean;
  settle: (delivery: FeishuCardDelivery) => void;
}

interface CardContext { source: KnowledgeSource; store: Store; publish?: (reason: 'observation' | 'review') => void }
interface CardCapabilitiesOptions {
  accounts: Accounts | null;
  scope: FeishuScope | null;
  timeZone: string;
  now: () => Date;
  contextForUser: (userId: string) => CardContext;
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value;
}

const fingerprints = new WeakMap<KnowledgeSource, string>();
/** Deterministic across service restarts; excludes learning and scheduling state. */
export function feishuCardSourceFingerprint(source: KnowledgeSource): string {
  const cached = fingerprints.get(source);
  if (cached) return cached;
  const hash = createHash('sha256').update('living-memory/feishu-card-source/v1');
  const append = (value: string) => hash.update(`:${Buffer.byteLength(value, 'utf8')}:`).update(value);
  append(source.namespace);
  for (const concept of [...source.index.concepts].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    append(JSON.stringify([concept.id, concept.title, concept.aliases, concept.domain, concept.summary, concept.body,
      concept.source.path, concept.source.revision]));
  }
  const result = hash.digest('hex');
  fingerprints.set(source, result);
  return result;
}

/** Narrow internal capability; no owner-session fallback or public raw-event route. */
export function createFeishuCardCapabilities(options: CardCapabilitiesOptions) {
  const { accounts, scope, now, contextForUser, timeZone } = options;
  let zoneValid = false;
  try { zoneValid = typeof timeZone === 'string' && timeZone.length <= 128
    && !!new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date(0)); } catch { /* Disabled card capability. */ }
  const reviews = accounts ? createFeishuReviewController({ accounts, now, timeZone, fingerprint: feishuCardSourceFingerprint }) : null;
  function authorized(actor: FeishuActor): FeishuReadAuthorization | null {
    if (!accounts || !scope || !zoneValid || !actor || actor.appId !== scope.appId || actor.tenantKey !== scope.tenantKey || !validId(actor.openId)) return null;
    const user = accounts.resolveFeishuAccount(actor);
    if (!user) return null;
    const binding = accounts.getFeishuBindingState(user.id).binding;
    return binding ? { userId: user.id, accessRevision: user.accessRevision, bindingId: binding.id } : null;
  }
  function sameAuthorization(actor: FeishuActor, expected: FeishuReadAuthorization): boolean {
    const current = authorized(actor);
    return !!current && current.userId === expected.userId && current.accessRevision === expected.accessRevision && current.bindingId === expected.bindingId;
  }
  function prepare(actor: FeishuActor, authorization: FeishuReadAuthorization, context: CardContext,
    view: FeishuBrowseView, originChatId: string, operationId: string): PreparedFeishuCardReply | null {
    const source = context.source; const asOf = now().toISOString();
    const plan = planFeishuCardView(view, { concepts: source.index.concepts,
      states: context.store.getStates(source.index.concepts, asOf), anchors: context.store.getAnchors(), asOf },
    { sourceId: source.namespace, asOf, timeZone, dayKey: reviewDayKey(asOf, timeZone),
      plan: context.store.getReviewPlan(), completedConceptIds: context.store.getCompletedConceptIds(asOf, timeZone) });
    return preparePlan(actor, authorization, context, view, plan, originChatId, operationId);
  }
  function preparePlan(actor: FeishuActor, authorization: FeishuReadAuthorization, context: CardContext,
    view: FeishuCardView, plan: FeishuCardViewPlan, originChatId: string, operationId: string,
    reviewGuard: () => boolean = () => true): PreparedFeishuCardReply | null {
    let draft: FeishuCardStored | null = null;
    try {
      const source = context.source;
      draft = accounts!.createFeishuCardDraft(actor, authorization, { namespace: source.namespace,
        sourceFingerprint: feishuCardSourceFingerprint(source), originChatId, view, actions: plan.actions });
      if (!draft) throw new Error('Feishu card unavailable');
      const card = plan.build(draft.id);
      if (Buffer.byteLength(JSON.stringify(card), 'utf8') > 20 * 1024) throw new Error('Feishu card exceeds budget');
      const cardId = draft.id;
      const stillAuthorized = () => {
        try { return context.source === source && sameAuthorization(actor, authorization)
          && reviewGuard() && accounts!.isFeishuCardDraftAuthorized(cardId, actor, authorization); }
        catch { return false; }
      };
      return { operationId, actor, card, expectedChatId: originChatId, stillAuthorized,
        settle: (delivery) => {
          const accepted = delivery?.status === 'platform-accepted' && validId(delivery.messageId)
            && validId(delivery.chatId) && delivery.chatId === originChatId;
          // Keep a failed receipt write from activating an incompletely settled
          // draft. The durable attempted receipt continues to prevent retries.
          try { accounts!.finishFeishuRead(operationId, authorization.userId, accepted ? 'platform-accepted' : 'failed-or-unknown'); }
          catch {
            try { accounts!.discardFeishuCard(cardId, actor, authorization); } catch { /* TTL still bounds metadata. */ }
            throw new Error('Feishu card settlement unavailable');
          }
          if (accepted && stillAuthorized() && accounts!.activateFeishuCard(cardId, actor, authorization, delivery)) return;
          accounts!.discardFeishuCard(cardId, actor, authorization);
        } };
    } catch {
      try { accounts!.finishFeishuRead(operationId, authorization.userId, 'failed-or-unknown'); } catch { /* Fixed metadata only. */ }
      if (draft) { try { accounts!.discardFeishuCard(draft.id, actor, authorization); } catch { /* TTL bounds failed drafts. */ } }
      return null;
    }
  }
  return {
    prepareMessage(message: FeishuReadMessage): PreparedFeishuCardReply | null {
      if (!message || ![message.eventId, message.messageId, message.chatId].every(validId)
        || typeof message.text !== 'string' || message.text.length > 4096) return null;
      try {
        const command = parseFeishuReviewCommand(message.text);
        const view = command?.kind === 'help' ? { kind: 'help' as const } : parseFeishuCardCommand(message.text);
        if (!command && !view) return null;
        const actor = { appId: message.appId, tenantKey: message.tenantKey, openId: message.openId };
        const authorization = authorized(actor);
        if (!authorization) return null;
        const context = contextForUser(authorization.userId);
        if (command && command.kind !== 'help') {
          const reviewed = reviews!.prepare(actor, authorization, { kind: 'message', message }, context, command);
          return reviewed ? preparePlan(actor, authorization, context, reviewed.plan.view, reviewed.plan,
            message.chatId, reviewed.operationId, reviewed.stillAuthorized) : null;
        }
        const operationId = feishuReadOperationId(actor, message.messageId);
        if (!accounts!.claimFeishuRead(operationId, actor, authorization)) return null;
        try { return prepare(actor, authorization, context, view!, message.chatId, operationId); }
        catch { accounts!.finishFeishuRead(operationId, authorization.userId, 'failed-or-unknown'); return null; }
      } catch { return null; }
    },
    prepareAction(action: FeishuCardNavAction): PreparedFeishuCardReply | null {
      if (!action || ![action.eventId, action.messageId, action.chatId].every(validId)) return null;
      try {
        const authorization = authorized(action);
        if (!authorization) return null;
        const stored = accounts!.getFeishuCardForAction(action);
        if (!stored) return null;
        // A resumed session invalidates the entire old review card, including its browse controls.
        if (stored.view.kind === 'review' && !accounts!.isFeishuReviewVersionAuthorized(
          stored.view.sessionId, stored.view.version, action, authorization)) return null;
        const context = contextForUser(authorization.userId);
        const sourceFingerprint = feishuCardSourceFingerprint(context.source);
        if (stored.namespace !== context.source.namespace || stored.sourceFingerprint !== sourceFingerprint) return null;
        const target = stored.actions.find(entry => entry.id === action.actionId)!.target;
        if (target.kind === 'review' || target.kind === 'review-start' || target.kind === 'review-batch-start') {
          const reviewed = reviews!.prepare(action, authorization, { kind: 'card', action }, context);
          return reviewed ? preparePlan(action, authorization, context, reviewed.plan.view, reviewed.plan,
            stored.originChatId, reviewed.operationId, reviewed.stillAuthorized) : null;
        }
        const claimed = accounts!.claimFeishuCardAction(action, authorization,
          { cardId: stored.id, namespace: context.source.namespace, sourceFingerprint });
        if (!claimed) return null;
        if (claimed.target.kind === 'review' || claimed.target.kind === 'review-start' || claimed.target.kind === 'review-batch-start') return null;
        return prepare({ appId: action.appId, tenantKey: action.tenantKey, openId: action.openId }, authorization,
          context, claimed.target, stored.originChatId, claimed.operationId);
      } catch { return null; }
    },
  };
}
