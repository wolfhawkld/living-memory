import assert from 'node:assert/strict';
import test from 'node:test';
import type { Concept, GraphLink, Snapshot } from '../src/shared/types.js';
import { projectDomainView } from '../src/core/domain-view.js';
import { summarizeDomainVisibility } from '../src/core/domain-visibility.js';

function concept(id: string, path: string): Concept {
  return { id, title: id, aliases: [], domain: 'frontmatter-is-not-directory', summary: '', body: '', source: { path, revision: 'v1' } };
}
function link(id: string, source: string, target: string): GraphLink {
  return { id, source, target, type: 'related', description: '' };
}
function fixture(): Snapshot {
  return { concepts: [concept('a', 'Math/a.md'), concept('b', 'Math/b.md'), concept('c', 'Math/c.md'),
    concept('x', 'Model/x.md'), concept('y', 'Model/y.md'), concept('root', 'root.md')],
    links: [link('ab', 'a', 'b'), link('ac', 'a', 'c'), link('bc', 'b', 'c'), link('ca', 'c', 'a'),
      link('ax', 'a', 'x'), link('cy', 'c', 'y'), link('xy', 'x', 'y'), link('broken', 'a', 'missing')],
    source: { name: 'synthetic', mode: 'demo', conceptCount: 6, limit: 2, diagnostics: [] },
    states: {}, config: { modelVersion: 'time-only-v0', revision: 1, halfLifeDays: 7 }, asOf: '2026-10-07T00:00:00.000Z', observationsCount: 0 };
}

test('summaries count real primary relations without treating hidden cross-domain links as hidden internal links', () => {
  const full = fixture(); const before = structuredClone(full);
  const view = projectDomainView(full, 'Math');
  assert.deepEqual(summarizeDomainVisibility(full, view, 'Math'), {
    domainTotalNodes: 3, visiblePrimaryNodes: 2, hiddenPrimaryNodes: 1, visibleCrossDomainNodes: 0,
    totalInternalLinks: 4, visibleInternalLinks: 1, hiddenInternalLinks: 3,
  });
  assert.deepEqual(full, before);
});

test('selected replacement counts the final primary set and only its explicit connected cross-domain expansion', () => {
  const full = fixture();
  const view = projectDomainView(full, 'Math', { selectedId: 'c', expandedIds: ['x', 'y'] });
  assert.deepEqual(view.concepts.map(item => item.id), ['a', 'c', 'x', 'y']);
  assert.deepEqual(summarizeDomainVisibility(full, view, 'Math'), {
    domainTotalNodes: 3, visiblePrimaryNodes: 2, hiddenPrimaryNodes: 1, visibleCrossDomainNodes: 2,
    totalInternalLinks: 4, visibleInternalLinks: 2, hiddenInternalLinks: 2,
  });
});

test('visibility requires both rendered endpoints and the actual matching view relation', () => {
  const full = fixture(); const view = projectDomainView(full, 'Math', { limit: 3 });
  view.links = [link('ab', 'a', 'b'), link('ac', 'c', 'a'), link('fabricated', 'b', 'c')];
  assert.equal(summarizeDomainVisibility(full, view, 'Math').visibleInternalLinks, 1);
  assert.equal(summarizeDomainVisibility(full, view, 'Math').hiddenInternalLinks, 3);
  view.concepts = view.concepts.filter(item => item.id !== 'b');
  assert.equal(summarizeDomainVisibility(full, view, 'Math').visibleInternalLinks, 0);
});

test('full source identity rejects foreign nodes, normalizes paths and ignores misleading projected metadata', () => {
  const full = fixture();
  full.concepts[0]!.source.path = '.\\Math\\a.md';
  const view = projectDomainView(full, 'Math', { limit: 3 });
  view.concepts = [...view.concepts.map(item => ({ ...item, source: { ...item.source, path: 'Model/fake.md' } })), concept('unknown', 'Math/unknown.md')];
  assert.equal(summarizeDomainVisibility(full, view, '.\\Math\\').visiblePrimaryNodes, 3);
  assert.equal(summarizeDomainVisibility(full, view, 'Math').visibleCrossDomainNodes, 0);
  assert.equal(summarizeDomainVisibility(full, view, 'Math').domainTotalNodes, 3);
});

test('empty or absent domains and root domains report exact zeroes without negative counts', () => {
  const full = fixture(); const empty = { ...full, concepts: [], links: [] };
  assert.deepEqual(summarizeDomainVisibility(empty, empty, 'Math'), {
    domainTotalNodes: 0, visiblePrimaryNodes: 0, hiddenPrimaryNodes: 0, visibleCrossDomainNodes: 0,
    totalInternalLinks: 0, visibleInternalLinks: 0, hiddenInternalLinks: 0,
  });
  assert.equal(summarizeDomainVisibility(full, empty, 'Math').hiddenPrimaryNodes, 3);
  assert.equal(summarizeDomainVisibility(full, projectDomainView(full, '__root__'), '').visiblePrimaryNodes, 1);
  assert.equal(summarizeDomainVisibility(full, projectDomainView(full, 'missing'), 'missing').totalInternalLinks, 0);
});
