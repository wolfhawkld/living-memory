import type {
  AnchorEvent,
  MemoryState,
  ModelConfig,
  Snapshot,
} from '../shared/types.js';
import { DAY_MS, MODEL_VERSION } from '../shared/types.js';
import { isValidInstant, projectMemory } from './time-model.js';

/** The fixed time model used by the first read-only demonstration. */
export const DEMO_HALF_LIFE_DAYS = 7 as const;

const DEMO_VERSION = 1 as const;
const DEMO_MODE = 'demo' as const;
const DEMO_ELAPSED_DAYS: readonly (number | null)[] = [
  0,
  3,
  7,
  10,
  14,
  21,
  28,
  null,
];
const SIMULATION_REASON = '模拟起点，仅用于展示，不是个人学习记录。';
const SIMULATION_UNKNOWN_REASON = '未分配模拟时间起点；模拟起点仅用于展示，不是个人学习记录。';

export interface DemoAssignment {
  conceptId: string;
  sourceRevision: string;
  elapsedDays: number | null;
}

export interface DemoRecord {
  version: typeof DEMO_VERSION;
  mode: typeof DEMO_MODE;
  modelVersion: typeof MODEL_VERSION;
  sourceId: string;
  generatedAt: string;
  baseAsOf: string;
  halfLifeDays: typeof DEMO_HALF_LIFE_DAYS;
  assignments: DemoAssignment[];
}

interface DemoRecordValidation {
  record: DemoRecord;
  sourceId?: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function instantTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !isValidInstant(value)) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function isValidElapsedDays(value: unknown): value is number | null {
  return value === null || (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0
  );
}

function isValidVirtualAnchorTimestamp(baseTimestamp: number, elapsedDays: number): boolean {
  const occurredTimestamp = baseTimestamp - elapsedDays * DAY_MS;
  if (!Number.isFinite(occurredTimestamp)) return false;
  return Number.isFinite(new Date(occurredTimestamp).getTime());
}

function validateDemoRecord(
  value: unknown,
  sourceId?: string,
): DemoRecordValidation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;

  if (candidate.version !== DEMO_VERSION || candidate.mode !== DEMO_MODE) return null;
  if (candidate.modelVersion !== MODEL_VERSION) return null;
  if (!isNonEmptyString(candidate.sourceId)) return null;
  if (sourceId !== undefined && candidate.sourceId !== sourceId) return null;
  if (instantTimestamp(candidate.generatedAt) === null) return null;
  const baseTimestamp = instantTimestamp(candidate.baseAsOf);
  if (baseTimestamp === null) return null;
  if (candidate.halfLifeDays !== DEMO_HALF_LIFE_DAYS) return null;
  if (!Array.isArray(candidate.assignments)) return null;

  const seenConceptIds = new Set<string>();
  const assignments: DemoAssignment[] = [];
  for (const item of candidate.assignments) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const assignment = item as Record<string, unknown>;
    if (!isNonEmptyString(assignment.conceptId)) return null;
    if (!isNonEmptyString(assignment.sourceRevision)) return null;
    if (!isValidElapsedDays(assignment.elapsedDays)) return null;
    if (
      assignment.elapsedDays !== null &&
      !isValidVirtualAnchorTimestamp(baseTimestamp, assignment.elapsedDays)
    ) return null;
    if (seenConceptIds.has(assignment.conceptId)) return null;
    seenConceptIds.add(assignment.conceptId);
    assignments.push({
      conceptId: assignment.conceptId,
      sourceRevision: assignment.sourceRevision,
      elapsedDays: assignment.elapsedDays,
    });
  }

  return {
    sourceId: sourceId === undefined ? undefined : sourceId,
    record: {
      version: DEMO_VERSION,
      mode: DEMO_MODE,
      modelVersion: MODEL_VERSION,
      sourceId: candidate.sourceId,
      generatedAt: candidate.generatedAt as string,
      baseAsOf: candidate.baseAsOf as string,
      halfLifeDays: DEMO_HALF_LIFE_DAYS,
      assignments,
    },
  };
}

function requireValidInstant(value: string, fieldName: string): number {
  const timestamp = instantTimestamp(value);
  if (timestamp === null) {
    throw new RangeError(`${fieldName} 必须是带时区的 ISO 8601 时间。`);
  }
  return timestamp;
}

function requireValidSourceId(sourceId: string): string {
  if (!isNonEmptyString(sourceId)) {
    throw new RangeError('sourceId 必须是非空字符串。');
  }
  return sourceId;
}

function requireValidSnapshot(snapshot: Snapshot): void {
  if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.concepts)) {
    throw new TypeError('snapshot 必须包含 concepts 数组。');
  }
}

/**
 * Create a deterministic, read-only set of time anchors for a snapshot.
 *
 * The values are deliberately synthetic. They let the visual prototype show
 * the full recent/revisit/stale/unknown palette without writing any personal
 * learning event to the local store.
 */
export function createDemoRecord(
  snapshot: Snapshot,
  sourceId: string,
  baseAsOf?: string,
): DemoRecord {
  requireValidSnapshot(snapshot);
  const normalizedSourceId = requireValidSourceId(sourceId);
  const resolvedBaseAsOf = baseAsOf ?? snapshot.asOf;
  requireValidInstant(resolvedBaseAsOf, 'baseAsOf');

  const concepts = [...snapshot.concepts].sort((left, right) => left.id.localeCompare(right.id));
  const generatedAt = new Date().toISOString();
  const assignments = concepts.map((concept, index): DemoAssignment => ({
    conceptId: concept.id,
    sourceRevision: concept.source.revision,
    elapsedDays: DEMO_ELAPSED_DAYS[index % DEMO_ELAPSED_DAYS.length] ?? null,
  }));

  return {
    version: DEMO_VERSION,
    mode: DEMO_MODE,
    modelVersion: MODEL_VERSION,
    sourceId: normalizedSourceId,
    generatedAt,
    baseAsOf: resolvedBaseAsOf,
    halfLifeDays: DEMO_HALF_LIFE_DAYS,
    assignments,
  };
}

/**
 * Extend an existing synthetic record with assignments for concepts that are
 * not in it yet. Existing assignments stay byte-for-byte equivalent in their
 * original order, including assignments for concepts absent from the current
 * snapshot. New concepts are appended in stable ID order and continue the
 * deterministic elapsed-day cycle from the existing assignment count.
 */
export function extendDemoRecord(
  snapshot: Snapshot,
  record: DemoRecord,
): DemoRecord {
  requireValidSnapshot(snapshot);
  const validatedRecord = requireDemoRecord(record);
  const existingConceptIds = new Set(
    validatedRecord.assignments.map((assignment) => assignment.conceptId),
  );
  const newConcepts = [...snapshot.concepts]
    .filter((concept) => !existingConceptIds.has(concept.id))
    .sort((left, right) => left.id.localeCompare(right.id));
  const assignmentStart = validatedRecord.assignments.length;
  const newAssignments = newConcepts.map((concept, index): DemoAssignment => ({
    conceptId: concept.id,
    sourceRevision: concept.source.revision,
    elapsedDays: DEMO_ELAPSED_DAYS[(assignmentStart + index) % DEMO_ELAPSED_DAYS.length] ?? null,
  }));

  return {
    ...validatedRecord,
    assignments: [...validatedRecord.assignments, ...newAssignments],
  };
}

/**
 * Check whether a value is a complete demo record for one source namespace.
 * This is intentionally a type guard so local-storage values can be rejected
 * before they enter the projection path.
 */
export function isDemoRecord(value: unknown, sourceId: string): value is DemoRecord {
  return validateDemoRecord(value, sourceId) !== null;
}

function requireDemoRecord(value: unknown): DemoRecord {
  const validated = validateDemoRecord(value);
  if (!validated) throw new RangeError('模拟记录格式无效，无法投影。');
  return validated.record;
}

function simulatedAnchor(
  record: DemoRecord,
  assignment: DemoAssignment,
  baseTimestamp: number,
): AnchorEvent | null {
  if (assignment.elapsedDays === null) return null;
  const occurredTimestamp = baseTimestamp - assignment.elapsedDays * DAY_MS;
  if (!Number.isFinite(occurredTimestamp)) {
    throw new RangeError('模拟记录的时间起点超出可表示日期范围。');
  }
  const occurredAt = new Date(occurredTimestamp);
  if (!Number.isFinite(occurredAt.getTime())) {
    throw new RangeError('模拟记录的时间起点超出可表示日期范围。');
  }
  return {
    eventId: `demo:${record.sourceId}:${assignment.conceptId}`,
    conceptId: assignment.conceptId,
    sourceRevision: assignment.sourceRevision,
    occurredAt: occurredAt.toISOString(),
    recordedAt: record.generatedAt,
    kind: 'estimated',
  };
}

function withSimulationReason(state: MemoryState): MemoryState {
  if (state.anchor === null && state.status === 'unknown') {
    return { ...state, reason: SIMULATION_UNKNOWN_REASON };
  }
  return {
    ...state,
    reason: state.reason ? `${SIMULATION_REASON} ${state.reason}` : SIMULATION_REASON,
  };
}

/**
 * Project a snapshot against the synthetic anchors in a demo record.
 * Existing anchors in the real snapshot are deliberately ignored.
 */
export function projectDemoSnapshot(
  snapshot: Snapshot,
  record: DemoRecord,
  offsetDays = 0,
): Snapshot {
  requireValidSnapshot(snapshot);
  const validatedRecord = requireDemoRecord(record);
  if (!Number.isFinite(offsetDays) || offsetDays < 0) {
    throw new RangeError('offsetDays 必须是有限的非负数字。');
  }

  const baseTimestamp = requireValidInstant(validatedRecord.baseAsOf, 'baseAsOf');
  const asOfTimestamp = baseTimestamp + offsetDays * DAY_MS;
  if (!Number.isFinite(asOfTimestamp)) {
    throw new RangeError('offsetDays 使模拟时间超出可表示日期范围。');
  }
  const asOfDate = new Date(asOfTimestamp);
  if (!Number.isFinite(asOfDate.getTime())) {
    throw new RangeError('offsetDays 使模拟时间超出可表示日期范围。');
  }
  const asOf = offsetDays === 0 ? validatedRecord.baseAsOf : asOfDate.toISOString();
  const config: ModelConfig = {
    modelVersion: MODEL_VERSION,
    halfLifeDays: DEMO_HALF_LIFE_DAYS,
    revision: 1,
  };
  const assignments = new Map(validatedRecord.assignments.map((assignment) => [assignment.conceptId, assignment]));
  const states: Record<string, MemoryState> = {};

  for (const concept of snapshot.concepts) {
    const assignment = assignments.get(concept.id);
    const anchor = assignment ? simulatedAnchor(validatedRecord, assignment, baseTimestamp) : null;
    states[concept.id] = withSimulationReason(projectMemory(concept, anchor, config, asOf));
  }

  return {
    ...snapshot,
    config,
    states,
    asOf,
    observationsCount: 0,
  };
}
