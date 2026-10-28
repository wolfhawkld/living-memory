import assert from 'node:assert/strict';
import test from 'node:test';
import { domainIdOf, projectDomainView } from '../src/core/domain-view.js';
import type { Concept, GraphLink, Snapshot } from '../src/shared/types.js';

function concept(id: string, domain = 'Math'): Concept {
  return { id, title: id, aliases: [], domain: 'unrelated-frontmatter', summary: '', body: '',
    source: { path: `${domain}/${id}.md`, revision: 'synthetic-v1' } };
}
function edge(source: string, target: string, id = `${source}-${target}`, type = 'related'): GraphLink {
  return { id, source, target, type, description: `${source} to ${target}` };
}
function snapshot(concepts: Concept[], links: GraphLink[], limit = 20): Snapshot {
  const asOf = '2026-10-26T00:00:00.000Z';
  return { concepts, links, states: Object.fromEntries(concepts.map(item => [item.id, {
    conceptId: item.id, status: 'unknown' as const, decay: null, elapsedDays: null,
    anchor: null, reason: null, asOf,
  }])), source: { name: 'synthetic', mode: 'demo', conceptCount: concepts.length, limit, diagnostics: [] },
  config: { modelVersion: 'time-only-v0', halfLifeDays: 7, revision: 1 }, asOf, observationsCount: 4 };
}
function ids(view: Snapshot): string[] { return view.concepts.map(item => item.id); }
function chain(prefix: string, count: number): { concepts: Concept[]; links: GraphLink[] } {
  const concepts = Array.from({ length: count }, (_, index) => concept(`${prefix}${index}`));
  return { concepts, links: concepts.slice(1).map((item, index) => edge(concepts[index]!.id, item.id)) };
}
/** Independently count components through the actual projected links. */
function componentSizes(view: Snapshot): number[] {
  const remaining = new Set(ids(view));
  const sizes: number[] = [];
  while (remaining.size) {
    const seed = remaining.values().next().value!;
    const queue = [seed];
    remaining.delete(seed);
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const current = queue[cursor]!;
      for (const link of view.links) {
        const neighbor = link.source === current ? link.target : link.target === current ? link.source : null;
        if (neighbor !== null && remaining.delete(neighbor)) queue.push(neighbor);
      }
    }
    sizes.push(queue.length);
  }
  return sizes.sort((a, b) => b - a);
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

test('a 20-node cap shows one connected region even when source-first nodes have no mutual edges', () => {
  const left = Array.from({ length: 20 }, (_, i) => concept(`a${i}`));
  const right = Array.from({ length: 20 }, (_, i) => concept(`b${i}`));
  const links = left.flatMap((item, i) => [edge(item.id, right[i]!.id),
    ...(i < 19 ? [edge(right[i]!.id, left[i + 1]!.id)] : [])]);
  const full = snapshot([...left, ...right], links);
  const oldFirstIds = new Set(left.map(item => item.id));
  assert.equal(links.filter(link => oldFirstIds.has(link.source) && oldFirstIds.has(link.target)).length, 0);
  const view = projectDomainView(full, 'Math');
  assert.equal(view.concepts.length, 20);
  assert.deepEqual(componentSizes(view), [20]);
  assert.deepEqual(ids(view), full.concepts.filter(item => ids(view).includes(item.id)).map(item => item.id));
  assert.equal(view.source.conceptCount, 40);
});

test('unique same-domain neighbors determine degree while original directed multi-edges are preserved', () => {
  const concepts = ['noisy', 'leaf', 'hub', 'x', 'y'].map(id => concept(id));
  const outside = concept('outside', 'Model');
  const real = [edge('noisy', 'leaf'), edge('leaf', 'hub'), edge('hub', 'x'), edge('hub', 'y')];
  const noise = Array.from({ length: 40 }, (_, i) => [
    edge('noisy', 'leaf', `duplicate-${i}`), edge('leaf', 'noisy', `reverse-${i}`),
    edge('noisy', 'noisy', `self-${i}`), edge('noisy', 'missing', `dangling-${i}`),
    edge('noisy', 'outside', `cross-${i}`),
  ]).flat();
  const variants = [edge('x', 'hub', 'incoming', 'prerequisite'),
    edge('hub', 'x', 'other-type', 'application'), { ...real[2]!, description: 'second description' }];
  const full = snapshot([...concepts, outside], [...real, ...noise, ...variants]);
  assert.deepEqual(ids(projectDomainView(full, 'Math', { limit: 1 })), ['hub']);
  assert.deepEqual(ids(projectDomainView(full, 'Math', { limit: 4 })), ['leaf', 'hub', 'x', 'y']);
  const view = projectDomainView(full, 'Math', { limit: 5 });
  const visible = new Set(ids(view));
  assert.deepEqual(view.links, full.links.filter(link => visible.has(link.source) && visible.has(link.target)));
  assert.equal(view.links.filter(link => link.source === 'noisy' && link.target === 'leaf').length, 41);
  for (const link of view.links) assert.ok(full.links.includes(link));
});

test('selection inside the default region is stable and selection outside opens its connected neighborhood', () => {
  const main = chain('main', 8), remote = chain('remote', 5);
  const full = snapshot([...main.concepts, ...remote.concepts], [...main.links, ...remote.links], 3);
  const initial = projectDomainView(full, 'Math');
  for (const selectedId of ids(initial)) {
    const focused = projectDomainView(full, 'Math', { selectedId });
    assert.deepEqual(focused.concepts, initial.concepts);
    assert.deepEqual(focused.links, initial.links);
  }
  const selected = projectDomainView(full, 'Math', { selectedId: 'remote4' });
  assert.ok(ids(selected).includes('remote4'));
  assert.ok(ids(selected).every(id => id.startsWith('remote')));
  assert.deepEqual(componentSizes(selected), [3]);
  assert.deepEqual(ids(selected), ['remote2', 'remote3', 'remote4']);
  assert.deepEqual(ids(projectDomainView(full, 'Math', { selectedId: 'missing' })), ids(initial));
});

test('a capped breadth-first frontier prefers greater degree and resolves equal neighbors by source order', () => {
  const concepts = ['low', 'tie-first', 'hub', 'high', 'tie-last', 'tail-a', 'tail-b'].map(id => concept(id));
  const links = [edge('hub', 'tie-last'), edge('hub', 'low'), edge('hub', 'high'),
    edge('hub', 'tie-first'), edge('high', 'tail-a'), edge('high', 'tail-b')];
  const full = snapshot(concepts, links);
  assert.deepEqual(ids(projectDomainView(full, 'Math', { limit: 2 })), ['hub', 'high']);
  assert.deepEqual(ids(projectDomainView(full, 'Math', { limit: 3 })), ['low', 'hub', 'high']);
  assert.deepEqual(ids(projectDomainView(full, 'Math', { limit: 4 })), ['low', 'tie-first', 'hub', 'high']);
});

test('larger real components come first and equal-sized components use source order without invented links', () => {
  const a = chain('a', 2), b = chain('b', 2), large = chain('large', 3);
  const full = snapshot([concept('isolated'), ...b.concepts, ...a.concepts, ...large.concepts],
    [...a.links, ...large.links, ...b.links], 5);
  const view = projectDomainView(full, 'Math');
  assert.deepEqual(ids(view), ['b0', 'b1', 'large0', 'large1', 'large2']);
  assert.deepEqual(componentSizes(view), [3, 2]);
  assert.deepEqual(view.links, full.links.filter(link => ids(view).includes(link.source) && ids(view).includes(link.target)));
  const allButOne = projectDomainView(full, 'Math', { limit: 7 });
  assert.equal(allButOne.concepts.length, 7);
  assert.deepEqual(componentSizes(allButOne), [3, 2, 2]);
});

test('fully isolated concepts keep source-first limits and an explicit outside selection remains visible', () => {
  const concepts = Array.from({ length: 25 }, (_, i) => concept(`isolated${i}`));
  const full = snapshot(concepts, [edge('isolated24', 'isolated24'), edge('isolated24', 'missing')]);
  assert.deepEqual(ids(projectDomainView(full, 'Math')), concepts.slice(0, 20).map(item => item.id));
  assert.deepEqual(ids(projectDomainView(full, 'Math', { limit: 1, selectedId: 'isolated24' })), ['isolated24']);
  assert.equal(projectDomainView(full, 'Math').links.length, 0);
});

test('a complete domain at or below its cap preserves source order regardless of degree or selection', () => {
  const full = snapshot(['first', 'second', 'hub', 'last'].map(id => concept(id)),
    [edge('hub', 'last'), edge('hub', 'first'), edge('hub', 'second')]);
  for (const limit of [4, 5, 300]) {
    for (const selectedId of [null, 'last', 'hub']) {
      const view = projectDomainView(full, 'Math', { limit, selectedId });
      assert.deepEqual(view.concepts, full.concepts);
      assert.deepEqual(view.links, full.links);
    }
  }
});

test('edge order and repeated reverse edges do not change the chosen primary concepts', () => {
  const graph = chain('node', 40);
  const full = snapshot(graph.concepts, graph.links, 9);
  const expected = ids(projectDomainView(full, 'Math'));
  const changed = { ...full, links: [...graph.links].reverse().flatMap((link, i) => [link,
    edge(link.target, link.source, `reverse-${i}`), { ...link }, edge(link.source, link.source, `self-${i}`)]) };
  assert.deepEqual(ids(projectDomainView(changed, 'Math')), expected);
  assert.deepEqual(componentSizes(projectDomainView(changed, 'Math')), [9]);
});

test('cross-domain expansion is gated by the final selected region and cannot chain through expansions', () => {
  const main = chain('main', 6), remote = chain('remote', 4);
  const outside = ['old', 'new', 'second-hop', ...Array.from({ length: 7 }, (_, i) => `extra${i}`)]
    .map(id => concept(id, 'Model'));
  const links = [...main.links, ...remote.links, edge('main1', 'old'), edge('remote3', 'new'),
    edge('new', 'second-hop'), ...outside.filter(item => item.id.startsWith('extra')).map(item => edge(item.id, 'remote3'))];
  const full = snapshot([...main.concepts, ...remote.concepts, ...outside], links, 3);
  const view = projectDomainView(full, 'Math', { selectedId: 'remote3', expandedIds: outside.map(item => item.id) });
  const expanded = view.concepts.filter(item => domainIdOf(item) !== 'Math');
  assert.equal(expanded.length, 6);
  assert.ok(expanded.some(item => item.id === 'new'));
  assert.ok(!expanded.some(item => item.id === 'old' || item.id === 'second-hop'));
  for (const item of expanded) assert.ok(view.links.some(link =>
    (link.source === item.id && link.target.startsWith('remote')) || (link.target === item.id && link.source.startsWith('remote'))));
  assert.ok(view.links.every(link => ids(view).includes(link.source) && ids(view).includes(link.target)));
});

test('large connected domains respect 1/20/300 limits and total expansion capacity', () => {
  const graph = chain('node', 1000);
  const outside = concept('outside', 'Model');
  const full = snapshot([...graph.concepts, outside], [...graph.links, edge('node999', 'outside')]);
  for (const [limit, count] of [[0, 1], [1, 1], [20, 20], [300, 300], [301, 300], [NaN, 20], [Infinity, 20]]) {
    const view = projectDomainView(full, 'Math', { limit, selectedId: 'node999' });
    assert.equal(view.concepts.length, count);
    assert.ok(ids(view).includes('node999'));
    assert.deepEqual(componentSizes(view), [count]);
  }
  assert.equal(projectDomainView(full, 'Math', { limit: 299, selectedId: 'node999', expandedIds: ['outside'] }).concepts.length, 300);
  assert.equal(projectDomainView(full, 'Math', { limit: 300, selectedId: 'node999', expandedIds: ['outside'] }).concepts.length, 300);
});

test('projection preserves frozen input facts and object references while only selecting visible state entries', () => {
  const graph = chain('node', 30);
  const full = snapshot(graph.concepts, graph.links);
  const before = structuredClone(full);
  const options = freeze({ selectedId: 'node29', expandedIds: ['missing'], limit: 4 });
  freeze(full);
  const view = projectDomainView(full, '.\\Math\\', options);
  assert.deepEqual(full, before);
  assert.equal(view.config, full.config);
  assert.equal(view.asOf, full.asOf);
  assert.equal(view.observationsCount, full.observationsCount);
  assert.equal(view.source.limit, full.source.limit);
  assert.equal(view.source.conceptCount, 30);
  assert.deepEqual(Object.keys(view.states).sort(), ids(view).sort());
  for (const item of view.concepts) {
    assert.ok(full.concepts.includes(item));
    assert.equal(view.states[item.id], full.states[item.id]);
  }
  for (const link of view.links) assert.ok(full.links.includes(link));
});
