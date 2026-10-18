import type { Observation } from '../shared/types.js';
import {
  assessmentFromObservation, observationAssessmentsEqual, observationRevisionRequestEqual,
  ObservationRevisionError, parseObservationRevision, parseObservationRevisionRequest,
  type ObservationAssessment, type ObservationRevision, type ObservationRevisionRequest,
} from '../shared/observation-revisions.js';
import { isValidInstant } from './time-model.js';

export type ObservationRevisionIssueCode = 'INVALID_PARENT' | 'INVALID_REVISION' | 'EVENT_CONFLICT'
  | 'MISSING_PARENT' | 'MISSING_PREDECESSOR' | 'FOREIGN_PREDECESSOR' | 'PARENT_MISMATCH'
  | 'FORK' | 'CYCLE' | 'INVALID_REVISION_TIME' | 'INVALID_TRANSITION'
  | 'UNCHANGED_ASSESSMENT' | 'LEARNING_SHAPE_MISMATCH';
export interface ObservationRevisionIssue {
  observationEventId: string | null;
  eventId: string | null;
  kind: 'invalid' | 'incomplete';
  code: ObservationRevisionIssueCode;
}
export interface ObservationRevisionAuditEntry {
  eventId: string;
  previousEventId: string | null;
  action: ObservationRevision['action'];
  occurredAt: string;
  recordedAt: string;
}
export interface ObservationAssessmentState {
  observationEventId: string;
  status: 'active' | 'withdrawn' | 'unresolved' | 'not-yet-recorded';
  currentAssessment: ObservationAssessment | null;
  latestRevisionEventId: string | null;
  appliedRevisionCount: number;
  audit: ObservationRevisionAuditEntry[];
  issues: ObservationRevisionIssue[];
}
export interface DerivedObservationAssessment {
  kind: 'derived-observation-assessment';
  observationEventId: string;
  revisionEventId: string | null;
  observation: Observation;
}
export interface ObservationAssessmentProjection {
  asOf: string;
  effective: DerivedObservationAssessment[];
  states: ObservationAssessmentState[];
  issues: ObservationRevisionIssue[];
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable && 'value' in descriptor ? descriptor.value : undefined;
  } catch { return undefined; }
}
function attributedId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  return ID.test(id) ? id : null;
}
function time(value: unknown): number | null {
  return typeof value === 'string' && isValidInstant(value) ? Date.parse(value) : null;
}
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function identity(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 512 && value.trim().length > 0 && value === value.trim();
}
interface Parent {
  observation: Observation;
  observed: number;
  recorded: number;
  assessment: ObservationAssessment;
}
function parentOf(observation: Observation): Parent {
  try {
    if (typeof observation.eventId !== 'string' || !ID.test(observation.eventId)
      || !identity(observation.conceptId) || !identity(observation.sourceRevision)) throw new Error();
    const observed = time(observation.observedAt), recorded = time(observation.recordedAt);
    if (observed === null || recorded === null || observed > recorded) throw new Error();
    return { observation, observed, recorded, assessment: assessmentFromObservation(observation) };
  } catch { throw new ObservationRevisionError('INVALID_PARENT'); }
}
function requestOf(event: ObservationRevision): ObservationRevisionRequest {
  const { conceptId: _concept, sourceRevision: _revision, recordedAt: _recorded, ...request } = event;
  return request;
}
function auditOf(event: ObservationRevision): ObservationRevisionAuditEntry {
  return { eventId: event.eventId, previousEventId: event.previousEventId, action: event.action,
    occurredAt: event.occurredAt, recordedAt: event.recordedAt };
}
function transition(status: 'active' | 'withdrawn', current: ObservationAssessment, event: ObservationRevisionRequest): {
  status: 'active' | 'withdrawn'; assessment: ObservationAssessment;
} | 'INVALID_TRANSITION' | 'LEARNING_SHAPE_MISMATCH' | 'UNCHANGED_ASSESSMENT' {
  if (event.action === 'revise') {
    if (status !== 'active') return 'INVALID_TRANSITION';
    if ((current.learning === null) !== (event.assessment.learning === null)) return 'LEARNING_SHAPE_MISMATCH';
    if (observationAssessmentsEqual(current, event.assessment)) return 'UNCHANGED_ASSESSMENT';
    return { status, assessment: event.assessment };
  }
  if (event.action === 'withdraw') return status === 'active'
    ? { status: 'withdrawn', assessment: current } : 'INVALID_TRANSITION';
  return status === 'withdrawn' ? { status: 'active', assessment: current } : 'INVALID_TRANSITION';
}
function derived(parent: Observation, assessment: ObservationAssessment): Observation {
  const observation = { ...parent, rating: assessment.rating };
  if (parent.learning !== undefined) observation.learning = { ...parent.learning, ...assessment.learning! };
  return observation;
}

/**
 * Project a complete set from one already-authorized namespace. No persistence,
 * current KG lookup or implicit clock. Tagged results are not raw export rows.
 * An unattributable visible corrupt record throws rather than reviving scores.
 */
export function projectObservationAssessments(
  rawObservations: readonly Observation[], revisions: readonly unknown[], asOf: string,
): ObservationAssessmentProjection {
  const cutoff = time(asOf);
  if (cutoff === null) throw new ObservationRevisionError('INVALID_AS_OF');
  const parents = new Map<string, Observation>();
  const validated = new Map<string, Parent>();
  const issuesByParent = new Map<string, ObservationRevisionIssue[]>();
  const issueKeys = new Set<string>();
  function issue(parentId: string, eventId: string | null, code: ObservationRevisionIssueCode) {
    const key = JSON.stringify([parentId, eventId, code]);
    if (issueKeys.has(key)) return;
    issueKeys.add(key);
    const item: ObservationRevisionIssue = { observationEventId: parentId, eventId, code,
      kind: code === 'MISSING_PARENT' || code === 'MISSING_PREDECESSOR' ? 'incomplete' : 'invalid' };
    const bucket = issuesByParent.get(parentId);
    if (bucket) bucket.push(item); else issuesByParent.set(parentId, [item]);
  }
  for (const observation of rawObservations) {
    const id = attributedId(own(observation, 'eventId'));
    if (id === null) throw new ObservationRevisionError('INVALID_PARENT');
    if (parents.has(id)) issue(id, id, 'INVALID_PARENT');
    else parents.set(id, observation);
    try { if (!validated.has(id)) validated.set(id, parentOf(observation)); }
    catch { issue(id, id, 'INVALID_PARENT'); }
  }

  const futureIds = new Set<string>();
  const parsedById = new Map<string, ObservationRevision>();
  const canonicalById = new Map<string, string>();
  const mentions = new Map<string, Set<string>>();
  const mentionCounts = new Map<string, number>();
  const invalidIds = new Set<string>();
  const conflictingIds = new Set<string>();
  const parsedByParent = new Map<string, ObservationRevision[]>();
  for (const raw of revisions) {
    const receipt = time(own(raw, 'recordedAt'));
    const eventId = attributedId(own(raw, 'eventId'));
    // Do not inspect a future record's schema, parent, payload or fork structure.
    if (receipt !== null && receipt > cutoff) {
      if (eventId !== null) futureIds.add(eventId);
      continue;
    }
    const parentId = attributedId(own(raw, 'observationEventId'));
    if (parentId === null) throw new ObservationRevisionError('UNATTRIBUTABLE_REVISION');
    if (eventId !== null) {
      mentionCounts.set(eventId, (mentionCounts.get(eventId) ?? 0) + 1);
      const bucket = mentions.get(eventId);
      if (bucket) bucket.add(parentId); else mentions.set(eventId, new Set([parentId]));
    }
    if (!parents.has(parentId)) issue(parentId, eventId, 'MISSING_PARENT');
    let event: ObservationRevision;
    try { event = parseObservationRevision(raw); }
    catch {
      issue(parentId, eventId, 'INVALID_REVISION');
      if (eventId !== null) invalidIds.add(eventId);
      continue;
    }
    const canonical = JSON.stringify(event);
    if (canonicalById.has(event.eventId)) {
      if (canonicalById.get(event.eventId) !== canonical) conflictingIds.add(event.eventId);
      continue;
    }
    canonicalById.set(event.eventId, canonical);
    parsedById.set(event.eventId, event);
    const bucket = parsedByParent.get(parentId);
    if (bucket) bucket.push(event); else parsedByParent.set(parentId, [event]);
  }
  for (const [eventId, owners] of mentions) {
    if (parents.has(eventId)) {
      issue(eventId, eventId, 'EVENT_CONFLICT');
      for (const owner of owners) issue(owner, eventId, 'EVENT_CONFLICT');
    }
    if (conflictingIds.has(eventId) || (invalidIds.has(eventId) && mentionCounts.get(eventId)! > 1)) {
      for (const owner of owners) issue(owner, eventId, 'EVENT_CONFLICT');
    }
  }

  const issueOrder = (a: ObservationRevisionIssue, b: ObservationRevisionIssue) =>
    compare(a.observationEventId ?? '', b.observationEventId ?? '') || compare(a.eventId ?? '', b.eventId ?? '')
      || compare(a.code, b.code) || compare(a.kind, b.kind);
  const states: ObservationAssessmentState[] = [];
  const effective: DerivedObservationAssessment[] = [];
  const sortableParent = (id: string) => issuesByParent.get(id)?.some(item => item.code === 'INVALID_PARENT')
    ? undefined : validated.get(id);
  const ordered = [...parents].sort(([idA], [idB]) => {
    const a = sortableParent(idA), b = sortableParent(idB);
    return (a?.observed ?? Infinity) - (b?.observed ?? Infinity)
      || (a?.recorded ?? Infinity) - (b?.recorded ?? Infinity) || compare(idA, idB);
  });
  for (const [id] of ordered) {
    const parent = validated.get(id);
    const events = parsedByParent.get(id) ?? [];
    const state: ObservationAssessmentState = { observationEventId: id, status: 'unresolved', currentAssessment: null,
      latestRevisionEventId: null, appliedRevisionCount: 0, audit: [], issues: [] };
    if (parent && !issuesByParent.has(id)) {
      const byId = new Map(events.map(event => [event.eventId, event]));
      const roots: ObservationRevision[] = [];
      const children = new Map<string, ObservationRevision[]>();
      for (const event of events) {
        if (event.conceptId !== parent.observation.conceptId || event.sourceRevision !== parent.observation.sourceRevision) issue(id, event.eventId, 'PARENT_MISMATCH');
        if (Date.parse(event.occurredAt) < parent.observed || Date.parse(event.recordedAt) < parent.recorded) issue(id, event.eventId, 'INVALID_REVISION_TIME');
        if (event.previousEventId === null) roots.push(event);
        else {
          const predecessor = parsedById.get(event.previousEventId);
          if (!predecessor) issue(id, event.eventId, futureIds.has(event.previousEventId) ? 'INVALID_REVISION_TIME' : 'MISSING_PREDECESSOR');
          else if (predecessor.observationEventId !== id) issue(id, event.eventId, 'FOREIGN_PREDECESSOR');
          else {
            if (Date.parse(event.occurredAt) < Date.parse(predecessor.occurredAt)
              || Date.parse(event.recordedAt) < Date.parse(predecessor.recordedAt)) issue(id, event.eventId, 'INVALID_REVISION_TIME');
            const bucket = children.get(predecessor.eventId);
            if (bucket) bucket.push(event); else children.set(predecessor.eventId, [event]);
          }
        }
      }
      if (roots.length > 1) issue(id, null, 'FORK');
      for (const [previousId, bucket] of children) if (bucket.length > 1) issue(id, previousId, 'FORK');
      // Iterative parent-pointer traversal handles disconnected cycles without recursion.
      const checked = new Set<string>();
      for (const event of events) {
        const path = new Set<string>();
        let cursor: ObservationRevision | undefined = event;
        while (cursor && !checked.has(cursor.eventId)) {
          if (path.has(cursor.eventId)) {
            const visited = [...path];
            const cycle = visited.slice(visited.indexOf(cursor.eventId));
            const representative = cycle.reduce((first, next) => compare(first, next) < 0 ? first : next);
            issue(id, representative, 'CYCLE'); break;
          }
          path.add(cursor.eventId);
          cursor = cursor.previousEventId === null ? undefined : byId.get(cursor.previousEventId);
        }
        for (const visited of path) checked.add(visited);
      }
      if (!issuesByParent.has(id)) {
        if (parent.recorded > cutoff) state.status = 'not-yet-recorded';
        else {
          let status: 'active' | 'withdrawn' = 'active';
          let assessment = parent.assessment;
          const audit: ObservationRevisionAuditEntry[] = [];
          let cursor: ObservationRevision | undefined = roots[0];
          while (cursor) {
            const next = transition(status, assessment, cursor);
            if (typeof next === 'string') { issue(id, cursor.eventId, next); break; }
            status = next.status; assessment = next.assessment; audit.push(auditOf(cursor));
            cursor = children.get(cursor.eventId)?.[0];
          }
          if (!issuesByParent.has(id)) {
            state.status = status; state.currentAssessment = assessment;
            state.audit = audit; state.appliedRevisionCount = audit.length;
            state.latestRevisionEventId = audit.at(-1)?.eventId ?? null;
            if (status === 'active') effective.push({ kind: 'derived-observation-assessment', observationEventId: id,
              revisionEventId: state.latestRevisionEventId, observation: derived(parent.observation, assessment) });
          }
        }
      }
    }
    state.issues = [...(issuesByParent.get(id) ?? [])].sort(issueOrder);
    states.push(state);
  }
  return { asOf: new Date(cutoff).toISOString(), effective, states,
    issues: [...issuesByParent.values()].flat().sort(issueOrder) };
}

/**
 * Prepare one candidate against a supplied complete persisted chain. This does
 * not prove persistence, check other event tables or serialize two writers.
 * OR-03 must repeat global idempotency and tail CAS inside its transaction.
 */
export function prepareObservationRevision(input: {
  observation: Observation; revisions: readonly unknown[]; request: unknown; recordedAt: string;
}): { status: 'append' | 'duplicate'; event: ObservationRevision } {
  const request = parseObservationRevisionRequest(input.request);
  const parent = parentOf(input.observation);
  if (request.observationEventId !== parent.observation.eventId) throw new ObservationRevisionError('INVALID_PARENT');
  if (request.eventId === parent.observation.eventId) throw new ObservationRevisionError('EVENT_CONFLICT');
  let duplicate: ObservationRevision | undefined;
  for (const raw of input.revisions) {
    if (attributedId(own(raw, 'eventId')) !== request.eventId) continue;
    const event = parseObservationRevision(raw);
    if (!observationRevisionRequestEqual(requestOf(event), request)) throw new ObservationRevisionError('EVENT_CONFLICT');
    if (duplicate && JSON.stringify(duplicate) !== JSON.stringify(event)) throw new ObservationRevisionError('EVENT_CONFLICT');
    if (event.conceptId !== parent.observation.conceptId || event.sourceRevision !== parent.observation.sourceRevision
      || Date.parse(event.occurredAt) < parent.observed || Date.parse(event.recordedAt) < parent.recorded) throw new ObservationRevisionError('INVALID_CHAIN');
    duplicate = event;
  }
  // A known success keeps its original receipt, even after later decisions.
  if (duplicate) return { status: 'duplicate', event: duplicate };
  let latestReceipt = parent.recorded;
  for (const event of input.revisions) latestReceipt = Math.max(latestReceipt, time(own(event, 'recordedAt')) ?? -Infinity);
  const projection = projectObservationAssessments([parent.observation], input.revisions, new Date(latestReceipt).toISOString());
  const state = projection.states[0];
  if (projection.issues.length || !state || state.status === 'unresolved' || state.status === 'not-yet-recorded') throw new ObservationRevisionError('INVALID_CHAIN');
  if (request.previousEventId !== state.latestRevisionEventId) throw new ObservationRevisionError('PREVIOUS_EVENT_CONFLICT');
  const recorded = time(input.recordedAt);
  const previous = state.audit.at(-1);
  if (recorded === null || recorded < parent.recorded || Date.parse(request.occurredAt) < parent.observed
    || Date.parse(request.occurredAt) > recorded || (previous && (recorded < Date.parse(previous.recordedAt)
      || Date.parse(request.occurredAt) < Date.parse(previous.occurredAt)))) throw new ObservationRevisionError('INVALID_REVISION_TIME');
  const next = transition(state.status, state.currentAssessment!, request);
  if (typeof next === 'string') throw new ObservationRevisionError(next === 'LEARNING_SHAPE_MISMATCH' ? 'INVALID_TRANSITION' : next);
  return { status: 'append', event: parseObservationRevision({ ...request, conceptId: parent.observation.conceptId,
    sourceRevision: parent.observation.sourceRevision, recordedAt: new Date(recorded).toISOString() }) };
}
