import { createHash } from 'node:crypto';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { assignHeadingSectionIds, assignKnowledgeContentBlocks, markdownHeadingText, scanWikiReferences, type BodyRange, type KnowledgeSection, type KnowledgeContentBlock } from '../shared/knowledge-references';
import { normalizeDisplayMath } from './markdown-normalization';

interface Node {
  type: string;
  depth?: number;
  url?: string;
  identifier?: string;
  value?: string;
  children?: Node[];
  position?: { start: { offset?: number }; end: { offset?: number } };
  data?: { hProperties?: Record<string, unknown> };
}
export interface MarkdownReferenceToken {
  rawTarget: string;
  label: string;
  bodyRange: BodyRange;
  syntax: 'markdown' | 'wiki';
  targetPath?: string;
  fragment?: string;
  unsupportedBlock: boolean;
  unsafe: boolean;
}
function parse(body: string): { content: string; tree: Node } {
  const content = normalizeDisplayMath(body);
  const tree = unified().use(remarkParse).use(remarkGfm).use(remarkMath).parse(content) as Node;
  return { content, tree };
}
function range(content: string, startOffset: number, endOffset: number): BodyRange {
  const line = (offset: number) => content.slice(0, offset).split(/\r\n|\n|\r/).length;
  return { coordinateSpace: 'render-markdown-v1', startOffset, endOffset,
    startLine: line(startOffset), endLine: line(Math.max(startOffset, endOffset - 1)) };
}
export function parseMarkdownSections(body: string): KnowledgeSection[] {
  const { content, tree } = parse(body);
  assignHeadingSectionIds(tree);
  const headings: Node[] = [];
  const visit = (node: Node): void => {
    if (node.type === 'heading') headings.push(node);
    node.children?.forEach(visit);
  };
  visit(tree);
  const ancestors: KnowledgeSection[] = [];
  return headings.map((node, index) => {
    const level = node.depth!;
    while (ancestors.length && ancestors.at(-1)!.level >= level) ancestors.pop();
    const title = markdownHeadingText(node);
    const start = node.position!.start.offset!;
    const end = headings.slice(index + 1).find((next) => next.depth! <= level)?.position!.start.offset ?? content.length;
    const section: KnowledgeSection = {
      sectionId: String(node.data!.hProperties!.id), parentId: ancestors.at(-1)?.sectionId ?? null,
      level, title, headingPath: [...ancestors.map((parent) => parent.title), title],
      bodyRange: range(content, start, end),
      contentHash: createHash('sha256').update(content.slice(start, end)).digest('hex'),
    };
    ancestors.push(section);
    return section;
  });
}

export function parseMarkdownContentBlocks(markdown: string, contentPart: 'summary' | 'body'): KnowledgeContentBlock[] {
  const { content, tree } = parse(markdown);
  return assignKnowledgeContentBlocks(tree, content, contentPart);
}
/** Local-note references only; URL links and image attachments are separate channels. */
export function parseMarkdownReferenceTokens(body: string): MarkdownReferenceToken[] {
  const { content, tree } = parse(body);
  const references: MarkdownReferenceToken[] = [];
  const definitions = new Map<string, Node>();
  const collect = (node: Node): void => {
    if (node.type === 'definition' && node.identifier && !definitions.has(node.identifier)) definitions.set(node.identifier, node);
    node.children?.forEach(collect);
  };
  collect(tree);
  const add = (rawTarget: string, label: string, start: number, end: number, syntax: 'markdown' | 'wiki'): void => {
    const target = rawTarget.trim();
    if (!target || /^(?:https?:|mailto:|tel:)/i.test(target) || target.startsWith('//')) return;
    let decoded = target;
    let unsafe = false;
    if (syntax === 'markdown') {
      try { decoded = decodeURIComponent(target); } catch { unsafe = true; }
    }
    unsafe ||= /[\u0000-\u001f\u007f]/.test(decoded) || /^[a-z][a-z\d+.-]*:/i.test(decoded)
      || decoded.startsWith('/') || decoded.includes('\\');
    // Split the URL before decoding: an encoded # can be part of a note name.
    const separator = target.indexOf('#');
    const decode = (value: string): string => {
      if (syntax === 'wiki') return value;
      try { return decodeURIComponent(value); } catch { return value; }
    };
    const targetPath = decode(separator < 0 ? target : target.slice(0, separator));
    const fragment = separator < 0 ? undefined : decode(target.slice(separator + 1));
    references.push({ rawTarget: target, label, syntax, bodyRange: range(content, start, end),
      ...(targetPath ? { targetPath } : {}), ...(fragment !== undefined ? { fragment } : {}),
      unsafe, unsupportedBlock: fragment?.startsWith('^') ?? false });
  };
  const visit = (node: Node): void => {
    if (['code', 'inlineCode', 'math', 'inlineMath', 'html', 'image', 'imageReference', 'definition'].includes(node.type)) return;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if ((node.type === 'link' || node.type === 'linkReference') && start !== undefined && end !== undefined) {
      const target = node.url ?? definitions.get(node.identifier ?? '')?.url;
      if (target) add(target, markdownHeadingText(node), start, end, 'markdown');
      return;
    }
    if (node.type === 'text' && start !== undefined && end !== undefined) {
      const raw = content.slice(start, end);
      for (const match of scanWikiReferences(raw)) {
        if (match.embedded) continue;
        add(match.target, match.label, start + match.index, start + match.index + match.length, 'wiki');
      }
    }
    node.children?.forEach(visit);
  };
  visit(tree);
  return references.sort((a, b) => a.bodyRange.startOffset - b.bodyRange.startOffset);
}
