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
}
interface HeadingNode {
  type?: string;
  value?: string;
  alt?: string;
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
