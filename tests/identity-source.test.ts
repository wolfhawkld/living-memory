import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { IdentityBinding } from '../src/shared/identity.js';
import type { Concept } from '../src/shared/types.js';
import { applyIdentityBindings } from '../src/server/identity-source.js';
import type { KnowledgeSource } from '../src/server/kg.js';

const binding: IdentityBinding = { operationId: 'move-1', rawConceptId: 'new-id', conceptId: 'old-id', fromPath: 'Old.md',
  toPath: 'New.md', sourceRevision: 'v1', confirmedAt: '2026-09-27T00:00:00Z', backupId: 'backup' };
const concept = (id: string, path: string, revision = 'v1'): Concept => ({ id, title: id, aliases: [], domain: 'Math',
  summary: '', body: '', source: { path, revision } });
function source(concepts: Concept[]): KnowledgeSource {
  const graph = { concepts, links: [{ id: 'edge', source: 'new-id', target: 'other-id', type: 'related', description: '' }],
    source: { name: 'test', mode: 'local' as const, conceptCount: concepts.length, limit: 20, diagnostics: [] } };
  return { graph, index: graph, namespace: 'private-space', root: '/synthetic' };
}

test('confirmed moves preserve stable IDs and reconnect graph endpoints without changing content version', () => {
  const original = source([concept('new-id', 'New.md', 'v2'), concept('other-id', 'Other.md')]);
  const result = applyIdentityBindings(original, [binding]);
  assert.equal(result.index.concepts[0].id, 'old-id');
  assert.deepEqual(result.index.concepts[0].source, { path: 'New.md', revision: 'v2' });
  assert.equal(result.index.links[0].source, 'old-id');
  assert.equal(original.index.concepts[0].id, 'new-id');
});

test('reappearing old files quarantine both competing nodes rather than attaching history to either', () => {
  const original = source([concept('new-id', 'New.md'), concept('old-id', 'Old.md'), concept('other-id', 'Other.md')]);
  const result = applyIdentityBindings(original, [binding]);
  assert.deepEqual(result.index.concepts.map(item => item.id), ['other-id']);
  assert.equal(result.index.links.length, 0);
  assert.equal(result.index.source.conceptCount, 1);
  assert.match(result.index.source.diagnostics.join('\n'), /身份冲突.*Old.md/);
});

test('bindings never guess from a matching name, and invalid binding paths are isolated', () => {
  const original = source([concept('unmatched', 'New.md'), concept('new-id', 'Wrong.md')]);
  const result = applyIdentityBindings(original, [binding]);
  assert.deepEqual(result.index.concepts.map(item => item.id), ['unmatched']);
  assert.match(result.index.source.diagnostics.join('\n'), /身份登记与文件不一致/);
});
