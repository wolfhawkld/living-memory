import { useId, useMemo, type AnchorHTMLAttributes, type ReactElement, type ReactNode } from 'react';
import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { MarkdownImage } from './MarkdownImage';
import { isImageReference, markdownImageUrl, type MarkdownMediaSource } from './markdown-media';
import { MermaidDiagram } from './MermaidDiagram';
import { normalizeDisplayMath } from './markdown-math';

export interface MarkdownContentProps {
  content: string;
  compact?: boolean;
  source?: MarkdownMediaSource;
}

type MarkdownNode = {
  type: string;
  value?: unknown;
  url?: string;
  alt?: string;
  children?: MarkdownNode[];
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

type MarkdownTableProps = {
  children?: ReactNode;
};

type MarkdownCodeProps = {
  children?: ReactNode;
  className?: string;
};

type MarkdownPreProps = ExtraProps & {
  children?: ReactNode;
};

const WIKI_LINK_PATTERN = /(!?)\[\[([^\]\n|]+?)(?:\|([^\]\n]*?))?\]\]/g;
const WIKI_SKIP_NODES = new Set(['code', 'inlineCode', 'math', 'inlineMath', 'html', 'link']);
const ID_REFERENCE_PROPERTIES = new Set([
  'ariaDescribedBy',
  'aria-describedby',
  'ariaLabelledBy',
  'aria-labelledby',
  'headers',
  'htmlFor',
  'for',
]);

function splitWikiLinks(value: string): MarkdownNode[] | null {
  WIKI_LINK_PATTERN.lastIndex = 0;
  const nodes: MarkdownNode[] = [];
  let lastIndex = 0;
  let matched = false;
  let match: RegExpExecArray | null;

  while ((match = WIKI_LINK_PATTERN.exec(value))) {
    matched = true;
    if (match.index > lastIndex) {
      nodes.push({ type: 'text', value: value.slice(lastIndex, match.index) });
    }
    const target = match[2].trim();
    const label = match[3]?.trim() || target;
    if (match[1] && isImageReference(target)) {
      const size = match[3]?.trim().match(/^(\d{1,4})(?:x(\d{1,4}))?$/);
      const width = size && Number(size[1]) > 0 && Number(size[1]) <= 5000 ? Number(size[1]) : undefined;
      const height = width && size?.[2] && Number(size[2]) > 0 && Number(size[2]) <= 5000 ? Number(size[2]) : undefined;
      nodes.push({ type: 'image', url: target, alt: size ? target.split('/').at(-1) ?? target : label,
        data: { hProperties: { 'data-wiki-target': target, ...(width ? { width } : {}), ...(height ? { height } : {}) } } });
    } else nodes.push({ type: 'text', value: label });
    lastIndex = match.index + match[0].length;
  }

  if (!matched) return null;
  if (lastIndex < value.length) {
    nodes.push({ type: 'text', value: value.slice(lastIndex) });
  }
  return nodes;
}

function rewriteWikiLinks(node: MarkdownNode): void {
  if (WIKI_SKIP_NODES.has(node.type)) return;

  if (node.type === 'text' && typeof node.value === 'string') return;

  if (!node.children) return;

  const nextChildren: MarkdownNode[] = [];
  for (const child of node.children) {
    if (WIKI_SKIP_NODES.has(child.type)) {
      nextChildren.push(child);
      continue;
    }
    if (child.type === 'text' && typeof child.value === 'string') {
      nextChildren.push(...(splitWikiLinks(child.value) ?? [child]));
      continue;
    }
    rewriteWikiLinks(child);
    nextChildren.push(child);
  }
  node.children = nextChildren;
}

/**
 * Turn Obsidian links into readable labels and image embeds into media nodes. This
 * runs on mdast text nodes, so code spans/fences and math nodes are untouched.
 */
function remarkWikiLinks() {
  return (tree: unknown) => {
    if (tree && typeof tree === 'object') {
      rewriteWikiLinks(tree as MarkdownNode);
    }
  };
}

function markdownNodeText(node: MarkdownNode): string {
  if (typeof node.value === 'string') return node.value;
  return node.children?.map(markdownNodeText).join('') ?? '';
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

function headingSlug(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]+/gu, '')
    .replace(/[\s_-]+/g, '-');
}

/** Assign heading ids before React renders so StrictMode cannot mutate identity. */
function remarkHeadingIds() {
  return (tree: unknown) => {
    const usedIds = new Map<string, number>();
    const visit = (node: MarkdownNode): void => {
      if (node.type === 'heading') {
        const base = headingSlug(markdownNodeText(node));
        if (base) {
          const count = usedIds.get(base) ?? 0;
          usedIds.set(base, count + 1);
          const id = count === 0 ? base : `${base}-${count + 1}`;
          node.data ??= {};
          node.data.hProperties ??= {};
          node.data.hProperties.id = id;
        }
      }
      node.children?.forEach(visit);
    };
    if (tree && typeof tree === 'object') visit(tree as MarkdownNode);
  };
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
    const visit = (node: HastNode): void => {
      if (node.type === 'element' && node.properties) {
        const properties = node.properties;
        if (typeof properties.id === 'string' && properties.id) {
          properties.id = scopeId(prefix, properties.id);
        }
        if (typeof properties.href === 'string' && properties.href.startsWith('#') && properties.href.length > 1) {
          properties.href = `#${scopeId(prefix, properties.href.slice(1))}`;
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

function MarkdownTable({ children }: MarkdownTableProps): ReactElement {
  return (
    <div className="markdown-content-table-wrap">
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
  return <pre className="markdown-content-pre">{children}</pre>;
}

function createMarkdownComponents(source?: MarkdownMediaSource): Components {
  return {
    a: MarkdownLink,
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

export function MarkdownContent({ content, compact = false, source }: MarkdownContentProps): ReactElement {
  const instanceId = useId();
  const scopePrefix = `markdown-${instanceId.replace(/[^A-Za-z0-9_-]/g, '-')}`;
  const components = useMemo(() => createMarkdownComponents(source), [source?.sourceId, source?.conceptId, source?.sourceRevision]);

  return (
    <div className={`markdown-content${compact ? ' markdown-content-compact' : ''}`}>
      <ReactMarkdown
        allowElement={(element) => element.tagName !== 'script' && element.tagName !== 'style'}
        components={components}
        remarkRehypeOptions={{ allowDangerousHtml: false }}
        remarkPlugins={[remarkGfm, remarkMath, remarkWikiLinks, remarkHeadingIds]}
        rehypePlugins={[[rehypeKatex, {
          errorColor: '#f4bd70',
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
