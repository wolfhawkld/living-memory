import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import {
  basename,
  dirname,
  extname,
  relative,
  resolve,
  sep,
} from 'node:path';
import type { Response } from 'express';

import type { Concept } from '../shared/types.js';
import type { KnowledgeSource } from './kg.js';
import { StoreError } from './store.js';

export const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;

const MAX_FALLBACK_SCAN_ENTRIES = 20_000;
const EXCLUDED_SCAN_DIRECTORIES = new Set(['.git', '.obsidian', 'node_modules']);

const IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

export interface AttachmentQuery {
  sourceId: string;
  sourceRevision: string;
  path: string;
}

interface AttachmentPath {
  target: string;
  wikiEmbed: boolean;
}

interface CandidateResult {
  kind: 'blocked' | 'missing' | 'non-file' | 'file';
  filePath?: string;
}

function attachmentError(
  code: string,
  message: string,
  status: number,
): StoreError {
  return new StoreError(code, message, status);
}

function invalidQuery(): never {
  throw attachmentError(
    'INVALID_ATTACHMENT_QUERY',
    '附件请求需要有效的 sourceId、sourceRevision 和 path。',
    400,
  );
}

function scalarQueryValue(query: unknown, key: keyof AttachmentQuery): string {
  if (typeof query !== 'object' || query === null || Array.isArray(query)) {
    return invalidQuery();
  }

  const value = (query as Record<string, unknown>)[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    return invalidQuery();
  }
  return value.trim();
}

export function parseAttachmentQuery(query: unknown): AttachmentQuery {
  return {
    sourceId: scalarQueryValue(query, 'sourceId'),
    sourceRevision: scalarQueryValue(query, 'sourceRevision'),
    path: scalarQueryValue(query, 'path'),
  };
}

function notFound(): never {
  throw attachmentError(
    'ATTACHMENT_NOT_FOUND',
    '找不到可用的图片附件。',
    404,
  );
}

function notImage(): never {
  throw attachmentError(
    'ATTACHMENT_NOT_IMAGE',
    '附件不是受支持的图片格式。',
    415,
  );
}

function tooLarge(): never {
  throw attachmentError(
    'ATTACHMENT_TOO_LARGE',
    '图片附件超过 20 MB 限制。',
    413,
  );
}

function ambiguous(): never {
  throw attachmentError(
    'ATTACHMENT_AMBIGUOUS',
    '附件名称对应多个文件，请使用明确路径。',
    409,
  );
}

function attachmentSearchLimit(): never {
  throw attachmentError(
    'ATTACHMENT_SEARCH_LIMIT',
    '附件搜索范围过大，无法安全查找。',
    404,
  );
}

function pathInvalid(): never {
  throw attachmentError(
    'ATTACHMENT_PATH_INVALID',
    '附件路径无效。',
    400,
  );
}

function isInside(root: string, target: string): boolean {
  const rootPath = resolve(root);
  const relativePath = relative(rootPath, resolve(target));
  return (
    relativePath.length > 0 &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`) &&
    !relativePath.startsWith(`..${sep === '/' ? '\\' : '/'}`) &&
    !relativePath.includes('\0')
  );
}

function isWindowsOrExternalPath(value: string): boolean {
  return (
    /^[a-z]:/i.test(value) ||
    /^\\/.test(value) ||
    /^\/\//.test(value) ||
    /^[a-z][a-z0-9+.-]*:/i.test(value)
  );
}

function parseWikiEmbed(rawPath: string): { target: string; wikiEmbed: boolean } {
  const trimmed = rawPath.trim();
  const wiki = trimmed.match(/^!?\[\[([^\]]+)\]\]$/);
  if (wiki) {
    const target = wiki[1]!
      .split('|', 1)[0]!
      .split('#', 1)[0]!
      .trim();
    if (!target) {
      return pathInvalid();
    }
    return { target, wikiEmbed: true };
  }

  if (trimmed.startsWith('![[') || trimmed.startsWith('[[')) {
    return pathInvalid();
  }

  return { target: trimmed, wikiEmbed: false };
}

function stripStandardUrlSuffix(rawPath: string): string {
  const queryIndex = rawPath.indexOf('?');
  const hashIndex = rawPath.indexOf('#');
  const suffixIndex = [queryIndex, hashIndex]
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  return suffixIndex === undefined ? rawPath : rawPath.slice(0, suffixIndex);
}

function decodeStandardPath(rawPath: string): string {
  // A literal percent in a Markdown filename arrives as `%` after Express
  // decodes URLSearchParams once. Preserve malformed escape-looking text
  // while decoding valid UTF-8 escapes exactly one additional time.
  return decodeURIComponent(rawPath.replace(/%(?![0-9a-f]{2})/gi, '%25'));
}

function normalizeAttachmentPath(rawPath: string): AttachmentPath {
  const trimmedPath = rawPath.trim();
  if (trimmedPath.includes('\0') || /[\u0000-\u001f\u007f]/.test(trimmedPath)) {
    return pathInvalid();
  }

  const wikiLiteral = /^!?\[\[/.test(trimmedPath);
  let pathForParsing = trimmedPath;
  if (!wikiLiteral) {
    pathForParsing = stripStandardUrlSuffix(pathForParsing);
    try {
      // Express has already decoded the query component once. A standard
      // Markdown URL can still contain a percent-encoded filename because
      // URLSearchParams encoded the percent sign a second time.
      pathForParsing = decodeStandardPath(pathForParsing);
    } catch {
      return pathInvalid();
    }
  }

  if (pathForParsing.includes('\0') || /[\u0000-\u001f\u007f]/.test(pathForParsing)) {
    return pathInvalid();
  }

  const parsed = parseWikiEmbed(pathForParsing);
  // Check the original separators before normalizing them. A leading
  // backslash is a Windows rooted path and must not become a vault-root URL.
  if (isWindowsOrExternalPath(parsed.target)) {
    return pathInvalid();
  }
  const target = parsed.target.replaceAll('\\', '/');
  if (
    target.length === 0 ||
    target.includes('\0') ||
    isWindowsOrExternalPath(target) ||
    target.startsWith('!') ||
    target.startsWith('[[')
  ) {
    return pathInvalid();
  }

  return { target, wikiEmbed: parsed.wikiEmbed };
}

function canonicalFileCandidate(root: string, candidate: string): CandidateResult {
  const lexicalPath = resolve(candidate);
  if (!isInside(root, lexicalPath)) {
    return { kind: 'blocked' };
  }

  let canonicalPath: string;
  try {
    canonicalPath = realpathSync(lexicalPath);
  } catch {
    return { kind: 'missing' };
  }

  if (!isInside(root, canonicalPath)) {
    return { kind: 'blocked' };
  }

  try {
    const information = statSync(canonicalPath);
    if (!information.isFile()) {
      return { kind: 'non-file' };
    }
  } catch {
    return { kind: 'missing' };
  }

  return { kind: 'file', filePath: canonicalPath };
}

function directCandidates(
  root: string,
  concept: Concept,
  path: AttachmentPath,
): string[] {
  const noteDirectory = resolve(root, dirname(concept.source.path));
  const isVaultRootPath = path.target.startsWith('/') && !path.target.startsWith('//');
  const target = isVaultRootPath ? path.target.slice(1) : path.target;

  if (isVaultRootPath) {
    return [resolve(root, target)];
  }

  if (!path.wikiEmbed) {
    return [resolve(noteDirectory, target)];
  }

  // Obsidian wiki links are normally vault-root relative. Explicit relative
  // links retain note-relative semantics before the vault-root fallback.
  if (target === '.' || target === '..' || target.startsWith('./') || target.startsWith('../')) {
    return [resolve(noteDirectory, target), resolve(root, target)];
  }
  return [resolve(root, target), resolve(noteDirectory, target)];
}

function fallbackMatches(root: string, wantedBasename: string): string[] {
  const matches: string[] = [];
  let visitedEntries = 0;

  const walk = (directory: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      visitedEntries += 1;
      if (visitedEntries > MAX_FALLBACK_SCAN_ENTRIES) {
        return attachmentSearchLimit();
      }

      const childPath = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (
          entry.name.startsWith('.') ||
          EXCLUDED_SCAN_DIRECTORIES.has(entry.name)
        ) {
          continue;
        }
        walk(childPath);
        if (matches.length > 1) {
          return;
        }
        continue;
      }

      // A fallback scan never follows symlinks. A direct request is checked
      // with realpathSync above, so a symlink can only resolve inside root.
      if (!entry.isFile() || entry.name !== wantedBasename) {
        continue;
      }
      try {
        if (lstatSync(childPath).isSymbolicLink()) {
          continue;
        }
      } catch {
        continue;
      }
      matches.push(childPath);
      if (matches.length > 1) {
        return;
      }
    }
  };

  walk(root);
  return matches;
}

function resolveAttachmentFile(
  source: KnowledgeSource,
  concept: Concept,
  rawPath: string,
): string {
  const parsed = normalizeAttachmentPath(rawPath);
  const root = resolve(source.root);

  for (const candidate of directCandidates(root, concept, parsed)) {
    const result = canonicalFileCandidate(root, candidate);
    if (result.kind === 'blocked' || result.kind === 'non-file') {
      return notFound();
    }
    if (result.kind === 'file') {
      return result.filePath!;
    }
  }

  if (!parsed.wikiEmbed) {
    return notFound();
  }

  const wantedBasename = basename(parsed.target);
  if (
    wantedBasename.length === 0 ||
    wantedBasename === '.' ||
    wantedBasename === '..' ||
    wantedBasename.includes('/')
  ) {
    return notFound();
  }

  const matches = fallbackMatches(root, wantedBasename);
  if (matches.length > 1) {
    return ambiguous();
  }
  if (matches.length === 0) {
    return notFound();
  }

  const result = canonicalFileCandidate(root, matches[0]!);
  if (result.kind !== 'file') {
    return notFound();
  }
  return result.filePath!;
}

function mimeForFile(filePath: string): string {
  const mimeType = IMAGE_MIME_BY_EXTENSION[extname(filePath).toLowerCase()];
  if (!mimeType) {
    return notImage();
  }
  return mimeType;
}

function startsWithBytes(data: Buffer, bytes: readonly number[]): boolean {
  if (data.length < bytes.length) {
    return false;
  }
  return bytes.every((byte, index) => data[index] === byte);
}

function isValidImageSignature(mimeType: string, data: Buffer): boolean {
  switch (mimeType) {
    case 'image/png':
      return startsWithBytes(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'image/jpeg':
      return startsWithBytes(data, [0xff, 0xd8, 0xff]);
    case 'image/gif':
      return data.subarray(0, 6).toString('ascii') === 'GIF87a' || data.subarray(0, 6).toString('ascii') === 'GIF89a';
    case 'image/webp':
      return (
        data.length >= 12 &&
        data.subarray(0, 4).toString('ascii') === 'RIFF' &&
        data.subarray(8, 12).toString('ascii') === 'WEBP'
      );
    case 'image/avif': {
      if (data.length < 12 || data.subarray(4, 8).toString('ascii') !== 'ftyp') {
        return false;
      }
      return data.subarray(8, Math.min(data.length, 64)).toString('ascii').includes('avif') ||
        data.subarray(8, Math.min(data.length, 64)).toString('ascii').includes('avis');
    }
    case 'image/bmp':
      return startsWithBytes(data, [0x42, 0x4d]);
    case 'image/x-icon':
      return startsWithBytes(data, [0x00, 0x00, 0x01, 0x00]);
    case 'image/svg+xml':
      return /^(?:\uFEFF|\s)*(?:<\?xml[\s\S]*?\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[\s\S]*?>\s*)*<svg(?:\s|>)/i.test(
        data.subarray(0, Math.min(data.length, 16 * 1024)).toString('utf8'),
      );
    default:
      return false;
  }
}

function readBoundedFile(filePath: string): Buffer {
  let descriptor = -1;
  try {
    descriptor = openSync(filePath, 'r');
    const information = fstatSync(descriptor);
    if (!information.isFile()) {
      return notFound();
    }
    if (information.size > ATTACHMENT_MAX_BYTES) {
      return tooLarge();
    }

    const data = Buffer.alloc(information.size);
    let offset = 0;
    while (offset < data.length) {
      const count = readSync(descriptor, data, offset, data.length - offset, offset);
      if (count <= 0) {
        throw new Error('short attachment read');
      }
      offset += count;
    }
    return data;
  } catch (error) {
    if (error instanceof StoreError) {
      throw error;
    }
    return notFound();
  } finally {
    if (descriptor !== -1) {
      try {
        closeSync(descriptor);
      } catch {
        // The response already has a safe generic outcome if close fails.
      }
    }
  }
}

function readAttachment(
  source: KnowledgeSource,
  concept: Concept,
  rawPath: string,
): { data: Buffer; mimeType: string } {
  const filePath = resolveAttachmentFile(source, concept, rawPath);
  const mimeType = mimeForFile(filePath);
  const data = readBoundedFile(filePath);
  if (!isValidImageSignature(mimeType, data)) {
    return notImage();
  }
  return { data, mimeType };
}

export function sendConceptAttachment(
  response: Response,
  source: KnowledgeSource,
  concept: Concept,
  rawQuery: unknown,
): void {
  const query = parseAttachmentQuery(rawQuery);
  if (query.sourceId !== source.namespace) {
    throw attachmentError(
      'SOURCE_MISMATCH',
      '请求来源与当前知识源不匹配。',
      409,
    );
  }
  if (query.sourceRevision !== concept.source.revision) {
    throw attachmentError(
      'SOURCE_REVISION_MISMATCH',
      '请求内容版本与当前概念不匹配。',
      409,
    );
  }

  const attachment = readAttachment(source, concept, query.path);
  response.status(200).set({
    'Cache-Control': 'no-store',
    'Content-Length': String(attachment.data.byteLength),
    'Content-Type': attachment.mimeType,
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
    ...(attachment.mimeType === 'image/svg+xml'
      ? { 'Content-Security-Policy': "default-src 'none'; sandbox" }
      : {}),
  });
  response.end(attachment.data);
}
