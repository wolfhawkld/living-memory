import { decodeString } from 'micromark-util-decode-string';

/** Coordinates in normalizeDisplayMath(body), never the original source file. */
export interface BodyRange {
  coordinateSpace: 'render-markdown-v1';
  startOffset: number;
  endOffset: number;
  startLine: number;
  endLine: number;
}
export interface KnowledgeSection {
  sectionId: string;
  parentId: string | null;
  level: number;
  title: string;
  headingPath: string[];
  bodyRange: BodyRange;
  contentHash: string;
}
export interface KnowledgeContentBlock {
  blockId: string;
  contentPart: 'summary' | 'body';
  kind: 'heading' | 'paragraph' | 'list-item' | 'code' | 'table';
  bodyRange: BodyRange;
  sectionId?: string;
}
export type KnowledgeReferenceStatus = 'resolved-document' | 'resolved-section' | 'missing-concept'
  | 'ambiguous' | 'missing-section' | 'unsupported-block' | 'unsafe';
export interface KnowledgeReference {
  referenceId: string;
  sourceConceptId: string;
  sourceRevision: string;
  rawTarget: string;
  label: string;
  syntax: 'markdown' | 'wiki';
  bodyRange: BodyRange;
  targetConceptId?: string;
  targetRevision?: string;
  targetPath?: string;
  fragment?: string;
  sectionId?: string;
  status: KnowledgeReferenceStatus;
}

export interface WikiReferenceMatch {
  index: number;
  length: number;
  embedded: boolean;
  target: string;
  label: string;
}

/** Shared raw-source scanner; callers restrict it to Markdown text nodes. */
export function scanWikiReferences(raw: string): WikiReferenceMatch[] {
  const references: WikiReferenceMatch[] = [];
  for (const match of raw.matchAll(/(!?)\[\[([^\]\n]+)\]\]/g)) {
    let slashes = 0;
    let cursor = match.index;
    while (cursor > 0 && raw[--cursor] === '\\') slashes += 1;
    if (slashes % 2 === 1) continue;
    const [target, ...label] = match[2].split('|');
    references.push({ index: match.index, length: match[0].length,
      embedded: Boolean(match[1]), target: target.trim(), label: label.join('|').trim() || target.trim() });
  }
  return references;
}
export interface KnowledgeReferences {
  conceptId: string;
  sourceRevision: string;
  sections: KnowledgeSection[];
  references: KnowledgeReference[];
  /** Optional only for older clients/fixtures; new metadata includes both parts. */
  blocks?: KnowledgeContentBlock[];
}
interface HeadingNode {
  type?: string;
  value?: string;
  alt?: string;
  depth?: number;
  lang?: string | null;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: HeadingNode[];
  data?: { hProperties?: Record<string, unknown> };
}
export function markdownHeadingText(node: unknown): string {
  const item = node as HeadingNode;
  if (item.type === 'image' || item.type === 'imageReference') return item.alt ?? '';
  if (typeof item.value === 'string') return item.value;
  return item.children?.map(markdownHeadingText).join('') ?? '';
}
export function headingSlug(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]+/gu, '').replace(/[\s_-]+/g, '-') || 'section';
}
/** Global uniqueness includes natural suffixes, not only repeated base titles. */
export function assignHeadingSectionIds(tree: unknown): void {
  const headings: HeadingNode[] = [];
  const visit = (node: HeadingNode): void => {
    if (node.type === 'heading') headings.push(node);
    node.children?.forEach(visit);
  };
  visit(tree as HeadingNode);
  const bases = headings.map((node) => headingSlug(markdownHeadingText(node)));
  const reserved = new Set(bases);
  const used = new Set<string>();
  headings.forEach((node, index) => {
    const base = bases[index];
    let id = base;
    for (let suffix = 2; used.has(id); suffix += 1) {
      id = `${base}-${suffix}`;
      while (reserved.has(id) || used.has(id)) id = `${base}-${++suffix}`;
    }
    used.add(id);
    node.data ??= {};
    node.data.hProperties ??= {};
    node.data.hProperties.id = id;
  });
}
export function remarkKnowledgeHeadingIds(): (tree: unknown) => void {
  return assignHeadingSectionIds;
}

/** The content must already be the renderer's normalizeDisplayMath input. */
export function assignKnowledgeContentBlocks(tree: unknown, normalizedContent: string,
  contentPart: 'summary' | 'body'): KnowledgeContentBlock[] {
  assignHeadingSectionIds(tree);
  const headings: HeadingNode[] = [];
  const collect = (node: HeadingNode): void => {
    if (node.type === 'heading' && node.position?.start.offset !== undefined) headings.push(node);
    node.children?.forEach(collect);
  };
  collect(tree as HeadingNode);
  const sections = headings.map((node, index) => ({
    sectionId: String(node.data!.hProperties!.id), level: node.depth!, start: node.position!.start.offset!,
    end: headings.slice(index + 1).find((next) => next.depth! <= node.depth!)?.position!.start.offset ?? normalizedContent.length,
  }));
  const ignored = new Set(['html', 'math', 'inlineMath', 'footnoteDefinition', 'image', 'imageReference']);
  const hasText = (node: HeadingNode): boolean => {
    if (ignored.has(node.type ?? '') || (node.type === 'code' && node.lang?.toLowerCase() === 'mermaid')) return false;
    if (node.type === 'text') {
      const start = node.position?.start.offset; const end = node.position?.end.offset;
      const raw = start !== undefined && end !== undefined ? normalizedContent.slice(start, end) : node.value ?? '';
      let rest = ''; let last = 0;
      for (const reference of scanWikiReferences(raw)) {
        if (!reference.embedded) continue;
        rest += raw.slice(last, reference.index); last = reference.index + reference.length;
      }
      return Boolean(decodeString(rest + raw.slice(last)).trim());
    }
    if (node.type === 'inlineCode' || node.type === 'code') return Boolean(node.value?.trim());
    return node.children?.some(hasText) ?? false;
  };
  const blocks: KnowledgeContentBlock[] = [];
  const kinds: Record<string, KnowledgeContentBlock['kind']> = {
    heading: 'heading', paragraph: 'paragraph', listItem: 'list-item', code: 'code', table: 'table',
  };
  const line = (offset: number) => normalizedContent.slice(0, offset).split(/\r\n|\n|\r/).length;
  const visit = (node: HeadingNode): void => {
    if (ignored.has(node.type ?? '') || (node.type === 'code' && node.lang?.toLowerCase() === 'mermaid')) return;
    const kind = kinds[node.type ?? ''];
    const start = node.position?.start.offset; const end = node.position?.end.offset;
    const textual = hasText(node);
    if (kind && textual && start !== undefined && end !== undefined && Number.isSafeInteger(start) && Number.isSafeInteger(end)
      && start >= 0 && end > start && end <= normalizedContent.length) {
      const blockId = `block-${contentPart}-${start}-${end}`;
      const section = contentPart === 'body' ? sections.filter((entry) => entry.start <= start && entry.end >= end)
        .sort((left, right) => right.level - left.level)[0] : undefined;
      const block: KnowledgeContentBlock = { blockId, contentPart, kind,
        bodyRange: { coordinateSpace: 'render-markdown-v1', startOffset: start, endOffset: end,
          startLine: line(start), endLine: line(end - 1) }, ...(section ? { sectionId: section.sectionId } : {}) };
      blocks.push(block);
      node.data ??= {}; node.data.hProperties ??= {};
      node.data.hProperties['data-knowledge-block'] = blockId;
      return; // A list/table container owns its descendants; no overlapping reports.
    }
    node.children?.forEach(visit);
  };
  visit(tree as HeadingNode);
  return blocks;
}

export function remarkKnowledgeContentBlocks(options: { contentPart: 'summary' | 'body' }):
  (tree: unknown, file: { value?: unknown }) => void {
  return (tree, file) => {
    if (typeof file.value === 'string') assignKnowledgeContentBlocks(tree, file.value, options.contentPart);
  };
}
