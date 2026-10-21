import type { LearningEvidence, Observation } from '../shared/types.js';
import { AnswerClearingError, parseAnswerClearingMarker, parseAnswerClearingReceipt, parseAnswerClearingRequest,
  type AnswerClearingMarker, type AnswerClearingReceipt, type AnswerClearingRequest,
  type ClearedObservation, type PrivacyObservation } from '../shared/answer-clearing.js';
import { isValidInstant } from './time-model.js';

function invalid(): never { throw new AnswerClearingError('INVALID_OBSERVATION'); }
function data(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  return value as Record<string, unknown>;
}
function field(record: Record<string, unknown>, key: string, optional = false): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor && optional) return undefined;
  if (!descriptor?.enumerable || !('value' in descriptor)) invalid();
  return descriptor.value;
}
function text(value: unknown, limit: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) invalid();
  return value;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) invalid();
  return value;
}
function instant(value: unknown): string {
  if (typeof value !== 'string' || !isValidInstant(value)) invalid();
  return value;
}
function number(value: unknown, minimum: number, maximum = Infinity): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) invalid();
  return value;
}
function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) invalid();
  return value as T;
}
function learning(value: unknown, observedAt: string): LearningEvidence {
  const input = data(value), task = choice(field(input, 'task'), ['concept', 'scenario']);
  const confidenceValue = field(input, 'confidence');
  const confidence = confidenceValue === null ? null : number(confidenceValue, 0, 100);
  if (confidence !== null && !Number.isInteger(confidence)) invalid();
  const confidenceTime = field(input, 'confidenceAt');
  const confidenceAt = confidenceTime === null ? null : instant(confidenceTime);
  if ((confidence === null) !== (confidenceAt === null) || (confidenceAt && Date.parse(confidenceAt) > Date.parse(observedAt))) invalid();
  const cue = choice(field(input, 'cue'), ['independent', 'hinted', 'lookup', 'unknown']);
  const outcome = choice(field(input, 'outcome'), ['success', 'partial', 'failure', 'unverified']);
  const basis = choice(field(input, 'basis'), ['self-check', 'application', 'unknown']);
  if (outcome !== 'unverified' && basis === 'unknown') invalid();
  const scenario = field(input, 'scenario', true), revisit = field(input, 'scenarioRevisit', true);
  const applicability = field(input, 'applicability', true);
  if (task === 'concept' && (scenario !== undefined || revisit !== undefined)) invalid();
  if (revisit !== undefined && revisit !== true) invalid();
  return Object.freeze({ task, confidence, confidenceAt, cue, outcome, basis,
    ...(task === 'scenario' ? { scenario: text(scenario, 4000) } : {}),
    ...(revisit === true ? { scenarioRevisit: true as const } : {}),
    ...(applicability !== undefined ? { applicability: text(applicability, 4000) } : {}) });
}

/** Select domain fields only: never carry SQL request_payload or arbitrary extra properties. */
function copyObservation(value: PrivacyObservation): PrivacyObservation {
  try {
    const input = data(value), answer = field(input, 'answer');
    const hasMarker = Object.hasOwn(input, 'answerClearing');
    if ((answer === null) !== hasMarker) throw new AnswerClearingError('INCONSISTENT_CLEARING');
    if (answer !== null && typeof answer !== 'string') invalid();
    const eventId = id(field(input, 'eventId'));
    const observedAt = instant(field(input, 'observedAt')), recordedAt = instant(field(input, 'recordedAt'));
    if (Date.parse(observedAt) > Date.parse(recordedAt)) invalid();
    const configRevision = number(field(input, 'configRevision'), 1, Number.MAX_SAFE_INTEGER);
    if (!Number.isInteger(configRevision)) invalid();
    const halfLifeDays = number(field(input, 'halfLifeDays'), Number.MIN_VALUE, 3650);
    const anchor = field(input, 'anchorEventId'), elapsed = field(input, 'elapsedDays'), decay = field(input, 'decay');
    const observedExposure = field(input, 'observedExposure');
    if (typeof observedExposure !== 'boolean') invalid();
    const mode = field(input, 'evidenceMode', true);
    const evidenceMode = mode === undefined ? undefined : choice(mode, ['mental', 'written']);
    if (evidenceMode === 'mental' && answer !== '') invalid();
    const evidence = field(input, 'learning', true);
    const base: Omit<Observation, 'answer'> = {
      eventId, conceptId: text(field(input, 'conceptId'), 512), sourceRevision: text(field(input, 'sourceRevision'), 512),
      observedAt, recordedAt, configRevision, halfLifeDays,
      anchorEventId: anchor === null ? null : id(anchor), elapsedDays: elapsed === null ? null : number(elapsed, 0),
      decay: decay === null ? null : number(decay, 0, 1),
      rating: choice(field(input, 'rating'), ['clear', 'partial', 'blank']),
      exposure: choice(field(input, 'exposure'), ['unexposed', 'exposed', 'unknown']), observedExposure,
      ...(evidenceMode !== undefined ? { evidenceMode } : {}),
      ...(evidence !== undefined ? { learning: learning(evidence, observedAt) } : {}),
    };
    if (answer !== null) return Object.freeze({ ...base, answer: answer as string });
    const marker = parseAnswerClearingMarker(field(input, 'answerClearing'));
    if (marker.observationEventId !== eventId) throw new AnswerClearingError('INCONSISTENT_CLEARING');
    if (Date.parse(marker.clearedAt) < Date.parse(recordedAt)) throw new AnswerClearingError('INVALID_CLEARED_AT');
    return Object.freeze({ ...base, answer: null, answerClearing: marker });
  } catch (error) {
    if (error instanceof AnswerClearingError) throw error;
    return invalid();
  }
}

/** Current privacy state has no historical cutoff: asOf must never resurrect a removed answer. */
export function applyAnswerClearing(observation: PrivacyObservation, input: AnswerClearingMarker): ClearedObservation {
  const parent = copyObservation(observation), marker = parseAnswerClearingMarker(input);
  if (parent.eventId !== marker.observationEventId) throw new AnswerClearingError('TARGET_MISMATCH');
  if (parent.answer === null) {
    if (parent.answerClearing.clearedAt !== marker.clearedAt) throw new AnswerClearingError('INCONSISTENT_CLEARING');
    return parent;
  }
  if (Date.parse(marker.clearedAt) < Date.parse(parent.recordedAt)) throw new AnswerClearingError('INVALID_CLEARED_AT');
  if (parent.answer.length === 0) throw new AnswerClearingError('NO_SAVED_ANSWER');
  return Object.freeze({ ...parent, answer: null, answerClearing: marker });
}

/** Pure preparation only. Persistence must atomically remove the stored text and its mechanical copies. */
export function planAnswerClearing(observation: PrivacyObservation, input: AnswerClearingRequest, clearedAt: string): {
  observation: ClearedObservation; receipt: AnswerClearingReceipt;
} {
  const request = parseAnswerClearingRequest(input);
  if (!isValidInstant(clearedAt) || !isValidInstant(new Date(clearedAt).toISOString())) throw new AnswerClearingError('INVALID_CLEARED_AT');
  const parent = copyObservation(observation);
  if (request.observationEventId !== parent.eventId) throw new AnswerClearingError('TARGET_MISMATCH');
  const alreadyCleared = parent.answer === null;
  const result = alreadyCleared ? parent : applyAnswerClearing(parent, { observationEventId: parent.eventId, clearedAt });
  return Object.freeze({ observation: result, receipt: parseAnswerClearingReceipt({
    status: alreadyCleared ? 'duplicate' : 'accepted', ...result.answerClearing,
  }) });
}

/** Invalid states throw fixed errors rather than silently being treated as an intact original. */
export function isAnswerCleared(observation: PrivacyObservation): observation is ClearedObservation {
  return copyObservation(observation).answer === null;
}

/** Necessary privacy gate only. true does not establish recall, independence or calibration eligibility. */
export function isAnswerPrivacyEligible(observation: PrivacyObservation): boolean { return !isAnswerCleared(observation); }
