import type {
  Concept,
  GraphLink,
  KnowledgeGraph,
  Layout,
  LayoutPosition,
  Snapshot,
} from '../shared/types.js';

/** A selectable directory-backed knowledge domain. */
export interface DomainOption {
  /** The normalized parent-directory path, or `__root__` for root notes. */
  id: string;
  /** A short display name, localized for the known domains. */
  label: string;
  /** The full normalized directory path used to distinguish equal leaf names. */
  path: string;
  /** Number of concepts in this domain before the graph display limit. */
  conceptCount: number;
}

export interface ProjectDomainViewOptions {
  selectedId?: string | null;
  expandedIds?: readonly string[];
  limit?: number;
}

export interface CrossDomainNeighbor {
  concept: Concept;
  domainId: string;
  domainLabel: string;
  links: GraphLink[];
}

/** Normalize a source path for stable domain IDs across Windows and POSIX hosts. */
function normalizeSourcePath(value: string): string {
  return value
    .replaceAll('\\', '/')
    .split('/')
    .filter((part) => part.length > 0 && part !== '.')
    .join('/');
}

function domainLeaf(domainId: string): string {
  if (domainId === '__root__') return domainId;
  const parts = domainId.split('/').filter(Boolean);
  return parts.at(-1) ?? '__root__';
}

/**
 * Return the directory domain represented by a concept's source path.
 *
 * The source path is intentionally authoritative here. A frontmatter `domain`
 * value can be useful for ingestion, but directory domains keep the graph
 * switcher deterministic and allow equal leaf names in different branches.
 */
export function domainIdOf(concept: Concept): string {
  const path = normalizeSourcePath(concept.source.path);
  const separator = path.lastIndexOf('/');
  if (separator < 0) return '__root__';
  const parent = path.slice(0, separator);
  return parent || '__root__';
}

const KNOWN_DOMAIN_LABELS: Readonly<Record<string, string>> = {
  __root__: '根目录',
  Math: '数学',
  Model: 'AI / 模型',
  Biology: '生物',
  thought: '思想',
  'history-archaeology': '历史与考古',
  linguistics: '语言学',
  'dl-training': '深度学习训练',
};

/** Return a localized label for a known leaf, otherwise the domain leaf itself. */
export function domainLabel(id: string): string {
  const normalized = normalizeSourcePath(id);
  const leaf = domainLeaf(normalized);
  return KNOWN_DOMAIN_LABELS[leaf] ?? leaf;
}

function compareText(left: string, right: string): number {
  if (left === '__root__') return right === '__root__' ? 0 : 1;
  if (right === '__root__') return -1;
  return left.localeCompare(right, 'zh-Hans-CN') || left.localeCompare(right);
}

/** List all source-path domains in deterministic path order. */
export function listDomains(snapshot: KnowledgeGraph): DomainOption[] {
  const counts = new Map<string, number>();
  for (const concept of snapshot.concepts) {
    const id = domainIdOf(concept);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([id, conceptCount]) => ({
      id,
      label: domainLabel(id),
      path: id === '__root__' ? '' : id,
      conceptCount,
    }));
}

function domainSet(snapshot: KnowledgeGraph): Set<string> {
  return new Set(listDomains(snapshot).map((domain) => domain.id));
}

/**
 * Pick a domain while preserving a user's saved choice whenever it remains
 * available. The server may optionally provide an initial domain hint.
 */
export function chooseDomain(
  snapshot: KnowledgeGraph,
  preferredId?: string | null,
): string | null {
  const available = domainSet(snapshot);
  if (preferredId && available.has(preferredId)) return preferredId;

  const initialDomainId = snapshot.source.initialDomainId;
  if (initialDomainId && available.has(initialDomainId)) return initialDomainId;
  if (available.has('Cognition/Math')) return 'Cognition/Math';

  return listDomains(snapshot)[0]?.id ?? null;
}

function clampLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 20;
  return Math.max(1, Math.min(300, Math.floor(value)));
}

function conceptById(snapshot: KnowledgeGraph): Map<string, Concept> {
  return new Map(snapshot.concepts.map((concept) => [concept.id, concept]));
}

function connectedToVisiblePrimary(
  candidateId: string,
  visiblePrimaryIds: ReadonlySet<string>,
  links: readonly GraphLink[],
): boolean {
  return links.some((link) => (
    (link.source === candidateId && visiblePrimaryIds.has(link.target))
    || (link.target === candidateId && visiblePrimaryIds.has(link.source))
  ));
}

/**
 * Project a snapshot to one directory domain and a small, explicitly requested
 * set of connected cross-domain concepts. This function only selects existing
 * objects; it never changes memory state, anchors, configuration, or timestamps.
 */
export function projectDomainView(
  snapshot: Snapshot,
  domainId: string,
  options: ProjectDomainViewOptions = {},
): Snapshot {
  const normalizedDomainId = normalizeSourcePath(domainId) || '__root__';
  const allConcepts = snapshot.concepts;
  const domainConcepts = allConcepts.filter((concept) => domainIdOf(concept) === normalizedDomainId);
  const primaryCount = domainConcepts.length;
  const limit = clampLimit(options.limit ?? snapshot.source.limit);
  const selectedId = options.selectedId ?? null;
  const selected = selectedId
    ? domainConcepts.find((concept) => concept.id === selectedId)
    : undefined;

  // Keep source order because it is the order produced by the knowledge-source
  // scanner. That makes paging and refreshes stable for a given source.
  const primary = domainConcepts.slice(0, limit);
  if (selected && !primary.some((concept) => concept.id === selected.id)) {
    // Keep the display cap fixed when a focused node is outside the first N:
    // replace the last ordinary node rather than making the graph denser.
    if (primary.length >= limit) primary[primary.length - 1] = selected;
    else primary.push(selected);
  }

  // Use the final primary set when deciding whether an expansion is related.
  const visiblePrimaryIds = new Set(primary.map((concept) => concept.id));

  const expanded = [] as Concept[];
  const visibleIds = new Set(primary.map((concept) => concept.id));
  const byId = conceptById(snapshot);
  const expandedIds = options.expandedIds ?? [];
  for (const expandedId of expandedIds) {
    if (expanded.length >= 6 || visibleIds.size >= 300) break;
    if (typeof expandedId !== 'string' || visibleIds.has(expandedId)) continue;
    const concept = byId.get(expandedId);
    if (!concept || domainIdOf(concept) === normalizedDomainId) continue;
    if (!connectedToVisiblePrimary(concept.id, visiblePrimaryIds, snapshot.links)) continue;
    expanded.push(concept);
    visibleIds.add(concept.id);
  }

  const concepts = [...primary, ...expanded];
  const stateEntries = Object.entries(snapshot.states)
    .filter(([conceptId]) => visibleIds.has(conceptId));
  const links = snapshot.links.filter((link) => visibleIds.has(link.source) && visibleIds.has(link.target));

  return {
    ...snapshot,
    concepts,
    links,
    source: { ...snapshot.source, conceptCount: primaryCount },
    states: Object.fromEntries(stateEntries),
  };
}

/** Return connected concepts outside the selected concept's source directory. */
export function getCrossDomainNeighbors(
  snapshot: Snapshot,
  conceptId: string,
): CrossDomainNeighbor[] {
  const conceptsById = conceptById(snapshot);
  const selected = conceptsById.get(conceptId);
  if (!selected) return [];
  const selectedDomainId = domainIdOf(selected);
  const neighbors = new Map<string, GraphLink[]>();

  for (const link of snapshot.links) {
    let neighborId: string | undefined;
    if (link.source === conceptId) neighborId = link.target;
    else if (link.target === conceptId) neighborId = link.source;
    if (!neighborId || neighborId === conceptId) continue;
    const neighbor = conceptsById.get(neighborId);
    if (!neighbor || domainIdOf(neighbor) === selectedDomainId) continue;
    const links = neighbors.get(neighborId) ?? [];
    if (!links.some((existing) => existing.id === link.id)) links.push(link);
    neighbors.set(neighborId, links);
  }

  return [...neighbors.entries()]
    .map(([neighborId, links]) => {
      const concept = conceptsById.get(neighborId) as Concept;
      return {
        concept,
        domainId: domainIdOf(concept),
        domainLabel: domainLabel(domainIdOf(concept)),
        links: [...links].sort((left, right) => compareText(left.id, right.id)),
      };
    })
    .sort((left, right) => (
      compareText(left.domainId, right.domainId)
      || compareText(left.concept.title, right.concept.title)
      || compareText(left.concept.id, right.concept.id)
    ));
}

/** Merge positions for the visible projection without dropping hidden nodes. */
export function mergeLayout(existing: Layout, visiblePositions: Layout): Layout {
  const merged: Layout = {};
  for (const [id, position] of Object.entries(existing)) {
    merged[id] = clonePosition(position);
  }
  for (const [id, position] of Object.entries(visiblePositions)) {
    merged[id] = clonePosition(position);
  }
  return merged;
}

function clonePosition(position: LayoutPosition): LayoutPosition {
  return { x: position.x, y: position.y, z: position.z };
}
