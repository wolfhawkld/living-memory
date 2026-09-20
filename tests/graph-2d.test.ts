import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import type ThreeForceGraphType from 'three-forcegraph';
import { calculateNodeFocus } from '../src/web/graph-focus.js';
import { calculateGraphOverview } from '../src/web/graph-overview.js';
import { graphNodePosition } from '../src/web/graph-position.js';
import { projectGraphLabelPoint } from '../src/web/graph-labels.js';

interface TestNode {
  id: string;
  x?: number;
  y?: number;
  z?: number;
  fx?: number;
  fy?: number;
  fz?: number;
  __threeObj?: THREE.Object3D;
}

interface TestLink {
  source: string | TestNode;
  target: string | TestNode;
}

type ForceGraph = ThreeForceGraphType<TestNode, TestLink>;
type ForceGraphConstructor = new () => ForceGraph;

function installThreeWindow(): () => void {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { THREE },
  });
  return () => {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  };
}

async function flushGraphUpdate(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function buildGraph(
  ThreeForceGraph: ForceGraphConstructor,
  dimensions: 2 | 3,
  nodes: TestNode[],
  links: TestLink[],
): Promise<ForceGraph> {
  const graph = new ThreeForceGraph();
  graph
    .numDimensions(dimensions)
    .warmupTicks(0)
    .cooldownTicks(180)
    .cooldownTime(30_000)
    .d3AlphaDecay(0.06)
    .graphData({ nodes, links });
  await flushGraphUpdate();
  for (let tick = 0; tick < 240; tick += 1) graph.tickFrame();
  graph.updateMatrixWorld(true);
  return graph;
}

async function disposeGraph(graph: ForceGraph): Promise<void> {
  graph.graphData({ nodes: [], links: [] });
  await flushGraphUpdate();
}

function assertFiniteVector(vector: THREE.Vector3): void {
  assert.ok(Number.isFinite(vector.x));
  assert.ok(Number.isFinite(vector.y));
  assert.ok(Number.isFinite(vector.z));
}

test('real three-forcegraph 2D stays finite, projects/focuses flat nodes, and preserves saved 3D positions', async () => {
  const restoreWindow = installThreeWindow();
  try {
    const { default: ThreeForceGraph } = await import('three-forcegraph') as { default: ForceGraphConstructor };
    const flatNodes: TestNode[] = [
      { id: 'left', x: -120, y: -42 },
      { id: 'middle', x: 0, y: 8, z: 0 },
      { id: 'right', x: 135, y: 54 },
    ];
    const flatLinks: TestLink[] = [
      { source: 'left', target: 'middle' },
      { source: 'middle', target: 'right' },
    ];
    const flatGraph = await buildGraph(ThreeForceGraph, 2, flatNodes, flatLinks);
    try {
      const flatData = flatGraph.graphData();
      assert.equal(flatData.nodes.length, flatNodes.length);
      for (const node of flatData.nodes) {
        assert.ok(Number.isFinite(node.x));
        assert.ok(Number.isFinite(node.y));
        const mesh = node.__threeObj;
        assert.ok(mesh, `node ${node.id} should have a real Three.js mesh`);
        assertFiniteVector(mesh.position);
        assert.equal(mesh.position.z, 0);
        const position = graphNodePosition(node, true);
        assert.ok(position);
        assert.equal(position.z, 0);
      }

      const width = 800;
      const height = 600;
      const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 10_000);
      camera.position.set(0, 0, 320);
      camera.lookAt(0, 0, 0);
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld();

      const focusNode = flatData.nodes.find((node) => node.id === 'left');
      assert.ok(focusNode);
      assert.equal(focusNode.z, undefined);
      const focusTarget = graphNodePosition(focusNode, true);
      assert.ok(focusTarget);
      const focus = calculateNodeFocus(
        { x: camera.position.x, y: camera.position.y, z: camera.position.z },
        focusTarget,
        2.2,
        true,
      );
      camera.position.set(focus.position.x, focus.position.y, focus.position.z);
      camera.lookAt(focus.target.x, focus.target.y, focus.target.z);
      camera.updateMatrixWorld();
      const focusedLabel = projectGraphLabelPoint(focusNode, camera, width, height, true);
      assert.ok(focusedLabel);
      assert.ok(Math.abs(focusedLabel.x - width / 2) < 1e-7);
      assert.ok(Math.abs(focusedLabel.y - height / 2) < 1e-7);

      const overview = calculateGraphOverview(flatData.nodes, flatData.links, {
        position: { x: 0, y: 0, z: 320 },
        target: { x: 0, y: 0, z: 0 },
        up: { x: 0, y: 1, z: 0 },
        fov: camera.fov,
        zoom: 1,
        near: camera.near,
        width,
        height,
        twoDimensional: true,
      });
      assert.ok(overview);
      camera.position.set(overview.position.x, overview.position.y, overview.position.z);
      camera.lookAt(overview.target.x, overview.target.y, overview.target.z);
      camera.updateMatrixWorld();
      for (const node of flatData.nodes) {
        const projected = projectGraphLabelPoint(node, camera, width, height, true);
        assert.ok(projected, `node ${node.id} should be covered by the 2D overview`);
        assert.ok(projected.x >= 0 && projected.x <= width);
        assert.ok(projected.y >= 0 && projected.y <= height);
      }
    } finally {
      await disposeGraph(flatGraph);
    }

    const saved3d = {
      left: { x: -52, y: 18, z: 84 },
      right: { x: 76, y: -31, z: -67 },
    };
    const savedBefore = structuredClone(saved3d);
    const temporary2dNodes = Object.entries(saved3d).map(([id, position]) => ({
      id,
      x: position.x,
      y: position.y,
      z: 0,
      fx: position.x,
      fy: position.y,
    }));
    const temporary2d = await buildGraph(ThreeForceGraph, 2, temporary2dNodes, []);
    try {
      for (const node of temporary2d.graphData().nodes) assert.equal(node.__threeObj?.position.z, 0);
      assert.deepEqual(saved3d, savedBefore);
    } finally {
      await disposeGraph(temporary2d);
    }

    const restored3dNodes = Object.entries(saved3d).map(([id, position]) => ({
      id,
      ...position,
      fx: position.x,
      fy: position.y,
      fz: position.z,
    }));
    const restored3d = await buildGraph(ThreeForceGraph, 3, restored3dNodes, []);
    try {
      for (const node of restored3d.graphData().nodes) {
        const expected = saved3d[node.id as keyof typeof saved3d];
        assert.ok(expected);
        assert.equal(node.x, expected.x);
        assert.equal(node.y, expected.y);
        assert.equal(node.z, expected.z);
        assert.equal(node.__threeObj?.position.x, expected.x);
        assert.equal(node.__threeObj?.position.y, expected.y);
        assert.equal(node.__threeObj?.position.z, expected.z);
      }
      assert.deepEqual(saved3d, savedBefore);
    } finally {
      await disposeGraph(restored3d);
    }
  } finally {
    restoreWindow();
  }
});
