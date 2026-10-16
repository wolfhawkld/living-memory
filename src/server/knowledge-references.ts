import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { parseMarkdownReferenceTokens, parseMarkdownSections } from '../core/markdown-sections.js';
import type { Concept } from '../shared/types.js';
import type { KnowledgeReference, KnowledgeReferences, KnowledgeSection } from '../shared/knowledge-references.js';
import type { KnowledgeSource } from './kg.js';
import { StoreError } from './store.js';

interface SourceCache {
  paths: Map<string, Concept>;
  names: Map<string, Concept[]>;
  sections: Map<string, KnowledgeSection[]>;
  pages: Map<string, KnowledgeReferences>;
}

// A refresh replaces the source object, so old versions can be garbage collected.
const sources = new WeakMap<KnowledgeSource, SourceCache>();
const normal = (value: string) => value.normalize('NFKC').trim().toLowerCase();
const withoutExtension = (value: string) => value.replace(/\.md$/i, '');

function cacheFor(source: KnowledgeSource): SourceCache {
  const existing = sources.get(source);
  if (existing) return existing;
  const cache: SourceCache = { paths: new Map(), names: new Map(), sections: new Map(), pages: new Map() };
  for (const concept of source.index.concepts) {
    const path = concept.source.path.replaceAll('\\', '/');
    cache.paths.set(path, concept);
    const keys = new Set([path, withoutExtension(path), posix.basename(withoutExtension(path)), concept.title, ...concept.aliases].map(normal));
    for (const key of keys) {
      if (!key) continue;
      const matches = cache.names.get(key) ?? [];
      matches.push(concept);
      cache.names.set(key, matches);
    }
  }
  sources.set(source, cache);
  return cache;
}

function sectionsFor(cache: SourceCache, concept: Concept): KnowledgeSection[] {
  let sections = cache.sections.get(concept.id);
  if (!sections) {
    sections = parseMarkdownSections(concept.body);
    cache.sections.set(concept.id, sections);
  }
  return sections;
}

function targetFor(cache: SourceCache, from: Concept, path: string): { concept?: Concept; unsafe?: boolean; ambiguous?: boolean } {
  if (!path) return { concept: from };
  if (/[\u0000-\u001f\u007f\\]/.test(path) || /^(?:\/|[a-z][a-z\d+.-]*:)/i.test(path) || path.includes('?')) return { unsafe: true };
  const relative = posix.normalize(posix.join(posix.dirname(from.source.path), path));
  if (relative === '..' || relative.startsWith('../')) return { unsafe: true };
  const candidates = [relative, relative.endsWith('.md') ? relative : `${relative}.md`, path, withoutExtension(path)];
  for (const candidate of candidates) {
    const exact = cache.paths.get(candidate);
    if (exact) return { concept: exact };
  }
  const found = new Map<string, Concept>();
  for (const candidate of candidates) for (const concept of cache.names.get(normal(candidate)) ?? []) found.set(concept.id, concept);
  if (found.size === 1) return { concept: [...found.values()][0] };
  return found.size > 1 ? { ambiguous: true } : {};
}

function sectionFor(sections: KnowledgeSection[], fragment: string, syntax: 'markdown' | 'wiki') {
  // Wiki fragments name a heading; Markdown fragments normally name its slug.
  // Repeated human titles remain ambiguous rather than silently picking one.
  const titles = sections.filter((section) => normal(section.title) === normal(fragment)
    || section.headingPath.map(normal).join('#') === fragment.split('#').map(normal).join('#'));
  const ids = sections.filter((section) => section.sectionId === fragment);
  const matches = syntax === 'wiki' ? titles.length ? titles : ids : ids.length ? ids : titles;
  return matches.length === 1 ? { section: matches[0] } : { ambiguous: matches.length > 1 };
}

/** Metadata only, scoped to this already-authorized complete source index. */
export function getKnowledgeReferences(source: KnowledgeSource, conceptId: string, sourceRevision: string): KnowledgeReferences {
  const concept = source.index.concepts.find((item) => item.id === conceptId);
  if (!concept) throw new StoreError('CONCEPT_NOT_FOUND', '找不到当前知识空间中的概念。', 404);
  if (concept.source.revision !== sourceRevision) throw new StoreError('SOURCE_CHANGED', '资料版本已变化，请重新加载后核对原引用。', 409);
  const cache = cacheFor(source);
  const existing = cache.pages.get(concept.id);
  if (existing) return existing;
  const references = parseMarkdownReferenceTokens(concept.body).map((token): KnowledgeReference => {
    const referenceId = `reference_${createHash('sha256').update(JSON.stringify([
      concept.id, concept.source.revision, token.syntax, token.rawTarget, token.bodyRange.startOffset, token.bodyRange.endOffset,
    ])).digest('hex').slice(0, 32)}`;
    const item: KnowledgeReference = {
      referenceId, sourceConceptId: concept.id, sourceRevision: concept.source.revision,
      rawTarget: token.rawTarget, label: token.label, bodyRange: token.bodyRange,
      syntax: token.syntax,
      ...(token.fragment !== undefined ? { fragment: token.fragment } : {}), status: 'missing-concept',
    };
    if (token.unsafe) return { ...item, status: 'unsafe' };
    const result = targetFor(cache, concept, token.targetPath ?? '');
    if (result.unsafe) return { ...item, status: 'unsafe' };
    if (result.ambiguous) return { ...item, status: 'ambiguous' };
    const target = result.concept;
    if (!target) return item;
    const resolved = { ...item, targetConceptId: target.id, targetRevision: target.source.revision, targetPath: target.source.path };
    if (token.unsupportedBlock) return { ...resolved, status: 'unsupported-block' };
    if (!token.fragment) return { ...resolved, status: 'resolved-document' };
    const match = sectionFor(sectionsFor(cache, target), token.fragment, token.syntax);
    if (match.section) return { ...resolved, sectionId: match.section.sectionId, status: 'resolved-section' };
    return { ...resolved, status: match.ambiguous ? 'ambiguous' : 'missing-section' };
  });
  const result = { conceptId: concept.id, sourceRevision: concept.source.revision, sections: sectionsFor(cache, concept), references };
  cache.pages.set(concept.id, result);
  return result;
}
