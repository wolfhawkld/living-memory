import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import matter from 'gray-matter';
import type { Concept, GraphLink, KnowledgeGraph } from '../shared/types.js';

export interface KnowledgeGraphOptions {
  /** Root directory of a progressive-kg vault. */
  root: string;
  /** Maximum number of selected concepts. The count is calculated before this limit. */
  limit?: number;
  /** Optional path prefix relative to root, for example `Cognition/Math`. */
  includePrefix?: string;
}

export interface KnowledgeSource {
  graph: KnowledgeGraph;
  /** Hash used to isolate learning history between source roots. */
  namespace: string;
  /** Canonical source root, kept internal and never returned by the API. */
  root: string;
}

export class KnowledgeSourceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'KnowledgeSourceError';
    this.code = code;
  }
}

interface ParsedConcept {
  concept: Concept;
  relativePath: string;
  title: string;
  aliases: string[];
  targetKeys: string[];
}

interface ParsedLink {
  from: string;
  target: string;
  type: string;
  description: string;
  key: string;
}

const EXCLUDED_DIRECTORY_NAMES = new Set(['.git', '.obsidian', 'raw', '_system', 'node_modules']);
const RELATION_NAMES: Record<string, string> = {
  前置: 'prerequisite',
  组成: 'component',
  对比: 'contrast',
  扩展: 'extension',
  应用: 'application',
  相关: 'related',
};

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

function normalizePrefix(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = normalizePath(value).replace(/\/+$/, '');
  return normalized || undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function aliasesOf(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(asString).filter((item): item is string => Boolean(item));
  }
  const text = asString(value);
  return text ? text.split(',').map((item) => item.trim()).filter(Boolean) : [];
}

function firstHeading(body: string): string | undefined {
  return body.match(/^#\s+(.+?)\s*$/m)?.[1]?.trim();
}

function fallbackSummary(body: string): string {
  const text = body
    .replace(/^```[\s\S]*?```/gm, '')
    .replace(/^#+\s+/gm, '')
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .find(Boolean);
  return text ?? '';
}

function domainOf(frontmatter: Record<string, unknown>, relativePath: string, root: string): string {
  const explicit = asString(frontmatter.domain);
  if (explicit) return explicit;
  const parent = normalizePath(relativePath).split('/').slice(0, -1).pop();
  if (parent) return parent;
  return root.split(/[\\/]/).filter(Boolean).pop() ?? 'default';
}

function canonicalBody(body: string): string {
  return body.replaceAll('\r\n', '\n').replaceAll('\r', '\n').trim();
}

function sourceRevision(frontmatter: Record<string, unknown>, body: string): string {
  // Only fields which affect what a learner can read are included. Metadata such as
  // mtime, updated, maturity, confidence and verified must not invalidate history.
  const meaningful = {
    title: asString(frontmatter.title) ?? '',
    aliases: aliasesOf(frontmatter.aliases).sort(),
    domain: asString(frontmatter.domain) ?? '',
    summary: asString(frontmatter.summary) ?? '',
    body: canonicalBody(body),
  };
  return `sha256:${sha256(JSON.stringify(meaningful))}`;
}

function keyForConcept(relativePath: string, title: string, aliases: string[]): string[] {
  const normalizedPath = normalizePath(relativePath);
  const withoutExtension = normalizedPath.replace(/\.md$/i, '');
  const filename = withoutExtension.split('/').pop() ?? withoutExtension;
  return [normalizedPath, withoutExtension, filename, title, ...aliases]
    .map((item) => item.trim().toLocaleLowerCase())
    .filter(Boolean);
}

function targetWithoutHeading(value: string): string {
  return value.split('#', 1)[0].split('|', 1)[0].trim();
}

function wikilinks(value: string): string[] {
  return Array.from(value.matchAll(/\[\[([^\]]+)\]\]/g), (match) => match[1].trim());
}

function relationLines(body: string): Array<{ type: string; line: string }> {
  const result: Array<{ type: string; line: string }> = [];
  let inNetwork = false;
  for (const line of body.split(/\r?\n/)) {
    const heading = line.match(/^##\s+(.+?)\s*$/)?.[1]?.trim();
    if (heading) {
      inNetwork = heading === '关系网络' || heading.toLocaleLowerCase() === 'relation network';
      continue;
    }
    if (!inNetwork) continue;
    // Both `- 应用：[[概念]] — 说明` and the common shorthand
    // `- 定义 [[概念]] — 说明` occur in progressive-kg. Derive the label
    // from the text immediately before the first wikilink, instead of
    // requiring a colon.
    const firstLink = line.indexOf('[[');
    if (firstLink < 0) continue;
    const rawType = line.slice(0, firstLink)
      .replace(/^\s*[-*+]\s*/, '')
      .replace(/[：:]\s*$/, '')
      .trim();
    const type = RELATION_NAMES[rawType] ?? (rawType ? rawType.toLocaleLowerCase() : 'related');
    const linkText = line.slice(firstLink).trim();
    if (type) result.push({ type, line: linkText });
  }
  return result;
}

function parseRelationLinks(relativePath: string, body: string): ParsedLink[] {
  const links: ParsedLink[] = [];
  for (const relation of relationLines(body)) {
    const targets = wikilinks(relation.line);
    if (targets.length === 0) continue;
    const description = relation.line.replace(/\[\[[^\]]+\]\]/g, '').replace(/^\s*[—–-]\s*/, '').replace(/\s+/g, ' ').trim();
    for (const target of targets) {
      links.push({
        from: relativePath,
        target,
        type: relation.type || 'related',
        description,
        key: `${relativePath}\u0000${target}\u0000${relation.type}\u0000${description}`,
      });
    }
  }
  return links;
}

function parseOrdinaryLinks(relativePath: string, body: string): ParsedLink[] {
  const relationText = relationLines(body).map((item) => item.line).join('\n');
  const relationTargets = new Set(wikilinks(relationText).map((target) => targetWithoutHeading(target).toLocaleLowerCase()));
  return wikilinks(body)
    .filter((target) => !relationTargets.has(targetWithoutHeading(target).toLocaleLowerCase()))
    .map((target) => ({
      from: relativePath,
      target,
      type: 'related',
      description: '',
      key: `${relativePath}\u0000${target}\u0000related\u0000`,
    }));
}

function collectMarkdown(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      throw new KnowledgeSourceError('KG_READ_FAILED', '无法读取知识源目录，请检查目录权限。');
    }
    for (const entry of entries) {
      if (EXCLUDED_DIRECTORY_NAMES.has(entry.name)) continue;
      const full = join(directory, entry.name);
      let info;
      try {
        info = lstatSync(full);
      } catch {
        continue;
      }
      // A symlink can escape the configured root. Do not follow it in an import.
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        visit(full);
      } else if (info.isFile() && entry.name.toLocaleLowerCase().endsWith('.md')) {
        files.push(full);
      }
    }
  };
  visit(root);
  return files.sort((a, b) => a.localeCompare(b));
}

function resolveTarget(
  fromRelativePath: string,
  rawTarget: string,
  byKey: Map<string, ParsedConcept[]>,
  byPath: Map<string, ParsedConcept>,
): { concept?: ParsedConcept; ambiguous?: boolean } {
  const withoutHeading = targetWithoutHeading(rawTarget);
  const fromDirectory = normalizePath(fromRelativePath).split('/').slice(0, -1).join('/');
  const relativeCandidate = normalizePath(join(fromDirectory, withoutHeading));
  const candidates = [
    relativeCandidate,
    relativeCandidate.endsWith('.md') ? relativeCandidate : `${relativeCandidate}.md`,
    normalizePath(withoutHeading),
    normalizePath(withoutHeading).replace(/\.md$/i, ''),
  ];
  for (const candidate of candidates) {
    const exact = byPath.get(candidate) ?? byPath.get(candidate.replace(/\.md$/i, ''));
    if (exact) return { concept: exact };
  }
  const keyed = new Map<string, ParsedConcept>();
  for (const candidate of candidates) {
    for (const concept of byKey.get(candidate.toLocaleLowerCase()) ?? []) keyed.set(concept.relativePath, concept);
  }
  if (keyed.size === 1) return { concept: keyed.values().next().value };
  if (keyed.size > 1) return { ambiguous: true };
  return {};
}

/**
 * Read a progressive-kg source as a deterministic, read-only graph snapshot.
 * The scan happens before applying the limit so diagnostics and conceptCount are
 * meaningful. No source file is ever written by this module.
 */
export function loadKnowledgeGraph(options: KnowledgeGraphOptions): KnowledgeSource {
  const requestedRoot = resolve(options.root);
  let root: string;
  try {
    if (!statSync(requestedRoot).isDirectory()) {
      throw new KnowledgeSourceError('KG_ROOT_MISSING', '知识源目录不存在或不是目录。');
    }
    root = realpathSync(requestedRoot);
  } catch (error) {
    if (error instanceof KnowledgeSourceError) throw error;
    throw new KnowledgeSourceError('KG_ROOT_MISSING', '知识源目录不存在或不是目录。');
  }
  const limit = Math.max(1, Math.min(300, Math.floor(options.limit ?? 20)));
  const includePrefix = normalizePrefix(options.includePrefix);
  const diagnostics: string[] = [];
  const files = collectMarkdown(root);
  const parsed: ParsedConcept[] = [];
  for (const file of files) {
    const relativePath = normalizePath(relative(root, file));
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      diagnostics.push(`无法读取来源文件：${relativePath}`);
      continue;
    }
    let document;
    try {
      document = matter(raw);
    } catch {
      diagnostics.push(`无法解析来源文件：${relativePath}`);
      continue;
    }
    const data = (document.data ?? {}) as Record<string, unknown>;
    if (asString(data.type)?.toLocaleLowerCase() !== 'concept') continue;
    const body = document.content.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
    const aliases = aliasesOf(data.aliases);
    const title = asString(data.title) ?? firstHeading(body) ?? relativePath.replace(/\.md$/i, '').split('/').pop() ?? relativePath;
    const summary = asString(data.summary) ?? fallbackSummary(body);
    const domain = domainOf(data, relativePath, root);
    const sourceNamespace = sha256(root).slice(0, 24);
    const id = `concept_${sha256(`${sourceNamespace}:${relativePath}`).slice(0, 32)}`;
    parsed.push({
      concept: {
        id,
        title,
        aliases,
        domain,
        summary,
        body,
        source: { path: relativePath, revision: sourceRevision(data, body) },
      },
      relativePath,
      title,
      aliases,
      targetKeys: keyForConcept(relativePath, title, aliases),
    });
  }

  const byPath = new Map<string, ParsedConcept>();
  const byKey = new Map<string, ParsedConcept[]>();
  for (const item of parsed) {
    byPath.set(item.relativePath, item);
    byPath.set(item.relativePath.replace(/\.md$/i, ''), item);
    for (const key of item.targetKeys) {
      const list = byKey.get(key) ?? [];
      list.push(item);
      byKey.set(key, list);
    }
  }
  // Build the full source index before applying an include prefix. A selected
  // Math note may legitimately link to a Model note outside the displayed
  // prefix; that target should be resolved and then omitted from this view,
  // not reported as a broken link.
  const candidates = includePrefix
    ? parsed.filter((item) => item.relativePath === includePrefix || item.relativePath.startsWith(`${includePrefix}/`))
    : parsed;
  const selected = candidates.slice(0, limit);
  const selectedPaths = new Set(selected.map((item) => item.relativePath));
  const links: GraphLink[] = [];
  const seenLinks = new Set<string>();
  for (const item of selected) {
    const candidates = [...parseRelationLinks(item.relativePath, item.concept.body), ...parseOrdinaryLinks(item.relativePath, item.concept.body)];
    for (const link of candidates) {
      const targetResult = resolveTarget(item.relativePath, link.target, byKey, byPath);
      if (targetResult.ambiguous) {
        diagnostics.push(`关系目标有歧义：${item.relativePath} → ${targetWithoutHeading(link.target)}`);
        continue;
      }
      if (!targetResult.concept) {
        diagnostics.push(`关系目标未找到：${item.relativePath} → ${targetWithoutHeading(link.target)}`);
        continue;
      }
      if (!selectedPaths.has(targetResult.concept.relativePath)) continue;
      const dedupe = `${item.relativePath}\u0000${targetResult.concept.relativePath}\u0000${link.type}\u0000${link.description}`;
      if (seenLinks.has(dedupe)) continue;
      seenLinks.add(dedupe);
      links.push({
        id: `link_${sha256(dedupe).slice(0, 32)}`,
        source: item.concept.id,
        target: targetResult.concept.concept.id,
        type: link.type,
        description: link.description,
      });
    }
  }

  const namespace = `kg_${sha256(root).slice(0, 48)}`;
  const graph: KnowledgeGraph = {
    concepts: selected.map((item) => item.concept),
    links,
    source: {
      name: root.split(/[\\/]/).filter(Boolean).pop() ?? 'knowledge-source',
      mode: root.endsWith(normalizePath('fixtures/demo-kg')) ? 'demo' : 'local',
      conceptCount: candidates.length,
      limit,
      diagnostics,
    },
  };
  return { graph, namespace, root };
}
