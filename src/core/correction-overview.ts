import type { CorrectionEvent, CorrectionStatus } from '../shared/corrections.js';
import type {
  ApplicationRecord,
  Concept,
} from '../shared/types.js';
import type {
  CorrectionOverview,
  CorrectionOverviewFilter,
  CorrectionOverviewItem,
} from '../shared/correction-overview.js';
import { domainIdOf } from './domain-view.js';
import { isValidInstant } from './time-model.js';

/** Inputs used to build the metadata-only correction queue. */
export interface CorrectionOverviewInput {
  concepts: readonly Concept[];
  applications: readonly ApplicationRecord[];
  corrections: readonly CorrectionEvent[];
  asOf: string;
}

export interface CorrectionOverviewSelectionOptions {
  domainId?: string;
  query?: string;
  filter?: CorrectionOverviewFilter;
}

function timestamp(value: string): number | null {
  if (!isValidInstant(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function compareIds(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function isVisible(
  occurredAt: string,
  recordedAt: string,
  asOfTimestamp: number,
): boolean {
  const occurred = timestamp(occurredAt);
  const recorded = timestamp(recordedAt);
  return occurred !== null && recorded !== null
    && Number.isFinite(asOfTimestamp)
    && occurred <= asOfTimestamp
    && recorded <= asOfTimestamp;
}

/**
 * Find the tail of a correction chain using its explicit parent links. A
 * malformed branch or cycle is left unresolved rather than guessing that one
 * of its decisions is the current status.
 */
function latestCorrection(
  events: readonly CorrectionEvent[],
): CorrectionEvent | null {
  if (events.length === 0) return null;
  const byId = new Map(events.map((event) => [event.eventId, event]));
  const hasChild = new Set<string>();
  for (const event of events) {
    if (event.previousEventId && byId.has(event.previousEventId)) {
      hasChild.add(event.previousEventId);
    }
  }
  const tails = events.filter((event) => !hasChild.has(event.eventId));
  return tails.length === 1 ? tails[0] : null;
}

function correctionStatusIsPending(item: CorrectionOverviewItem): boolean {
  return item.status === 'open' || item.needsRecheck;
}

function matchesFilter(item: CorrectionOverviewItem, filter: CorrectionOverviewFilter): boolean {
  switch (filter) {
    case 'open':
      return item.status === 'open';
    case 'recheck':
      return item.needsRecheck;
    case 'resolved':
      return item.status === 'resolved' && !item.needsRecheck;
    case 'dismissed':
      return item.status === 'dismissed';
    case 'all':
      return true;
    case 'actionable':
    default:
      return correctionStatusIsPending(item);
  }
}

function selectionTime(item: CorrectionOverviewItem): number {
  return timestamp(item.latestOccurredAt ?? item.occurredAt) ?? Number.NEGATIVE_INFINITY;
}

function compareOverviewItems(left: CorrectionOverviewItem, right: CorrectionOverviewItem): number {
  const leftPending = correctionStatusIsPending(left) ? 1 : 0;
  const rightPending = correctionStatusIsPending(right) ? 1 : 0;
  if (leftPending !== rightPending) return rightPending - leftPending;

  const leftTime = selectionTime(left);
  const rightTime = selectionTime(right);
  if (leftTime !== rightTime) return rightTime - leftTime;
  return compareIds(left.applicationEventId, right.applicationEventId);
}

/** Build a correction queue without returning suggestions, notes, or content. */
export function buildCorrectionOverview({
  concepts,
  applications,
  corrections,
  asOf,
}: CorrectionOverviewInput): CorrectionOverview {
  const asOfTimestamp = timestamp(asOf) ?? Number.NaN;
  const conceptsById = new Map<string, Concept>();
  for (const concept of concepts) {
    // The source index should contain one current concept per ID. Keeping the
    // first entry makes duplicate/legacy input deterministic.
    if (!conceptsById.has(concept.id)) conceptsById.set(concept.id, concept);
  }

  const visibleCorrectionsByApplication = new Map<string, CorrectionEvent[]>();
  for (const correction of corrections) {
    if (!isVisible(correction.occurredAt, correction.recordedAt, asOfTimestamp)) continue;
    const bucket = visibleCorrectionsByApplication.get(correction.applicationEventId);
    if (bucket) bucket.push(correction);
    else visibleCorrectionsByApplication.set(correction.applicationEventId, [correction]);
  }

  const items: CorrectionOverviewItem[] = [];
  let unavailableCount = 0;
  for (const application of applications) {
    if (!application.correction.trim()) continue;
    if (!isVisible(application.occurredAt, application.recordedAt, asOfTimestamp)) continue;

    const concept = conceptsById.get(application.conceptId);
    if (!concept) {
      unavailableCount += 1;
      continue;
    }

    const latest = latestCorrection(visibleCorrectionsByApplication.get(application.eventId) ?? []);
    const currentRevision = concept.source.revision;
    const reviewedRevision = latest?.sourceRevision ?? null;
    const status: CorrectionStatus = latest?.status ?? 'open';
    items.push({
      applicationEventId: application.eventId,
      conceptId: application.conceptId,
      title: concept.title,
      domainId: domainIdOf(concept),
      sourceRevision: currentRevision,
      applicationRevision: application.sourceRevision,
      kind: application.kind,
      occurredAt: application.occurredAt,
      recordedAt: application.recordedAt,
      status,
      latestEventId: latest?.eventId ?? null,
      latestOccurredAt: latest?.occurredAt ?? null,
      reviewedRevision,
      sourceChanged: application.sourceRevision !== currentRevision,
      needsRecheck: status === 'resolved' && reviewedRevision !== currentRevision,
    });
  }

  return { items, unavailableCount };
}

/** Filter and prioritize correction items for a focused maintenance queue. */
export function selectCorrectionOverviewItems(
  items: readonly CorrectionOverviewItem[],
  { domainId, query, filter = 'actionable' }: CorrectionOverviewSelectionOptions = {},
): CorrectionOverviewItem[] {
  const normalizedQuery = query?.trim().toLowerCase();
  const selected = items.filter((item) => {
    if (domainId !== undefined && item.domainId !== domainId) return false;
    if (!matchesFilter(item, filter)) return false;
    if (normalizedQuery
      && !item.title.toLowerCase().includes(normalizedQuery)
      && !item.conceptId.toLowerCase().includes(normalizedQuery)
      && !item.applicationEventId.toLowerCase().includes(normalizedQuery)) return false;
    return true;
  });
  return [...selected].sort(compareOverviewItems);
}
