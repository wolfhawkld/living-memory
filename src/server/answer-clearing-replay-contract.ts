import { isValidInstant } from '../core/time-model.js';
import type { ExportDataV3 } from '../shared/answer-clearing-export.js';
import { MAX_IMPORT_BYTES, type ImportOptions, type ImportReceipt } from '../shared/import-data.js';
import type { Layout, ModelConfig, ReviewRequest } from '../shared/types.js';
import type { ReviewPlan } from '../shared/review-plan.js';
import type { PreparedAnswerClearingImport } from './import-plan.js';
import { AnswerClearingStoreError } from './answer-clearing-store-error.js';

/** A format tag, never a digest of a request, export, answer or preview token. */
export const SAFE_IMPORT_CREDENTIAL = 'answer-clearing:safe-import-replay:v1';
const KINDS = ['anchors', 'observations', 'observationRevisions', 'retentions', 'applications', 'corrections', 'relationReviews', 'practiceCards', 'practiceAttempts'] as const;
type EventKind = typeof KINDS[number];
export interface SafeImportReplayDescriptor {
  version: 1;
  namespace: string;
  options: ImportOptions;
  exportedAt: string;
  concepts: ExportDataV3['concepts'];
  config: ModelConfig;
  configHistory: ModelConfig[];
  layout: Layout;
  reviewPlan?: ReviewPlan;
  restoreMetadata: { anchorRequests: ReviewRequest[]; configRecordedAt: Record<string, string> };
  events: Array<{ kind: EventKind; eventId: string; recordedAt: string }>;
}
export interface SafeImportReceiptEnvelope {
  version: 1;
  receipt: ImportReceipt;
  replay: SafeImportReplayDescriptor;
}
function invalid(): never { throw new AnswerClearingStoreError('ANSWER_CLEARING_REPLAY_DATA_INVALID', 503); }

/** Copy bounded plain JSON without invoking getters, toJSON or unknown prototypes. */
function json(value: unknown): unknown {
  const ancestors = new Set<object>();
  let size = 0;
  const visit = (item: unknown, depth: number): unknown => {
    if (depth > 100 || ++size > MAX_IMPORT_BYTES) invalid();
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number') { if (!Number.isFinite(item)) invalid(); return item; }
    if (typeof item === 'string') { size += Buffer.byteLength(item, 'utf8'); if (size > MAX_IMPORT_BYTES) invalid(); return item; }
    if (!item || typeof item !== 'object' || ancestors.has(item)) invalid();
    const array = Array.isArray(item);
    if (!array && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) invalid();
    if (Object.getOwnPropertySymbols(item).length) invalid();
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const elements: unknown[] = [];
    ancestors.add(item);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
      if (array && key === 'length') continue;
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
      if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= (item as unknown[]).length)) invalid();
      size += Buffer.byteLength(key, 'utf8');
      const child = visit(descriptor.value, depth + 1);
      if (array) elements[Number(key)] = child;
      else result[key] = child;
    }
    ancestors.delete(item);
    if (array && Object.keys(elements).length !== (item as unknown[]).length) invalid();
    return array ? elements : result;
  };
  const result = visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_IMPORT_BYTES) invalid();
  return result;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function fields(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  const result = record(value);
  if (Object.keys(result).some(key => !required.includes(key) && !optional.includes(key))
    || required.some(key => !Object.hasOwn(result, key))) invalid();
  return result;
}
function array(value: unknown, max: number): unknown[] { if (!Array.isArray(value) || value.length > max) invalid(); return value; }
function text(value: unknown): string { if (typeof value !== 'string' || !value.trim()) invalid(); return value; }
function id(value: unknown): string { const result = text(value); if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(result)) invalid(); return result; }
function namespace(value: unknown): string {
  const result = text(value);
  if (result !== result.trim() || Buffer.byteLength(result, 'utf8') > 256 || /[\u0000-\u001f\u007f]/.test(result)) invalid();
  return result;
}
function instant(value: unknown): string { const result = text(value); if (!isValidInstant(result)) invalid(); return result; }
function number(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) invalid(); return value;
}
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const result = number(value, min, max); if (!Number.isSafeInteger(result)) invalid(); return result;
}
function boolean(value: unknown): boolean { if (typeof value !== 'boolean') invalid(); return value; }
function config(value: unknown): ModelConfig {
  const row = fields(value, ['modelVersion', 'halfLifeDays', 'revision']);
  if (row.modelVersion !== 'time-only-v0') invalid();
  const halfLifeDays = number(row.halfLifeDays, 0, 3650); if (halfLifeDays === 0) invalid();
  return { modelVersion: 'time-only-v0', halfLifeDays, revision: integer(row.revision, 1) };
}
function unique<T>(rows: T[], key: (row: T) => string): T[] {
  if (new Set(rows.map(key)).size !== rows.length) invalid();
  return rows.sort((a, b) => key(a).localeCompare(key(b)));
}
function descriptor(value: unknown): SafeImportReplayDescriptor {
  const row = fields(value, ['version', 'namespace', 'options', 'exportedAt', 'concepts', 'config', 'configHistory', 'layout', 'restoreMetadata', 'events'], ['reviewPlan']);
  if (row.version !== 1) invalid();
  const opts = fields(row.options, ['restoreLayout', 'restoreReviewPlan']);
  const concepts = unique(array(row.concepts, 10_000).map(item => {
    const concept = fields(item, ['id', 'title', 'source']);
    const source = fields(concept.source, ['path', 'revision']);
    if (typeof concept.title !== 'string') invalid();
    return { id: text(concept.id), title: concept.title, source: { path: text(source.path), revision: text(source.revision) } };
  }), item => item.id);
  const configHistory = array(row.configHistory, 50_000).map(config).sort((a, b) => a.revision - b.revision);
  if (new Set(configHistory.map(item => item.revision)).size !== configHistory.length) invalid();
  const layout: Layout = Object.create(null) as Layout;
  const positions = record(row.layout); if (Object.keys(positions).length > 10_000) invalid();
  for (const [key, item] of Object.entries(positions)) {
    text(key); const point = fields(item, ['x', 'y', 'z']);
    layout[key] = { x: number(point.x, -Number.MAX_VALUE, Number.MAX_VALUE), y: number(point.y, -Number.MAX_VALUE, Number.MAX_VALUE), z: number(point.z, -Number.MAX_VALUE, Number.MAX_VALUE) };
  }
  let reviewPlan: ReviewPlan | undefined;
  if (Object.hasOwn(row, 'reviewPlan')) {
    const plan = fields(row.reviewPlan, ['revision', 'dailyBudget', 'concepts']);
    const preferences: ReviewPlan['concepts'] = Object.create(null) as ReviewPlan['concepts'];
    const entries = record(plan.concepts); if (Object.keys(entries).length > 10_000) invalid();
    for (const [key, item] of Object.entries(entries)) {
      text(key); const preference = fields(item, ['focus', 'deferUntil']);
      if (preference.deferUntil !== null) instant(preference.deferUntil);
      preferences[key] = { focus: boolean(preference.focus), deferUntil: preference.deferUntil as string | null };
    }
    reviewPlan = { revision: integer(plan.revision), dailyBudget: integer(plan.dailyBudget, 0, 50), concepts: preferences };
  }
  const metadata = fields(row.restoreMetadata, ['anchorRequests', 'configRecordedAt']);
  const anchorRequests = unique(array(metadata.anchorRequests, 50_000).map(item => {
    const request = fields(item, ['eventId', 'conceptId', 'sourceRevision', 'kind'], ['occurredAt']);
    if (request.kind !== 'review' && request.kind !== 'estimated') invalid();
    return { eventId: id(request.eventId), conceptId: text(request.conceptId), sourceRevision: text(request.sourceRevision), kind: request.kind,
      ...(Object.hasOwn(request, 'occurredAt') ? { occurredAt: instant(request.occurredAt) } : {}) } as ReviewRequest;
  }), item => item.eventId);
  const configRecordedAt: Record<string, string> = Object.create(null) as Record<string, string>;
  const recorded = record(metadata.configRecordedAt); if (Object.keys(recorded).length > 50_000) invalid();
  for (const [key, item] of Object.entries(recorded)) {
    if (!/^[1-9]\d*$/.test(key) || !Number.isSafeInteger(Number(key))) invalid();
    configRecordedAt[key] = instant(item);
  }
  const events = unique(array(row.events, 50_000).map(item => {
    const event = fields(item, ['kind', 'eventId', 'recordedAt']);
    if (!KINDS.includes(event.kind as EventKind)) invalid();
    return { kind: event.kind as EventKind, eventId: id(event.eventId), recordedAt: instant(event.recordedAt) };
  }), item => item.eventId).sort((a, b) => a.kind.localeCompare(b.kind) || a.eventId.localeCompare(b.eventId));
  return { version: 1, namespace: namespace(row.namespace), options: { restoreLayout: boolean(opts.restoreLayout), restoreReviewPlan: boolean(opts.restoreReviewPlan) },
    exportedAt: instant(row.exportedAt), concepts, config: config(row.config), configHistory, layout,
    ...(reviewPlan === undefined ? {} : { reviewPlan }), restoreMetadata: { anchorRequests, configRecordedAt }, events };
}

/** Select only non-event inputs and event identities; event bodies stay in their original rows. */
export function buildSafeImportReplayDescriptor(prepared: PreparedAnswerClearingImport, options: ImportOptions): SafeImportReplayDescriptor {
  try {
    const data = prepared.normalized;
    const groups = [data.anchors, data.observations, data.observationRevisions, data.retentions ?? [], data.applications ?? [], data.corrections ?? [], data.relationReviews ?? [], data.practice?.cards ?? [], data.practice?.attempts ?? []];
    const value = { version: 1, namespace: prepared.preview.sourceId,
      options: { restoreLayout: options.restoreLayout, restoreReviewPlan: options.restoreReviewPlan }, exportedAt: data.exportedAt,
      concepts: data.concepts.map(item => ({ id: item.id, title: item.title, source: { path: item.source.path, revision: item.source.revision } })),
      config: data.config, configHistory: data.configHistory, layout: data.layout,
      ...(data.reviewPlan === undefined ? {} : { reviewPlan: data.reviewPlan }),
      restoreMetadata: { anchorRequests: data.restoreMetadata!.anchorRequests, configRecordedAt: data.restoreMetadata!.configRecordedAt },
      events: groups.flatMap((events, index) => events.map(event => ({ kind: KINDS[index], eventId: event.eventId, recordedAt: event.recordedAt }))),
    };
    return descriptor(json(value));
  } catch { return invalid(); }
}
function receipt(value: unknown): ImportReceipt {
  const row = fields(value, ['status', 'importId', 'sourceId', 'importedAt', 'counts', 'backupId']);
  if (row.status !== 'accepted') invalid();
  const counts = fields(row.counts, ['added', 'duplicates', 'configurations', 'matchedConcepts', 'remappedConcepts', 'unresolvedConcepts'], ['relationReviews', 'practiceCards', 'practiceAttempts', 'observationRevisions']);
  const added = fields(counts.added, ['anchors', 'observations', 'retentions', 'applications', 'corrections']);
  const result: ImportReceipt['counts'] = { added: { anchors: integer(added.anchors), observations: integer(added.observations), retentions: integer(added.retentions), applications: integer(added.applications), corrections: integer(added.corrections) },
    duplicates: integer(counts.duplicates), configurations: integer(counts.configurations), matchedConcepts: integer(counts.matchedConcepts), remappedConcepts: integer(counts.remappedConcepts), unresolvedConcepts: integer(counts.unresolvedConcepts) };
  for (const key of ['relationReviews', 'practiceCards', 'practiceAttempts', 'observationRevisions'] as const) if (Object.hasOwn(counts, key)) result[key] = integer(counts[key]);
  return { status: 'accepted', importId: id(row.importId), sourceId: namespace(row.sourceId), importedAt: instant(row.importedAt), counts: result, backupId: text(row.backupId) };
}
export function parseSafeImportReceiptEnvelope(value: unknown, expected: { namespace: string; importId: string }): SafeImportReceiptEnvelope {
  try {
    const row = fields(json(value), ['version', 'receipt', 'replay']);
    if (row.version !== 1) invalid();
    const accepted = receipt(row.receipt), replay = descriptor(row.replay);
    if (accepted.sourceId !== namespace(expected.namespace) || accepted.importId !== id(expected.importId) || replay.namespace !== accepted.sourceId) invalid();
    return { version: 1, receipt: accepted, replay };
  } catch { return invalid(); }
}
export function encodeSafeImportReceiptEnvelope(accepted: ImportReceipt, replay: SafeImportReplayDescriptor): string {
  try {
    const detached = fields(json({ version: 1, receipt: accepted, replay }), ['version', 'receipt', 'replay']);
    const replayRow = record(detached.replay), receiptRow = record(detached.receipt);
    return canonical(parseSafeImportReceiptEnvelope(detached, { namespace: namespace(replayRow.namespace), importId: id(receiptRow.importId) }));
  } catch { return invalid(); }
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`;
}
export function safeImportReplayEqual(a: SafeImportReplayDescriptor, b: SafeImportReplayDescriptor): boolean {
  return canonical(descriptor(json(a))) === canonical(descriptor(json(b)));
}
