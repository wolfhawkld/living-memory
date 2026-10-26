import type { Observation } from './types.js';
import { isValidInstant } from '../core/time-model.js';

/** Explicit protocol 3 contracts; persisted protocol 2 does not accept these types. */
export interface AnswerClearingRequest { observationEventId: string }
export interface AnswerClearingMarker { observationEventId: string; clearedAt: string }
export interface AnswerClearingReceipt extends AnswerClearingMarker { status: 'accepted' | 'duplicate' }
/** A current-state projection which never includes the saved answer or its metadata. */
export type AnswerClearingState = { observationEventId: string; status: 'saved' | 'empty' }
  | { observationEventId: string; status: 'cleared'; clearedAt: string };

/** null means deliberately removed; '' continues to mean an originally empty answer. */
export type ClearedObservation = Omit<Observation, 'answer'> & {
  answer: null;
  answerClearing: AnswerClearingMarker;
};
export type PrivacyObservation = Observation | ClearedObservation;
export type AnswerClearingErrorCode = 'INVALID_REQUEST' | 'INVALID_MARKER' | 'INVALID_RECEIPT' | 'INVALID_STATE'
  | 'INVALID_OBSERVATION' | 'TARGET_MISMATCH' | 'INVALID_CLEARED_AT' | 'NO_SAVED_ANSWER' | 'INCONSISTENT_CLEARING';
export class AnswerClearingError extends Error {
  constructor(readonly code: AnswerClearingErrorCode) { super(code); this.name = 'AnswerClearingError'; }
}

function invalid(code: AnswerClearingErrorCode): never { throw new AnswerClearingError(code); }
function data(value: unknown, fields: readonly string[], code: AnswerClearingErrorCode): Record<string, unknown> {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid(code);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== 'string' || !fields.includes(key) || !descriptor.enumerable || !('value' in descriptor)) invalid(code);
  }
  if (fields.some(key => !Object.hasOwn(value, key))) invalid(code);
  return value as Record<string, unknown>;
}
function id(value: unknown, code: AnswerClearingErrorCode): string {
  if (typeof value !== 'string') invalid(code);
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized)) invalid(code);
  return normalized;
}
function instant(value: unknown, code: AnswerClearingErrorCode): string {
  if (typeof value !== 'string' || !isValidInstant(value)) invalid(code);
  const normalized = new Date(value).toISOString();
  if (!isValidInstant(normalized)) invalid(code);
  return normalized;
}
export function parseAnswerClearingRequest(value: unknown): AnswerClearingRequest {
  try {
    const input = data(value, ['observationEventId'], 'INVALID_REQUEST');
    return Object.freeze({ observationEventId: id(input.observationEventId, 'INVALID_REQUEST') });
  } catch { return invalid('INVALID_REQUEST'); }
}
export function parseAnswerClearingMarker(value: unknown): AnswerClearingMarker {
  try {
    const input = data(value, ['observationEventId', 'clearedAt'], 'INVALID_MARKER');
    return Object.freeze({ observationEventId: id(input.observationEventId, 'INVALID_MARKER'), clearedAt: instant(input.clearedAt, 'INVALID_MARKER') });
  } catch { return invalid('INVALID_MARKER'); }
}
export function parseAnswerClearingReceipt(value: unknown): AnswerClearingReceipt {
  try {
    const input = data(value, ['status', 'observationEventId', 'clearedAt'], 'INVALID_RECEIPT');
    if (input.status !== 'accepted' && input.status !== 'duplicate') invalid('INVALID_RECEIPT');
    return Object.freeze({ status: input.status, observationEventId: id(input.observationEventId, 'INVALID_RECEIPT'),
      clearedAt: instant(input.clearedAt, 'INVALID_RECEIPT') });
  } catch { return invalid('INVALID_RECEIPT'); }
}
export function parseAnswerClearingState(value: unknown): AnswerClearingState {
  try {
    // Inspect a data descriptor before selecting the union; never invoke a getter.
    const descriptor = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'status') : undefined;
    const status = descriptor && 'value' in descriptor ? descriptor.value : undefined;
    if (status !== 'saved' && status !== 'empty' && status !== 'cleared') invalid('INVALID_STATE');
    const input = data(value, status === 'cleared' ? ['observationEventId', 'status', 'clearedAt'] : ['observationEventId', 'status'], 'INVALID_STATE');
    const observationEventId = id(input.observationEventId, 'INVALID_STATE');
    return Object.freeze(status === 'cleared'
      ? { observationEventId, status, clearedAt: instant(input.clearedAt, 'INVALID_STATE') }
      : { observationEventId, status });
  } catch { return invalid('INVALID_STATE'); }
}
