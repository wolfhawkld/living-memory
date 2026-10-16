import { useEffect, useId, useMemo, type AnchorHTMLAttributes, type ReactElement, type ReactNode } from 'react';
import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { decodeString } from 'micromark-util-decode-string';
import { MarkdownImage } from './MarkdownImage';
import { isImageReference, markdownImageUrl, type MarkdownMediaSource } from './markdown-media';
import { MermaidDiagram } from './MermaidDiagram';
import { normalizeDisplayMath } from './markdown-math';
import { remarkKnowledgeHeadingIds, remarkKnowledgeContentBlocks, scanWikiReferences, type KnowledgeReference } from '../shared/knowledge-references';

export interface MarkdownContentProps {
  content: string;
  compact?: boolean;
  contentPart?: 'summary' | 'body';
  source?: MarkdownMediaSource;
  references?: readonly KnowledgeReference[];
  onNavigateReference?: (reference: KnowledgeReference) => void;
  onNavigateSection?: (sectionId: string) => void;
  onRendered?: () => void;
}

type MarkdownNode = {
  type: string;
  value?: unknown;
  url?: string;
  alt?: string;
  children?: MarkdownNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
  data?: {
    hProperties?: Record<string, unknown>;
  };
};

type HastNode = {
  type: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

type MarkdownAnchorProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  node?: unknown;
};

type MarkdownTableProps = ExtraProps & {
  children?: ReactNode;
};

type MarkdownCodeProps = {
  children?: ReactNode;
  className?: string;
};

type MarkdownPreProps = ExtraProps & {
  children?: ReactNode;
};

const WIKI_SKIP_NODES = new Set(['code', 'inlineCode', 'math', 'inlineMath', 'html', 'link', 'linkReference', 'definition']);
const ID_REFERENCE_PROPERTIES = new Set([
  'ariaDescribedBy',
  'aria-describedby',
  'ariaLabelledBy',
  'aria-labelledby',
  'headers',
  'htmlFor',
  'for',
]);

function decodedText(value: string): string {
  return decodeString(value);
}

function splitWikiLinks(node: MarkdownNode, content: string): MarkdownNode[] | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (typeof node.value !== 'string' || start === undefined || end === undefined) return null;
  const raw = content.slice(start, end);
  // Text positions use the normalized Markdown source. Never guess after an
  // unfamiliar parser transform: an unbound, readable wiki token is safer.
  if (decodedText(raw) !== node.value) return null;
  const matches = scanWikiReferences(raw);
  if (!matches.length) return null;
  const nodes: MarkdownNode[] = [];
  let previous = 0;
  for (const match of matches) {
    const offset = decodedText(raw.slice(0, match.index)).length;
    const finish = decodedText(raw.slice(0, match.index + match.length)).length;
    if (offset < previous) return null;
    if (offset > previous) nodes.push({ type: 'text', value: node.value.slice(previous, offset) });
    const target = match.target;
    const label = decodedText(match.label);
    if (match.embedded && isImageReference(target)) {
      const size = match.label.trim().match(/^(\d{1,4})(?:x(\d{1,4}))?$/);
      const width = size && Number(size[1]) > 0 && Number(size[1]) <= 5000 ? Number(size[1]) : undefined;
      const height = width && size?.[2] && Number(size[2]) > 0 && Number(size[2]) <= 5000 ? Number(size[2]) : undefined;
      nodes.push({ type: 'image', url: target, alt: size ? target.split('/').at(-1) ?? target : label,
        data: { hProperties: { 'data-wiki-target': target, ...(width ? { width } : {}), ...(height ? { height } : {}) } } });
    } else if (match.embedded) nodes.push({ type: 'text', value: label });
    else nodes.push({ type: 'link', url: '#', children: [{ type: 'text', value: label }], data: { hProperties: {
      'data-wiki-reference': true, 'data-reference-syntax': 'wiki', 'data-reference-offset': start + match.index,
    } } });
    previous = finish;
  }
  if (previous < node.value.length) nodes.push({ type: 'text', value: node.value.slice(previous) });
  return nodes;
}

function rewriteWikiLinks(node: MarkdownNode, content: string): void {
  if (node.type === 'heading' && typeof node.data?.hProperties?.id === 'string') {
    node.data.hProperties['data-knowledge-section'] = node.data.hProperties.id;
  }
  if (node.type === 'link' || node.type === 'linkReference') {
    const offset = node.position?.start.offset;
    if (offset !== undefined) {
      node.data ??= {};
      node.data.hProperties ??= {};
      Object.assign(node.data.hProperties, { 'data-reference-syntax': 'markdown', 'data-reference-offset': offset });
    }
  }
  if (WIKI_SKIP_NODES.has(node.type) || !node.children) return;
  const nextChildren: MarkdownNode[] = [];
  for (const child of node.children) {
    if (child.type === 'text') nextChildren.push(...(splitWikiLinks(child, content) ?? [child]));
    else { rewriteWikiLinks(child, content); nextChildren.push(child); }
  }
  node.children = nextChildren;
}

/** Preserve original source coordinates and escapes when rendering wiki links. */
function remarkWikiLinks() {
  return (tree: unknown, file: { value?: unknown }) => {
    if (tree && typeof tree === 'object' && typeof file.value === 'string') rewriteWikiLinks(tree as MarkdownNode, file.value);
  };
}

function safeUrlTransform(url: string): string {
  const candidate = url.trim();
  if (!candidate || /[\u0000-\u001f\u007f]/.test(candidate)) return '';

  // Local document navigation remains separate from image attachment loading.
  if (candidate.startsWith('#')) return candidate;
  if (!/^(?:https?:|mailto:)/i.test(candidate)) return '';

  try {
    const parsed = new URL(candidate);
    const protocol = parsed.protocol.toLowerCase();
    return protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:'
      ? candidate
      : '';
  } catch {
    return '';
  }
}

function isExternalUrl(url: string): boolean {
  return /^(?:https?:|mailto:)/i.test(url);
}

function scopeId(prefix: string, value: string): string {
  return `${prefix}-${value}`;
}

function scopeIdReferences(prefix: string, value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((reference) => typeof reference === 'string' ? scopeId(prefix, reference) : reference);
  }
  if (typeof value !== 'string') return value;
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((reference) => scopeId(prefix, reference))
    .join(' ');
}

/** Scope every generated id and local fragment in one Markdown instance. */
function createScopeIdsPlugin(prefix: string) {
  return () => (tree: unknown) => {
    const sectionIds = new Set<string>();
    const collect = (node: HastNode): void => {
      const logicalId = node.properties?.['data-knowledge-section'];
      if (typeof logicalId === 'string') sectionIds.add(logicalId);
      node.children?.forEach(collect);
    };
    if (tree && typeof tree === 'object') collect(tree as HastNode);
    const visit = (node: HastNode): void => {
      if (node.type === 'element' && node.properties) {
        const properties = node.properties;
        if (typeof properties.id === 'string' && properties.id) {
          properties.id = scopeId(prefix, typeof properties['data-knowledge-section'] === 'string' ? `section-${properties.id}` : properties.id);
        }
        if (typeof properties.href === 'string' && properties.href.startsWith('#') && properties.href.length > 1) {
          const target = safelyDecodeTarget(properties.href.slice(1));
          const footnote = ['dataFootnoteRef', 'dataFootnoteBackref', 'data-footnote-ref', 'data-footnote-backref']
            .some((key) => properties[key] !== undefined);
          properties.href = `#${scopeId(prefix, !footnote && sectionIds.has(target) ? `section-${target}` : target)}`;
        }
        for (const property of ID_REFERENCE_PROPERTIES) {
          if (properties[property]) properties[property] = scopeIdReferences(prefix, properties[property]);
        }
      }
      node.children?.forEach(visit);
    };
    if (tree && typeof tree === 'object') visit(tree as HastNode);
  };
}

function MarkdownLink({
  children,
  href,
  node: _node,
  rel: _rel,
  target: _target,
  ...rest
}: MarkdownAnchorProps): ReactElement {
  const safeHref = href ? safeUrlTransform(href) : '';
  if (!safeHref) {
    return (
      <span className="markdown-content-link-placeholder" title="此链接暂不可用">
        {children || '链接'}
        <span aria-hidden="true">（链接暂不可用）</span>
      </span>
    );
  }

  const external = isExternalUrl(safeHref);
  return (
    <a
      {...rest}
      href={safeHref}
      target={external ? '_blank' : undefined}
      rel={external ? 'noopener noreferrer' : undefined}
    >
      {children}
    </a>
  );
}

function MarkdownTable({ children, node }: MarkdownTableProps): ReactElement {
  return (
    <div className="markdown-content-table-wrap" data-knowledge-block={typeof node?.properties['data-knowledge-block'] === 'string' ? node.properties['data-knowledge-block'] : undefined}>
      <table>{children}</table>
    </div>
  );
}

function MarkdownCode({ children, className }: MarkdownCodeProps): ReactElement {
  const language = className?.match(/(?:^|\s)language-([\w-]+)/)?.[1];
  const classes = ['markdown-content-code', language ? `language-${language}` : '']
    .filter(Boolean)
    .join(' ');
  return <code className={classes}>{children}</code>;
}

function MarkdownPre({ children, node }: MarkdownPreProps): ReactElement {
  const block = node?.children.find((child) => child.type === 'element' && child.tagName === 'code');
  if (block?.type === 'element') {
    const classes = block.properties.className;
    const languages = Array.isArray(classes) ? classes : [];
    if (languages.some((value) => String(value).toLowerCase() === 'language-mermaid')) {
      const code = block.children.filter((child) => child.type === 'text').map((child) => child.value).join('');
      return <MermaidDiagram key={code} code={code} />;
    }
  }
  const marker = node?.properties['data-knowledge-block'] ?? (block?.type === 'element' ? block.properties['data-knowledge-block'] : undefined);
  return <pre className="markdown-content-pre" data-knowledge-block={typeof marker === 'string' ? marker : undefined}>{children}</pre>;
}

function createMarkdownComponents(source: MarkdownMediaSource | undefined, references: readonly KnowledgeReference[] | undefined,
  onNavigateReference: MarkdownContentProps['onNavigateReference'], onNavigateSection: MarkdownContentProps['onNavigateSection']): Components {
  return {
    a: ({ node, ...props }) => {
      const wikiTarget = node?.properties['data-wiki-reference'];
      const syntax = node?.properties['data-reference-syntax'];
      const offset = node?.properties['data-reference-offset'];
      const reference = references?.find((entry) => entry.syntax === syntax && entry.bodyRange.startOffset === Number(offset));
      if (reference && onNavigateReference) return <button type="button" className="markdown-reference-link" data-reference-id={reference.referenceId}
        onClick={() => onNavigateReference(reference)}>{props.children}</button>;
      if (wikiTarget) return <span className="markdown-content-link-placeholder" title="此引用暂不可用">{props.children}<span>（引用暂不可用）</span></span>;
      const footnote = ['dataFootnoteRef', 'dataFootnoteBackref', 'data-footnote-ref', 'data-footnote-backref']
        .some((key) => node?.properties[key] !== undefined);
      if (props.href?.startsWith('#') && onNavigateSection && !footnote) return <button type="button" className="markdown-reference-link"
        onClick={() => onNavigateSection(safelyDecodeTarget(props.href!.slice(1)))}>{props.children}</button>;
      const safeProps = { ...props };
      delete (safeProps as Record<string, unknown>)['data-reference-syntax'];
      delete (safeProps as Record<string, unknown>)['data-reference-offset'];
      return <MarkdownLink {...safeProps} />;
    },
    code: MarkdownCode,
    img: ({ node, ...props }) => {
      // Keep wiki targets literal: mdast encodes image URLs, but Obsidian filenames
      // may contain literal percent signs and use vault-wide attachment lookup.
      const wikiTarget = node?.properties['data-wiki-target'];
      const src = typeof wikiTarget === 'string'
        ? /^https?:\/\//i.test(wikiTarget) ? wikiTarget : `![[${wikiTarget}]]`
        : props.src;
      return <MarkdownImage {...props} src={src} source={source} />;
    },
    pre: MarkdownPre,
    table: MarkdownTable,
  };
}

function safelyDecodeTarget(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

export function MarkdownContent({ content, compact = false, contentPart = 'body', source, references, onNavigateReference, onNavigateSection, onRendered }: MarkdownContentProps): ReactElement {
  const instanceId = useId();
  const scopePrefix = `markdown-${instanceId.replace(/[^A-Za-z0-9_-]/g, '-')}`;
  const components = useMemo(() => createMarkdownComponents(source, references, onNavigateReference, onNavigateSection ? (id) => onNavigateSection(id.startsWith(`${scopePrefix}-section-`) ? id.slice(scopePrefix.length + 9) : id.startsWith(`${scopePrefix}-`) ? id.slice(scopePrefix.length + 1) : id) : undefined), [source?.sourceId, source?.conceptId, source?.sourceRevision, references, onNavigateReference, onNavigateSection, scopePrefix]);

  useEffect(() => { onRendered?.(); }, [content, onRendered]);

  return (
    <div className={`markdown-content${compact ? ' markdown-content-compact' : ''}`}>
      <ReactMarkdown
        allowElement={(element) => element.tagName !== 'script' && element.tagName !== 'style'}
        components={components}
        remarkRehypeOptions={{ allowDangerousHtml: false }}
        remarkPlugins={[remarkGfm, remarkMath, remarkKnowledgeHeadingIds, [remarkKnowledgeContentBlocks, { contentPart }], remarkWikiLinks]}
        rehypePlugins={[[rehypeKatex, {
          errorColor: 'var(--ui-warning, #f4bd70)',
          strict: 'ignore',
          throwOnError: false,
          trust: false,
        }], createScopeIdsPlugin(scopePrefix)]}
        skipHtml
        urlTransform={(url, key, node) => node.tagName === 'img' && key === 'src'
          ? markdownImageUrl(url, source) ? url : ''
          : safeUrlTransform(url)}
      >
        {normalizeDisplayMath(content)}
      </ReactMarkdown>
    </div>
  );
}

export default MarkdownContent;
