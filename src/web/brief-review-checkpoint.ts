import type {
  Exposure,
  LearningEvidence,
  ObservationRequest,
  RecallRating,
  ReviewRequest,
} from '../shared/types.js';
import type { BriefReviewItem, BriefReviewSession } from './brief-review-session.js';
import { isValidInstant } from '../core/time-model.js';

export type BriefRecallAttempt = {
  conceptId: string;
  eventId: string | null;
  answer: string;
  startedAt: string;
  observedAt: string | null;
  configRevision: number | null;
  anchorEventId: string | null;
  sourceRevision: string;
  sourceViewedBefore: boolean;
  stage: 'prediction' | 'answer' | 'feedback';
  rating: RecallRating | null;
  exposure: Exposure;
  learning: LearningEvidence;
  submittedPayload?: ObservationRequest;
};

export interface BriefReviewCheckpoint {
  version: 1;
  savedAt: string;
  session: BriefReviewSession;
  attempt: BriefRecallAttempt | null;
  reviewRequest?: ReviewRequest;
}

export interface BriefReviewCheckpointStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const CHECKPOINT_VERSION = 1 as const;
const STORAGE_PREFIX = 'living-memory.brief-review-checkpoint.v1:';
const MAX_SOURCE_ID_LENGTH = 1000;
const MAX_SESSION_ID_LENGTH = 256;
const MAX_CONCEPT_ID_LENGTH = 512;
const MAX_REVISION_LENGTH = 512;
const MAX_DOMAIN_ID_LENGTH = 1000;
const MAX_TITLE_LENGTH = 4000;
const MAX_EVENT_ID_LENGTH = 128;
const MAX_TEXT_LENGTH = 12000;
const MAX_LEARNING_TEXT_LENGTH = 4000;

const REVIEW_RESULTS = ['saved', 'queued', 'skipped', 'unavailable'] as const;
const REVIEW_OUTCOMES = ['success', 'partial', 'failure', 'unverified'] as const;
const REVIEW_CUES = ['independent', 'hinted', 'lookup', 'unknown'] as const;
const REVIEW_BASES = ['self-check', 'application', 'unknown'] as const;
const REVIEW_RATINGS = ['clear', 'partial', 'blank'] as const;
const REVIEW_EXPOSURES = ['unexposed', 'exposed', 'unknown'] as const;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(record: UnknownRecord, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(record).every((key) => allowed.has(key));
}

function hasOwn(record: UnknownRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function safeString(value: unknown, maxLength: number, required = true): string | null {
  if (typeof value !== 'string') return null;
  if (value.length > maxLength || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)) return null;
  if (required && !value.trim()) return null;
  return value;
}

function nullableString(value: unknown, maxLength: number): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  return safeString(value, maxLength) ?? undefined;
}

function instant(value: unknown): string | null {
  return typeof value === 'string' && isValidInstant(value) ? value : null;
}

function oneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && values.includes(value as T);
}

function eventId(value: unknown): string | null {
  const result = safeString(value, MAX_EVENT_ID_LENGTH);
  return result && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(result) ? result : null;
}

function validateLearning(value: unknown, observedAt: string | null, required: boolean, strict = true): LearningEvidence | undefined {
  if (value === undefined && !required) return undefined;
  if (!isRecord(value) || !hasOnlyKeys(value, ['task', 'scenario', 'applicability', 'confidence', 'confidenceAt', 'cue', 'outcome', 'basis'])) return undefined;
  if (!oneOf(value.task, ['concept', 'scenario'] as const)
    || !oneOf(value.cue, REVIEW_CUES)
    || !oneOf(value.outcome, REVIEW_OUTCOMES)
    || !oneOf(value.basis, REVIEW_BASES)) return undefined;

  const confidence = value.confidence;
  if (confidence !== null && (typeof confidence !== 'number' || !Number.isInteger(confidence) || confidence < 0 || confidence > 100)) return undefined;
  if (!hasOwn(value, 'confidenceAt')) return undefined;
  const confidenceAt = value.confidenceAt === null ? null : instant(value.confidenceAt);
  if (value.confidenceAt !== null && confidenceAt === null) return undefined;
  if (confidence === null && confidenceAt !== null) return undefined;
  if (strict && confidence !== null && confidenceAt === null) return undefined;
  if (confidenceAt && observedAt && Date.parse(confidenceAt) > Date.parse(observedAt)) return undefined;

  let scenario: string | undefined;
  if (value.task === 'scenario') {
    const scenarioValue = safeString(value.scenario, MAX_LEARNING_TEXT_LENGTH);
    if (!scenarioValue) return undefined;
    scenario = scenarioValue;
  } else if (hasOwn(value, 'scenario')) {
    return undefined;
  }

  let applicability: string | undefined;
  if (hasOwn(value, 'applicability')) {
    const applicabilityValue = safeString(value.applicability, MAX_LEARNING_TEXT_LENGTH);
    if (!applicabilityValue) return undefined;
    applicability = applicabilityValue;
  }
  if (strict && value.outcome !== 'unverified' && value.basis === 'unknown') return undefined;

  return {
    task: value.task,
    ...(scenario === undefined ? {} : { scenario }),
    ...(applicability === undefined ? {} : { applicability }),
    confidence: confidence as number | null,
    confidenceAt,
    cue: value.cue,
    outcome: value.outcome,
    basis: value.basis,
  };
}

function validateObservationPayload(value: unknown): ObservationRequest | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['eventId', 'conceptId', 'sourceRevision', 'observedAt', 'configRevision', 'anchorEventId', 'answer', 'rating', 'exposure', 'observedExposure', 'learning'])) return null;
  const payloadEventId = eventId(value.eventId);
  const conceptId = safeString(value.conceptId, MAX_CONCEPT_ID_LENGTH);
  const sourceRevision = safeString(value.sourceRevision, MAX_REVISION_LENGTH);
  const observedAt = instant(value.observedAt);
  const anchorEventId = nullableString(value.anchorEventId, MAX_EVENT_ID_LENGTH);
  const answer = safeString(value.answer, MAX_TEXT_LENGTH, false);
  const learning = validateLearning(value.learning, observedAt, false);
  const configRevision = typeof value.configRevision === 'number' && Number.isInteger(value.configRevision) && value.configRevision >= 1
    ? value.configRevision : null;
  const rating = oneOf(value.rating, REVIEW_RATINGS) ? value.rating : null;
  const exposure = oneOf(value.exposure, REVIEW_EXPOSURES) ? value.exposure : null;
  const observedExposure = typeof value.observedExposure === 'boolean' ? value.observedExposure : null;
  if (!payloadEventId || !conceptId || !sourceRevision || !observedAt || anchorEventId === undefined || answer === null
    || configRevision === null || rating === null || exposure === null || observedExposure === null
    || (hasOwn(value, 'learning') && value.learning !== undefined && learning === undefined)) return null;
  return {
    eventId: payloadEventId,
    conceptId,
    sourceRevision,
    observedAt,
    configRevision,
    anchorEventId,
    answer,
    rating,
    exposure,
    observedExposure,
    ...(learning === undefined ? {} : { learning }),
  };
}

function equalLearning(left: LearningEvidence, right: LearningEvidence | undefined): boolean {
  return right !== undefined && JSON.stringify(left) === JSON.stringify(right);
}

function validateAttempt(value: unknown, currentItem: BriefReviewItem | undefined, completed: boolean): BriefRecallAttempt | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['conceptId', 'eventId', 'answer', 'startedAt', 'observedAt', 'configRevision', 'anchorEventId', 'sourceRevision', 'sourceViewedBefore', 'stage', 'rating', 'exposure', 'learning', 'submittedPayload'])) return null;
  const conceptId = safeString(value.conceptId, MAX_CONCEPT_ID_LENGTH);
  const attemptEventId = value.eventId === null ? null : eventId(value.eventId);
  const answer = safeString(value.answer, MAX_TEXT_LENGTH, false);
  const startedAt = instant(value.startedAt);
  const observedAt = value.observedAt === null ? null : instant(value.observedAt);
  const configRevision = value.configRevision === null
    ? null
    : typeof value.configRevision === 'number' && Number.isInteger(value.configRevision) && value.configRevision >= 1
      ? value.configRevision : undefined;
  const anchorEventId = nullableString(value.anchorEventId, MAX_EVENT_ID_LENGTH);
  const learning = validateLearning(value.learning, observedAt, true, false);
  const submittedPayload = value.submittedPayload === undefined ? undefined : validateObservationPayload(value.submittedPayload);
  const stage = oneOf(value.stage, ['prediction', 'answer', 'feedback'] as const) ? value.stage : null;
  const rating = value.rating === null ? null : oneOf(value.rating, REVIEW_RATINGS) ? value.rating : undefined;
  const exposure = oneOf(value.exposure, REVIEW_EXPOSURES) ? value.exposure : null;
  const sourceViewedBefore = typeof value.sourceViewedBefore === 'boolean' ? value.sourceViewedBefore : null;
  if (!conceptId || answer === null || !startedAt || observedAt === undefined || configRevision === undefined || anchorEventId === undefined
    || !learning || stage === null || rating === undefined || exposure === null || sourceViewedBefore === null
    || (value.eventId !== null && !attemptEventId)
    || (value.observedAt !== null && !observedAt)
    || (value.anchorEventId !== null && anchorEventId === null)
    || (hasOwn(value, 'submittedPayload') && value.submittedPayload !== undefined && !submittedPayload)) return null;
  if (!currentItem || conceptId !== currentItem.conceptId || value.sourceRevision !== currentItem.sourceRevision) return null;
  const sourceRevision = safeString(value.sourceRevision, MAX_REVISION_LENGTH);
  if (!sourceRevision || completed) return null;
  if (submittedPayload === null) return null;
  if ((stage === 'prediction' || stage === 'answer')
    && (observedAt !== null || configRevision !== null || attemptEventId !== null || rating !== null || submittedPayload !== undefined)) return null;
  if (stage === 'prediction' && answer !== '') return null;
  if (stage === 'feedback' && (observedAt === null || configRevision === null)) return null;
  if (attemptEventId !== null && submittedPayload === undefined) return null;
  if (sourceViewedBefore && exposure !== 'exposed') return null;
  if (submittedPayload !== undefined) {
    if (stage !== 'feedback' || !attemptEventId || !observedAt || configRevision === null || rating === null
      || submittedPayload.eventId !== attemptEventId || submittedPayload.conceptId !== conceptId
      || submittedPayload.sourceRevision !== sourceRevision || submittedPayload.observedAt !== observedAt
      || submittedPayload.configRevision !== configRevision || submittedPayload.anchorEventId !== anchorEventId
      || submittedPayload.answer !== answer || submittedPayload.rating !== rating
      || submittedPayload.exposure !== exposure || submittedPayload.observedExposure !== sourceViewedBefore
      || !equalLearning(learning, submittedPayload.learning)) return null;
  }
  return {
    conceptId,
    eventId: attemptEventId,
    answer,
    startedAt,
    observedAt,
    configRevision,
    anchorEventId,
    sourceRevision,
    sourceViewedBefore,
    stage,
    rating,
    exposure,
    learning,
    ...(submittedPayload === undefined ? {} : { submittedPayload }),
  };
}

function validateItem(value: unknown): BriefReviewItem | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['conceptId', 'title', 'sourceRevision', 'status', 'elapsedDays', 'estimated', 'focus'])) return null;
  const conceptId = safeString(value.conceptId, MAX_CONCEPT_ID_LENGTH);
  const title = safeString(value.title, MAX_TITLE_LENGTH);
  const sourceRevision = safeString(value.sourceRevision, MAX_REVISION_LENGTH);
  if (!conceptId || !title || !sourceRevision || !oneOf(value.status, ['stale', 'revisit'] as const)
    || typeof value.elapsedDays !== 'number' || !Number.isFinite(value.elapsedDays) || value.elapsedDays < 0
    || typeof value.estimated !== 'boolean' || (hasOwn(value, 'focus') && typeof value.focus !== 'boolean')) return null;
  return {
    conceptId,
    title,
    sourceRevision,
    status: value.status,
    elapsedDays: value.elapsedDays,
    estimated: value.estimated,
    ...(hasOwn(value, 'focus') ? { focus: value.focus as boolean } : {}),
  };
}

function validateRecord<T extends string>(value: unknown, allowed: readonly T[], itemIds: ReadonlySet<string>): Record<string, T> | null {
  if (!isRecord(value)) return null;
  const result: Record<string, T> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!itemIds.has(key) || !oneOf(entry, allowed)) return null;
    result[key] = entry;
  }
  return result;
}

function validateSession(value: unknown, sourceId: string): BriefReviewSession | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['id', 'sourceId', 'domainId', 'items', 'index', 'results', 'reviews'])) return null;
  const id = safeString(value.id, MAX_SESSION_ID_LENGTH);
  const sessionSourceId = safeString(value.sourceId, MAX_SOURCE_ID_LENGTH);
  const domainId = safeString(value.domainId, MAX_DOMAIN_ID_LENGTH);
  const index = typeof value.index === 'number' && Number.isInteger(value.index) ? value.index : null;
  if (!id || sessionSourceId !== sourceId || !domainId || !Array.isArray(value.items) || value.items.length === 0 || value.items.length > 5
    || index === null || index < 0 || index >= value.items.length) return null;
  const items: BriefReviewItem[] = [];
  const itemIds = new Set<string>();
  for (const rawItem of value.items) {
    const item = validateItem(rawItem);
    if (!item || itemIds.has(item.conceptId)) return null;
    itemIds.add(item.conceptId);
    items.push(item);
  }
  const results = validateRecord(value.results, REVIEW_RESULTS, itemIds);
  const reviews = validateRecord(value.reviews, ['saved', 'queued'] as const, itemIds);
  if (!results || !reviews) return null;
  for (const [conceptId, review] of Object.entries(reviews)) {
    if (results[conceptId] !== 'saved' || (review !== 'saved' && review !== 'queued')) return null;
  }
  return { id, sourceId: sessionSourceId, domainId, items, index, results, reviews };
}

function validateReviewRequest(value: unknown, currentItem: BriefReviewItem): ReviewRequest | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['eventId', 'conceptId', 'sourceRevision', 'kind', 'occurredAt'])) return null;
  const event = eventId(value.eventId);
  const conceptId = safeString(value.conceptId, MAX_CONCEPT_ID_LENGTH);
  const sourceRevision = safeString(value.sourceRevision, MAX_REVISION_LENGTH);
  const occurredAt = instant(value.occurredAt);
  if (!event || !conceptId || !sourceRevision || !occurredAt || value.kind !== 'review'
    || conceptId !== currentItem.conceptId || sourceRevision !== currentItem.sourceRevision) return null;
  return { eventId: event, conceptId, sourceRevision, kind: 'review', occurredAt };
}

function validateCheckpoint(sourceId: string, value: unknown): BriefReviewCheckpoint | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['version', 'savedAt', 'session', 'attempt', 'reviewRequest']) || value.version !== CHECKPOINT_VERSION) return null;
  const savedAt = instant(value.savedAt);
  if (!savedAt) return null;
  const session = validateSession(value.session, sourceId);
  if (!session) return null;
  const currentItem = session.items[session.index];
  const currentResult = session.results[currentItem.conceptId];
  const reviewRequest = value.reviewRequest === undefined ? undefined : validateReviewRequest(value.reviewRequest, currentItem);
  if (value.reviewRequest !== undefined && !reviewRequest) return null;
  if (reviewRequest && (currentResult !== 'saved' || value.attempt !== null)) return null;
  if (value.attempt !== null && value.attempt !== undefined) {
    const attempt = validateAttempt(value.attempt, currentItem, currentResult !== undefined);
    if (!attempt) return null;
    return { version: CHECKPOINT_VERSION, savedAt, session, attempt, ...(reviewRequest ? { reviewRequest } : {}) };
  }
  if (value.attempt !== null) return null;
  return { version: CHECKPOINT_VERSION, savedAt, session, attempt: null, ...(reviewRequest ? { reviewRequest } : {}) };
}

function storageFor(storage?: BriefReviewCheckpointStorage): BriefReviewCheckpointStorage {
  if (storage) return storage;
  if (typeof window === 'undefined' || !window.localStorage) throw new Error('浏览器本地存储不可用。');
  return window.localStorage;
}

export function briefReviewCheckpointKey(sourceId: string): string {
  const normalized = safeString(sourceId, MAX_SOURCE_ID_LENGTH);
  if (!normalized) throw new Error('缺少有效知识源，无法访问复习断点。');
  return `${STORAGE_PREFIX}${encodeURIComponent(normalized)}`;
}

/** Backwards-compatible descriptive alias for callers that prefer the storage name. */
export const briefReviewCheckpointStorageKey = briefReviewCheckpointKey;

/** Serialize a source-bound checkpoint into a versioned storage envelope. */
export function serializeBriefReviewCheckpoint(sourceId: string, checkpoint: BriefReviewCheckpoint): string {
  const normalizedSourceId = safeString(sourceId, MAX_SOURCE_ID_LENGTH);
  if (!normalizedSourceId) throw new Error('缺少有效知识源，无法保存复习断点。');
  const validated = validateCheckpoint(normalizedSourceId, checkpoint);
  if (!validated) throw new Error('复习断点格式无效，未保存。');
  return JSON.stringify({ sourceId: normalizedSourceId, ...validated });
}

/** Return null for absent, damaged, tampered, or cross-source checkpoint data. */
export function parseBriefReviewCheckpoint(raw: string | null, sourceId: string): BriefReviewCheckpoint | null {
  const normalizedSourceId = safeString(sourceId, MAX_SOURCE_ID_LENGTH);
  if (!normalizedSourceId || typeof raw !== 'string' || raw.length === 0 || raw.length > 1_000_000) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value.sourceId !== normalizedSourceId) return null;
    const { sourceId: _sourceId, ...checkpoint } = value;
    return validateCheckpoint(normalizedSourceId, checkpoint);
  } catch {
    return null;
  }
}

export function readBriefReviewCheckpoint(sourceId: string, storage?: BriefReviewCheckpointStorage): BriefReviewCheckpoint | null {
  const target = storageFor(storage);
  const raw = target.getItem(briefReviewCheckpointKey(sourceId));
  const parsed = parseBriefReviewCheckpoint(raw, sourceId);
  if (raw !== null && parsed === null) throw new Error('复习断点存储已损坏或与当前知识空间不匹配，原数据已保留。');
  return parsed;
}

export function writeBriefReviewCheckpoint(sourceId: string, checkpoint: BriefReviewCheckpoint, storage?: BriefReviewCheckpointStorage): void {
  const target = storageFor(storage);
  target.setItem(briefReviewCheckpointKey(sourceId), serializeBriefReviewCheckpoint(sourceId, checkpoint));
}

export function clearBriefReviewCheckpoint(sourceId: string, storage?: BriefReviewCheckpointStorage): void {
  storageFor(storage).removeItem(briefReviewCheckpointKey(sourceId));
}
