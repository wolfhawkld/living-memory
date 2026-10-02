import { isValidInstant } from '../core/time-model.js';
import type {
  PracticeAttemptRequest,
  PracticeCardRequest,
  PracticeKind,
  PracticeSource,
} from '../shared/practice.js';
import type { Exposure } from '../shared/types.js';
import { StoreError } from './store.js';

const EVENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PRACTICE_KINDS = ['detail', 'comparison'] as const;
const EXPOSURES = ['unexposed', 'exposed', 'unknown'] as const;
const CUES = ['independent', 'hinted', 'lookup', 'unknown'] as const;
const OUTCOMES = ['success', 'partial', 'failure', 'unverified'] as const;

function recordOf(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new StoreError('INVALID_BODY', `${name} 必须是 JSON 对象。`);
  }
  return value as Record<string, unknown>;
}

function text(record: Record<string, unknown>, key: string, limit: number, required = false): string {
  const value = record[key];
  if (typeof value !== 'string') throw new StoreError('INVALID_BODY', `字段 ${key} 必须是字符串。`);
  if (value.length > limit) throw new StoreError('INVALID_BODY', `字段 ${key} 不能超过 ${limit} 个字符。`);
  if (required && !value.trim()) throw new StoreError('INVALID_BODY', `字段 ${key} 不能为空。`);
  return value;
}

function identifier(record: Record<string, unknown>, key: string, limit = 128): string {
  const value = record[key];
  if (typeof value !== 'string' || !value.trim() || value.trim().length > limit) {
    throw new StoreError('INVALID_BODY', `字段 ${key} 必须是长度不超过 ${limit} 的非空字符串。`);
  }
  const normalized = value.trim();
  if (!EVENT_ID_PATTERN.test(normalized)) {
    throw new StoreError('INVALID_EVENT_ID', `${key} 格式无效。`);
  }
  return normalized;
}

function version(record: Record<string, unknown>): string {
  const value = record.sourceRevision;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 512) {
    throw new StoreError('INVALID_BODY', 'sourceRevision 必须是长度不超过 512 的非空字符串。');
  }
  return value.trim();
}

function instant(record: Record<string, unknown>, key: string, code: string): string {
  const value = record[key];
  if (typeof value !== 'string' || !isValidInstant(value)) {
    throw new StoreError(code, `${key} 必须是带时区的 ISO 8601 时间。`);
  }
  return new Date(Date.parse(value)).toISOString();
}

function nullableInstant(record: Record<string, unknown>, key: string, code: string): string | null {
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== 'string' || !isValidInstant(value)) {
    throw new StoreError(code, `${key} 必须是 null 或带时区的 ISO 8601 时间。`);
  }
  return new Date(Date.parse(value)).toISOString();
}

function sources(record: Record<string, unknown>, kind: PracticeKind): PracticeSource[] {
  if (!Array.isArray(record.sources)) throw new StoreError('INVALID_BODY', 'sources 必须是数组。');
  const values = record.sources.map((value, index) => {
    const item = recordOf(value, `sources[${index}]`);
    const conceptId = item.conceptId;
    if (typeof conceptId !== 'string' || !conceptId.trim() || conceptId.trim().length > 512) {
      throw new StoreError('INVALID_BODY', `sources[${index}].conceptId 必须是长度不超过 512 的非空字符串。`);
    }
    const sourceRevision = item.sourceRevision;
    if (typeof sourceRevision !== 'string' || !sourceRevision.trim() || sourceRevision.trim().length > 512) {
      throw new StoreError('INVALID_BODY', `sources[${index}].sourceRevision 必须是长度不超过 512 的非空字符串。`);
    }
    return { conceptId: conceptId.trim(), sourceRevision: sourceRevision.trim() };
  });
  const required = kind === 'detail' ? values.length === 1 : values.length >= 2 && values.length <= 4;
  if (!required) {
    throw new StoreError('INVALID_BODY', kind === 'detail'
      ? 'detail 练习必须恰好引用一个来源概念。'
      : 'comparison 练习必须引用 2 到 4 个来源概念。');
  }
  const keys = values.map((value) => value.conceptId);
  if (new Set(keys).size !== keys.length) throw new StoreError('INVALID_BODY', 'sources 必须引用不同概念，不能用同一概念的多个版本充当比较对象。');
  return values.sort((left, right) => left.conceptId.localeCompare(right.conceptId) || left.sourceRevision.localeCompare(right.sourceRevision));
}

function oneOf<T extends readonly string[]>(values: T, value: unknown, key: string): value is T[number] {
  if (typeof value !== 'string' || !values.includes(value)) {
    throw new StoreError('INVALID_BODY', `字段 ${key} 的值无效。`);
  }
  return true;
}

/** Parse, validate, and canonicalize a manually authored practice card request. */
export function parsePracticeCardRequest(value: unknown): PracticeCardRequest {
  const record = recordOf(value, 'practice card');
  const eventId = identifier(record, 'eventId');
  const cardId = identifier(record, 'cardId');
  const previousRaw = record.previousEventId;
  let previousEventId: string | null;
  if (previousRaw === null) previousEventId = null;
  else {
    if (typeof previousRaw !== 'string' || !previousRaw.trim()) {
      throw new StoreError('INVALID_BODY', 'previousEventId 必须是事件 ID 或 null。');
    }
    previousEventId = previousRaw.trim();
    if (!EVENT_ID_PATTERN.test(previousEventId)) throw new StoreError('INVALID_EVENT_ID', 'previousEventId 格式无效。');
  }
  const kind = record.kind;
  oneOf(PRACTICE_KINDS, kind, 'kind');
  const practiceKind = kind as PracticeKind;
  if (record.sourceChecked !== true) throw new StoreError('INVALID_BODY', 'sourceChecked 必须是字面量 true。');
  if (typeof record.paused !== 'boolean') throw new StoreError('INVALID_BODY', 'paused 必须是布尔值。');
  return {
    eventId,
    cardId,
    previousEventId,
    occurredAt: instant(record, 'occurredAt', 'INVALID_OCCURRED_AT'),
    kind: practiceKind,
    title: text(record, 'title', 160, true),
    prompt: text(record, 'prompt', 4000, true),
    referenceAnswer: text(record, 'referenceAnswer', 12000, true),
    referenceNotes: text(record, 'referenceNotes', 4000),
    sources: sources(record, practiceKind),
    sourceChecked: true,
    paused: record.paused,
  };
}

/** Parse, validate, and canonicalize an answer to a specific card revision. */
export function parsePracticeAttemptRequest(value: unknown): PracticeAttemptRequest {
  const record = recordOf(value, 'practice attempt');
  const eventId = identifier(record, 'eventId');
  const cardId = identifier(record, 'cardId');
  const cardEventId = identifier(record, 'cardEventId');
  const answeredAt = instant(record, 'answeredAt', 'INVALID_ANSWERED_AT');
  const confidence = record.confidence;
  if (confidence !== null && (typeof confidence !== 'number' || !Number.isInteger(confidence) || confidence < 0 || confidence > 100)) {
    throw new StoreError('INVALID_BODY', 'confidence 必须是 0 到 100 的整数或 null。');
  }
  const confidenceAt = record.confidenceAt === null
    ? null
    : nullableInstant(record, 'confidenceAt', 'INVALID_CONFIDENCE_AT');
  if (confidence === null && confidenceAt !== null) {
    throw new StoreError('INVALID_BODY', 'confidenceAt 必须在 confidence 有值时提供，否则必须为 null。');
  }
  if (confidence !== null && confidenceAt === null) {
    throw new StoreError('INVALID_BODY', 'confidenceAt 必须在 confidence 有值时提供。');
  }
  if (confidenceAt && Date.parse(confidenceAt) > Date.parse(answeredAt)) {
    throw new StoreError('INVALID_BODY', 'confidenceAt 不能晚于 answeredAt。');
  }
  const exposure = record.exposure;
  oneOf(EXPOSURES, exposure, 'exposure');
  const observedExposure = record.observedExposure;
  if (typeof observedExposure !== 'boolean') throw new StoreError('INVALID_BODY', 'observedExposure 必须是布尔值。');
  // A checked exposure is evidence that the source was shown. Preserve the
  // existing Observation rule by canonicalizing any attempted downgrade.
  const normalizedExposure: Exposure = observedExposure ? 'exposed' : exposure as Exposure;
  const cue = record.cue;
  oneOf(CUES, cue, 'cue');
  const outcome = record.outcome;
  oneOf(OUTCOMES, outcome, 'outcome');
  return {
    eventId,
    cardId,
    cardEventId,
    answeredAt,
    answer: text(record, 'answer', 12000),
    confidence: confidence as number | null,
    confidenceAt,
    exposure: normalizedExposure,
    observedExposure,
    cue: cue as PracticeAttemptRequest['cue'],
    outcome: outcome as PracticeAttemptRequest['outcome'],
    checkNotes: text(record, 'checkNotes', 4000),
  };
}
