import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createIsolatedNodeForce,
  type GraphIsolationLink,
  type GraphIsolationNode,
} from '../src/web/graph-isolation.js';

function distance(node: GraphIsolationNode, centre = { x: 0, y: 0, z: 0 }): number {
  return Math.hypot(
    (node.x ?? 0) - centre.x,
    (node.y ?? 0) - centre.y,
    (node.z ?? 0) - centre.z,
  );
}

function link(source: unknown, target: unknown): GraphIsolationLink {
  return { source, target };
}

test('reclaims a distant isolated node without moving the connected core or inventing links', () => {
  const links = [link('core-left', 'core-right')];
  const originalLinks = structuredClone(links);
  const nodes: GraphIsolationNode[] = [
    { id: 'core-left', x: -100, y: 0, z: -20, vx: 1, vy: 2, vz: 3 },
    { id: 'core-right', x: 100, y: 0, z: 20, vx: 4, vy: 5, vz: 6 },
    { id: 'log-sum-exp', x: 3_000, y: 2_000, z: -2_000, vx: 7, vy: 8, vz: 9 },
  ];
  const coreBefore = nodes.slice(0, 2).map((node) => structuredClone(node));
  const force = createIsolatedNodeForce(links);

  force.initialize(nodes);

  assert.deepEqual(nodes.slice(0, 2), coreBefore, 'connected nodes are only geometry anchors');
  assert.ok(distance(nodes[2]) < 500, 'the old far coordinate should be brought to the core boundary');
  assert.ok(Number.isFinite(nodes[2].x) && Number.isFinite(nodes[2].y) && Number.isFinite(nodes[2].z));
  assert.deepEqual(links, originalLinks, 'the isolation force must not add or rewrite edges');
});

test('missing endpoints and self-links do not make a node part of the connected core', () => {
  const nodes: GraphIsolationNode[] = [
    { id: 'a', x: -80, y: 0, z: 0 },
    { id: 'b', x: 80, y: 0, z: 0 },
    { id: 'isolated', x: 2_000, y: 0, z: 0 },
  ];
  const links = [
    link('a', 'a'),
    link('missing', 'a'),
    link('b', { id: 'missing-too' }),
  ];
  const force = createIsolatedNodeForce(links);
  force.initialize(nodes);
  assert.ok((nodes[2].x ?? 0) < 500, 'invalid and self links must not protect the distant node');
});

test('object endpoints resolve by id while a fixed isolated node remains untouched', () => {
  const fixed: GraphIsolationNode = {
    id: 'fixed', x: 8_000, y: -4_000, z: 2_000, vx: 11, vy: 12, vz: 13, fx: 8_000,
  };
  const nodes: GraphIsolationNode[] = [
    { id: 'left', x: -80, y: 0, z: 0 },
    { id: 'right', x: 80, y: 0, z: 0 },
    fixed,
  ];
  const before = structuredClone(fixed);
  const force = createIsolatedNodeForce([link({ id: 'left' }, { id: 'right' })]);
  force.initialize(nodes);
  force(1);
  assert.deepEqual(fixed, before, 'a node fixed on one axis is fully excluded from this force');
});

test('2D mode repairs only xy and does not create z or vz', () => {
  const nodes: GraphIsolationNode[] = [
    { id: 'left', x: -80, y: 0 },
    { id: 'right', x: 80, y: 0 },
    { id: 'isolated', x: 2_000, y: 1_000, vx: 0, vy: 0 },
  ];
  const force = createIsolatedNodeForce([link('left', 'right')], true);
  force.initialize(nodes);
  force(1);
  assert.ok((nodes[2].x ?? 0) < 500 && (nodes[2].y ?? 0) < 500);
  assert.equal('z' in nodes[2], false);
  assert.equal('vz' in nodes[2], false);
});

test('an all-isolated graph uses a robust finite range instead of one old outlier', () => {
  const nodes: GraphIsolationNode[] = [
    { id: 'near-a', x: 0, y: 0, z: 0 },
    { id: 'near-b', x: 12, y: 8, z: -4 },
    { id: 'old', x: 6_000, y: 5_000, z: -4_000 },
  ];
  const force = createIsolatedNodeForce([]);
  force.initialize(nodes);
  assert.ok(distance(nodes[2]) < 500, 'the fallback range must not be set by the old outlier');
  assert.ok(distance(nodes[0]) < 100, 'ordinary nearby nodes should not be displaced by the fallback');
  assert.ok(distance(nodes[1]) < 100, 'ordinary nearby nodes should not be displaced by the fallback');
});

test('a single node needs no layout correction, even with an old coordinate', () => {
  const node: GraphIsolationNode = { id: 'only', x: 9_000, y: -3_000, z: 2_000, vx: 4, vy: 5, vz: 6 };
  const before = structuredClone(node);
  const force = createIsolatedNodeForce([]);
  force.initialize([node]);
  force(1);
  assert.deepEqual(node, before);
});

test('reinitializing the same force does not progressively move an already repaired node', () => {
  const nodes: GraphIsolationNode[] = [
    { id: 'a', x: -120, y: 0, z: 0 },
    { id: 'b', x: 120, y: 0, z: 0 },
    { id: 'outlier', x: 4_000, y: -2_000, z: 1_000 },
  ];
  const force = createIsolatedNodeForce([link('a', 'b')]);
  force.initialize(nodes);
  const afterFirstInitialization = structuredClone(nodes[2]);
  force.initialize(nodes);
  assert.deepEqual(nodes[2], afterFirstInitialization);
  for (let tick = 0; tick < 20; tick += 1) force(1);
  const afterTicks = structuredClone(nodes[2]);
  force.initialize(nodes);
  assert.deepEqual(nodes[2], afterTicks, 'initialize must not re-clamp a node already inside the boundary');
});

test('refreshes the boundary when the connected core translates during simulation', () => {
  const nodes: GraphIsolationNode[] = [
    { id: 'a', x: -100, y: 0, z: 0 },
    { id: 'b', x: 100, y: 0, z: 0 },
    { id: 'isolated', x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 },
  ];
  const force = createIsolatedNodeForce([link('a', 'b')]);
  force.initialize(nodes);
  // Simulate the ordinary center force moving the connected graph as a whole.
  nodes[0].x = 900;
  nodes[1].x = 1_100;
  force(1);
  assert.ok((nodes[2].vx ?? 0) > 0, 'the isolated node should be pulled toward the translated core');
  assert.equal(nodes[0].x, 900);
  assert.equal(nodes[1].x, 1_100);
});

test('real d3-force-3d simulation keeps the repaired isolated node finite and near the core', async () => {
  // d3-force-3d ships JavaScript without TypeScript declarations in this
  // workspace.  The small local shape below is all this test needs.
  // @ts-expect-error d3-force-3d has no declaration file in the project
  const { forceSimulation } = await import('d3-force-3d') as {
    forceSimulation: (nodes: GraphIsolationNode[], dimensions: number) => {
      force: (name: string, force: unknown) => unknown;
      stop: () => unknown;
      tick: (iterations?: number) => unknown;
    };
  };
  const nodes: GraphIsolationNode[] = [
    { id: 'left', x: -150, y: 0, z: 0, fx: -150, fy: 0, fz: 0 },
    { id: 'right', x: 150, y: 0, z: 0, fx: 150, fy: 0, fz: 0 },
    { id: 'isolated', x: 1_800, y: 900, z: -1_200 },
  ];
  const force = createIsolatedNodeForce([link('left', 'right')]);
  const simulation = forceSimulation(nodes, 3).force('isolated-boundary', force) as {
    stop: () => unknown;
    tick: (iterations?: number) => unknown;
  };
  simulation.stop();
  simulation.tick(150);

  assert.ok(Number.isFinite(nodes[2].x) && Number.isFinite(nodes[2].y) && Number.isFinite(nodes[2].z));
  assert.ok(distance(nodes[2]) < 300, 'the real force engine should leave the node near the core');
  assert.equal(nodes[0].x, -150);
  assert.equal(nodes[1].x, 150);
});
