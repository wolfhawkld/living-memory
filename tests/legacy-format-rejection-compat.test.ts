import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { Store } from '../src/server/store.js';
import { backupInstance, verifyInstanceBundle } from '../src/server/instance-backup.js';
import { B16_COMMIT, loadB16ParsingEntries, readB16EntryFixture } from './helpers/b16-format-entries.js';
import { treeHashes } from './helpers/instance-backup-fixture.js';

function oldEntries() {
  const calls = { timestamp: 0, inventory: 0, newStage: 0 };
  const unreachable = (key: keyof typeof calls) => () => { calls[key]++; throw new Error(`unexpected post-version-gate dependency: ${key}`); };
  return { calls, entries: loadB16ParsingEntries({ timestamp: unreachable('timestamp'), inventory: unreachable('inventory'), newStage: unreachable('newStage') }) };
}

test('fixed b16 parsing-entry fragments retain original source and declaration provenance, not a claimed old executable', () => {
  const { provenance, sources, applicationVersion } = readB16EntryFixture();
  assert.equal(provenance.sourceCommit, B16_COMMIT);
  assert.equal(applicationVersion, '0.0.1-preview.1');
  assert.equal(provenance.entries.length, 3);
  assert.equal(provenance.entries.find(entry => entry.sourcePath === 'src/server/instance-backup.ts')?.sourceSha256,
    'b5f88d968e824d5dcf5b1d8b71082253d43d76e6873154e840af1eb192ae0561');
  assert.match(sources.get('src/server/import-plan.ts')!, /record\.schemaVersion !== 1/);
  assert.match(sources.get('src/server/instance-backup.ts')!, /manifest\.version !== 1/);
});

test('actual b16 JSON parsing entry rejects a current JSON2 export before timestamps or downstream import work', () => {
  const base = mkdtempSync(join(tmpdir(), 'lm-b16-json2-entry-'));
  const store = new Store({ dataDir: base, namespace: 'synthetic', now: () => new Date('2026-10-20T00:00:00.000Z') });
  try {
    const currentExport = store.exportData({ name: 'synthetic', mode: 'local', conceptCount: 0, limit: 10, diagnostics: [] }, []);
    assert.equal(currentExport.schemaVersion, 2);
    assert.deepEqual(currentExport.observationRevisions, []);
    const before = JSON.stringify(currentExport);
    const { entries, calls } = oldEntries();
    assert.throws(() => entries.validateExportEnvelope(currentExport, currentExport.exportedAt), { name: 'StoreError', code: 'UNSUPPORTED_SCHEMA', status: 400 });
    assert.deepEqual(calls, { timestamp: 0, inventory: 0, newStage: 0 });
    assert.equal(JSON.stringify(currentExport), before);
  } finally { store.close(); rmSync(base, { recursive: true, force: true }); }
});

test('actual b16 restore entry rejects an unmodified new-tool bundle2 before inventory or creation of any target stage', async () => {
  const base = mkdtempSync(join(tmpdir(), 'lm-b16-bundle2-entry-'));
  const dataDir = join(base, 'data'), kgRoot = join(base, 'knowledge'), cliStateDir = join(base, 'cli'), procRoot = join(base, 'proc');
  for (const directory of [dataDir, kgRoot, cliStateDir, procRoot]) mkdirSync(directory);
  writeFileSync(join(kgRoot, 'Synthetic.md'), '---\ntype: concept\ntitle: Synthetic\n---\n# Definition\nSynthetic body.\n');
  const store = new Store({ dataDir, namespace: 'synthetic', now: () => new Date('2026-10-20T00:00:00.000Z') });
  store.close();
  try {
    const bundle = join(base, 'bundle');
    const manifest = await backupInstance({ dataDir, kgRoot, cliStateDir, procRoot, output: bundle, now: () => new Date('2026-10-20T00:00:00.000Z') });
    assert.equal(manifest.version, 2); assert.equal(manifest.learningSchemaVersion, 2);
    assert.equal(verifyInstanceBundle(bundle).version, 2);
    const before = treeHashes(bundle), directories = readdirSync(base).sort();
    const { entries, calls } = oldEntries();
    const target = join(base, 'never-created');
    assert.equal(existsSync(target), false);
    assert.throws(() => entries.verifyInstanceBundle(bundle), { name: 'InstanceBackupError', code: 'INSTANCE_MANIFEST_INVALID' });
    await assert.rejects(entries.restoreInstance({ bundle, target }), { name: 'InstanceBackupError', code: 'INSTANCE_MANIFEST_INVALID' });
    assert.deepEqual(calls, { timestamp: 0, inventory: 0, newStage: 0 });
    assert.equal(existsSync(target), false);
    assert.deepEqual(readdirSync(base).sort(), directories, 'no stage or other restore side effect');
    assert.deepEqual(treeHashes(bundle), before);
    assert.equal(JSON.parse(readFileSync(join(bundle, 'manifest.json'), 'utf8')).version, 2);
    // The real old-tool bundle is a separate immutable artifact, never produced by editing version fields.
    const oldManifest = JSON.parse(readFileSync(resolve('tests/fixtures/compat-b16-instance-v1/bundle/manifest.json'), 'utf8'));
    assert.equal(oldManifest.version, 1); assert.equal(oldManifest.applicationVersion, '0.0.1-preview.1');
  } finally { rmSync(base, { recursive: true, force: true }); }
});
