import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertStaticBuildCompatible, StaticBuildCompatibilityError } from '../src/server/static-build-compatibility.js';
import { STATIC_BUILD_MANIFEST_FILE, STATIC_BUILD_MANIFEST_FORMAT, STATIC_BUILD_MANIFEST_VERSION } from '../src/shared/static-build-compatibility.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lm-static-build-'));
  const index = join(root, 'index.html'), marker = join(root, STATIC_BUILD_MANIFEST_FILE);
  writeFileSync(index, '\ufeff<!doctype html><title>合成网页</title>\r\n');
  const manifest = { format: STATIC_BUILD_MANIFEST_FORMAT, version: STATIC_BUILD_MANIFEST_VERSION,
    supportedLearningProtocols: [2, 3], indexHtmlSha256: createHash('sha256').update(readFileSync(index)).digest('hex') };
  const write = (value: unknown = manifest) => writeFileSync(marker, JSON.stringify(value));
  write();
  return { root, index, marker, manifest, write, close: () => rmSync(root, { recursive: true, force: true }) };
}
function rejected(operation: () => void) {
  assert.throws(operation, error => error instanceof StaticBuildCompatibilityError
    && error.code === 'RUNTIME_BUILD_INCOMPATIBLE' && error.message === 'RUNTIME_BUILD_INCOMPATIBLE');
}

test('v2 preserves unmarked and unavailable static directory behavior without inspecting the assets', () => {
  const f = fixture();
  try {
    unlinkSync(f.marker); assert.doesNotThrow(() => assertStaticBuildCompatible(f.root, 2));
    writeFileSync(f.marker, 'SYNTHETIC_PRIVATE_INVALID_JSON');
    const before = readFileSync(f.marker);
    assert.doesNotThrow(() => assertStaticBuildCompatible(f.root, 2));
    assert.deepEqual(readFileSync(f.marker), before);
    assert.doesNotThrow(() => assertStaticBuildCompatible(join(f.root, 'not-present'), 2));
  } finally { f.close(); }
});

test('v3 accepts a matching raw-byte index hash and known protocol declaration without rewriting files', () => {
  const f = fixture();
  try {
    const before = readdirSync(f.root).map(name => [name, readFileSync(join(f.root, name)).toString('base64')]);
    assert.doesNotThrow(() => assertStaticBuildCompatible(f.root, 3));
    assert.deepEqual(readdirSync(f.root).map(name => [name, readFileSync(join(f.root, name)).toString('base64')]), before);
    f.write({ ...f.manifest, supportedLearningProtocols: [3] });
    assert.doesNotThrow(() => assertStaticBuildCompatible(f.root, 3));
  } finally { f.close(); }
});

test('v3 rejects missing, malformed or unknown manifest contracts and unsupported protocol lists with one fixed error', () => {
  const f = fixture();
  try {
    unlinkSync(f.marker); rejected(() => assertStaticBuildCompatible(f.root, 3));
    for (const value of [null, [], {}, { ...f.manifest, format: 'unknown' }, { ...f.manifest, version: 2 },
      { ...f.manifest, privatePath: 'SYNTHETIC_PRIVATE_PATH' }, { ...f.manifest, indexHtmlSha256: 'F'.repeat(64) },
      ...[undefined, null, [], [2], ['3'], [3, 3], [2, 3, 3], [1, 3], [2, 4]].map(supportedLearningProtocols => ({ ...f.manifest, supportedLearningProtocols }))]) {
      f.write(value); rejected(() => assertStaticBuildCompatible(f.root, 3));
    }
    writeFileSync(f.marker, '{"private":"SYNTHETIC_PRIVATE_INVALID_JSON');
    rejected(() => assertStaticBuildCompatible(f.root, 3));
  } finally { f.close(); }
});

test('v3 rejects changed or missing HTML instead of accepting a marker from a different build', () => {
  const f = fixture();
  try {
    writeFileSync(f.index, '<!doctype html><title>Other build</title>');
    rejected(() => assertStaticBuildCompatible(f.root, 3));
    unlinkSync(f.index); rejected(() => assertStaticBuildCompatible(f.root, 3));
  } finally { f.close(); }
});

test('v3 requires bounded ordinary marker and index files and rejects symlinks and directories', () => {
  for (const name of ['marker', 'index'] as const) {
    const f = fixture();
    try {
      const path = f[name], original = join(f.root, 'original-file');
      renameSync(path, original); symlinkSync(original, path);
      rejected(() => assertStaticBuildCompatible(f.root, 3));
      unlinkSync(path); mkdirSync(path); rejected(() => assertStaticBuildCompatible(f.root, 3));
      rmSync(path, { recursive: true }); renameSync(original, path);
      writeFileSync(path, ' '.repeat(name === 'marker' ? 16 * 1024 + 1 : 2 * 1024 * 1024 + 1));
      rejected(() => assertStaticBuildCompatible(f.root, 3));
    } finally { f.close(); }
  }
});

test('invalid runtime versions never bypass the v3 gate or expose the requested path', () => {
  for (const version of [undefined, null, '3', 1, 4]) {
    rejected(() => assertStaticBuildCompatible('/SYNTHETIC_PRIVATE_PATH/not-present', version as 3));
  }
});
