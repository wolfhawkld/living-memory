import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

const root = new URL('../fixtures/compat-b16-format-entries/', import.meta.url);
const PROVENANCE_SHA256 = '210f5cf2ac40fd91ab89c56a5dd8115797d3c1a5e8a87dd79b9f7241693b40c7';
export const B16_COMMIT = 'b16f0b226c3983573b1eee070618b12075b6edcc';
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
interface Declaration { name: string; startOffset: number; endOffset: number; startLine: number; endLine: number; sha256: string }
interface Entry { sourcePath: string; sourceSha256: string; fixture: string; fixtureSha256: string; declarations: Declaration[] }
interface Provenance {
  sourceCommit: string;
  applicationVersion: string;
  entries: Entry[];
  package: { sourcePath: string; fixture: string; sha256: string };
}

/** Verify fixed bytes before compiling. No git, current product parser, network or old binary is loaded. */
export function readB16EntryFixture() {
  const bytes = readFileSync(new URL('provenance.json', root));
  assert.equal(digest(bytes), PROVENANCE_SHA256, 'fixed extraction provenance');
  const provenance = JSON.parse(bytes.toString('utf8')) as Provenance;
  assert.equal(provenance.sourceCommit, B16_COMMIT);
  const names = new Set<string>();
  const sources = new Map<string, string>();
  for (const entry of provenance.entries) {
    const source = readFileSync(new URL(entry.fixture, root), 'utf8');
    assert.equal(digest(source), entry.fixtureSha256, entry.sourcePath);
    assert.match(entry.sourceSha256, /^[a-f0-9]{64}$/);
    let offset = 0;
    for (const declaration of entry.declarations) {
      assert.equal(names.has(declaration.name), false, 'duplicate extracted declaration');
      names.add(declaration.name);
      const length = declaration.endOffset - declaration.startOffset;
      assert.ok(length > 0 && declaration.startLine <= declaration.endLine);
      const text = source.slice(offset, offset + length);
      assert.equal(digest(text), declaration.sha256, declaration.name);
      assert.match(text, new RegExp(`^(?:(?:async )?function|class|const) ${declaration.name}\\b`));
      offset += length;
      const separator = source.slice(offset, offset + (declaration === entry.declarations.at(-1) ? 1 : 2));
      assert.equal(separator, declaration === entry.declarations.at(-1) ? '\n' : '\n\n');
      offset += separator.length;
    }
    assert.equal(offset, source.length, 'no extra unverified code');
    sources.set(entry.sourcePath, source);
  }
  const packageBytes = readFileSync(new URL(provenance.package.fixture, root));
  assert.equal(digest(packageBytes), provenance.package.sha256);
  const applicationVersion = (JSON.parse(packageBytes.toString('utf8')) as { version: string }).version;
  assert.equal(applicationVersion, provenance.applicationVersion);
  return { provenance, sources, applicationVersion };
}

export interface B16EarlyRejectionTraps {
  timestamp: () => never;
  inventory: () => never;
  newStage: () => never;
}
export interface B16ParsingEntries {
  validateExportEnvelope(data: unknown, now: string): unknown;
  verifyInstanceBundle(bundle: string): unknown;
  restoreInstance(options: { bundle: string; target: string }): Promise<unknown>;
}

/**
 * Execute only the unchanged early-rejection entry paths. Unreached dependencies are
 * intentionally absent, and guarded post-gate dependencies throw rather than simulating success.
 * Native type transformation is available from the project's minimum Node 22.13.
 */
export function loadB16ParsingEntries(traps: B16EarlyRejectionTraps): B16ParsingEntries {
  const { sources, applicationVersion } = readB16EntryFixture();
  const source = ['src/server/store.ts', 'src/server/import-plan.ts', 'src/server/instance-backup.ts']
    .map(path => { assert.ok(sources.has(path)); return sources.get(path)!; }).join('\n\n');
  // AST generation stored declaration spans without the outer export wrapper. No body rewriting.
  const js = stripTypeScriptTypes(source, { mode: 'transform' });
  const dependencies = {
    applicationVersion, ...traps,
    existsSync, lstatSync, readFileSync, realpathSync, dirname, isAbsolute, join, relative, resolve,
  };
  return new Function(...Object.keys(dependencies), `${js}\nreturn { validateExportEnvelope, verifyInstanceBundle, restoreInstance };`)
    (...Object.values(dependencies)) as B16ParsingEntries;
}
