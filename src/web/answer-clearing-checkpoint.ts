import { getAnswerPrivacyChannel, answerPrivacyLockKey, type AnswerPrivacyScope } from './answer-clearing-privacy';
import { clearBriefReviewCheckpoint, readBriefReviewCheckpoint, writeBriefReviewCheckpoint, scrubBriefReviewCheckpoint, type BriefReviewCheckpoint, type BriefReviewCheckpointStorage } from './brief-review-checkpoint';
import { instanceStorage } from './instance-storage';
import { withPendingStorageLock } from './pending-coordination';

export class AnswerClearingUnknownError extends Error {
  readonly code = 'ANSWER_CLEARING_UNKNOWN';
  constructor() { super('此观察的原答清除结果尚未确认，请先核对状态再恢复复习。'); }
}
const writeEpochs = new Map<string, number>();
const epochKey = (scope: AnswerPrivacyScope) => JSON.stringify([scope.sourceId, scope.instanceId]);
/** storage is raw browser storage; instance namespacing is applied here once. */
function scopedStorage(scope: AnswerPrivacyScope, storage?: BriefReviewCheckpointStorage) {
  const raw = storage ?? (typeof window === 'undefined' ? null : window.localStorage);
  if (!raw) throw new Error('浏览器本地存储不可用。');
  return instanceStorage(raw, scope.instanceId);
}
function filterCheckpoint(scope: AnswerPrivacyScope, checkpoint: BriefReviewCheckpoint): BriefReviewCheckpoint {
  const channel = getAnswerPrivacyChannel(scope);
  channel.reconcile();
  const attempt = checkpoint.attempt;
  const ids = [...new Set([attempt?.eventId, attempt?.submittedPayload?.eventId].filter((id): id is string => !!id))];
  let next = checkpoint;
  for (const id of ids) {
    if (channel.getMarker(id)) next = scrubBriefReviewCheckpoint(next, id);
    else if (channel.isBlocked(id)) throw new AnswerClearingUnknownError();
  }
  return next;
}
export function readPrivateBriefReviewCheckpoint(scope: AnswerPrivacyScope, storage?: BriefReviewCheckpointStorage): BriefReviewCheckpoint | null {
  const checkpoint = readBriefReviewCheckpoint(scope.sourceId, scopedStorage(scope, storage));
  return checkpoint ? filterCheckpoint(scope, checkpoint) : null;
}
export async function writePrivateBriefReviewCheckpoint(scope: AnswerPrivacyScope, checkpoint: BriefReviewCheckpoint, storage?: BriefReviewCheckpointStorage): Promise<BriefReviewCheckpoint> {
  // Freeze before waiting. A queued old autosave must consult the tombstone
  // again inside the same short lock used by confirmed-copy cleanup.
  const frozen = JSON.parse(JSON.stringify(checkpoint)) as BriefReviewCheckpoint;
  const key = epochKey(scope), epoch = writeEpochs.get(key) ?? 0;
  return withPendingStorageLock(answerPrivacyLockKey(scope), () => {
    if (epoch !== (writeEpochs.get(key) ?? 0)) throw new Error('本轮复习已结束，旧草稿未重新保存。');
    const next = filterCheckpoint(scope, frozen);
    writeBriefReviewCheckpoint(scope.sourceId, next, scopedStorage(scope, storage));
    return next;
  });
}
export async function clearPrivateBriefReviewCheckpoint(scope: AnswerPrivacyScope, storage?: BriefReviewCheckpointStorage): Promise<void> {
  const key = epochKey(scope);
  writeEpochs.set(key, (writeEpochs.get(key) ?? 0) + 1);
  return withPendingStorageLock(answerPrivacyLockKey(scope), () => clearBriefReviewCheckpoint(scope.sourceId, scopedStorage(scope, storage)));
}
