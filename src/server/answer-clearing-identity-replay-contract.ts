import { isValidInstant } from '../core/time-model.js';
import type { IdentityBinding, IdentityLinkReceipt, IdentityLinkRequest } from '../shared/identity.js';
import { AnswerClearingStoreError } from './answer-clearing-store-error.js';

/** A fixed format marker, never derived from a token, export or answer. */
export const SAFE_IDENTITY_CREDENTIAL = 'answer-clearing:safe-identity-replay:v1';
export interface SafeIdentityReplayRequest extends IdentityLinkRequest {
  namespace: string;
  operationId: string;
}
export interface SafeIdentityReceiptEnvelope extends SafeIdentityReplayRequest {
  version: 1;
  receipt: IdentityLinkReceipt;
}
function invalid(): never { throw new AnswerClearingStoreError('ANSWER_CLEARING_IDENTITY_REPLAY_DATA_INVALID', 503); }
/** Every accepted property is an own data property. Unknown/accessor fields never get read. */
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length) invalid();
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !keys.includes(key)) invalid();
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !('value' in descriptor)) invalid();
    result[key] = descriptor.value;
  }
  return result;
}
function text(value: unknown, max = 4096): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || Buffer.byteLength(value, 'utf8') > max) invalid();
  return value;
}
/** Preserve the existing identity path/revision contract, including multibyte text. */
function identityText(value: unknown): string {
  const result = text(value, 16_384);
  if (result.length > 4096) invalid();
  return result;
}
function operationId(value: unknown): string {
  const result = text(value, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(result)) invalid();
  return result;
}
function namespace(value: unknown): string {
  const result = text(value, 256);
  if (/[\u0000-\u001f\u007f]/.test(result)) invalid();
  return result;
}
function instant(value: unknown): string {
  const result = text(value, 128); if (!isValidInstant(result)) invalid(); return result;
}
function request(value: unknown): SafeIdentityReplayRequest {
  const row = record(value, ['namespace', 'operationId', 'fromConceptId', 'toConceptId']);
  const fromConceptId = text(row.fromConceptId, 2048), toConceptId = text(row.toConceptId, 2048);
  if (fromConceptId.length > 512 || toConceptId.length > 512 || fromConceptId === toConceptId) invalid();
  return { namespace: namespace(row.namespace), operationId: operationId(row.operationId), fromConceptId, toConceptId };
}
function receipt(value: unknown): IdentityLinkReceipt {
  const row = record(value, ['status', 'operationId', 'sourceId', 'conceptId', 'linkedPath', 'confirmedAt', 'backupId']);
  if (row.status !== 'accepted') invalid();
  const conceptId = text(row.conceptId, 2048); if (conceptId.length > 512) invalid();
  return { status: 'accepted', operationId: operationId(row.operationId), sourceId: namespace(row.sourceId), conceptId,
    linkedPath: identityText(row.linkedPath), confirmedAt: instant(row.confirmedAt), backupId: text(row.backupId) };
}
export function parseSafeIdentityReceiptEnvelope(value: unknown, expected: { namespace: string; operationId: string }): SafeIdentityReceiptEnvelope {
  try {
    const row = record(value, ['version', 'namespace', 'operationId', 'fromConceptId', 'toConceptId', 'receipt']);
    if (row.version !== 1) invalid();
    const replay = request({ namespace: row.namespace, operationId: row.operationId, fromConceptId: row.fromConceptId, toConceptId: row.toConceptId });
    const accepted = receipt(row.receipt);
    if (replay.namespace !== namespace(expected.namespace) || replay.operationId !== operationId(expected.operationId)
      || accepted.sourceId !== replay.namespace || accepted.operationId !== replay.operationId || accepted.conceptId !== replay.fromConceptId) invalid();
    return { version: 1, ...replay, receipt: accepted };
  } catch { return invalid(); }
}
export function buildSafeIdentityReceiptEnvelope(accepted: IdentityLinkReceipt, replay: SafeIdentityReplayRequest): SafeIdentityReceiptEnvelope {
  try {
    const normalized = request(replay);
    return parseSafeIdentityReceiptEnvelope({ version: 1, ...normalized, receipt: accepted }, normalized);
  } catch { return invalid(); }
}
export function encodeSafeIdentityReceiptEnvelope(accepted: IdentityLinkReceipt, replay: SafeIdentityReplayRequest): string {
  return JSON.stringify(buildSafeIdentityReceiptEnvelope(accepted, replay));
}
/** Compare the original semantic request and immutable binding, not a preview invalidated by its own success. */
export function safeIdentityReplayMatches(envelope: SafeIdentityReceiptEnvelope, candidate: IdentityLinkRequest, binding: IdentityBinding): boolean {
  try {
    // Do not trust caller object methods/accessors while validating stored data.
    const row = record(envelope, ['version', 'namespace', 'operationId', 'fromConceptId', 'toConceptId', 'receipt']);
    const saved = parseSafeIdentityReceiptEnvelope(envelope, { namespace: namespace(row.namespace), operationId: operationId(row.operationId) });
    const incoming = record(candidate, ['fromConceptId', 'toConceptId']);
    const original = record(binding, ['operationId', 'rawConceptId', 'conceptId', 'fromPath', 'toPath', 'sourceRevision', 'confirmedAt', 'backupId']);
    const fromConceptId = text(incoming.fromConceptId, 2048), toConceptId = text(incoming.toConceptId, 2048);
    if (fromConceptId.length > 512 || toConceptId.length > 512) invalid();
    // These fields have no matching receipt column, but must still be well formed domain values.
    if (original.fromPath !== null) identityText(original.fromPath);
    identityText(original.sourceRevision);
    const normalized = { operationId: operationId(original.operationId), rawConceptId: text(original.rawConceptId, 2048),
      conceptId: text(original.conceptId, 2048), toPath: identityText(original.toPath),
      confirmedAt: instant(original.confirmedAt), backupId: text(original.backupId) };
    if (normalized.rawConceptId.length > 512 || normalized.conceptId.length > 512) invalid();
    return saved.fromConceptId === fromConceptId && saved.toConceptId === toConceptId
      && normalized.operationId === saved.operationId
      && normalized.rawConceptId === saved.toConceptId && normalized.conceptId === saved.fromConceptId
      && normalized.toPath === saved.receipt.linkedPath && normalized.confirmedAt === saved.receipt.confirmedAt
      && normalized.backupId === saved.receipt.backupId;
  } catch { return invalid(); }
}
