import type { Snapshot } from '../shared/types.js';
import { domainIdOf } from './domain-view.js';

const DEFAULT_LIMIT = 3;
const MAX_LIMIT = 5;

export interface BriefReviewCandidate {
  conceptId: string;
  sourceRevision: string;
  status: 'stale' | 'revisit';
  elapsedDays: number;
  estimated: boolean;
}

interface BriefReviewOptions {
  limit?: number;
  excludedIds?: ReadonlySet<string>;
}

function normalizeDomainId(value: string): string {
  const normalized = value
    .replaceAll('\\', '/')
    .split('/')
    .filter((part) => part.length > 0 && part !== '.')
    .join('/');
  return normalized || '__root__';
}

function resolveLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.max(0, Math.min(MAX_LIMIT, Math.floor(value)));
}

function compareConceptIds(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * Select a small, read-only set of time-driven review candidates for a domain.
 * The source limit only controls graph projection; this selection reads the
 * complete snapshot so a candidate outside that display cap is still eligible.
 */
export function selectBriefReviewCandidates(
  snapshot: Snapshot,
  domainId: string,
  options: BriefReviewOptions = {},
): BriefReviewCandidate[] {
  const limit = resolveLimit(options.limit);
  if (limit === 0) return [];

  const normalizedDomainId = normalizeDomainId(domainId);
  const excludedIds = options.excludedIds;
  const candidates = new Map<string, BriefReviewCandidate>();

  for (const concept of snapshot.concepts) {
    if (domainIdOf(concept) !== normalizedDomainId) continue;
    if (excludedIds?.has(concept.id)) continue;

    const state = snapshot.states[concept.id];
    if (!state || (state.status !== 'stale' && state.status !== 'revisit')) continue;

    const anchor = state.anchor;
    if (
      !anchor
      || anchor.conceptId !== concept.id
      || anchor.sourceRevision !== concept.source.revision
    ) continue;

    const elapsedDays = state.elapsedDays;
    if (
      typeof elapsedDays !== 'number'
      || !Number.isFinite(elapsedDays)
      || elapsedDays < 0
    ) continue;

    const decay = state.decay;
    if (
      typeof decay !== 'number'
      || !Number.isFinite(decay)
      || decay < 0
      || decay > 0.5
    ) continue;

    if (state.retention?.active === true) continue;

    // A malformed snapshot may contain duplicate concept entries. Keep one
    // candidate per ID without changing the source array or its objects.
    if (!candidates.has(concept.id)) {
      candidates.set(concept.id, {
        conceptId: concept.id,
        sourceRevision: concept.source.revision,
        status: state.status,
        elapsedDays,
        estimated: anchor.kind === 'estimated',
      });
    }
  }

  return [...candidates.values()]
    .sort((left, right) => (
      right.elapsedDays - left.elapsedDays
      || compareConceptIds(left.conceptId, right.conceptId)
    ))
    .slice(0, limit);
}
