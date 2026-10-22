import { isValidInstant } from '../core/time-model.js';
import { StoreError } from './store-error.js';
import { MIN_DAILY_REVIEW_BUDGET, MAX_DAILY_REVIEW_BUDGET, type ConceptReviewPreference, type ReviewPlan } from '../shared/review-plan.js';
import type { LearningEvidence, Observation } from '../shared/types.js';
import type { PracticeAttempt, PracticeAttemptRequest, PracticeCardEvent, PracticeScenarioCard, PracticeScenarioAttempt, PracticeSource } from '../shared/practice.js';
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


export function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new StoreError('INVALID_BODY', '请求体必须是 JSON 对象。');
  return value as Record<string, unknown>;
}

export function isOneOf<T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === 'string' && values.includes(value);
}

export function normalizeLearningEvidence(value: unknown, observedAt?: string): LearningEvidence | undefined {
  if (value === undefined) return undefined;
  const record = asRecord(value);
  if (!isOneOf(LEARNING_TASKS, record.task)) {
    throw new StoreError('INVALID_LEARNING', 'learning.task 必须是 concept 或 scenario。');
  }
  if (!isOneOf(LEARNING_CUES, record.cue)) {
    throw new StoreError('INVALID_LEARNING', 'learning.cue 必须是 independent、hinted、lookup 或 unknown。');
  }
  if (!isOneOf(LEARNING_OUTCOMES, record.outcome)) {
    throw new StoreError('INVALID_LEARNING', 'learning.outcome 必须是 success、partial、failure 或 unverified。');
  }
  if (!isOneOf(LEARNING_BASES, record.basis)) {
    throw new StoreError('INVALID_LEARNING', 'learning.basis 必须是 self-check、application 或 unknown。');
  }

  const confidence = record.confidence;
  if (confidence !== null && (!finiteNumber(confidence) || !Number.isInteger(confidence) || confidence < 0 || confidence > 100)) {
    throw new StoreError('INVALID_LEARNING', 'learning.confidence 必须是 0 到 100 的整数或 null。');
  }
  const rawConfidenceAt = record.confidenceAt;
  if (confidence === null) {
    if (rawConfidenceAt !== null) throw new StoreError('INVALID_LEARNING', 'confidenceAt 必须在 confidence 有值时提供，否则必须为 null。');
  } else if (typeof rawConfidenceAt !== 'string' || !rawConfidenceAt.trim()) {
    throw new StoreError('INVALID_LEARNING', 'confidenceAt 必须在 confidence 有值时提供。');
  }

  const confidenceAt = rawConfidenceAt === null
    ? null
    : normalizeDate(rawConfidenceAt as string, 'INVALID_CONFIDENCE_AT');
  if (confidenceAt && observedAt && parseDate(confidenceAt) > parseDate(observedAt, 'INVALID_OBSERVED_AT')) {
    throw new StoreError('INVALID_LEARNING', 'confidenceAt 不能晚于 observedAt。');
  }

  let scenario: string | undefined;
  if (record.task === 'scenario') {
    if (typeof record.scenario !== 'string' || !record.scenario.trim() || record.scenario.trim().length > 4000) {
      throw new StoreError('INVALID_LEARNING', 'scenario 任务必须包含不超过 4000 个字符的场景描述。');
    }
    scenario = record.scenario.trim();
    if (record.scenarioRevisit !== undefined && record.scenarioRevisit !== true) {
      throw new StoreError('INVALID_LEARNING', 'scenarioRevisit 只能是 scenario 任务中的 true。');
    }
  } else if (record.scenario !== undefined) {
    throw new StoreError('INVALID_LEARNING', 'concept 任务不能携带 scenario。');
  } else if (record.scenarioRevisit !== undefined) {
    throw new StoreError('INVALID_LEARNING', 'scenarioRevisit 只能用于 scenario 任务，并且必须为 true。');
  }

  let applicability: string | undefined;
  if (record.applicability !== undefined) {
    if (typeof record.applicability !== 'string' || !record.applicability.trim() || record.applicability.trim().length > 4000) {
      throw new StoreError('INVALID_LEARNING', 'applicability 必须是不超过 4000 个字符的非空说明。');
    }
    applicability = record.applicability.trim();
  }

  if (record.outcome !== 'unverified' && record.basis === 'unknown') {
    throw new StoreError('INVALID_LEARNING', '已验证的 learning.outcome 必须提供非 unknown 的 basis。');
  }

  return {
    task: record.task,
    ...(scenario !== undefined ? { scenario } : {}),
    ...(record.scenarioRevisit === true ? { scenarioRevisit: true as const } : {}),
    ...(applicability !== undefined ? { applicability } : {}),
    confidence: confidence as number | null,
    confidenceAt,
    cue: record.cue,
    outcome: record.outcome,
    basis: record.basis,
  };
}

export function parseStoredLearning(value: string | null): LearningEvidence | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return normalizeLearningEvidence(parsed);
  } catch {
    // A corrupt optional evidence blob must not make the complete history
    // unreadable. The original observation remains available without it.
    return undefined;
  }
}

const LEARNING_TASKS = ['concept', 'scenario'] as const;

const LEARNING_CUES = ['independent', 'hinted', 'lookup', 'unknown'] as const;

const LEARNING_OUTCOMES = ['success', 'partial', 'failure', 'unverified'] as const;

const LEARNING_BASES = ['self-check', 'application', 'unknown'] as const;

export function practiceAttemptFromRow(row: {
  event_id: string;
  card_id: string;
  card_event_id: string;
  answered_at: string;
  recorded_at: string;
  answer: string;
  confidence: number | null;
  confidence_at: string | null;
  exposure: 'unexposed' | 'exposed' | 'unknown';
  observed_exposure: number;
  cue: 'independent' | 'hinted' | 'lookup' | 'unknown';
  outcome: 'success' | 'partial' | 'failure' | 'unverified';
  check_notes: string;
  scenario_json: string | null;
}): PracticeAttempt {
  const scenario = row.scenario_json
    ? parseStoredPracticeScenario<PracticeScenarioAttempt>(row.scenario_json)
    : undefined;
  return {
    eventId: row.event_id,
    cardId: row.card_id,
    cardEventId: row.card_event_id,
    answeredAt: row.answered_at,
    recordedAt: row.recorded_at,
    answer: row.answer,
    confidence: row.confidence,
    confidenceAt: row.confidence_at,
    exposure: row.exposure,
    observedExposure: row.observed_exposure === 1,
    cue: row.cue,
    outcome: row.outcome,
    checkNotes: row.check_notes,
    ...(scenario ? { scenario } : {}),
  };
}

export function parseReviewPlanRow(row: { revision: number; daily_budget: number; concepts_json: string }): ReviewPlan {
  if (!Number.isSafeInteger(row.revision) || row.revision < 0
      || !Number.isSafeInteger(row.daily_budget) || row.daily_budget < MIN_DAILY_REVIEW_BUDGET || row.daily_budget > MAX_DAILY_REVIEW_BUDGET) {
    throw new StoreError('REVIEW_PLAN_CORRUPT', '复习计划数据无效，请修复本地数据后重试。', 500);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(row.concepts_json); } catch {
    throw new StoreError('REVIEW_PLAN_CORRUPT', '复习计划数据无效，请修复本地数据后重试。', 500);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new StoreError('REVIEW_PLAN_CORRUPT', '复习计划数据无效，请修复本地数据后重试。', 500);
  }
  const concepts: Record<string, ConceptReviewPreference> = {};
  for (const [conceptId, raw] of Object.entries(parsed as Record<string, unknown>)) {
    if (!conceptId.trim() || !raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new StoreError('REVIEW_PLAN_CORRUPT', '复习计划数据无效，请修复本地数据后重试。', 500);
    }
    const preference = raw as Record<string, unknown>;
    if (typeof preference.focus !== 'boolean') {
      throw new StoreError('REVIEW_PLAN_CORRUPT', '复习计划数据无效，请修复本地数据后重试。', 500);
    }
    const deferUntil = preference.deferUntil;
    if (deferUntil !== null && (typeof deferUntil !== 'string' || !isValidInstant(deferUntil))) {
      throw new StoreError('REVIEW_PLAN_CORRUPT', '复习计划数据无效，请修复本地数据后重试。', 500);
    }
    Object.defineProperty(concepts, conceptId, {
      value: {
        focus: preference.focus,
        deferUntil: deferUntil === null ? null : new Date(parseDate(deferUntil)).toISOString(),
      },
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return { revision: row.revision, dailyBudget: row.daily_budget, concepts };
}
