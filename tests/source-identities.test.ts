import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadKnowledgeGraph } from '../src/server/kg.js';
import { parseSourceIdentityRegistry, resolveSourceIdentity, sourceIdentityHash } from '../src/server/source-identities.js';

test('an explicit private registry preserves legacy raw IDs and namespace across physical roots', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lm-source-identity-'));
  try {
    const oldRoot = join(dir, 'old'), newRoot = join(dir, 'new'), data = join(dir, 'data');
    for (const root of [oldRoot, newRoot, data]) mkdirSync(root);
    for (const root of [oldRoot, newRoot]) writeFileSync(join(root, 'A.md'), '---\ntype: concept\ntitle: Alpha\n---\n# Alpha\ncontent\n');
    const original = loadKnowledgeGraph({ root: oldRoot });
    assert.equal(resolveSourceIdentity(data, oldRoot).identityHash, sourceIdentityHash(oldRoot));
    assert.notEqual(loadKnowledgeGraph({ root: newRoot }).namespace, original.namespace);
    writeFileSync(join(data, 'source-identities.json'), JSON.stringify({ format: 'living-memory-source-identities', version: 1,
      entries: [{ physicalRoot: newRoot, identityHash: sourceIdentityHash(oldRoot) }] }), { mode: 0o600 });
    const identity = resolveSourceIdentity(data, newRoot), migrated = loadKnowledgeGraph({ root: newRoot, identityHash: identity.identityHash });
    assert.equal(migrated.namespace, original.namespace); assert.equal(migrated.index.concepts[0].id, original.index.concepts[0].id);
    assert.equal(migrated.index.concepts[0].source.revision, original.index.concepts[0].source.revision);
    assert.equal(migrated.root, newRoot); assert.equal(identity.sourceRootFingerprint, sourceIdentityHash(newRoot));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('damaged, duplicate or conflicting registries fail instead of silently generating a new identity', () => {
  const entry = { physicalRoot: '/synthetic/source', identityHash: 'a'.repeat(64) };
  const valid = { format: 'living-memory-source-identities', version: 1, entries: [entry] };
  assert.equal(parseSourceIdentityRegistry(valid).entries.length, 1);
  for (const entries of [[entry, entry], [entry, { ...entry, physicalRoot: '/another/source' }], [{ ...entry, physicalRoot: '../escape' }], [{ ...entry, identityHash: 'invalid' }]]) {
    assert.throws(() => parseSourceIdentityRegistry({ ...valid, entries }));
  }
  assert.throws(() => loadKnowledgeGraph({ root: 'fixtures/demo-kg', identityHash: 'untrusted' }));
});
