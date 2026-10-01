import type { Concept } from '../shared/types.js';
import { domainIdOf } from '../core/domain-view.js';

/** The compact result window used by the left-column search menu. */
export const DEFAULT_CONCEPT_SEARCH_LIMIT = 8;
export const MAX_CONCEPT_SEARCH_RESULTS = 8;

export type ConceptSearchField = 'title' | 'alias' | 'summary';
export type ConceptSearchMatchKind = 'exact' | 'prefix' | 'contains';

export interface ConceptSearchHit {
  concept: Concept;
  matchedField: ConceptSearchField;
  matchedAlias?: string;
  matchKind: ConceptSearchMatchKind;
  isCurrentDomain: boolean;
}

export interface ConceptSearchResults {
  /** The best matches, capped by the requested limit and the UI maximum. */
  items: ConceptSearchHit[];
  /** Number of matching concepts before the result window was applied. */
  totalMatches: number;
}

export interface ConceptSearchOptions {
  currentDomainId?: string | null;
  limit?: number;
}

/**
 * Make user-entered text comparable with source text. NFKC covers full-width
 * forms (including full-width Latin letters and spaces); lower-casing keeps
 * Latin searches case-insensitive without needing a separate search library.
 */
export function normalizeSearchText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('zh-Hans-CN')
    .replace(/\s+/gu, ' ')
    .trim();
}

interface TextMatch {
  kind: ConceptSearchMatchKind;
  rank: number;
}

interface RankedHit extends ConceptSearchHit {
  rank: number;
  sourceIndex: number;
}

function matchText(value: string, query: string): TextMatch | null {
  const normalized = normalizeSearchText(value);
  if (!normalized || !query) return null;
  if (normalized === query) return { kind: 'exact', rank: 0 };
  if (normalized.startsWith(query)) return { kind: 'prefix', rank: 1 };
  if (normalized.includes(query)) return { kind: 'contains', rank: 2 };
  return null;
}

function normalizedDomainId(value: string): string {
  const normalized = value
    .replaceAll('\\', '/')
    .split('/')
    .filter((part) => part.length > 0 && part !== '.')
    .join('/');
  return normalized || '__root__';
}

function resolveOptions(
  optionsOrDomain: ConceptSearchOptions | string | null | undefined,
): ConceptSearchOptions {
  if (typeof optionsOrDomain === 'string' || optionsOrDomain === null) {
    return { currentDomainId: optionsOrDomain };
  }
  return optionsOrDomain ?? {};
}

function resultLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_CONCEPT_SEARCH_LIMIT;
  return Math.min(MAX_CONCEPT_SEARCH_RESULTS, Math.max(0, Math.floor(value)));
}

/**
 * Search every concept by title, aliases, and summary.
 *
 * A title/alias match is stronger than a summary match, and exact/prefix/
 * substring matches are ordered within each field group. The current domain
 * is then preferred for ties, while source order is retained as the final
 * tie-breaker so duplicate titles remain distinguishable and stable.
 */
export function searchConcepts(
  concepts: readonly Concept[],
  query: string,
  optionsOrDomain: ConceptSearchOptions | string | null = {},
): ConceptSearchResults {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return { items: [], totalMatches: 0 };

  const options = resolveOptions(optionsOrDomain);
  const currentDomainId = options.currentDomainId === null || options.currentDomainId === undefined
    ? null
    : normalizedDomainId(options.currentDomainId);
  const ranked: RankedHit[] = [];

  concepts.forEach((concept, sourceIndex) => {
    const domainId = domainIdOf(concept);
    const candidates: Array<{
      field: ConceptSearchField;
      match: TextMatch;
      alias?: string;
      fieldRank: number;
    }> = [];

    const titleMatch = matchText(concept.title, normalizedQuery);
    if (titleMatch) {
      candidates.push({
        field: 'title',
        match: titleMatch,
        fieldRank: 0,
      });
    }

    concept.aliases.forEach((alias) => {
      const aliasMatch = matchText(alias, normalizedQuery);
      if (!aliasMatch) return;
      candidates.push({
        field: 'alias',
        match: aliasMatch,
        alias,
        // Exact/prefix/contains title and alias matches have equal strength;
        // current-domain priority should be able to break their ties.
        fieldRank: 0,
      });
    });

    const summaryMatch = matchText(concept.summary, normalizedQuery);
    if (summaryMatch) {
      candidates.push({
        field: 'summary',
        match: summaryMatch,
        fieldRank: 30,
      });
    }

    if (candidates.length === 0) return;

    // Names/aliases precede summaries; within each group prefer exact matches
    // over prefixes and substrings before applying current-domain priority.
    const best = candidates.reduce((left, right) => {
      const leftRank = left.match.rank * 10 + left.fieldRank;
      const rightRank = right.match.rank * 10 + right.fieldRank;
      return rightRank < leftRank ? right : left;
    });
    const isCurrentDomain = currentDomainId !== null && domainId === currentDomainId;
    ranked.push({
      concept,
      matchedField: best.field,
      ...(best.alias === undefined ? {} : { matchedAlias: best.alias }),
      matchKind: best.match.kind,
      isCurrentDomain,
      rank: best.match.rank * 10 + best.fieldRank,
      sourceIndex,
    });
  });

  ranked.sort((left, right) => (
    left.rank - right.rank
    || Number(right.isCurrentDomain) - Number(left.isCurrentDomain)
    || left.sourceIndex - right.sourceIndex
  ));

  const limit = resultLimit(options.limit);
  return {
    items: ranked.slice(0, limit).map(({ rank: _rank, sourceIndex: _sourceIndex, ...hit }) => hit),
    totalMatches: ranked.length,
  };
}
