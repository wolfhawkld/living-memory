import assert from 'node:assert/strict';
import test from 'node:test';
import type { Concept, GraphLink, Layout, Snapshot } from '../src/shared/types.js';
import {
  chooseDomain,
  domainIdOf,
  domainLabel,
  getCrossDomainNeighbors,
  listDomains,
  mergeLayout,
  projectDomainView,
} from '../src/core/domain-view.js';

function concept(id: string, path: string, title = id): Concept {
  return {
    id,
    title,
    aliases: [],
    domain: 'ignored-frontmatter-domain',
    summary: `${title} summary`,
    body: `${title} body`,
    source: { path, revision: `rev-${id}` },
  };
}

function link(id: string, source: string, target: string, type = 'related'): GraphLink {
  return { id, source, target, type, description: '' };
}

function makeSnapshot(): Snapshot {
  const concepts = [
    concept('math-a', 'Cognition/Math/a.md', 'A'),
    concept('math-b', 'Cognition/Math/b.md', 'B'),
    concept('model-a', 'Cognition/Model/a.md', 'Model A'),
    concept('biology-a', 'Cognition/Biology/a.md', 'Biology A'),
    concept('root-a', 'root.md', 'Root A'),
  ];
  const states = Object.fromEntries(concepts.map((item) => [item.id, {
    conceptId: item.id,
    status: 'recent' as const,
    decay: 1,
    elapsedDays: 0,
    anchor: null,
    reason: null,
    asOf: '2026-09-17T00:00:00.000Z',
  }]));
  return {
    concepts,
    links: [
      link('model-to-math', 'model-a', 'math-a'),
      link('math-to-biology', 'math-a', 'biology-a'),
      link('biology-to-math', 'biology-a', 'math-a'),
      link('math-to-model', 'math-a', 'model-a'),
      link('same-domain', 'math-a', 'math-b'),
    ],
    source: {
      name: 'fixture',
      mode: 'local',
      conceptCount: concepts.length,
      limit: 20,
      diagnostics: [],
      initialDomainId: 'Cognition/Model',
    },
    config: { modelVersion: 'time-only-v0', halfLifeDays: 7, revision: 3 },
    states,
    asOf: '2026-09-17T00:00:00.000Z',
    observationsCount: 4,
  };
}

test('domain IDs use normalized parent paths and labels distinguish duplicate leaves', () => {
  assert.equal(domainIdOf(concept('root', './root.md')), '__root__');
  assert.equal(domainIdOf(concept('math', 'Cognition\\Math\\a.md')), 'Cognition/Math');
  assert.equal(domainLabel('Cognition/Math'), '数学');
  assert.equal(domainLabel('Cognition/Model'), 'AI / 模型');
  assert.equal(domainLabel('Notes/Research'), 'Research');
  assert.equal(domainLabel('__root__'), '根目录');

  const snapshot = makeSnapshot();
  const options = listDomains(snapshot);
  assert.deepEqual(options.map(({ id, label, path, conceptCount }) => ({ id, label, path, conceptCount })), [
    { id: 'Cognition/Biology', label: '生物', path: 'Cognition/Biology', conceptCount: 1 },
    { id: 'Cognition/Math', label: '数学', path: 'Cognition/Math', conceptCount: 2 },
    { id: 'Cognition/Model', label: 'AI / 模型', path: 'Cognition/Model', conceptCount: 1 },
    { id: '__root__', label: '根目录', path: '', conceptCount: 1 },
  ]);
});

test('domain choice honors a valid saved choice, initial hint, then Math and first domain', () => {
  const snapshot = makeSnapshot();
  assert.equal(chooseDomain(snapshot, 'Cognition/Math'), 'Cognition/Math');
  assert.equal(chooseDomain(snapshot, 'missing'), 'Cognition/Model');

  const withoutInitial = {
    ...snapshot,
    source: { ...snapshot.source, initialDomainId: undefined },
  };
  assert.equal(chooseDomain(withoutInitial, 'missing'), 'Cognition/Math');

  const withoutMath = {
    ...withoutInitial,
    concepts: snapshot.concepts.filter((item) => !item.id.startsWith('math-')),
  };
  assert.equal(chooseDomain(withoutMath, null), 'Cognition/Biology');

  assert.equal(chooseDomain({ ...snapshot, concepts: [] }, null), null);
});

test('domain projection caps primary nodes, keeps a focused node, and expands only linked requests', () => {
  const snapshot = makeSnapshot();
  const selectedState = snapshot.states['math-b'];
  const projected = projectDomainView(snapshot, 'Cognition/Math', {
    limit: 1,
    selectedId: 'math-b',
    expandedIds: ['root-a', 'biology-a', 'model-a', 'missing-id', 'math-a'],
  });

  assert.deepEqual(projected.concepts.map((item) => item.id), ['math-b']);
  assert.equal(projected.source.conceptCount, 2);
  assert.equal(projected.states['math-b'], selectedState);
  assert.deepEqual(Object.keys(projected.states).sort(), ['math-b']);
  assert.ok(projected.links.every((item) => (
    projected.concepts.some((concept) => concept.id === item.source)
    && projected.concepts.some((concept) => concept.id === item.target)
  )));
  assert.deepEqual(projected.links, []);
  assert.equal(projected.asOf, snapshot.asOf);
  assert.equal(projected.config, snapshot.config);
  assert.equal(projected.observationsCount, snapshot.observationsCount);
  assert.equal(snapshot.concepts.length, 5);
  assert.equal(snapshot.links.length, 5);
});

test('projection ignores unrelated or same-domain expansions, limits six, and never exceeds 300 nodes', () => {
  const primary = Array.from({ length: 2 }, (_, index) => concept(`math-${index}`, `Cognition/Math/${index}.md`));
  const outside = Array.from({ length: 8 }, (_, index) => concept(`model-${index}`, `Cognition/Model/${index}.md`));
  const unrelated = concept('root-unrelated', 'root-unrelated.md');
  const concepts = [...primary, ...outside, unrelated];
  const links = outside.map((item, index) => link(`cross-${index}`, item.id, primary[0].id));
  const states = Object.fromEntries(concepts.map((item) => [item.id, {
    conceptId: item.id,
    status: 'unknown' as const,
    decay: null,
    elapsedDays: null,
    anchor: null,
    reason: null,
    asOf: '2026-09-17T00:00:00.000Z',
  }]));
  const snapshot: Snapshot = {
    ...makeSnapshot(),
    concepts,
    links,
    states,
    source: { ...makeSnapshot().source, limit: 1 },
  };
  const projected = projectDomainView(snapshot, 'Cognition/Math', {
    limit: 1,
    expandedIds: ['root-unrelated', ...outside.map((item) => item.id), 'math-1'],
  });

  assert.deepEqual(projected.concepts.map((item) => item.id), [
    'math-0', 'model-0', 'model-1', 'model-2', 'model-3', 'model-4', 'model-5',
  ]);
  assert.equal(projected.concepts.length, 7);

  const capped = projectDomainView(snapshot, 'Cognition/Math', {
    limit: 300,
    expandedIds: outside.map((item) => item.id),
  });
  assert.ok(capped.concepts.length <= 300);
  assert.equal(capped.concepts.filter((item) => domainIdOf(item) !== 'Cognition/Math').length, 6);

  const largePrimary = Array.from({ length: 301 }, (_, index) => concept(`math-${index}`, `Cognition/Math/${index}.md`));
  const largeSnapshot = { ...snapshot, concepts: [...largePrimary, ...outside] };
  const full = projectDomainView(largeSnapshot, 'Cognition/Math', {
    limit: 300,
    expandedIds: outside.map((item) => item.id),
  });
  assert.equal(full.concepts.length, 300);
  assert.ok(full.concepts.every((item) => domainIdOf(item) === 'Cognition/Math'));
  const nearFull = projectDomainView(largeSnapshot, 'Cognition/Math', {
    limit: 299,
    expandedIds: outside.map((item) => item.id),
  });
  assert.equal(nearFull.concepts.length, 300);
  assert.equal(nearFull.concepts.filter((item) => domainIdOf(item) !== 'Cognition/Math').length, 1);
});

test('cross-domain neighbors include incoming and outgoing links, dedupe concepts, and sort stably', () => {
  const snapshot = makeSnapshot();
  const neighbors = getCrossDomainNeighbors(snapshot, 'math-a');

  assert.deepEqual(neighbors.map((item) => ({
    id: item.concept.id,
    domainId: item.domainId,
    domainLabel: item.domainLabel,
    links: item.links.map((edge) => edge.id),
  })), [
    {
      id: 'biology-a',
      domainId: 'Cognition/Biology',
      domainLabel: '生物',
      links: ['biology-to-math', 'math-to-biology'],
    },
    {
      id: 'model-a',
      domainId: 'Cognition/Model',
      domainLabel: 'AI / 模型',
      links: ['math-to-model', 'model-to-math'],
    },
  ]);
  assert.deepEqual(getCrossDomainNeighbors(snapshot, 'missing'), []);
});

test('layout merge preserves hidden positions and does not mutate either input', () => {
  const existing: Layout = {
    hidden: { x: 1, y: 2, z: 3 },
    visible: { x: 4, y: 5, z: 6 },
  };
  const incoming: Layout = {
    visible: { x: 40, y: 50, z: 60 },
    added: { x: 7, y: 8, z: 9 },
  };
  const merged = mergeLayout(existing, incoming);

  assert.deepEqual(merged, {
    hidden: { x: 1, y: 2, z: 3 },
    visible: { x: 40, y: 50, z: 60 },
    added: { x: 7, y: 8, z: 9 },
  });
  assert.notEqual(merged.hidden, existing.hidden);
  assert.notEqual(merged.visible, incoming.visible);
  assert.deepEqual(existing.visible, { x: 4, y: 5, z: 6 });
  assert.deepEqual(incoming.visible, { x: 40, y: 50, z: 60 });
});
