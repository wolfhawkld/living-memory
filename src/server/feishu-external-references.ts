import { isIP } from 'node:net';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkMath from 'remark-math';
import { normalizeDisplayMath } from '../core/markdown-normalization.js';

export interface FeishuExternalReference { label: string; href: string; hostname: string }
export interface FeishuExternalReferences { items: FeishuExternalReference[]; hasMore: boolean }

interface Ast {
  type: string;
  value?: string;
  url?: string;
  identifier?: string;
  children?: Ast[];
}
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_NODES = 50_000;
const MAX_URL_BYTES = 1024;
const OMIT = new Set(['code', 'inlineCode', 'math', 'inlineMath', 'html', 'image', 'imageReference', 'definition']);
// U+FFFD may be a parser repair of an invalid control/entity; do not guess its target.
const INVALID_URL = /[\s\u0000-\u001f\u007f-\u009f\ufffd\\]/u;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u;

function allowedUrl(value: string | undefined): URL | undefined {
  if (!value || INVALID_URL.test(value) || LONE_SURROGATE.test(value) || Buffer.byteLength(value) > MAX_URL_BYTES) return;
  // Require an explicit authority rather than WHATWG's repaired slash variants.
  const authority = value.match(/^https:\/\/([^/?#]+)/i)?.[1];
  if (!authority || authority.includes('@')) return;
  let url: URL;
  try { url = new URL(value); } catch { return; }
  if (url.protocol !== 'https:' || url.username || url.password) return;
  if (INVALID_URL.test(url.href) || Buffer.byteLength(url.href) > MAX_URL_BYTES) return;
  // A trailing DNS dot must not bypass localhost, local suffix, or IP checks.
  const hostname = url.hostname.replace(/\.$/, '').toLowerCase();
  if (hostname.split('.').some(label => !label)) return;
  const ip = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  if (isIP(ip) || !hostname.includes('.') || hostname === 'localhost'
    || hostname.endsWith('.localhost') || hostname.endsWith('.local')) return;
  return url;
}

function blocked(node: Ast): boolean {
  return OMIT.has(node.type) || (node.type !== 'root' && !!node.children?.some(child => child.type === 'html'));
}

function visibleLabel(node: Ast): string {
  const pending = [...(node.children ?? [])].reverse();
  let value = '';
  while (pending.length) {
    const child = pending.pop()!;
    if (blocked(child)) continue;
    if (child.type === 'text') value += child.value ?? '';
    else if (child.type === 'break') value += ' ';
    else if (child.children) for (let i = child.children.length - 1; i >= 0; i--) pending.push(child.children[i]);
  }
  return value.replace(/[\s\u0000-\u001f\u007f-\u009f]+/gu, ' ').trim();
}

/** Extract existing Markdown targets only; never fetch, resolve DNS, or infer URLs. */
export function extractFeishuExternalReferences(body: string): FeishuExternalReferences {
  const empty = (): FeishuExternalReferences => ({ items: [], hasMore: false });
  try {
    if (typeof body !== 'string' || body.length > MAX_BODY_BYTES || Buffer.byteLength(body) > MAX_BODY_BYTES) return empty();
    const tree = unified().use(remarkParse).use(remarkMath).parse(normalizeDisplayMath(body)) as Ast;
    const definitions = new Map<string, string>();
    const countStack = [tree];
    let count = 0;
    while (countStack.length) {
      const node = countStack.pop()!;
      if (++count > MAX_NODES) return empty();
      // CommonMark uses the first definition for an identifier.
      if (node.type === 'definition' && node.identifier && node.url && !definitions.has(node.identifier)) {
        definitions.set(node.identifier, node.url);
      }
      if (node.children) for (let i = node.children.length - 1; i >= 0; i--) countStack.push(node.children[i]);
    }
    const items: FeishuExternalReference[] = [];
    const seen = new Set<string>();
    const pending = [tree];
    while (pending.length) {
      const node = pending.pop()!;
      if (blocked(node)) continue;
      if (node.type === 'link' || node.type === 'linkReference') {
        const url = allowedUrl(node.type === 'link' ? node.url : definitions.get(node.identifier ?? ''));
        // An image-only link must not turn its image description into a text link.
        const label = visibleLabel(node);
        if (url && label && !seen.has(url.href)) {
          if (items.length === 3) return { items, hasMore: true };
          seen.add(url.href);
          items.push({ label, href: url.href, hostname: url.hostname });
        }
        continue;
      }
      if (node.children) for (let i = node.children.length - 1; i >= 0; i--) pending.push(node.children[i]);
    }
    return { items, hasMore: false };
  } catch { return empty(); }
}
