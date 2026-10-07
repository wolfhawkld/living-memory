import type { GraphLink, KnowledgeGraph } from '../shared/types.js';
import { domainIdOf } from './domain-view.js';

export interface DomainVisibilitySummary {
  domainTotalNodes: number;
  visiblePrimaryNodes: number;
  hiddenPrimaryNodes: number;
  visibleCrossDomainNodes: number;
  totalInternalLinks: number;
  visibleInternalLinks: number;
  hiddenInternalLinks: number;
}

function relationKey(link: GraphLink): string {
  return JSON.stringify([link.id, link.source, link.target]);
}

/** Count the source domain against the graph actually rendered, without changing it. */
export function summarizeDomainVisibility(
  full: KnowledgeGraph,
  view: KnowledgeGraph,
  domainId: string,
): DomainVisibilitySummary {
  const normalizedDomain = domainId.replaceAll('\\', '/').split('/')
    .filter(part => part.length > 0 && part !== '.').join('/') || '__root__';
  const allIds = new Set(full.concepts.map(concept => concept.id));
  const primaryIds = new Set(full.concepts.filter(concept => domainIdOf(concept) === normalizedDomain)
    .map(concept => concept.id));
  const visibleIds = new Set(view.concepts.filter(concept => allIds.has(concept.id)).map(concept => concept.id));
  const visiblePrimaryIds = new Set([...visibleIds].filter(id => primaryIds.has(id)));
  const visibleRelations = new Set(view.links.map(relationKey));
  const internalLinks = full.links.filter(link => primaryIds.has(link.source) && primaryIds.has(link.target));
  const visibleInternalLinks = internalLinks.filter(link => visiblePrimaryIds.has(link.source)
    && visiblePrimaryIds.has(link.target) && visibleRelations.has(relationKey(link))).length;
  return {
    domainTotalNodes: primaryIds.size,
    visiblePrimaryNodes: visiblePrimaryIds.size,
    hiddenPrimaryNodes: primaryIds.size - visiblePrimaryIds.size,
    visibleCrossDomainNodes: visibleIds.size - visiblePrimaryIds.size,
    totalInternalLinks: internalLinks.length,
    visibleInternalLinks,
    hiddenInternalLinks: internalLinks.length - visibleInternalLinks,
  };
}
