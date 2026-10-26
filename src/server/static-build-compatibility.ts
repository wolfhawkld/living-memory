import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { STATIC_BUILD_MANIFEST_FILE, STATIC_BUILD_MANIFEST_FORMAT, STATIC_BUILD_MANIFEST_VERSION } from '../shared/static-build-compatibility.js';

export class StaticBuildCompatibilityError extends Error {
  readonly code = 'RUNTIME_BUILD_INCOMPATIBLE';
  constructor() { super('RUNTIME_BUILD_INCOMPATIBLE'); this.name = 'StaticBuildCompatibilityError'; }
}

function ordinaryBytes(path: string, limit: number): Buffer {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > limit) throw new StaticBuildCompatibilityError();
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > limit || stat.dev !== before.dev || stat.ino !== before.ino) throw new StaticBuildCompatibilityError();
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(descriptor, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length !== stat.size) throw new StaticBuildCompatibilityError();
    return bytes.subarray(0, length);
  } finally { closeSync(descriptor); }
}

/** Explicit v3 requires matching production assets. Existing v2 assets remain accepted. */
export function assertStaticBuildCompatible(staticDir: string, learningSchemaVersion: 2 | 3): void {
  if (learningSchemaVersion === 2) return;
  try {
    if (learningSchemaVersion !== 3) throw new StaticBuildCompatibilityError();
    const manifest: unknown = JSON.parse(ordinaryBytes(join(staticDir, STATIC_BUILD_MANIFEST_FILE), 16 * 1024).toString('utf8'));
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
      || Object.keys(manifest).sort().join(',') !== 'format,indexHtmlSha256,supportedLearningProtocols,version') throw new StaticBuildCompatibilityError();
    const value = manifest as Record<string, unknown>;
    const protocols = value.supportedLearningProtocols;
    if (value.format !== STATIC_BUILD_MANIFEST_FORMAT || value.version !== STATIC_BUILD_MANIFEST_VERSION
      || !Array.isArray(protocols) || protocols.length < 1 || protocols.length > 2
      || protocols.some(protocol => protocol !== 2 && protocol !== 3) || new Set(protocols).size !== protocols.length
      || !protocols.includes(learningSchemaVersion)
      || typeof value.indexHtmlSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.indexHtmlSha256)) throw new StaticBuildCompatibilityError();
    const actual = createHash('sha256').update(ordinaryBytes(join(staticDir, 'index.html'), 2 * 1024 * 1024)).digest('hex');
    if (actual !== value.indexHtmlSha256) throw new StaticBuildCompatibilityError();
  } catch { throw new StaticBuildCompatibilityError(); }
}
