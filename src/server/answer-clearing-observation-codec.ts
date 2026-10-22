import { isAnswerCleared } from '../core/answer-clearing.js';
import { parseAnswerClearingMarker, type PrivacyObservation } from '../shared/answer-clearing.js';
import type { LearningEvidence } from '../shared/types.js';
import { AnswerClearingStoreError } from './answer-clearing-store-error.js';
const invalid = () => new AnswerClearingStoreError('ANSWER_CLEARING_DATA_INVALID', 503);
const LEARNING_FIELDS = ['task', 'scenario', 'scenarioRevisit', 'applicability', 'confidence', 'confidenceAt', 'cue', 'outcome', 'basis'];
function learning(value: unknown): LearningEvidence {
  if (typeof value !== 'string') throw invalid();
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalid();
  // JSON may contain future/SQL helper fields. Only the domain fields leave this boundary.
  return Object.freeze(Object.fromEntries(LEARNING_FIELDS.filter(key => Object.hasOwn(parsed, key))
    .map(key => [key, (parsed as Record<string, unknown>)[key]]))) as unknown as LearningEvidence;
}
export function decodeAnswerClearingObservation(row: Record<string, unknown>): PrivacyObservation {
  try {
    if (row.observed_exposure !== 0 && row.observed_exposure !== 1) throw invalid();
    const cleared = row.answer_cleared_at !== null;
    if (cleared ? row.answer !== null || row.request_payload !== null
      : typeof row.answer !== 'string' || typeof row.request_payload !== 'string') throw invalid();
    const marker = cleared ? parseAnswerClearingMarker({ observationEventId: row.event_id, clearedAt: row.answer_cleared_at }) : null;
    if (marker && marker.clearedAt !== row.answer_cleared_at) throw invalid();
    const value = {
      eventId: row.event_id, conceptId: row.concept_id, sourceRevision: row.source_revision,
      observedAt: row.observed_at, recordedAt: row.recorded_at, configRevision: row.config_revision,
      halfLifeDays: row.half_life_days, anchorEventId: row.anchor_event_id, elapsedDays: row.elapsed_days, decay: row.decay,
      answer: row.answer, rating: row.rating, exposure: row.exposure, observedExposure: row.observed_exposure === 1,
      ...(row.evidence_mode !== null ? { evidenceMode: row.evidence_mode } : {}),
      ...(row.learning_json !== null ? { learning: learning(row.learning_json) } : {}),
      ...(marker ? { answerClearing: marker } : {}),
    } as PrivacyObservation;
    // Validate every domain value, including the null/marker pair, before returning the selected fields.
    isAnswerCleared(value);
    return Object.freeze(value);
  } catch { throw invalid(); }
}

