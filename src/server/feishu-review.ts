import { createHash, randomUUID } from 'node:crypto';
import type { FeishuActor } from '../shared/feishu-binding.js';
import type { FeishuReadAuthorization } from '../shared/feishu-reading.js';
import type {
  FeishuReviewCommand, FeishuReviewMutation, FeishuReviewOperation, FeishuReviewSession,
  FeishuReviewState, FeishuReviewTarget, FeishuReviewTrigger, FeishuReviewWriteIntent,
} from '../shared/feishu-review.js';
import type { Snapshot } from '../shared/types.js';
import { reviewDayKey } from '../shared/review-plan.js';
import type { Accounts } from './accounts.js';
import type { KnowledgeSource } from './kg.js';
import { StoreError, type Store } from './store.js';
import { selectFeishuReviewCandidates } from './feishu-card-view.js';
import { planFeishuReviewView, type FeishuReviewRenderInput } from './feishu-review-view.js';

export interface FeishuReviewContext {
  source: KnowledgeSource;
  store: Store;
  publish?: (reason: 'observation' | 'review') => void;
}
interface ReviewOptions {
  accounts: Accounts;
  timeZone: string;
  now: () => Date;
  fingerprint: (source: KnowledgeSource) => string;
}
const CONFLICT_CODES = new Set(['EVENT_CONFLICT', 'ANCHOR_CONFLICT', 'CONFIG_REVISION_UNKNOWN',
  'CONFIG_CONFLICT', 'SOURCE_CHANGED', 'SOURCE_MISMATCH', 'SESSION_EXPIRED', 'STATE_CONFLICT',
  'FUTURE_OBSERVATION', 'FUTURE_EVENT']);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/** Only authenticated transport calls this capability. No public write route or startup replay. */
export function createFeishuReviewController(options: ReviewOptions) {
  const { accounts, timeZone, now, fingerprint } = options;
  function availability(session: FeishuReviewSession, context: FeishuReviewContext): FeishuReviewRenderInput['availability'] {
    if (Date.parse(session.expiresAt) <= now().getTime()) return 'expired';
    const concept = context.source.index.concepts.find(item => item.id === session.state.conceptId);
    if (session.namespace !== context.source.namespace || session.sourceFingerprint !== fingerprint(context.source)
      || !concept || concept.source.revision !== session.state.sourceRevision) return 'source-changed';
    if (session.state.phase === 'front' && !candidates(context, session.state.domainId, session.state.conceptId).length) return 'ineligible';
    return 'ready';
  }
  function candidates(context: FeishuReviewContext, domainId: string | null, conceptId?: string) {
    const asOf = now().toISOString();
    const store = context.store; const source = context.source;
    const concepts = conceptId ? source.index.concepts.filter(item => item.id === conceptId) : source.index.concepts;
    const snapshot: Snapshot = { ...source.index, concepts, states: store.getStates(concepts, asOf),
      asOf, config: store.getConfig(), observationsCount: 0 };
    return selectFeishuReviewCandidates(snapshot, { sourceId: source.namespace, asOf, timeZone,
      dayKey: reviewDayKey(asOf, timeZone), plan: store.getReviewPlan(),
      completedConceptIds: store.getCompletedConceptIds(asOf, timeZone) }, domainId, 5).candidates;
  }
  function create(context: FeishuReviewContext, target: FeishuReviewTarget | null): FeishuReviewMutation {
    const domainId = target?.kind === 'review-start' ? target.domainId : null;
    const eligible = candidates(context, domainId);
    const concept = target?.kind === 'review-start'
      ? context.source.index.concepts.find(item => digest(item.id).startsWith(target.reference)
        && digest(item.source.revision).slice(0, 12) === target.revision
        && candidates(context, domainId, item.id).length > 0)
      : context.source.index.concepts.find(item => item.id === eligible[0]?.conceptId);
    if (!concept) return { kind: 'none' };
    // A shortened reference must still identify one concept in the complete index.
    if (target?.kind === 'review-start'
      && context.source.index.concepts.filter(item => digest(item.id).startsWith(target.reference)).length !== 1) return { kind: 'none' };
    return { kind: 'create', id: randomUUID().replaceAll('-', ''), state: { domainId,
      conceptId: concept.id, sourceRevision: concept.source.revision, phase: 'front', paused: false, page: 1, frozen: null } };
  }
  function mutate(session: FeishuReviewSession, operations: FeishuReviewOperation[], target: FeishuReviewTarget | null,
    command: FeishuReviewCommand | undefined, context: FeishuReviewContext): FeishuReviewMutation | null {
    let verb: Extract<FeishuReviewTarget, { kind: 'review' }>['verb'] = target?.kind === 'review' ? target.verb : 'resume';
    if (command?.kind === 'pause') verb = 'pause';
    if (command?.kind === 'finish') verb = 'finish';
    const state: FeishuReviewState = { ...session.state };
    const pending = operations.some(operation => operation.status === 'pending');
    const conflict = operations.some(operation => operation.status === 'conflict');
    const ready = availability(session, context) === 'ready';
    if (verb === 'pause') return { kind: 'update', state: { ...state, paused: true } };
    if (verb === 'resume') return { kind: 'update', state: { ...state, paused: false } };
    if (verb === 'finish') return { kind: 'update', state: pending ? state : { ...state, phase: 'finished' } };
    if (verb === 'retry') return { kind: 'update', state };
    if (verb === 'show') {
      if (!ready || state.paused || pending || conflict) return { kind: 'update', state };
      return { kind: 'update', state: { ...state, page: target?.kind === 'review' ? target.page : state.page } };
    }
    if (!ready) return { kind: 'update', state };
    if (state.paused || pending || conflict) return null;
    if (verb === 'reveal') {
      if (state.phase !== 'front' || state.frozen) return null;
      const observedAt = now().toISOString(); const config = context.store.getConfig();
      const anchor = context.store.getAnchor(state.conceptId, observedAt);
      return { kind: 'update', state: { ...state, phase: 'revealed', page: 1, frozen: {
        observedAt, configRevision: config.revision, halfLifeDays: config.halfLifeDays,
        anchorEventId: anchor?.sourceRevision === state.sourceRevision ? anchor.eventId : null,
      } } };
    }
    let intent: FeishuReviewWriteIntent;
    if (verb.startsWith('rate-')) {
      if (state.phase !== 'revealed' || !state.frozen || operations.some(operation => operation.intent.kind === 'observation')) return null;
      const rating = verb === 'rate-clear' ? 'clear' : verb === 'rate-partial' ? 'partial' : 'blank';
      intent = { kind: 'observation', request: { eventId: `feishu-observation:${session.id}`,
        conceptId: state.conceptId, sourceRevision: state.sourceRevision,
        observedAt: state.frozen.observedAt, configRevision: state.frozen.configRevision,
        anchorEventId: state.frozen.anchorEventId, answer: '', evidenceMode: 'mental', rating,
        exposure: 'unknown', observedExposure: false,
        learning: { task: 'concept', cue: 'unknown', outcome: 'unverified', basis: 'self-check', confidence: null, confidenceAt: null },
      } };
    } else if (verb === 'confirm-review') {
      if (state.phase !== 'saved' || operations.some(operation => operation.intent.kind === 'review')
        || !operations.some(operation => operation.intent.kind === 'observation' && operation.status === 'applied')) return null;
      intent = { kind: 'review', request: { eventId: `feishu-review:${session.id}`, conceptId: state.conceptId,
        sourceRevision: state.sourceRevision, kind: 'review', occurredAt: now().toISOString() } };
    } else return null;
    return { kind: 'update', state, intent };
  }
  function applyPending(session: FeishuReviewSession, actor: FeishuActor, authorization: FeishuReadAuthorization,
    context: FeishuReviewContext): FeishuReviewSession {
    let current = session;
    for (const operation of accounts.getFeishuReviewOperations(session.id, actor, authorization)) {
      if (operation.status !== 'pending') continue;
      if (!accounts.isFeishuReviewVersionAuthorized(current.id, current.version, actor, authorization)
        || current.namespace !== context.source.namespace || context.store.namespace !== current.namespace) break;
      let receipt;
      try {
        const request = operation.intent.request;
        const exists = context.store.hasEvent(request.eventId);
        if (!exists) {
          const status = availability(current, context);
          if (status !== 'ready') throw new StoreError(status === 'expired' ? 'SESSION_EXPIRED' : 'SOURCE_CHANGED', '复习快照已失效。', 409);
          if (operation.intent.kind === 'observation') {
            const frozen = current.state.frozen;
            const config = frozen && context.store.getConfigAt(frozen.configRevision);
            if (!frozen || !config || config.halfLifeDays !== frozen.halfLifeDays) throw new StoreError('CONFIG_CONFLICT', '冻结参数已不可用。', 409);
          }
        }
        receipt = operation.intent.kind === 'observation'
          ? context.store.addObservation(operation.intent.request, current.state.frozen!.anchorEventId)
          : context.store.addReview(operation.intent.request);
        if (exists && receipt.status !== 'duplicate') throw new StoreError('EVENT_CONFLICT', '原事件不匹配。', 409);
      } catch (error) {
        // Database/unknown errors stay pending; only a classified business conflict is terminal.
        if (!(error instanceof StoreError) || !CONFLICT_CODES.has(error.code)) continue;
        const errorCode = error.code;
        try { current = accounts.settleFeishuReviewOperation(operation.id, actor, authorization, { status: 'conflict', errorCode }) ?? current; }
        catch { /* Keep the immutable pending intent for explicit recovery. */ }
        continue;
      }
      // Never classify a settlement failure as failure of the already committed learning event.
      try {
        current = accounts.settleFeishuReviewOperation(operation.id, actor, authorization, { status: 'applied' }) ?? current;
        context.publish?.(operation.intent.kind);
      } catch { /* Same request is compared by Store on the next explicit retry. */ }
    }
    return current;
  }
  return {
    prepare(actor: FeishuActor, authorization: FeishuReadAuthorization, trigger: FeishuReviewTrigger,
      context: FeishuReviewContext, command?: FeishuReviewCommand) {
      const originChatId = trigger.kind === 'message' ? trigger.message.chatId : trigger.action.chatId;
      const claimed = accounts.claimFeishuReviewTransition(actor, authorization, trigger, {
        namespace: context.source.namespace, sourceFingerprint: fingerprint(context.source), originChatId,
      }, ({ session, operations, target }) => {
        if (!session) {
          if (target?.kind === 'review' || (command && command.kind !== 'start')) return { kind: 'none' };
          return create(context, target);
        }
        return mutate(session, operations, target, command, context);
      });
      if (!claimed) return null;
      let session = claimed.session;
      // Pausing does not implicitly retry a write. All other recovery is tied to this accepted action.
      const isPause = command?.kind === 'pause' || (trigger.kind === 'card' && session?.state.paused === true);
      if (session && !isPause) session = applyPending(session, actor, authorization, context);
      const operations = session ? accounts.getFeishuReviewOperations(session.id, actor, authorization) : [];
      const status = session ? availability(session, context) : command?.kind === 'start' || trigger.kind === 'card' ? 'no-candidate' : 'no-session';
      const concept = session && status === 'ready'
        ? context.source.index.concepts.find(item => item.id === session!.state.conceptId) ?? null : null;
      const plan = planFeishuReviewView({ session, operations, concept, availability: status });
      const snapshot = session;
      return { operationId: claimed.operationId, plan,
        stillAuthorized: () => !snapshot || (accounts.isFeishuReviewVersionAuthorized(snapshot.id, snapshot.version, actor, authorization)
          && (!(snapshot.state.phase === 'revealed' && !snapshot.state.paused && status === 'ready')
            || availability(snapshot, context) === 'ready')),
      };
    },
  };
}
