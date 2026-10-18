import type { Observation, RecallRating, LearningEvidence } from './types.js';
import { isValidInstant } from '../core/time-model.js';

export interface ObservationAssessment {
  rating: RecallRating;
  learning: null | Pick<LearningEvidence, 'outcome' | 'basis'>;
}
export type ObservationRevisionReason = 'input-error' | 'rechecked-original' | 'unreliable-evidence' | 'other';
interface RevisionRequestBase {
  eventId: string;
  observationEventId: string;
  previousEventId: string | null;
  occurredAt: string;
  reason: ObservationRevisionReason;
  note?: string;
}
export type ObservationRevisionRequest = RevisionRequestBase & (
  | { action: 'revise'; assessment: ObservationAssessment }
  | { action: 'withdraw' | 'reinstate'; assessment?: never }
);
export type ObservationRevision = ObservationRevisionRequest & { conceptId: string; sourceRevision: string; recordedAt: string };
export type ObservationRevisionErrorCode = 'INVALID_REQUEST' | 'INVALID_REVISION' | 'INVALID_AS_OF' | 'INVALID_PARENT'
  | 'UNATTRIBUTABLE_REVISION' | 'EVENT_CONFLICT' | 'INVALID_CHAIN' | 'PREVIOUS_EVENT_CONFLICT' | 'INVALID_TRANSITION'
  | 'UNCHANGED_ASSESSMENT' | 'INVALID_REVISION_TIME';
export class ObservationRevisionError extends Error {
  constructor(readonly code: ObservationRevisionErrorCode) { super(code); this.name = 'ObservationRevisionError'; }
}

type RecordValue = Record<string, unknown>;
function invalid(code: ObservationRevisionErrorCode): never { throw new ObservationRevisionError(code); }
function object(value: unknown, allowed: readonly string[], code: ObservationRevisionErrorCode): RecordValue {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid(code);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (descriptor.enumerable && (typeof key !== 'string' || !allowed.includes(key) || !('value' in descriptor))) invalid(code);
  }
  return value as RecordValue;
}
function field(record: RecordValue, key: string, code: ObservationRevisionErrorCode): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor?.enumerable || !('value' in descriptor)) invalid(code);
  return descriptor.value;
}
function text(value: unknown, limit: number, code: ObservationRevisionErrorCode, trim = false): string {
  if (typeof value !== 'string') invalid(code);
  const result = trim ? value.trim() : value;
  if (!result.length || result.length > limit) invalid(code);
  return result;
}
function id(value: unknown, code: ObservationRevisionErrorCode): string {
  const result = text(value, 128, code, true);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(result)) invalid(code);
  return result;
}
function instant(value: unknown, code: ObservationRevisionErrorCode): string {
  if (typeof value !== 'string' || !isValidInstant(value)) invalid(code);
  return new Date(value).toISOString();
}
function choice<T extends string>(value: unknown, choices: readonly T[], code: ObservationRevisionErrorCode): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) invalid(code);
  return value as T;
}
function learning(value: unknown, code: ObservationRevisionErrorCode, exact = true): NonNullable<ObservationAssessment['learning']> {
  const record = object(value, exact ? ['outcome', 'basis'] : Object.keys(value as object), code);
  const outcome = choice(field(record, 'outcome', code), ['success', 'partial', 'failure', 'unverified'], code);
  const basis = choice(field(record, 'basis', code), ['self-check', 'application', 'unknown'], code);
  if (outcome !== 'unverified' && basis === 'unknown') invalid(code);
  return Object.freeze({ outcome, basis });
}
function assessment(value: unknown, code: ObservationRevisionErrorCode): ObservationAssessment {
  const record = object(value, ['rating', 'learning'], code);
  const rating = choice(field(record, 'rating', code), ['clear', 'partial', 'blank'], code);
  const evidence = field(record, 'learning', code);
  return Object.freeze({ rating, learning: evidence === null ? null : learning(evidence, code) });
}
const requestKeys = ['eventId', 'observationEventId', 'previousEventId', 'occurredAt', 'action', 'reason', 'note', 'assessment'];
function parse(value: unknown, stored: boolean): ObservationRevisionRequest | ObservationRevision {
  const code = stored ? 'INVALID_REVISION' : 'INVALID_REQUEST';
  try {
    const record = object(value, stored ? [...requestKeys, 'conceptId', 'sourceRevision', 'recordedAt'] : requestKeys, code);
    const previous = field(record, 'previousEventId', code);
    const action = choice(field(record, 'action', code), ['revise', 'withdraw', 'reinstate'], code);
    const base: RevisionRequestBase = {
      eventId: id(field(record, 'eventId', code), code), observationEventId: id(field(record, 'observationEventId', code), code),
      previousEventId: previous === null ? null : id(previous, code), occurredAt: instant(field(record, 'occurredAt', code), code),
      reason: choice(field(record, 'reason', code), ['input-error', 'rechecked-original', 'unreliable-evidence', 'other'], code),
    };
    if (Object.hasOwn(record, 'note')) {
      const note = field(record, 'note', code);
      if (typeof note !== 'string' || note.length > 1000) invalid(code);
      base.note = note;
    }
    if (action !== 'revise' && Object.hasOwn(record, 'assessment')) invalid(code);
    const request: ObservationRevisionRequest = action === 'revise'
      ? { ...base, action, assessment: assessment(field(record, 'assessment', code), code) }
      : { ...base, action };
    if (!stored) return Object.freeze(request);
    const recordedAt = instant(field(record, 'recordedAt', code), code);
    if (Date.parse(request.occurredAt) > Date.parse(recordedAt)) invalid(code);
    return Object.freeze({ ...request, conceptId: text(field(record, 'conceptId', code), 512, code, true),
      sourceRevision: text(field(record, 'sourceRevision', code), 512, code, true), recordedAt });
  } catch { return invalid(code); }
}
export function parseObservationRevisionRequest(value: unknown): ObservationRevisionRequest {
  return parse(value, false) as ObservationRevisionRequest;
}
export function parseObservationRevision(value: unknown): ObservationRevision {
  return parse(value, true) as ObservationRevision;
}
export function observationRevisionRequestEqual(a: ObservationRevisionRequest, b: ObservationRevisionRequest): boolean {
  return JSON.stringify(parseObservationRevisionRequest(a)) === JSON.stringify(parseObservationRevisionRequest(b));
}
export function observationAssessmentsEqual(a: ObservationAssessment, b: ObservationAssessment): boolean {
  return JSON.stringify(assessment(a, 'INVALID_REQUEST')) === JSON.stringify(assessment(b, 'INVALID_REQUEST'));
}
export function assessmentFromObservation(observation: Observation): ObservationAssessment {
  const code = 'INVALID_PARENT';
  try {
    // Only assessment fields are projected. Other historical conditions stay raw.
    const record = object(observation, Object.keys(observation), code);
    const rating = choice(field(record, 'rating', code), ['clear', 'partial', 'blank'], code);
    const evidence = Object.hasOwn(record, 'learning') ? field(record, 'learning', code) : undefined;
    return Object.freeze({ rating, learning: evidence === undefined ? null : learning(evidence, code, false) });
  } catch { return invalid(code); }
}
