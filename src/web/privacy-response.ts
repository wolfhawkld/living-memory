import type { PrivacyObservation } from '../shared/answer-clearing';
import type { ConceptHistory } from '../shared/types';
import type { ObservationRevisionHistory } from '../shared/observation-revision-history';
import type { ObservationPrivacySummary } from '../shared/observation-privacy';
import type { LearningOverview } from '../shared/learning-overview';
import type { LearningProtocolVersion } from '../shared/learning-protocol';
import { isAnswerCleared } from '../core/answer-clearing';

export class PrivacyResponseError extends Error {
  readonly code = 'LEARNING_PRIVACY_RESPONSE_INVALID';
  constructor() { super('学习记录隐私状态无效，请重新读取。'); this.name = 'PrivacyResponseError'; }
}
function invalid(): never { throw new PrivacyResponseError(); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  return value as Record<string, unknown>;
}
function valueOf(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor?.enumerable || !('value' in descriptor)) invalid();
  return descriptor.value;
}
export function validateObservationPrivacy(value: unknown, protocol: LearningProtocolVersion): PrivacyObservation {
  try {
    const observation = record(value);
    if (protocol === 2) {
      // The v2 boundary deliberately does not tighten legacy evidence parsing.
      if (typeof valueOf(observation, 'answer') !== 'string' || Object.hasOwn(observation, 'answerClearing')) invalid();
    } else if (protocol === 3) {
      isAnswerCleared(value as PrivacyObservation);
    } else invalid();
    return value as PrivacyObservation;
  } catch { return invalid(); }
}
export function validateObservationPrivacySummary(value: unknown): ObservationPrivacySummary {
  const summary = record(value);
  const cleared = valueOf(summary, 'cleared'), excluded = valueOf(summary, 'excludedFromPerformance');
  if (!Number.isSafeInteger(cleared) || (cleared as number) < 0
    || !Number.isSafeInteger(excluded) || (excluded as number) < 0 || (excluded as number) > (cleared as number)) invalid();
  return value as ObservationPrivacySummary;
}
export function validateConceptHistoryPrivacy(value: unknown, protocol: LearningProtocolVersion): ConceptHistory<PrivacyObservation> {
  try {
    const history = record(value), entries = valueOf(history, 'entries');
    if (!Array.isArray(entries)) invalid();
    for (const item of entries) {
      const entry = record(item);
      if (valueOf(entry, 'type') === 'observation') validateObservationPrivacy(valueOf(entry, 'event'), protocol);
    }
    if (protocol === 3) {
      const version = valueOf(history, 'observationAssessmentVersion');
      if (typeof version !== 'string' || !/^[a-f0-9]{64}$/.test(version)) invalid();
      validateObservationPrivacySummary(valueOf(history, 'observationPrivacy'));
    } else if (protocol !== 2) invalid();
    return value as ConceptHistory<PrivacyObservation>;
  } catch { return invalid(); }
}
export function validateRevisionHistoryPrivacy(value: unknown, protocol: LearningProtocolVersion): ObservationRevisionHistory<PrivacyObservation> {
  try {
    const history = record(value);
    validateObservationPrivacy(valueOf(history, 'observation'), protocol);
    return value as ObservationRevisionHistory<PrivacyObservation>;
  } catch { return invalid(); }
}
export function validateLearningOverviewPrivacy(value: unknown, protocol: LearningProtocolVersion): LearningOverview {
  try {
    if (protocol === 3) {
      const overview = record(value), items = valueOf(overview, 'items');
      if (!Array.isArray(items)) invalid();
      validateObservationPrivacySummary(valueOf(overview, 'observationPrivacy'));
      for (const item of items) validateObservationPrivacySummary(valueOf(record(item), 'observationPrivacy'));
    } else if (protocol !== 2) invalid();
    return value as LearningOverview;
  } catch { return invalid(); }
}

/** The first observed clearing fact cannot be withdrawn by a refresh or later page. */
export function rememberObservationPrivacy(
  known: Map<string, string>, observation: PrivacyObservation,
): void {
  const first = known.get(observation.eventId);
  const marker = observation.answer === null ? observation.answerClearing.clearedAt : null;
  if (first !== undefined && marker !== first) invalid();
  if (marker !== null) known.set(observation.eventId, marker);
}
export function observationPrivacyVersion(observation: PrivacyObservation): string | null {
  return observation.answer === null ? observation.answerClearing.clearedAt : null;
}
