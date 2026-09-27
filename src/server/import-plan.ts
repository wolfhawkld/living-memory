import { createHash } from 'node:crypto';
import type {
  AnchorEvent,
  ApplicationRecord,
  Concept,
  ExportData,
  LearningEvidence,
  Layout,
  ModelConfig,
  Observation,
  RetentionEvent,
  ReviewRequest,
} from '../shared/types.js';
import {
  DEFAULT_DAILY_REVIEW_BUDGET,
  type ConceptReviewPreference,
  type ReviewPlan,
} from '../shared/review-plan.js';
import {
  DEFAULT_IMPORT_OPTIONS,
  MAX_IMPORT_BYTES,
  type ImportConceptMatch,
  type ImportCounts,
  type ImportIssue,
  type ImportOptions,
  type ImportPreview,
} from '../shared/import-data.js';
import { DAY_MS, MODEL_VERSION } from '../shared/types.js';
import { decayAt, isValidInstant } from '../core/time-model.js';
import {
  parseApplicationRequest,
  parseLearningEvidence,
  parseObservationRequest,
  parseRetentionRequest,
  StoreError,
} from './store.js';

/** Input accepted by the pure import planner. */
export interface ImportPlanInput {
  data: unknown;
  options: ImportOptions;
  current: ExportData;
  concepts: Concept[];
  sourceId: string;
  now: string;
  /** Server-registered path history for confirmed stable concept IDs. */
  acceptedPaths?: Record<string, string[]>;
}

/** A config row ready for a store import transaction. */
export type PreparedConfig = ModelConfig & { recordedAt: string };

/** The validated, mapped records consumed by the eventual store commit step. */
export interface PreparedImport {
  preview: ImportPreview;
  normalized: ExportData;
  newAnchors: AnchorEvent[];
  newObservations: Observation[];
  newRetentions: RetentionEvent[];
  newApplications: ApplicationRecord[];
  newConfigs: PreparedConfig[];
  mergedLayout: Layout;
  mergedReviewPlan: ReviewPlan;
  metadataConcepts: ExportData['concepts'];
  anchorRequests: Record<string, ReviewRequest>;
}

const EVENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_HALF_LIFE_DAYS = 3650;
const MAX_CONCEPTS = 10_000;
const MAX_EVENTS = 50_000;
const MAX_LAYOUT = 10_000;
const MAX_ISSUE_OUTPUT = 100;
const EVENT_KINDS = ['anchors', 'observations', 'retentions', 'applications'] as const;
const RECALL_RATINGS = ['clear', 'partial', 'blank'] as const;
const EXPOSURES = ['unexposed', 'exposed', 'unknown'] as const;

type EventKind = (typeof EVENT_KINDS)[number];
type Event = AnchorEvent | Observation | RetentionEvent | ApplicationRecord;

interface IssueState {
  all: ImportIssue[];
  errors: number;
}

interface ConceptMapping {
  byId: Map<string, string | null>;
  matches: ImportConceptMatch[];
  metadata: ExportData['concepts'];
  unresolved: Set<string>;
}

interface EventIdentity {
  kind: EventKind;
  event: Event;
}

interface ConfigMerge {
  incoming: ModelConfig[];
  newConfigs: PreparedConfig[];
  merged: ModelConfig[];
  current: ModelConfig;
  recordedAt: Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function invalid(message: string, code = 'INVALID_IMPORT'): never {
  throw new StoreError(code, message, 400);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) invalid(`${label} 必须是 JSON 对象。`);
  return value;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) invalid(`${label} 必须是数组。`);
  return value;
}

function optionalArray(record: Record<string, unknown>, key: string): unknown[] {
  const value = record[key];
  if (value === undefined) return [];
  return requireArray(value, key);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) invalid(`${label} 必须是非空字符串。`);
  return value.trim();
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') invalid(`${label} 必须是布尔值。`);
  return value;
}

function finite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid(`${label} 必须是有限数字。`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  const number = finite(value, label);
  if (!Number.isSafeInteger(number) || number < 1) invalid(`${label} 必须是正整数。`);
  return number;
}

function optionalNullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return requireString(value, label);
}

function timestamp(value: unknown, label: string): { raw: string; ms: number } {
  const raw = requireString(value, label);
  if (!isValidInstant(raw)) invalid(`${label} 必须是带时区的 ISO 8601 时间。`, 'INVALID_IMPORT_DATE');
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) invalid(`${label} 不是有效时间。`, 'INVALID_IMPORT_DATE');
  return { raw, ms };
}

function compareTime(a: string, b: string): number {
  return Date.parse(a) - Date.parse(b);
}

function clone<T>(value: T): T {
  // Import payloads are JSON values. This also makes the no-mutation contract
  // explicit at the boundary instead of relying on callers to clone first.
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    invalid('导入数据必须可序列化为 JSON。');
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonical(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(canonical(value), 'utf8').digest('hex');
}

function jsonByteLength(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) invalid('导入数据必须是 JSON 值。');
    return Buffer.byteLength(serialized, 'utf8');
  } catch {
    invalid('导入数据必须是 JSON 值。');
  }
}

function addIssue(
  state: IssueState,
  code: string,
  message: string,
  options: { severity?: 'error' | 'warning'; eventId?: string; conceptId?: string } = {},
): void {
  const severity = options.severity ?? 'error';
  if (severity === 'error') state.errors += 1;
  const issue: ImportIssue = { severity, code, message };
  if (options.eventId !== undefined) issue.eventId = options.eventId;
  if (options.conceptId !== undefined) issue.conceptId = options.conceptId;
  state.all.push(issue);
}

function shownIssues(state: IssueState): ImportIssue[] {
  return [...state.all]
    .sort((left, right) => (left.severity === right.severity ? 0 : left.severity === 'error' ? -1 : 1))
    .slice(0, MAX_ISSUE_OUTPUT);
}

function validateOptions(value: ImportOptions): ImportOptions {
  const record = requireRecord(value, 'options');
  return {
    restoreLayout: requireBoolean(record.restoreLayout, 'options.restoreLayout'),
    restoreReviewPlan: requireBoolean(record.restoreReviewPlan, 'options.restoreReviewPlan'),
  };
}

function validateExportEnvelope(data: unknown, now: string): Record<string, unknown> {
  const record = requireRecord(data, '导入数据');
  if (record.schemaVersion !== 1) invalid('仅支持 schemaVersion 1 的导出文件。', 'UNSUPPORTED_SCHEMA');
  const exported = timestamp(record.exportedAt, 'exportedAt');
  const currentNow = timestamp(now, 'now');
  if (exported.ms > currentNow.ms) invalid('exportedAt 不能晚于当前时间。', 'FUTURE_EXPORT');
  const source = requireRecord(record.source, 'source');
  if (typeof source.name !== 'string' || typeof source.mode !== 'string') invalid('source 元数据无效。');
  if (source.mode !== 'demo' && source.mode !== 'local') invalid('source.mode 无效。');
  requireArray(record.concepts, 'concepts');
  requireRecord(record.config, 'config');
  requireArray(record.configHistory, 'configHistory');
  requireArray(record.anchors, 'anchors');
  requireArray(record.observations, 'observations');
  if (record.retentions !== undefined) requireArray(record.retentions, 'retentions');
  if (record.applications !== undefined) requireArray(record.applications, 'applications');
  requireRecord(record.layout, 'layout');
  if (record.reviewPlan !== undefined) requireRecord(record.reviewPlan, 'reviewPlan');
  if (record.restoreMetadata !== undefined) requireRecord(record.restoreMetadata, 'restoreMetadata');
  return record;
}

function validateConceptMetadata(record: Record<string, unknown>, index: number): ExportData['concepts'][number] {
  const id = requireString(record.id, `concepts[${index}].id`);
  const title = typeof record.title === 'string' ? record.title : invalid(`concepts[${index}].title 无效。`);
  const source = requireRecord(record.source, `concepts[${index}].source`);
  const path = requireString(source.path, `concepts[${index}].source.path`);
  const revision = requireString(source.revision, `concepts[${index}].source.revision`);
  return { id, title, source: { path, revision } };
}

function validateConcepts(raw: unknown[]): ExportData['concepts'] {
  if (raw.length > MAX_CONCEPTS) invalid(`concepts 不能超过 ${MAX_CONCEPTS} 个。`, 'IMPORT_LIMIT');
  const seen = new Set<string>();
  return raw.map((value, index) => {
    const concept = validateConceptMetadata(requireRecord(value, `concepts[${index}]`), index);
    if (seen.has(concept.id)) invalid(`concepts 中存在重复 ID：${concept.id}。`, 'DUPLICATE_CONCEPT_ID');
    seen.add(concept.id);
    return concept;
  });
}

function liveIdentityKey(path: string, revision: string): string {
  return `${path}\u0000${revision}`;
}

function buildConceptMapping(
  backupConcepts: ExportData['concepts'],
  liveConcepts: Concept[],
  references: Set<string>,
  acceptedPaths: Record<string, string[]> | undefined,
  state: IssueState,
): ConceptMapping {
  const byId = new Map<string, string | null>();
  const matches: ImportConceptMatch[] = [];
  const metadata: ExportData['concepts'] = [];
  const unresolved = new Set<string>();
  const liveById = new Map<string, Concept>();
  const liveByPath = new Map<string, Concept[]>();
  for (const concept of liveConcepts) {
    if (liveById.has(concept.id)) invalid(`当前知识源存在重复概念 ID：${concept.id}。`, 'LIVE_CONCEPT_DUPLICATE');
    liveById.set(concept.id, concept);
    const key = liveIdentityKey(concept.source.path, concept.source.revision);
    liveByPath.set(key, [...(liveByPath.get(key) ?? []), concept]);
  }

  const mappedTargets = new Map<string, string>();
  for (const backup of backupConcepts) {
    const liveByIdItem = liveById.get(backup.id);
    if (liveByIdItem) {
      if (liveByIdItem.source.path !== backup.source.path) {
        const registeredPaths = acceptedPaths && Object.prototype.hasOwnProperty.call(acceptedPaths, backup.id)
          ? acceptedPaths[backup.id]
          : undefined;
        const pathWasAccepted = Array.isArray(registeredPaths)
          && registeredPaths.includes(backup.source.path)
          && registeredPaths.includes(liveByIdItem.source.path);
        if (!pathWasAccepted) {
          byId.set(backup.id, null);
          unresolved.add(backup.id);
          addIssue(state, 'CONCEPT_ID_PATH_MISMATCH', `概念 ID ${backup.id} 的来源路径与当前知识源不同，已阻止自动映射。`, { severity: 'error', conceptId: backup.id });
          matches.push({ fromId: backup.id, toId: null, title: backup.title, path: backup.source.path, backupRevision: backup.source.revision, currentRevision: liveByIdItem.source.revision, match: 'unresolved' });
          metadata.push(backup);
          continue;
        }
        addIssue(state, 'CONCEPT_ID_PATH_ACCEPTED', `概念 ID ${backup.id} 的历史路径 ${backup.source.path} 与当前路径 ${liveByIdItem.source.path} 均已由服务端登记确认，按稳定 ID 保留映射。`, { severity: 'warning', conceptId: backup.id });
      }
      byId.set(backup.id, liveByIdItem.id);
      matches.push({ fromId: backup.id, toId: liveByIdItem.id, title: backup.title, path: backup.source.path, backupRevision: backup.source.revision, currentRevision: liveByIdItem.source.revision, match: 'id' });
      if (backup.source.revision !== liveByIdItem.source.revision) {
        addIssue(state, 'OLD_SOURCE_REVISION', `概念 ${backup.id} 的事件包含旧来源版本，将保留为历史记录。`, { severity: 'warning', conceptId: backup.id });
      }
      metadata.push({ ...backup, id: liveByIdItem.id });
    } else {
      const candidates = liveByPath.get(liveIdentityKey(backup.source.path, backup.source.revision)) ?? [];
      if (candidates.length === 1) {
        const target = candidates[0];
        byId.set(backup.id, target.id);
        if (mappedTargets.has(target.id) && mappedTargets.get(target.id) !== backup.id) {
          addIssue(state, 'CONCEPT_MAPPING_COLLISION', `多个备份概念映射到了当前概念 ${target.id}。`, { severity: 'error', conceptId: target.id });
        }
        mappedTargets.set(target.id, backup.id);
        matches.push({ fromId: backup.id, toId: target.id, title: backup.title, path: backup.source.path, backupRevision: backup.source.revision, currentRevision: target.source.revision, match: 'path-revision' });
        metadata.push({ ...backup, id: target.id });
      } else {
        byId.set(backup.id, null);
        unresolved.add(backup.id);
        addIssue(state, 'UNRESOLVED_CONCEPT', `概念 ${backup.id} 无法按 ID、路径和版本唯一映射，将保留孤立历史。`, { severity: 'warning', conceptId: backup.id });
        matches.push({ fromId: backup.id, toId: null, title: backup.title, path: backup.source.path, backupRevision: backup.source.revision, currentRevision: null, match: 'unresolved' });
        metadata.push(backup);
      }
    }
  }

  // Events created by older builds may survive without a manifest entry. Keep
  // their original ID and expose the reference in the preview rather than
  // guessing from titles or paths.
  for (const id of references) {
    if (byId.has(id)) continue;
    const exactLive = liveById.get(id);
    if (exactLive) {
      // An old export can lack a concepts manifest, but an exact live ID is a
      // safe identity match. Mark it as an explicit ID match so the preview
      // never says "unresolved" while silently attaching it to a live node.
      byId.set(id, exactLive.id);
      addIssue(state, 'ORPHAN_CONCEPT_REFERENCE', `事件或布局引用了缺少 manifest 的当前概念 ${id}，按精确 ID 接回。`, { severity: 'warning', conceptId: id });
      matches.push({ fromId: id, toId: exactLive.id, title: '', path: exactLive.source.path, backupRevision: null, currentRevision: exactLive.source.revision, match: 'id' });
      metadata.push({ id: exactLive.id, title: '', source: { path: exactLive.source.path, revision: exactLive.source.revision } });
      continue;
    }
    byId.set(id, null);
    unresolved.add(id);
    addIssue(state, 'ORPHAN_CONCEPT_REFERENCE', `事件引用了未出现在 concepts manifest 中的概念 ${id}，将保留孤立历史。`, { severity: 'warning', conceptId: id });
    matches.push({ fromId: id, toId: null, title: '', path: '', backupRevision: null, currentRevision: null, match: 'unresolved' });
  }

  // Detect collisions from ID matches as well as path-based matches.
  const targetOwners = new Map<string, string>();
  for (const [from, to] of byId) {
    const target = to ?? from;
    const owner = targetOwners.get(target);
    if (owner && owner !== from) {
      addIssue(state, 'CONCEPT_MAPPING_COLLISION', `备份概念 ${owner} 与 ${from} 映射到了同一概念 ${target}。`, { severity: 'error', conceptId: target });
    } else {
      targetOwners.set(target, from);
    }
  }

  return { byId, matches, metadata, unresolved };
}

function mappedId(mapping: ConceptMapping, id: string): string {
  const target = mapping.byId.get(id);
  return target ?? id;
}

function mappedConceptEvent<T extends { conceptId: string }>(event: T, mapping: ConceptMapping): T {
  return { ...event, conceptId: mappedId(mapping, event.conceptId) };
}

function validateEventId(value: unknown, label: string): string {
  const id = requireString(value, label);
  if (!EVENT_ID_PATTERN.test(id)) invalid(`${label} 格式无效。`, 'INVALID_EVENT_ID');
  return id;
}

function eventCount(records: Record<EventKind, unknown[]>): number {
  return EVENT_KINDS.reduce((sum, kind) => sum + records[kind].length, 0);
}

function validateTimeBounds(
  occurred: { raw: string; ms: number },
  recorded: { raw: string; ms: number },
  nowMs: number,
  eventId: string,
  conceptId: string,
  state: IssueState,
  occurredLabel: string,
): void {
  if (occurred.ms > nowMs || recorded.ms > nowMs) addIssue(state, 'FUTURE_EVENT_DATE', `${eventId} 含有晚于当前时间的事件日期。`, { eventId, conceptId });
  if (recorded.ms < occurred.ms) addIssue(state, 'RECORDED_BEFORE_EVENT', `${eventId} 的 recordedAt 早于事件发生时间。`, { eventId, conceptId });
  if (!occurredLabel) return;
}

function validateAnchor(
  value: unknown,
  index: number,
  nowMs: number,
  state: IssueState,
): AnchorEvent {
  const record = requireRecord(value, `anchors[${index}]`);
  const eventId = validateEventId(record.eventId, `anchors[${index}].eventId`);
  const conceptId = requireString(record.conceptId, `anchors[${index}].conceptId`);
  const sourceRevision = requireString(record.sourceRevision, `anchors[${index}].sourceRevision`);
  const occurredAt = timestamp(record.occurredAt, `anchors[${index}].occurredAt`);
  const recordedAt = timestamp(record.recordedAt, `anchors[${index}].recordedAt`);
  if (record.kind !== 'review' && record.kind !== 'estimated') invalid(`anchors[${index}].kind 无效。`);
  validateTimeBounds(occurredAt, recordedAt, nowMs, eventId, conceptId, state, 'occurredAt');
  return { eventId, conceptId, sourceRevision, occurredAt: occurredAt.raw, recordedAt: recordedAt.raw, kind: record.kind };
}

function validateObservation(
  value: unknown,
  index: number,
  nowMs: number,
  state: IssueState,
): Observation {
  const record = requireRecord(value, `observations[${index}]`);
  const eventId = validateEventId(record.eventId, `observations[${index}].eventId`);
  const conceptId = requireString(record.conceptId, `observations[${index}].conceptId`);
  const sourceRevision = requireString(record.sourceRevision, `observations[${index}].sourceRevision`);
  const observedAt = timestamp(record.observedAt, `observations[${index}].observedAt`);
  const recordedAt = timestamp(record.recordedAt, `observations[${index}].recordedAt`);
  validateTimeBounds(observedAt, recordedAt, nowMs, eventId, conceptId, state, 'observedAt');
  const configRevision = positiveInteger(record.configRevision, `observations[${index}].configRevision`);
  const halfLifeDays = finite(record.halfLifeDays, `observations[${index}].halfLifeDays`);
  if (halfLifeDays <= 0 || halfLifeDays > MAX_HALF_LIFE_DAYS) invalid(`observations[${index}].halfLifeDays 超出范围。`);
  const anchorEventId = record.anchorEventId === null ? null : validateEventId(record.anchorEventId, `observations[${index}].anchorEventId`);
  const elapsedDays = record.elapsedDays === null ? null : finite(record.elapsedDays, `observations[${index}].elapsedDays`);
  const decay = record.decay === null ? null : finite(record.decay, `observations[${index}].decay`);
  if (elapsedDays !== null && elapsedDays < 0) invalid(`observations[${index}].elapsedDays 不能为负数。`);
  if (decay !== null && (decay < 0 || decay > 1)) invalid(`observations[${index}].decay 必须在 0 到 1 之间。`);
  if (anchorEventId === null && (elapsedDays !== null || decay !== null)) {
    invalid(`observations[${index}] 无 anchorEventId 时 elapsedDays 与 decay 必须为 null。`, 'FROZEN_DECAY_MISMATCH');
  }
  if (typeof record.answer !== 'string') invalid(`observations[${index}].answer 必须是字符串。`);
  if (!RECALL_RATINGS.includes(record.rating as (typeof RECALL_RATINGS)[number])) invalid(`observations[${index}].rating 无效。`);
  if (!EXPOSURES.includes(record.exposure as (typeof EXPOSURES)[number])) invalid(`observations[${index}].exposure 无效。`);
  const observedExposure = requireBoolean(record.observedExposure, `observations[${index}].observedExposure`);
  if (observedExposure && record.exposure !== 'exposed') invalid(`observations[${index}] observedExposure=true 时 exposure 必须为 exposed。`, 'EXPOSURE_MISMATCH');
  const learning = record.learning === undefined ? undefined : parseLearningEvidence(record.learning, observedAt.raw);
  if (learning?.confidenceAt) {
    const confidenceAt = timestamp(learning.confidenceAt, `observations[${index}].learning.confidenceAt`);
    if (confidenceAt.ms > nowMs) addIssue(state, 'FUTURE_CONFIDENCE_DATE', `${eventId} 的 confidenceAt 晚于当前时间。`, { eventId, conceptId });
  }
  return {
    eventId,
    conceptId,
    sourceRevision,
    observedAt: observedAt.raw,
    recordedAt: recordedAt.raw,
    configRevision,
    halfLifeDays,
    anchorEventId,
    elapsedDays,
    decay,
    answer: record.answer,
    rating: record.rating as Observation['rating'],
    exposure: record.exposure as Observation['exposure'],
    observedExposure,
    ...(learning ? { learning } : {}),
  };
}

function validateRetention(
  value: unknown,
  index: number,
  nowMs: number,
  state: IssueState,
): RetentionEvent {
  const record = requireRecord(value, `retentions[${index}]`);
  const eventId = validateEventId(record.eventId, `retentions[${index}].eventId`);
  const conceptId = requireString(record.conceptId, `retentions[${index}].conceptId`);
  const sourceRevision = requireString(record.sourceRevision, `retentions[${index}].sourceRevision`);
  const occurredAt = timestamp(record.occurredAt, `retentions[${index}].occurredAt`);
  const recordedAt = timestamp(record.recordedAt, `retentions[${index}].recordedAt`);
  validateTimeBounds(occurredAt, recordedAt, nowMs, eventId, conceptId, state, 'occurredAt');
  const active = requireBoolean(record.active, `retentions[${index}].active`);
  const previousEventId = record.previousEventId === null ? null : validateEventId(record.previousEventId, `retentions[${index}].previousEventId`);
  return { eventId, conceptId, sourceRevision, occurredAt: occurredAt.raw, recordedAt: recordedAt.raw, active, previousEventId };
}

function validateApplication(
  value: unknown,
  index: number,
  nowMs: number,
  state: IssueState,
): ApplicationRecord {
  const record = requireRecord(value, `applications[${index}]`);
  const eventId = validateEventId(record.eventId, `applications[${index}].eventId`);
  const conceptId = requireString(record.conceptId, `applications[${index}].conceptId`);
  const sourceRevision = requireString(record.sourceRevision, `applications[${index}].sourceRevision`);
  const occurredAt = timestamp(record.occurredAt, `applications[${index}].occurredAt`);
  const recordedAt = timestamp(record.recordedAt, `applications[${index}].recordedAt`);
  validateTimeBounds(occurredAt, recordedAt, nowMs, eventId, conceptId, state, 'occurredAt');
  const parsed = parseApplicationRequest(record);
  return { ...parsed, eventId, conceptId, sourceRevision, occurredAt: occurredAt.raw, recordedAt: recordedAt.raw };
}

function parseEventArrays(
  record: Record<string, unknown>,
  nowMs: number,
  state: IssueState,
): { anchors: AnchorEvent[]; observations: Observation[]; retentions: RetentionEvent[]; applications: ApplicationRecord[] } {
  const raw = {
    anchors: optionalArray(record, 'anchors'),
    observations: optionalArray(record, 'observations'),
    retentions: optionalArray(record, 'retentions'),
    applications: optionalArray(record, 'applications'),
  };
  if (eventCount(raw) > MAX_EVENTS) invalid(`事件总数不能超过 ${MAX_EVENTS}。`, 'IMPORT_LIMIT');
  return {
    anchors: raw.anchors.map((value, index) => validateAnchor(value, index, nowMs, state)),
    observations: raw.observations.map((value, index) => validateObservation(value, index, nowMs, state)),
    retentions: raw.retentions.map((value, index) => validateRetention(value, index, nowMs, state)),
    applications: raw.applications.map((value, index) => validateApplication(value, index, nowMs, state)),
  };
}

function collectReferences(events: Record<EventKind, unknown[]>, record: Record<string, unknown>): Set<string> {
  const references = new Set<string>();
  for (const kind of EVENT_KINDS) {
    for (const raw of events[kind]) {
      if (isRecord(raw) && typeof raw.conceptId === 'string' && raw.conceptId.trim()) references.add(raw.conceptId.trim());
    }
  }
  const observations = events.observations;
  for (const raw of observations) {
    if (isRecord(raw) && typeof raw.anchorEventId === 'string' && raw.anchorEventId.trim()) {
      // Anchor event IDs are not concept references; intentionally ignored.
    }
  }
  if (isRecord(record.layout)) {
    for (const id of Object.keys(record.layout)) references.add(id);
  }
  if (isRecord(record.reviewPlan) && isRecord(record.reviewPlan.concepts)) {
    for (const id of Object.keys(record.reviewPlan.concepts)) references.add(id);
  }
  return references;
}

function eventPayload(kind: EventKind, event: Event): unknown {
  const { recordedAt: _recordedAt, ...withoutRecordedAt } = event as Event & { recordedAt: string };
  // Keep frozen elapsed/decay/config values in observation identity. A replay
  // must never turn a historical observation into a newly recomputed one.
  return { kind, ...withoutRecordedAt };
}

function eventKey(kind: EventKind, event: Event): string {
  return `${kind}:${event.eventId}`;
}

function collectCurrentEvents(current: ExportData): Map<string, EventIdentity> {
  const map = new Map<string, EventIdentity>();
  for (const [kind, events] of [
    ['anchors', current.anchors],
    ['observations', current.observations],
    ['retentions', current.retentions ?? []],
    ['applications', current.applications ?? []],
  ] as const) {
    for (const event of events) map.set(eventKey(kind, event), { kind, event });
  }
  return map;
}

function compareEventIdentity(left: Event, right: Event, kind: EventKind): boolean {
  return canonical(eventPayload(kind, left)) === canonical(eventPayload(kind, right));
}

function classifyEventConflicts(
  incoming: { anchors: AnchorEvent[]; observations: Observation[]; retentions: RetentionEvent[]; applications: ApplicationRecord[] },
  current: ExportData,
  mapping: ConceptMapping,
  state: IssueState,
): { newAnchors: AnchorEvent[]; newObservations: Observation[]; newRetentions: RetentionEvent[]; newApplications: ApplicationRecord[]; duplicates: number } {
  const currentEvents = collectCurrentEvents(current);
  const seen = new Map<string, EventIdentity>();
  const seenByEventId = new Map<string, EventIdentity>();
  const result = { newAnchors: [] as AnchorEvent[], newObservations: [] as Observation[], newRetentions: [] as RetentionEvent[], newApplications: [] as ApplicationRecord[], duplicates: 0 };
  for (const [kind, events] of [
    ['anchors', incoming.anchors],
    ['observations', incoming.observations],
    ['retentions', incoming.retentions],
    ['applications', incoming.applications],
  ] as const) {
    for (const original of events) {
      const event = mappedConceptEvent(original, mapping) as Event;
      const identity = { kind, event } as EventIdentity;
      const key = eventKey(kind, event);
      if (seenByEventId.has(event.eventId)) {
        addIssue(state, 'DUPLICATE_EVENT_ID', `导入文件内 eventId ${event.eventId} 重复。`, { eventId: event.eventId, conceptId: event.conceptId });
        continue;
      }
      seen.set(key, identity);
      seenByEventId.set(event.eventId, identity);
      const currentSameId = [...currentEvents.values()].filter((item) => item.event.eventId === event.eventId);
      if (currentSameId.length) {
        if (currentSameId.length !== 1 || currentSameId[0].kind !== kind || !compareEventIdentity(currentSameId[0].event, event, kind)) {
          addIssue(state, 'EVENT_CONFLICT', `eventId ${event.eventId} 与当前记录的类型或内容冲突。`, { eventId: event.eventId, conceptId: event.conceptId });
        } else {
          result.duplicates += 1;
        }
        continue;
      }
      if (kind === 'anchors') result.newAnchors.push(event as AnchorEvent);
      else if (kind === 'observations') result.newObservations.push(event as Observation);
      else if (kind === 'retentions') result.newRetentions.push(event as RetentionEvent);
      else result.newApplications.push(event as ApplicationRecord);
    }
  }
  return result;
}

function parseConfig(value: unknown, label: string): ModelConfig {
  const record = requireRecord(value, label);
  const modelVersion = requireString(record.modelVersion, `${label}.modelVersion`);
  if (modelVersion !== MODEL_VERSION) invalid(`${label}.modelVersion 不受支持。`, 'MODEL_VERSION_MISMATCH');
  const revision = positiveInteger(record.revision, `${label}.revision`);
  const halfLifeDays = finite(record.halfLifeDays, `${label}.halfLifeDays`);
  if (halfLifeDays <= 0 || halfLifeDays > MAX_HALF_LIFE_DAYS) invalid(`${label}.halfLifeDays 超出范围。`);
  return { modelVersion: MODEL_VERSION, halfLifeDays, revision };
}

function mergeConfigs(
  record: Record<string, unknown>,
  current: ExportData,
  exportedAt: string,
  state: IssueState,
): ConfigMerge {
  const historyRaw = requireArray(record.configHistory, 'configHistory');
  const incoming = historyRaw.map((value, index) => parseConfig(value, `configHistory[${index}]`));
  if (!incoming.length) invalid('configHistory 不能为空。', 'INVALID_CONFIG_HISTORY');
  for (let index = 0; index < incoming.length; index += 1) {
    if (incoming[index].revision !== index + 1) invalid('configHistory revision 必须从 1 连续递增。', 'INVALID_CONFIG_HISTORY');
  }
  const incomingCurrent = parseConfig(record.config, 'config');
  const incomingLast = incoming[incoming.length - 1];
  if (incomingCurrent.revision !== incomingLast.revision || incomingCurrent.halfLifeDays !== incomingLast.halfLifeDays) {
    invalid('config 必须等于 configHistory 的最后一条。', 'CONFIG_CURRENT_MISMATCH');
  }
  const currentHistory = (current.configHistory ?? []).map((value, index) => parseConfig(value, `current.configHistory[${index}]`));
  const currentConfig = parseConfig(current.config, 'current.config');
  const all = new Map<number, ModelConfig>();
  for (const config of currentHistory) all.set(config.revision, config);
  for (const config of incoming) {
    const existing = all.get(config.revision);
    if (existing && existing.halfLifeDays !== config.halfLifeDays) {
      addIssue(state, 'CONFIG_REVISION_CONFLICT', `配置 revision ${config.revision} 的 halfLifeDays 与当前记录冲突。`);
    } else {
      all.set(config.revision, config);
    }
  }
  const ordered = [...all.values()].sort((a, b) => a.revision - b.revision);
  for (let index = 0; index < ordered.length; index += 1) {
    if (ordered[index].revision !== index + 1) addIssue(state, 'CONFIG_HISTORY_GAP', '合并后的配置 revision 不连续。');
  }
  const configRecordedAtRaw = isRecord((record.restoreMetadata as Record<string, unknown> | undefined)?.configRecordedAt)
    ? (record.restoreMetadata as Record<string, unknown>).configRecordedAt as Record<string, unknown>
    : {};
  const configRecordedAt: Record<string, string> = {};
  for (const [revision, raw] of Object.entries(configRecordedAtRaw)) {
    if (!/^\d+$/.test(revision) || !Number.isSafeInteger(Number(revision)) || Number(revision) < 1) {
      invalid(`restoreMetadata.configRecordedAt 的 revision ${revision} 无效。`, 'INVALID_CONFIG_DATE');
    }
    const value = timestamp(raw, `restoreMetadata.configRecordedAt.${revision}`);
    if (value.ms > Date.parse(exportedAt)) addIssue(state, 'CONFIG_DATE_AFTER_EXPORT', `配置 revision ${revision} 的记录时间晚于 exportedAt。`);
    configRecordedAt[revision] = value.raw;
  }
  const recordedAtFor = (revision: number): string => {
    return configRecordedAt[String(revision)] ?? exportedAt;
  };
  const newConfigs = incoming
    .filter((config) => !currentHistory.some((existing) => existing.revision === config.revision))
    .map((config) => ({ ...config, recordedAt: recordedAtFor(config.revision) }));
  const last = ordered.at(-1) ?? currentConfig;
  for (const revision of Object.keys(configRecordedAt)) {
    if (!incoming.some((config) => String(config.revision) === revision)) {
      addIssue(state, 'CONFIG_DATE_UNKNOWN_REVISION', `configRecordedAt 引用了不存在的配置 revision ${revision}。`);
    }
  }
  const normalizedRecordedAt: Record<string, string> = {};
  for (const config of incoming) normalizedRecordedAt[String(config.revision)] = recordedAtFor(config.revision);
  return { incoming, newConfigs, merged: ordered, current: last, recordedAt: normalizedRecordedAt };
}

function validateFrozenObservations(
  observations: Observation[],
  anchors: AnchorEvent[],
  current: ExportData,
  configs: ModelConfig[],
  mapping: ConceptMapping,
  state: IssueState,
): void {
  const anchorById = new Map<string, AnchorEvent>();
  for (const anchor of [...(current.anchors ?? []), ...anchors.map((event) => mappedConceptEvent(event, mapping))]) {
    if (!anchorById.has(anchor.eventId)) anchorById.set(anchor.eventId, anchor);
  }
  const configByRevision = new Map(configs.map((config) => [config.revision, config]));
  for (const original of observations) {
    const observation = mappedConceptEvent(original, mapping);
    const config = configByRevision.get(observation.configRevision);
    if (!config) {
      addIssue(state, 'CONFIG_REVISION_UNKNOWN', `观察 ${observation.eventId} 引用了不存在的配置 revision ${observation.configRevision}。`, { eventId: observation.eventId, conceptId: observation.conceptId });
      continue;
    }
    if (Math.abs(config.halfLifeDays - observation.halfLifeDays) > 1e-10) {
      addIssue(state, 'FROZEN_HALF_LIFE_MISMATCH', `观察 ${observation.eventId} 的冻结 halfLifeDays 与配置 revision 不一致。`, { eventId: observation.eventId, conceptId: observation.conceptId });
    }
    if (observation.anchorEventId === null) continue;
    const anchor = anchorById.get(observation.anchorEventId);
    if (!anchor) {
      addIssue(state, 'ANCHOR_NOT_FOUND', `观察 ${observation.eventId} 引用了不存在的 anchor ${observation.anchorEventId}。`, { eventId: observation.eventId, conceptId: observation.conceptId });
      continue;
    }
    if (anchor.conceptId !== observation.conceptId || anchor.sourceRevision !== observation.sourceRevision) {
      addIssue(state, 'ANCHOR_VERSION_MISMATCH', `观察 ${observation.eventId} 引用的 anchor 与概念版本不匹配。`, { eventId: observation.eventId, conceptId: observation.conceptId });
      continue;
    }
    if (compareTime(anchor.occurredAt, observation.observedAt) > 0) {
      addIssue(state, 'ANCHOR_AFTER_OBSERVATION', `观察 ${observation.eventId} 的 observedAt 早于其 anchor。`, { eventId: observation.eventId, conceptId: observation.conceptId });
      continue;
    }
    const elapsed = (Date.parse(observation.observedAt) - Date.parse(anchor.occurredAt)) / DAY_MS;
    const expectedDecay = decayAt(elapsed, config.halfLifeDays);
    if (observation.elapsedDays === null || observation.decay === null
        || Math.abs(observation.elapsedDays - elapsed) > 1e-10
        || Math.abs(observation.decay - expectedDecay) > 1e-10) {
      addIssue(state, 'FROZEN_DECAY_MISMATCH', `观察 ${observation.eventId} 的冻结 elapsedDays/decay 与 anchor/config 不一致。`, { eventId: observation.eventId, conceptId: observation.conceptId });
    }
  }
}

function validateRetentionChain(
  incoming: RetentionEvent[],
  current: ExportData,
  mapping: ConceptMapping,
  state: IssueState,
): RetentionEvent[] {
  const mappedIncoming = incoming.map((event) => mappedConceptEvent(event, mapping));
  const currentEvents = (current.retentions ?? []).map((event) => ({ ...event }));
  const all = new Map<string, RetentionEvent>();
  for (const event of currentEvents) all.set(event.eventId, event);
  for (const event of mappedIncoming) {
    const existing = all.get(event.eventId);
    if (!existing) all.set(event.eventId, event);
  }
  const children = new Map<string, RetentionEvent>();
  const roots = new Map<string, RetentionEvent>();
  for (const event of all.values()) {
    if (event.previousEventId === null) {
      const root = roots.get(event.conceptId);
      if (root && root.eventId !== event.eventId) {
        addIssue(state, 'RETENTION_BRANCH', `概念 ${event.conceptId} 的长期保持链出现多个起点。`, { eventId: event.eventId, conceptId: event.conceptId });
      } else {
        roots.set(event.conceptId, event);
      }
      continue;
    }
    const previous = all.get(event.previousEventId);
    if (!previous) {
      addIssue(state, 'RETENTION_PREVIOUS_NOT_FOUND', `长期保持事件 ${event.eventId} 引用的 previousEventId 不存在。`, { eventId: event.eventId, conceptId: event.conceptId });
      continue;
    }
    if (previous.conceptId !== event.conceptId) {
      addIssue(state, 'RETENTION_CONCEPT_MISMATCH', `长期保持事件 ${event.eventId} 的 previousEventId 属于另一个概念。`, { eventId: event.eventId, conceptId: event.conceptId });
    }
    const child = children.get(event.previousEventId);
    if (child && child.eventId !== event.eventId) {
      addIssue(state, 'RETENTION_BRANCH', `长期保持事件 ${event.previousEventId} 出现分叉。`, { eventId: event.eventId, conceptId: event.conceptId });
    } else {
      children.set(event.previousEventId, event);
    }
  }
  const newSet = new Set(mappedIncoming.map((event) => event.eventId));
  const ordered: RetentionEvent[] = [];
  const visited = new Set<string>();
  for (const start of mappedIncoming) {
    const path: RetentionEvent[] = [];
    const pathIds = new Set<string>();
    let cursor: RetentionEvent | undefined = start;
    while (cursor && !visited.has(cursor.eventId)) {
      if (pathIds.has(cursor.eventId)) {
        addIssue(state, 'RETENTION_CYCLE', `长期保持事件 ${start.eventId} 的 previousEventId 形成环。`, { eventId: start.eventId, conceptId: start.conceptId });
        break;
      }
      pathIds.add(cursor.eventId);
      path.push(cursor);
      cursor = cursor.previousEventId ? all.get(cursor.previousEventId) : undefined;
    }
    for (let index = path.length - 1; index >= 0; index -= 1) {
      const event = path[index];
      visited.add(event.eventId);
      if (newSet.has(event.eventId)) ordered.push(event);
    }
  }
  return ordered;
}

function validateLayout(value: unknown, label: string): Layout {
  const record = requireRecord(value, label);
  const entries = Object.entries(record);
  if (entries.length > MAX_LAYOUT) invalid(`${label} 不能超过 ${MAX_LAYOUT} 个条目。`, 'IMPORT_LIMIT');
  const result = Object.create(null) as Layout;
  for (const [id, raw] of entries) {
    const position = requireRecord(raw, `${label}.${id}`);
    Object.defineProperty(result, id, {
      value: {
      x: finite(position.x, `${label}.${id}.x`),
      y: finite(position.y, `${label}.${id}.y`),
      z: finite(position.z, `${label}.${id}.z`),
      },
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

function validateReviewPlan(value: unknown, label: string): ReviewPlan {
  const record = requireRecord(value, label);
  const revision = finite(record.revision, `${label}.revision`);
  if (!Number.isSafeInteger(revision) || revision < 0) invalid(`${label}.revision 无效。`);
  const dailyBudget = finite(record.dailyBudget, `${label}.dailyBudget`);
  if (!Number.isSafeInteger(dailyBudget) || dailyBudget < 1 || dailyBudget > 50) invalid(`${label}.dailyBudget 超出范围。`);
  const concepts = requireRecord(record.concepts, `${label}.concepts`);
  const result = Object.create(null) as Record<string, ConceptReviewPreference>;
  for (const [conceptId, raw] of Object.entries(concepts)) {
    const preference = requireRecord(raw, `${label}.concepts.${conceptId}`);
    const focus = requireBoolean(preference.focus, `${label}.concepts.${conceptId}.focus`);
    const deferUntil = preference.deferUntil === null ? null : requireString(preference.deferUntil, `${label}.concepts.${conceptId}.deferUntil`);
    if (deferUntil !== null) timestamp(deferUntil, `${label}.concepts.${conceptId}.deferUntil`);
    Object.defineProperty(result, conceptId, {
      value: { focus, deferUntil },
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return { revision, dailyBudget, concepts: result };
}

function mapLayout(layout: Layout, mapping: ConceptMapping): Layout {
  const result = Object.create(null) as Layout;
  for (const [id, position] of Object.entries(layout)) {
    Object.defineProperty(result, mappedId(mapping, id), {
      value: { ...position }, enumerable: true, configurable: true, writable: true,
    });
  }
  return result;
}

function mapReviewPlan(plan: ReviewPlan, mapping: ConceptMapping): ReviewPlan {
  const concepts = Object.create(null) as Record<string, ConceptReviewPreference>;
  for (const [id, preference] of Object.entries(plan.concepts)) {
    Object.defineProperty(concepts, mappedId(mapping, id), {
      value: { ...preference }, enumerable: true, configurable: true, writable: true,
    });
  }
  return { ...plan, concepts };
}

function sameValue(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}

function mergeLayout(current: Layout, incoming: Layout, mapping: ConceptMapping, restore: boolean): { value: Layout; changed: boolean } {
  if (!restore) return { value: clone(current), changed: false };
  const value = { ...clone(current), ...mapLayout(incoming, mapping) };
  return { value, changed: !sameValue(value, current) };
}

function mergeReviewPlan(current: ReviewPlan, incoming: ReviewPlan, mapping: ConceptMapping, restore: boolean): { value: ReviewPlan; changed: boolean } {
  if (!restore) return { value: clone(current), changed: false };
  const mapped = mapReviewPlan(incoming, mapping);
  const concepts = { ...clone(current.concepts), ...mapped.concepts };
  const draft = { dailyBudget: mapped.dailyBudget, concepts };
  const changed = current.dailyBudget !== draft.dailyBudget || !sameValue(current.concepts, draft.concepts);
  return {
    changed,
    value: {
      revision: changed ? current.revision + 1 : current.revision,
      dailyBudget: draft.dailyBudget,
      concepts,
    },
  };
}

function buildAnchorRequests(
  record: Record<string, unknown>,
  anchors: AnchorEvent[],
  mapping: ConceptMapping,
  exportedAt: string,
  targetSourceId: string,
  state: IssueState,
): Record<string, ReviewRequest> {
  const rawMetadata = record.restoreMetadata;
  const result: Record<string, ReviewRequest> = {};
  if (rawMetadata === undefined) {
    for (const anchor of anchors) {
      result[anchor.eventId] = {
        eventId: anchor.eventId,
        conceptId: mappedId(mapping, anchor.conceptId),
        sourceRevision: anchor.sourceRevision,
        kind: anchor.kind,
        occurredAt: anchor.occurredAt,
      };
    }
    return result;
  }
  const metadata = requireRecord(rawMetadata, 'restoreMetadata');
  if (metadata.sourceId !== undefined && typeof metadata.sourceId !== 'string') invalid('restoreMetadata.sourceId 无效。');
  if (typeof metadata.sourceId === 'string' && metadata.sourceId !== '' && metadata.sourceId !== targetSourceId) {
    // A backup can be moved between accounts. This is deliberately a warning;
    // sourceId is provenance and never chooses the target namespace.
    addIssue(state, 'BACKUP_SOURCE_ID', `备份来源 ${metadata.sourceId} 与当前目标 ${targetSourceId} 不同，仅作迁移提示。`, { severity: 'warning' });
  }
  const requests = requireArray(metadata.anchorRequests, 'restoreMetadata.anchorRequests');
  if (requests.length !== anchors.length) invalid('restoreMetadata.anchorRequests 必须与 anchors 一一对应。', 'ANCHOR_REQUEST_MISMATCH');
  const byId = new Map<string, ReviewRequest>();
  for (const [index, raw] of requests.entries()) {
    const request = requireRecord(raw, `restoreMetadata.anchorRequests[${index}]`);
    const eventId = validateEventId(request.eventId, `restoreMetadata.anchorRequests[${index}].eventId`);
    if (byId.has(eventId)) invalid(`restoreMetadata.anchorRequests 中 eventId ${eventId} 重复。`, 'ANCHOR_REQUEST_MISMATCH');
    const conceptId = requireString(request.conceptId, `restoreMetadata.anchorRequests[${index}].conceptId`);
    const sourceRevision = requireString(request.sourceRevision, `restoreMetadata.anchorRequests[${index}].sourceRevision`);
    if (request.kind !== 'review' && request.kind !== 'estimated') invalid(`restoreMetadata.anchorRequests[${index}].kind 无效。`);
    const anchor = anchors.find((item) => item.eventId === eventId);
    if (!anchor || anchor.conceptId !== conceptId || anchor.sourceRevision !== sourceRevision || anchor.kind !== request.kind) {
      invalid(`restoreMetadata.anchorRequests[${index}] 与对应 anchor 不一致。`, 'ANCHOR_REQUEST_MISMATCH');
    }
    const rawOccurredAt = request.occurredAt;
    if (rawOccurredAt !== undefined) {
      const occurredAt = timestamp(rawOccurredAt, `restoreMetadata.anchorRequests[${index}].occurredAt`);
      if (occurredAt.ms !== Date.parse(anchor.occurredAt)) invalid(`restoreMetadata.anchorRequests[${index}].occurredAt 与 anchor 不一致。`, 'ANCHOR_REQUEST_MISMATCH');
    } else if (request.kind === 'estimated') {
      invalid('estimated anchor request 必须包含 occurredAt。', 'ANCHOR_REQUEST_MISMATCH');
    }
    const normalized: ReviewRequest = {
      eventId,
      conceptId: mappedId(mapping, conceptId),
      sourceRevision,
      kind: request.kind,
      ...(rawOccurredAt !== undefined ? { occurredAt: rawOccurredAt as string } : {}),
    };
    byId.set(eventId, normalized);
  }
  for (const anchor of anchors) {
    const request = byId.get(anchor.eventId);
    if (!request) invalid(`anchor ${anchor.eventId} 缺少 restoreMetadata 请求。`, 'ANCHOR_REQUEST_MISMATCH');
    result[anchor.eventId] = request;
  }
  // Keep the normalized exported timestamp referenced so a future extension
  // can distinguish omitted review occurredAt without changing this contract.
  void exportedAt;
  return result;
}

function stripExportedAt(value: ExportData): unknown {
  const copy = clone(value) as Partial<ExportData>;
  delete copy.exportedAt;
  return copy;
}

function sortTokenCollections(value: ExportData): ExportData {
  const copy = clone(value);
  copy.concepts = [...copy.concepts].sort((a, b) => a.id.localeCompare(b.id));
  copy.configHistory = [...copy.configHistory].sort((a, b) => a.revision - b.revision);
  copy.anchors = [...copy.anchors].sort((a, b) => a.eventId.localeCompare(b.eventId));
  copy.observations = [...copy.observations].sort((a, b) => a.eventId.localeCompare(b.eventId));
  copy.retentions = [...(copy.retentions ?? [])].sort((a, b) => a.eventId.localeCompare(b.eventId));
  copy.applications = [...(copy.applications ?? [])].sort((a, b) => a.eventId.localeCompare(b.eventId));
  return copy;
}

function sortAcceptedPaths(value: Record<string, string[]> | undefined): Record<string, string[]> {
  const result: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  for (const key of Object.keys(value ?? {}).sort()) {
    const paths = value?.[key];
    result[key] = Array.isArray(paths) ? [...new Set(paths)].sort() : [];
  }
  return result;
}

/**
 * Validate an export and prepare a pure, deterministic restore plan. No store
 * or filesystem is touched; callers must inspect preview.canImport before a
 * separate commit transaction.
 */
export function buildImportPlan(input: ImportPlanInput): PreparedImport {
  const options = validateOptions(input.options ?? DEFAULT_IMPORT_OPTIONS);
  const now = timestamp(input.now, 'now');
  if (jsonByteLength(input.data) > MAX_IMPORT_BYTES) invalid(`导入文件不能超过 ${MAX_IMPORT_BYTES} 字节。`, 'IMPORT_LIMIT');
  const record = validateExportEnvelope(input.data, input.now);
  const exportedAt = timestamp(record.exportedAt, 'exportedAt');
  const backupConcepts = validateConcepts(requireArray(record.concepts, 'concepts'));
  const rawEvents: Record<EventKind, unknown[]> = {
    anchors: optionalArray(record, 'anchors'),
    observations: optionalArray(record, 'observations'),
    retentions: optionalArray(record, 'retentions'),
    applications: optionalArray(record, 'applications'),
  };
  const references = collectReferences(rawEvents, record);
  const state: IssueState = { all: [], errors: 0 };
  if (Array.isArray(record.identityBindings) && record.identityBindings.length > 0) {
    addIssue(state, 'IDENTITY_BINDINGS_UNTRUSTED', '备份中的 identityBindings 仅供确认时核对，不会授权路径映射或自动创建绑定；导入仍按当前知识空间的路径和版本关联。', { severity: 'warning' });
  }
  const mapping = buildConceptMapping(backupConcepts, input.concepts, references, input.acceptedPaths, state);
  const parsedEvents = parseEventArrays(record, now.ms, state);
  const configMerge = mergeConfigs(record, input.current, exportedAt.raw, state);
  const mappedAnchors = parsedEvents.anchors.map((event) => mappedConceptEvent(event, mapping));
  const mappedObservations = parsedEvents.observations.map((event) => mappedConceptEvent(event, mapping));
  const mappedRetentions = parsedEvents.retentions.map((event) => mappedConceptEvent(event, mapping));
  const mappedApplications = parsedEvents.applications.map((event) => mappedConceptEvent(event, mapping));

  for (const event of [...mappedAnchors, ...mappedObservations, ...mappedRetentions, ...mappedApplications]) {
    if (event.sourceRevision && event.conceptId && input.concepts.some((concept) => concept.id === event.conceptId && concept.source.revision !== event.sourceRevision)) {
      addIssue(state, 'OLD_SOURCE_REVISION', `事件 ${event.eventId} 使用了当前概念的旧来源版本，将保留为历史记录。`, { severity: 'warning', eventId: event.eventId, conceptId: event.conceptId });
    }
  }
  validateFrozenObservations(parsedEvents.observations, parsedEvents.anchors, input.current, [...configMerge.merged], mapping, state);
  const classified = classifyEventConflicts(parsedEvents, input.current, mapping, state);
  const orderedRetentions = validateRetentionChain(parsedEvents.retentions, input.current, mapping, state);
  const currentLayout = validateLayout(input.current.layout, 'current.layout');
  const incomingLayout = validateLayout(record.layout, 'layout');
  const layout = mergeLayout(currentLayout, incomingLayout, mapping, options.restoreLayout);
  const currentPlan = input.current.reviewPlan ? validateReviewPlan(input.current.reviewPlan, 'current.reviewPlan') : { revision: 0, dailyBudget: DEFAULT_DAILY_REVIEW_BUDGET, concepts: {} };
  const incomingPlan = record.reviewPlan === undefined ? currentPlan : validateReviewPlan(record.reviewPlan, 'reviewPlan');
  const reviewPlan = mergeReviewPlan(currentPlan, incomingPlan, mapping, options.restoreReviewPlan);
  const anchorRequests = buildAnchorRequests(record, parsedEvents.anchors, mapping, exportedAt.raw, input.sourceId, state);
  const normalizedInput: ExportData = {
    schemaVersion: 1,
    exportedAt: exportedAt.raw,
    source: clone(record.source) as ExportData['source'],
    concepts: mapping.metadata,
    config: parseConfig(record.config, 'config'),
    configHistory: configMerge.incoming,
    anchors: mappedAnchors,
    observations: mappedObservations,
    retentions: mappedRetentions,
    applications: mappedApplications,
    ...(record.reviewPlan !== undefined ? { reviewPlan: mapReviewPlan(incomingPlan, mapping) } : {}),
    layout: mapLayout(incomingLayout, mapping),
  };
  if (record.restoreMetadata !== undefined) {
    const metadata = requireRecord(record.restoreMetadata, 'restoreMetadata');
    normalizedInput.restoreMetadata = { sourceId: typeof metadata.sourceId === 'string' ? metadata.sourceId : '', anchorRequests: Object.values(anchorRequests), configRecordedAt: configMerge.recordedAt };
  } else {
    addIssue(state, 'LEGACY_RESTORE_METADATA', '旧备份缺少原始请求元数据；重温请求将补上原事件发生时间，无法保证曾省略时间的请求原样重试；缺失配置记录时间使用导出时间。', { severity: 'warning' });
    normalizedInput.restoreMetadata = { sourceId: '', anchorRequests: Object.values(anchorRequests), configRecordedAt: configMerge.recordedAt };
  }

  const metadataForToken = input.concepts.map((concept) => ({ id: concept.id, path: concept.source.path, revision: concept.source.revision })).sort((a, b) => a.id.localeCompare(b.id));
  const token = stableHash({ data: sortTokenCollections(normalizedInput), options, current: sortTokenCollections(stripExportedAt(input.current) as ExportData), liveConcepts: metadataForToken, acceptedPaths: sortAcceptedPaths(input.acceptedPaths), sourceId: input.sourceId });
  const counts: ImportCounts = {
    added: {
      anchors: classified.newAnchors.length,
      observations: classified.newObservations.length,
      retentions: classified.newRetentions.length,
      applications: classified.newApplications.length,
    },
    duplicates: classified.duplicates,
    configurations: configMerge.newConfigs.length,
    matchedConcepts: mapping.matches.filter((match) => match.toId !== null).length,
    remappedConcepts: mapping.matches.filter((match) => match.match === 'path-revision').length,
    unresolvedConcepts: mapping.unresolved.size,
  };
  const preview: ImportPreview = {
    sourceId: input.sourceId,
    token,
    canImport: state.errors === 0,
    exportedAt: exportedAt.raw,
    counts,
    matches: mapping.matches,
    issues: shownIssues(state),
    issueCount: state.all.length,
    config: { before: clone(input.current.config), after: configMerge.current },
    layoutChanged: layout.changed,
    reviewPlanChanged: reviewPlan.changed,
    options,
  };
  return {
    preview,
    normalized: normalizedInput,
    newAnchors: classified.newAnchors,
    newObservations: classified.newObservations,
    newRetentions: orderedRetentions.filter((event) => classified.newRetentions.some((candidate) => candidate.eventId === event.eventId)),
    newApplications: classified.newApplications,
    newConfigs: configMerge.newConfigs,
    mergedLayout: layout.value,
    mergedReviewPlan: reviewPlan.value,
    metadataConcepts: mapping.metadata,
    anchorRequests,
  };
}
