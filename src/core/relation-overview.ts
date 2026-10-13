import type { ApplicationRecord, Concept, GraphLink } from '../shared/types.js';
import type { RelationReviewEvent } from '../shared/relation-reviews.js';
import { buildRelationReviewBasis, relationReviewBasisEqual, relationReviewMatches, validateRelationReviewBasis } from '../shared/relation-reviews.js';
import type { RelationOverview, RelationOverviewFilter, RelationOverviewItem } from '../shared/relation-overview.js';
import { relationOverviewIsActionable } from '../shared/relation-overview.js';
import { domainIdOf } from './domain-view.js';
import { isValidInstant } from './time-model.js';

export { relationOverviewIsActionable } from '../shared/relation-overview.js';

export interface RelationOverviewInput {
  concepts: readonly Concept[];
  links: readonly GraphLink[];
  applications: readonly ApplicationRecord[];
  reviews: readonly RelationReviewEvent[];
  asOf: string;
}

export interface RelationOverviewSelectionOptions {
  domainId?: string;
  query?: string;
  filter?: RelationOverviewFilter;
}

function time(value: string): number {
  return isValidInstant(value) ? Date.parse(value) : Number.NaN;
}

function visible(event: { occurredAt: string; recordedAt: string }, asOf: number): boolean {
  return time(event.occurredAt) <= asOf && time(event.recordedAt) <= asOf;
}

/** Follow every predecessor; never choose a timestamp winner from a malformed chain. */
function reviewChain(application: ApplicationRecord, events: readonly RelationReviewEvent[], duplicateIds: ReadonlySet<string>): { latest: RelationReviewEvent | null; invalid: boolean } {
  if (!events.length) return { latest: null, invalid: false };
  const invalid = { latest: null, invalid: true };
  const byId = new Map(events.map((event) => [event.eventId, event]));
  if (byId.size !== events.length) return invalid;
  const children = new Map<string, number>();
  for (const event of events) {
    if (duplicateIds.has(event.eventId)
      || event.applicationEventId !== application.eventId || event.conceptId !== application.conceptId
      || !['open', 'resolved', 'dismissed'].includes(event.status)
      || time(event.recordedAt) < time(event.occurredAt)) return invalid;
    try { validateRelationReviewBasis(application.relationSuggestion!, event.basis); }
    catch { return invalid; }
    const parent = event.previousEventId === null ? null : byId.get(event.previousEventId);
    if (event.previousEventId !== null && !parent) return invalid;
    if (time(event.occurredAt) < time(parent?.occurredAt ?? application.occurredAt)) return invalid;
    if (parent) {
      const count = (children.get(parent.eventId) ?? 0) + 1;
      if (count > 1) return invalid;
      children.set(parent.eventId, count);
    }
  }
  const tails = events.filter((event) => !children.has(event.eventId));
  if (tails.length !== 1) return invalid;
  const visited = new Set<string>();
  let cursor: RelationReviewEvent | undefined = tails[0];
  while (cursor) {
    if (visited.has(cursor.eventId)) return invalid;
    visited.add(cursor.eventId);
    cursor = cursor.previousEventId === null ? undefined : byId.get(cursor.previousEventId);
  }
  return visited.size === events.length ? { latest: tails[0], invalid: false } : invalid;
}

/** Build from the full graph, returning only identities, state and exact-tuple presence. */
export function buildRelationOverview({ concepts, links, applications, reviews, asOf }: RelationOverviewInput): RelationOverview {
  const cutoff = time(asOf);
  const conceptsById = new Map<string, Concept>();
  for (const concept of concepts) if (!conceptsById.has(concept.id)) conceptsById.set(concept.id, concept);
  const reviewsByApplication = new Map<string, RelationReviewEvent[]>();
  const ids = new Set<string>();
  const duplicateIds = new Set<string>();
  for (const review of reviews) {
    if (!visible(review, cutoff)) continue;
    if (ids.has(review.eventId)) duplicateIds.add(review.eventId);
    ids.add(review.eventId);
    const bucket = reviewsByApplication.get(review.applicationEventId) ?? [];
    bucket.push(review);
    reviewsByApplication.set(review.applicationEventId, bucket);
  }
  const items: RelationOverviewItem[] = [];
  let unavailableCount = 0;
  for (const application of applications) {
    const suggestion = application.relationSuggestion;
    if (!suggestion || !visible(application, cutoff)) continue;
    const concept = conceptsById.get(application.conceptId);
    if (!concept) { unavailableCount += 1; continue; }
    const basis = buildRelationReviewBasis(suggestion, concepts, links);
    const { latest, invalid } = reviewChain(application, reviewsByApplication.get(application.eventId) ?? [], duplicateIds);
    const status = invalid ? null : latest?.status ?? 'open';
    const basisChanged = latest !== null && !relationReviewBasisEqual(latest.basis, basis);
    items.push({
      applicationEventId: application.eventId, conceptId: concept.id, title: concept.title,
      domainId: domainIdOf(concept), sourceRevision: concept.source.revision,
      applicationRevision: application.sourceRevision, kind: application.kind,
      occurredAt: application.occurredAt, recordedAt: application.recordedAt,
      operation: suggestion.operation,
      source: { ...(basis.source.current ?? suggestion.source) },
      target: { ...(basis.target.current ?? suggestion.target) },
      status, latestEventId: latest?.eventId ?? null, latestOccurredAt: latest?.occurredAt ?? null,
      basis, basisChanged, needsRecheck: status === 'resolved' && basisChanged,
      chainInvalid: invalid,
      structureMatches: basis.source.current && basis.target.current ? relationReviewMatches(suggestion, basis) : null,
      sourceChanged: application.sourceRevision !== concept.source.revision,
    });
  }
  return { items, unavailableCount };
}

function matchesFilter(item: RelationOverviewItem, filter: RelationOverviewFilter): boolean {
  switch (filter) {
    case 'open': return item.status === 'open';
    case 'recheck': return item.needsRecheck;
    case 'resolved': return item.status === 'resolved' && !item.needsRecheck;
    case 'dismissed': return item.status === 'dismissed';
    case 'all': return true;
    default: return relationOverviewIsActionable(item);
  }
}

export function selectRelationOverviewItems(items: readonly RelationOverviewItem[], { domainId, query, filter = 'actionable' }: RelationOverviewSelectionOptions = {}): RelationOverviewItem[] {
  const normalized = query?.trim().toLowerCase();
  return items.filter((item) => (domainId === undefined || item.domainId === domainId)
    && matchesFilter(item, filter)
    && (!normalized || [item.title, item.conceptId, item.source.title, item.source.conceptId, item.target.title, item.target.conceptId, item.applicationEventId].some((value) => value.toLowerCase().includes(normalized))))
    .sort((left, right) => {
      const pending = Number(relationOverviewIsActionable(right)) - Number(relationOverviewIsActionable(left));
      if (pending) return pending;
      const elapsed = time(right.latestOccurredAt ?? right.occurredAt) - time(left.latestOccurredAt ?? left.occurredAt);
      if (elapsed) return elapsed;
      return left.applicationEventId < right.applicationEventId ? -1 : left.applicationEventId > right.applicationEventId ? 1 : 0;
    });
}
