import { isValidInstant } from '../core/time-model.js';
import { MAX_IMPORT_BYTES } from '../shared/import-data.js';
import type { IdentityBinding } from '../shared/identity.js';
import type { ExportDataV3 } from '../shared/answer-clearing-export.js';
import { AnswerClearingImportError } from '../shared/answer-clearing-export.js';
import {
  buildAnswerClearingImportEngine,
  normalizeAnswerClearingExportData,
  type AnswerClearingImportPlanInput,
  type PreparedAnswerClearingImport,
} from './import-plan.js';

export { AnswerClearingImportError } from '../shared/answer-clearing-export.js';
export type { ExportDataV3 } from '../shared/answer-clearing-export.js';
export type { AnswerClearingImportPlanInput, PreparedAnswerClearingImport } from './import-plan.js';

function invalid(): never { throw new AnswerClearingImportError('INVALID_IMPORT_DATA'); }

/** Detach JSON data without invoking caller getters/toJSON or retaining unknown object aliases. */
function jsonData(value: unknown): unknown {
  const ancestors = new Set<object>();
  let bytes = 0;
  function visit(item: unknown, depth: number): unknown {
    if (depth > 100 || (bytes += 1) > MAX_IMPORT_BYTES) invalid();
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number') { if (!Number.isFinite(item)) invalid(); return item; }
    if (typeof item === 'string') {
      bytes += Buffer.byteLength(item, 'utf8');
      if (bytes > MAX_IMPORT_BYTES) invalid();
      return item;
    }
    if (!item || typeof item !== 'object' || ancestors.has(item)) invalid();
    const array = Array.isArray(item);
    if (!array && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) invalid();
    ancestors.add(item);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Object.getOwnPropertySymbols(item).length) invalid();
    const result: unknown[] | Record<string, unknown> = array ? [] : Object.create(null) as Record<string, unknown>;
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (array && key === 'length') continue;
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
      if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= (item as unknown[]).length)) invalid();
      bytes += Buffer.byteLength(key, 'utf8');
      const child = visit(descriptor.value, depth + 1);
      Object.defineProperty(result, key, { value: child, enumerable: true, writable: true, configurable: true });
    }
    if (array && Object.keys(result).length !== (item as unknown[]).length) invalid();
    ancestors.delete(item);
    return result;
  }
  const result = visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_IMPORT_BYTES) invalid();
  return result;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) invalid();
  return value;
}
function instant(value: unknown): string {
  const result = text(value);
  if (!isValidInstant(result)) invalid();
  return result;
}

function sourceMetadata(value: unknown): ExportDataV3['source'] {
  const data = record(value);
  const integer = (item: unknown): number => {
    if (typeof item !== 'number' || !Number.isSafeInteger(item) || item < 0) invalid();
    return item;
  };
  if (data.mode !== 'local' && data.mode !== 'demo') invalid();
  if (!Array.isArray(data.diagnostics)) invalid();
  return {
    name: text(data.name, true), mode: data.mode,
    conceptCount: integer(data.conceptCount), limit: integer(data.limit),
    diagnostics: data.diagnostics.map(item => text(item, true)),
    ...(data.initialDomainId === undefined ? {} : { initialDomainId: text(data.initialDomainId) }),
  };
}

/** Uploaded bindings are audit data only, never authority for concept mapping. */
function identityAudit(value: unknown, exportedAt: string): IdentityBinding[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 10_000) invalid();
  const seen = new Set<string>();
  return value.map(item => {
    const row = record(item);
    const operationId = text(row.operationId);
    const confirmedAt = instant(row.confirmedAt);
    if (seen.has(operationId) || Date.parse(confirmedAt) > Date.parse(exportedAt)) invalid();
    seen.add(operationId);
    return {
      operationId, rawConceptId: text(row.rawConceptId), conceptId: text(row.conceptId),
      fromPath: row.fromPath === null ? null : text(row.fromPath), toPath: text(row.toPath),
      sourceRevision: text(row.sourceRevision), confirmedAt, backupId: text(row.backupId),
    };
  });
}

function normalizedAudit(data: unknown): Record<string, unknown> {
  const value = record(jsonData(data));
  value.source = sourceMetadata(value.source);
  const bindings = identityAudit(value.identityBindings, instant(value.exportedAt));
  if (bindings !== undefined) value.identityBindings = bindings;
  return value;
}

/** Validate a standalone v3 file without consulting a live graph or creating replay credentials. */
export function parseAnswerClearingExport(data: unknown, options: { now: string }): ExportDataV3 {
  try {
    const now = instant(options.now);
    const raw = normalizedAudit(data);
    const parsed = normalizeAnswerClearingExportData(raw, now);
    parsed.source = sourceMetadata(raw.source);
    if (raw.identityBindings !== undefined) parsed.identityBindings = raw.identityBindings as IdentityBinding[];
    return parsed;
  } catch { throw new AnswerClearingImportError('INVALID_IMPORT_DATA'); }
}

export function serializeAnswerClearingExport(data: unknown, options: { now: string }): string {
  return JSON.stringify(parseAnswerClearingExport(data, options));
}

function validatedInput(input: AnswerClearingImportPlanInput): AnswerClearingImportPlanInput {
  let current: ExportDataV3;
  try { current = parseAnswerClearingExport(input.current, { now: input.now }); }
  catch { throw new AnswerClearingImportError('INVALID_IMPORT_CURRENT'); }
  if (typeof input.sourceId !== 'string' || !input.sourceId.trim() || input.sourceId.length > 256 || /[\u0000-\u001f\u007f]/.test(input.sourceId)) invalid();
  return { ...input, current, data: normalizedAudit(input.data) };
}

function prepare(input: AnswerClearingImportPlanInput): PreparedAnswerClearingImport {
  const prepared = buildAnswerClearingImportEngine(input);
  prepared.normalized.source = sourceMetadata(record(input.data).source);
  // The engine intentionally ignores uploaded bindings. Preserve their audit-only representation in the file.
  const audit = record(input.data).identityBindings;
  if (audit !== undefined) prepared.normalized.identityBindings = audit as IdentityBinding[];
  return prepared;
}

/** A v3 preview over independently validated current data; no database/receipt writes. */
export function buildAnswerClearingImportPlan(input: AnswerClearingImportPlanInput): PreparedAnswerClearingImport {
  try { return prepare(validatedInput(input)); }
  catch (error) {
    if (error instanceof AnswerClearingImportError) throw error;
    throw new AnswerClearingImportError('INVALID_IMPORT_DATA');
  }
}

/**
 * Recompute the preview from fresh supplied snapshots and produce a complete merged file.
 * This is a pure JSON operation, not a transaction or an idempotent import receipt.
 */
export function mergeAnswerClearingImport(input: AnswerClearingImportPlanInput, expectedPreviewToken: string): ExportDataV3 {
  try {
    const validated = validatedInput(input);
    const prepared = prepare(validated);
    if (typeof expectedPreviewToken !== 'string' || expectedPreviewToken !== prepared.preview.token) throw new AnswerClearingImportError('IMPORT_STALE');
    if (!prepared.preview.canImport) throw new AnswerClearingImportError('IMPORT_REJECTED');
    const current = validated.current;
    const incoming = prepared.normalized;
    const metadata = new Map(current.concepts.map(item => [item.id, item]));
    for (const concept of prepared.metadataConcepts) if (!metadata.has(concept.id)) metadata.set(concept.id, concept);
    for (const concept of input.concepts) {
      if (metadata.has(concept.id)) metadata.set(concept.id, { id: concept.id, title: concept.title, source: { path: concept.source.path, revision: concept.source.revision } });
    }
    const configRecordedAt = { ...current.restoreMetadata!.configRecordedAt };
    for (const config of prepared.newConfigs) configRecordedAt[String(config.revision)] = config.recordedAt;
    const merged: ExportDataV3 = {
      schemaVersion: 3, exportedAt: instant(input.now), source: current.source,
      concepts: [...metadata.values()], config: prepared.preview.config.after,
      configHistory: [...current.configHistory, ...prepared.newConfigs.map(({ recordedAt: _recordedAt, ...config }) => config)],
      anchors: [...current.anchors, ...prepared.newAnchors],
      observations: [...current.observations, ...prepared.newObservations],
      observationRevisions: [...current.observationRevisions, ...prepared.newObservationRevisions],
      retentions: [...(current.retentions ?? []), ...prepared.newRetentions],
      applications: [...(current.applications ?? []), ...prepared.newApplications],
      corrections: [...(current.corrections ?? []), ...prepared.newCorrections],
      ...(current.relationReviews !== undefined || incoming.relationReviews !== undefined ? { relationReviews: [...(current.relationReviews ?? []), ...prepared.newRelationReviews] } : {}),
      ...(current.practice !== undefined || incoming.practice !== undefined ? { practice: {
        cards: [...(current.practice?.cards ?? []), ...prepared.newPracticeCards],
        attempts: [...(current.practice?.attempts ?? []), ...prepared.newPracticeAttempts],
      } } : {}),
      ...(current.identityBindings !== undefined ? { identityBindings: current.identityBindings } : {}),
      reviewPlan: prepared.mergedReviewPlan, layout: prepared.mergedLayout,
      restoreMetadata: {
        sourceId: input.sourceId,
        anchorRequests: [...current.restoreMetadata!.anchorRequests, ...prepared.newAnchors.map(anchor => prepared.anchorRequests[anchor.eventId])],
        configRecordedAt,
      },
    };
    return parseAnswerClearingExport(merged, { now: input.now });
  } catch (error) {
    if (error instanceof AnswerClearingImportError) throw error;
    throw new AnswerClearingImportError('INVALID_IMPORT_DATA');
  }
}
