import type { Observation } from '../shared/types.js';
import { parseObservationRevision, type ObservationRevision } from '../shared/observation-revisions.js';
import { projectObservationAssessments } from '../core/observation-revisions.js';
import { isValidInstant } from '../core/time-model.js';

export type ObservationRevisionImportErrorCode = `OBSERVATION_REVISION_IMPORT_${
  'INVALID_INPUT' | 'INVALID_CURRENT' | 'INVALID_INCOMING' | 'EVENT_CONFLICT' | 'INVALID_CHAIN' | 'INVALID_TIME'}`;
export class ObservationRevisionImportError extends Error {
  constructor(readonly code: ObservationRevisionImportErrorCode) { super(code); this.name = 'ObservationRevisionImportError'; }
}
export interface ObservationRevisionImportInput {
  /** Actual persisted parents, before incoming observations are merged. */
  currentObservations: readonly Observation[];
  /** Complete, already authorized and consistently mapped parent collection. */
  observations: readonly Observation[];
  currentRevisions: readonly unknown[];
  incomingRevisions: readonly unknown[];
  /** IDs occupied by the other learning event kinds in this namespace. */
  occupiedEventIds: ReadonlySet<string>;
  exportedAt: string;
}
export interface ObservationRevisionImportPlan {
  newRevisions: ObservationRevision[];
  /** Unique incoming IDs replayed against current or earlier incoming events. */
  duplicateEventIds: string[];
  mergedRevisions: ObservationRevision[];
}
function fail(suffix: 'INVALID_INPUT' | 'INVALID_CURRENT' | 'INVALID_INCOMING' | 'EVENT_CONFLICT' | 'INVALID_CHAIN' | 'INVALID_TIME'): never {
  throw new ObservationRevisionImportError(`OBSERVATION_REVISION_IMPORT_${suffix}`);
}
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function parsed(value: unknown, incoming: boolean): ObservationRevision {
  try { return parseObservationRevision(value); }
  catch { return fail(incoming ? 'INVALID_INCOMING' : 'INVALID_CURRENT'); }
}
function orderedChain(observations: readonly Observation[], events: readonly ObservationRevision[]): ObservationRevision[] {
  let cutoff = -Infinity;
  for (const parent of observations) {
    if (!parent || typeof parent.recordedAt !== 'string' || !isValidInstant(parent.recordedAt)) fail('INVALID_INPUT');
    cutoff = Math.max(cutoff, Date.parse(parent.recordedAt));
  }
  for (const event of events) cutoff = Math.max(cutoff, Date.parse(event.recordedAt));
  // Empty sets need no invented wall clock. Visible orphan events still go through projection.
  if (!observations.length && !events.length) return [];
  let projection;
  try { projection = projectObservationAssessments(observations, events, new Date(cutoff).toISOString()); }
  catch { return fail('INVALID_CHAIN'); }
  if (projection.issues.length || projection.states.some(state => state.status !== 'active' && state.status !== 'withdrawn')) fail('INVALID_CHAIN');
  const byId = new Map(events.map(event => [event.eventId, event]));
  const ordered: ObservationRevision[] = [];
  for (const state of [...projection.states].sort((a, b) => compare(a.observationEventId, b.observationEventId))) {
    for (const audit of state.audit) {
      const event = byId.get(audit.eventId);
      if (!event) fail('INVALID_CHAIN');
      ordered.push(event);
    }
  }
  if (ordered.length !== events.length) fail('INVALID_CHAIN');
  return ordered;
}

/** Pure planning only: no database, request-payload reconstruction, clock or KG access. */
export function planObservationRevisionImport(input: ObservationRevisionImportInput): ObservationRevisionImportPlan {
  try {
    if (!input || !Array.isArray(input.currentObservations) || !Array.isArray(input.observations) || !Array.isArray(input.currentRevisions) || !Array.isArray(input.incomingRevisions)
      || typeof input.exportedAt !== 'string' || !isValidInstant(input.exportedAt) || typeof input.occupiedEventIds?.has !== 'function') fail('INVALID_INPUT');
    for (const collection of [input.currentObservations, input.observations]) {
      const parentIds = new Set<string>();
      for (const parent of collection) {
        if (!parent || typeof parent.eventId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(parent.eventId) || parentIds.has(parent.eventId)) fail('INVALID_INPUT');
        parentIds.add(parent.eventId);
      }
    }
    const current = new Map<string, ObservationRevision>();
    const incoming = new Map<string, ObservationRevision>();
    const duplicates = new Set<string>();
    const insert = (target: Map<string, ObservationRevision>, event: ObservationRevision, prior?: ObservationRevision) => {
      if (input.occupiedEventIds.has(event.eventId)) fail('EVENT_CONFLICT');
      const previous = prior ?? target.get(event.eventId);
      if (previous && JSON.stringify(previous) !== JSON.stringify(event)) fail('EVENT_CONFLICT');
      if (!target.has(event.eventId)) target.set(event.eventId, event);
      return previous !== undefined;
    };
    for (const raw of input.currentRevisions) insert(current, parsed(raw, false));
    // Reject a corrupt current chain even when incoming records could fill a gap or choose a branch.
    orderedChain(input.currentObservations, [...current.values()]);
    const exportedAt = Date.parse(input.exportedAt);
    for (const raw of input.incomingRevisions) {
      const event = parsed(raw, true);
      if (Date.parse(event.occurredAt) > exportedAt || Date.parse(event.recordedAt) > exportedAt) fail('INVALID_TIME');
      if (insert(incoming, event, current.get(event.eventId))) duplicates.add(event.eventId);
    }
    const merged = new Map(current);
    for (const [eventId, event] of incoming) if (!merged.has(eventId)) merged.set(eventId, event);
    const mergedRevisions = orderedChain(input.observations, [...merged.values()]);
    return { newRevisions: mergedRevisions.filter(event => !current.has(event.eventId)),
      duplicateEventIds: [...duplicates].sort(compare), mergedRevisions };
  } catch (error) {
    if (error instanceof ObservationRevisionImportError) throw error;
    return fail('INVALID_INPUT');
  }
}
