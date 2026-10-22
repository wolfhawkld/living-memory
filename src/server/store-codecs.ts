import { isValidInstant } from '../core/time-model.js';
import { StoreError } from './store-error.js';
import type { Observation } from '../shared/types.js';
import type { PracticeAttemptRequest, PracticeCardEvent, PracticeScenarioCard, PracticeScenarioAttempt, PracticeSource } from '../shared/practice.js';
import type { CorrectionRequest, CorrectionEvent, CorrectionStatus } from '../shared/corrections.js';
import { parseRelationReviewBasis, type RelationReviewRequest, type RelationReviewEvent, type RelationReviewStatus } from '../shared/relation-reviews.js';

// Shared storage codecs preserve the existing v2 payload and optional-history semantics.

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

export function parseDate(value: string, code = 'INVALID_DATE'): number {
  if (!isValidInstant(value)) throw new StoreError(code, '时间格式无效，请使用带时区的 ISO 8601 时间。');
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new StoreError(code, '时间格式无效，请使用 ISO 8601 时间。');
  return parsed;
}

export function normalizeDate(value: string, code = 'INVALID_DATE'): string {
  return new Date(parseDate(value, code)).toISOString();
}

export function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Missing mode stays missing; an empty legacy answer is not mental evidence. */
export function normalizeObservationEvidenceMode(value: unknown, answer: unknown): Observation['evidenceMode'] {
  if (value === undefined) return undefined;
  if (value !== 'mental' && value !== 'written') {
    throw new StoreError('INVALID_EVIDENCE_MODE', 'evidenceMode 必须是 mental 或 written。');
  }
  if (value === 'mental' && answer !== '') {
    throw new StoreError('INVALID_EVIDENCE_MODE', 'mental 观察的 answer 必须是空字符串。');
  }
  return value;
}

export function parseStoredPracticeSources(value: string): PracticeSource[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new StoreError('PRACTICE_DATA_CORRUPT', '练习卡来源数据无效，请检查本地数据。', 500);
  }
  if (!Array.isArray(parsed)) throw new StoreError('PRACTICE_DATA_CORRUPT', '练习卡来源数据无效，请检查本地数据。', 500);
  return parsed.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new StoreError('PRACTICE_DATA_CORRUPT', '练习卡来源数据无效，请检查本地数据。', 500);
    }
    const record = item as Record<string, unknown>;
    if (typeof record.conceptId !== 'string' || !record.conceptId
        || typeof record.sourceRevision !== 'string' || !record.sourceRevision) {
      throw new StoreError('PRACTICE_DATA_CORRUPT', '练习卡来源数据无效，请检查本地数据。', 500);
    }
    return { conceptId: record.conceptId, sourceRevision: record.sourceRevision };
  });
}

export function parseStoredPracticeScenario<T extends PracticeScenarioCard | PracticeScenarioAttempt>(value: string | null): T | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parsed as T;
  } catch {
    // Scenario metadata is optional for old rows. Keep a damaged optional
    // blob from making the rest of a private practice history unreadable.
    return undefined;
  }
}

export function assertPracticeScenarioContract(
  card: PracticeCardEvent,
  attempt: PracticeAttemptRequest,
  recordedAt: string,
): void {
  if (card.kind !== 'scenario') {
    if (attempt.scenario !== undefined) {
      throw new StoreError('PRACTICE_SCENARIO_MISMATCH', '非 scenario 练习卡不能保存 scenario 分阶段回答。');
    }
    return;
  }
  if (!card.scenario) {
    throw new StoreError('PRACTICE_SCENARIO_INVALID', 'scenario 练习卡缺少场景卡片信息。', 500);
  }
  if (!attempt.scenario) {
    throw new StoreError('PRACTICE_SCENARIO_MISSING', 'scenario 练习卡必须保存 scenario 分阶段回答。');
  }
  const upperBound = parseDate(recordedAt, 'PRACTICE_SCENARIO_TIME');
  for (const stage of attempt.scenario.stages) {
    if (parseDate(stage.answeredAt, 'PRACTICE_SCENARIO_TIME') > upperBound
        || (stage.hintShownAt !== null && parseDate(stage.hintShownAt, 'PRACTICE_SCENARIO_TIME') > upperBound)) {
      throw new StoreError('PRACTICE_SCENARIO_TIME', '场景阶段时间不能晚于记录时间。');
    }
    if (stage.stage === 'structure' && !card.scenario.structureHint.trim()) {
      throw new StoreError('PRACTICE_SCENARIO_HINT_MISSING', '场景卡没有可供 structure 阶段显示的提示。');
    }
    if (stage.stage === 'name' && !card.scenario.nameHint.trim()) {
      throw new StoreError('PRACTICE_SCENARIO_HINT_MISSING', '场景卡没有可供 name 阶段显示的提示。');
    }
  }
}

export function practiceCardFromRow(row: {
  event_id: string;
  card_id: string;
  previous_event_id: string | null;
  occurred_at: string;
  recorded_at: string;
  kind: 'detail' | 'comparison' | 'scenario';
  title: string;
  prompt: string;
  reference_answer: string;
  reference_notes: string;
  sources_json: string;
  source_checked: number;
  scenario_json: string | null;
  paused: number;
}): PracticeCardEvent {
  const scenario = row.scenario_json
    ? parseStoredPracticeScenario<PracticeScenarioCard>(row.scenario_json)
    : undefined;
  return {
    eventId: row.event_id,
    cardId: row.card_id,
    previousEventId: row.previous_event_id,
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
    kind: row.kind,
    title: row.title,
    prompt: row.prompt,
    referenceAnswer: row.reference_answer,
    referenceNotes: row.reference_notes,
    sources: parseStoredPracticeSources(row.sources_json),
    sourceChecked: true,
    paused: row.paused === 1,
    ...(scenario ? { scenario } : {}),
  };
}

export function correctionRequestPayload(request: CorrectionRequest): string {
  return canonicalJson({
    eventId: request.eventId,
    applicationEventId: request.applicationEventId,
    conceptId: request.conceptId,
    sourceRevision: request.sourceRevision,
    occurredAt: request.occurredAt,
    previousEventId: request.previousEventId,
    status: request.status,
    note: request.note,
  });
}

export function correctionFromRow(row: {
  event_id: string;
  application_event_id: string;
  concept_id: string;
  source_revision: string;
  occurred_at: string;
  recorded_at: string;
  previous_event_id: string | null;
  status: CorrectionStatus;
  note: string;
}): CorrectionEvent {
  return {
    eventId: row.event_id,
    applicationEventId: row.application_event_id,
    conceptId: row.concept_id,
    sourceRevision: row.source_revision,
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
    previousEventId: row.previous_event_id,
    status: row.status,
    note: row.note,
  };
}

export function relationReviewRequestPayload(request: RelationReviewRequest): string {
  return canonicalJson({
    eventId: request.eventId,
    applicationEventId: request.applicationEventId,
    conceptId: request.conceptId,
    basis: request.basis,
    occurredAt: request.occurredAt,
    previousEventId: request.previousEventId,
    status: request.status,
    note: request.note,
  });
}

export function relationReviewFromRow(row: {
  event_id: string;
  application_event_id: string;
  concept_id: string;
  basis_json: string;
  occurred_at: string;
  recorded_at: string;
  previous_event_id: string | null;
  status: RelationReviewStatus;
  note: string;
}): RelationReviewEvent {
  return {
    eventId: row.event_id,
    applicationEventId: row.application_event_id,
    conceptId: row.concept_id,
    basis: parseRelationReviewBasis(JSON.parse(row.basis_json)),
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
    previousEventId: row.previous_event_id,
    status: row.status,
    note: row.note,
  };
}
