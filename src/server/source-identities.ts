import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';

export interface SourceIdentityEntry { physicalRoot: string; identityHash: string; displayName?: string }
export interface SourceIdentityRegistry { format: 'living-memory-source-identities'; version: 1; entries: SourceIdentityEntry[] }
export const sourceIdentityHash = (root: string): string => createHash('sha256').update(realpathSync(resolve(root))).digest('hex');

export function parseSourceIdentityRegistry(value: unknown): SourceIdentityRegistry {
  const input = value as SourceIdentityRegistry;
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).sort().join(',') !== 'entries,format,version'
    || input.format !== 'living-memory-source-identities' || input.version !== 1 || !Array.isArray(input.entries) || input.entries.length > 10_000) {
    throw new Error('SOURCE_IDENTITY_INVALID: 知识源身份登记无效，已停止以避免重置身份。');
  }
  const paths = new Set<string>(), identities = new Set<string>(), seeds = new Set<string>();
  const entries = input.entries.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some((key) => !['identityHash', 'physicalRoot', 'displayName'].includes(key))
      || typeof entry.physicalRoot !== 'string' || !isAbsolute(entry.physicalRoot) || resolve(entry.physicalRoot) !== entry.physicalRoot
      || /[\u0000-\u001f\u007f]/.test(entry.physicalRoot) || !/^[a-f0-9]{64}$/.test(entry.identityHash)
      || paths.has(entry.physicalRoot) || identities.has(entry.identityHash.slice(0, 48)) || seeds.has(entry.identityHash.slice(0, 24))) {
      throw new Error('SOURCE_IDENTITY_CONFLICT: 知识源身份登记存在无效或冲突条目。');
    }
    if (entry.displayName !== undefined && (typeof entry.displayName !== 'string' || !entry.displayName.trim() || entry.displayName.length > 256 || /[\u0000-\u001f\u007f]/.test(entry.displayName))) throw new Error('SOURCE_IDENTITY_INVALID: 知识源显示名称无效。');
    paths.add(entry.physicalRoot); identities.add(entry.identityHash.slice(0, 48)); seeds.add(entry.identityHash.slice(0, 24));
    return { physicalRoot: entry.physicalRoot, identityHash: entry.identityHash, ...(entry.displayName ? { displayName: entry.displayName } : {}) };
  });
  return { format: 'living-memory-source-identities', version: 1, entries };
}

export function readSourceIdentityRegistry(dataDir: string): SourceIdentityRegistry | null {
  const path = join(dataDir, 'source-identities.json');
  let stat;
  try { stat = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024 || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) {
    throw new Error('SOURCE_IDENTITY_INVALID: 身份登记必须是私有普通文件。');
  }
  let value;
  try { value = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error('SOURCE_IDENTITY_INVALID: 身份登记无法解析。'); }
  return parseSourceIdentityRegistry(value);
}

/** Only server configuration / offline restoration supplies this trusted seed. */
export function resolveSourceIdentity(dataDir: string, root: string): { physicalRoot: string; identityHash: string; sourceRootFingerprint: string; displayName: string } {
  const physicalRoot = realpathSync(resolve(root));
  const sourceRootFingerprint = sourceIdentityHash(physicalRoot);
  const entry = readSourceIdentityRegistry(dataDir)?.entries.find((item) => item.physicalRoot === physicalRoot);
  return { physicalRoot, identityHash: entry?.identityHash ?? sourceRootFingerprint, sourceRootFingerprint, displayName: entry?.displayName ?? basename(physicalRoot) };
}
