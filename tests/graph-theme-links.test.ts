import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import type ThreeForceGraphType from 'three-forcegraph';

interface TestNode {
  id: string;
  x?: number;
  y?: number;
  z?: number;
  __threeObj?: THREE.Object3D;
}

interface TestLink {
  id: string;
  source: string | TestNode;
  target: string | TestNode;
  color?: string;
  __lineObj?: THREE.Line;
  __arrowObj?: THREE.Mesh;
}

type ForceGraph = ThreeForceGraphType<TestNode, TestLink>;
type ForceGraphConstructor = new () => ForceGraph;

function colorHex(color: THREE.Color): string {
  return `#${color.getHexString()}`;
}

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

function waitForGraphUpdate(graph: ForceGraph): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('three-forcegraph did not finish its update within 1 second'));
    }, 1_000);
    graph.onFinishUpdate(() => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function nodeCoordinates(nodes: TestNode[]): Array<{ x?: number; y?: number; z?: number }> {
  return nodes.map((node) => ({ x: node.x, y: node.y, z: node.z }));
}

async function disposeGraph(graph: ForceGraph): Promise<void> {
  const updateFinished = waitForGraphUpdate(graph);
  graph.graphData({ nodes: [], links: [] });
  await updateFinished;
}

test('settled graph link style setters update lines/arrows without reheating or replacing nodes', async () => {
  const restoreWindow = installThreeWindow();
  try {
    const { default: ThreeForceGraph } = await import('three-forcegraph') as { default: ForceGraphConstructor };
    const nodes: TestNode[] = [
      { id: 'left', x: -70, y: 8, z: 12 },
      { id: 'right', x: 72, y: -14, z: -8 },
      { id: 'third', x: 4, y: 64, z: 21 },
    ];
    const links: TestLink[] = [{ id: 'edge', source: 'left', target: 'right' }];
    const graph = new ThreeForceGraph();
    let engineTickCount = 0;
    graph
      .numDimensions(3)
      .warmupTicks(0)
      .cooldownTicks(120)
      .cooldownTime(30_000)
      .d3AlphaDecay(0.08)
      .linkColor(() => '#ff0000')
      .linkDirectionalArrowLength(() => 1.4)
      .linkDirectionalArrowColor(() => '#ff0000')
      .linkOpacity(0.4)
      .onEngineTick(() => {
        engineTickCount += 1;
      });

    try {
      const initialUpdate = waitForGraphUpdate(graph);
      graph.graphData({ nodes, links });
      await initialUpdate;
      for (let tick = 0; tick < 240; tick += 1) graph.tickFrame();

      const settledData = graph.graphData();
      const settledNodes = [...settledData.nodes];
      const settledLinks = [...settledData.links];
      const settledPositions = nodeCoordinates(settledNodes);
      const settledTickCount = engineTickCount;
      assert.equal(settledNodes.length, nodes.length);
      assert.equal(settledLinks.length, links.length);
      assert.ok(settledNodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y) && Number.isFinite(node.z)));

      const line = settledLinks[0].__lineObj;
      const arrow = settledLinks[0].__arrowObj;
      assert.ok(line, 'the settled link should have a line object');
      assert.ok(arrow, 'the configured directional arrow should exist');
      assert.equal(colorHex((line.material as THREE.LineBasicMaterial).color), '#ff0000');
      assert.equal(colorHex((arrow.material as THREE.MeshLambertMaterial).color), '#ff0000');

      const updateFinished = waitForGraphUpdate(graph);
      graph
        .linkColor(() => '#00ff00')
        .linkDirectionalArrowColor(() => '#0000ff')
        .linkOpacity(0.7);
      await updateFinished;
      // The digest itself does not run physics. Advance render ticks as the
      // application does, so an accidental resetCountdown/reheat is observable.
      for (let tick = 0; tick < 10; tick += 1) graph.tickFrame();

      const afterStyleData = graph.graphData();
      afterStyleData.nodes.forEach((node, index) => assert.equal(node, settledNodes[index]));
      afterStyleData.links.forEach((link, index) => assert.equal(link, settledLinks[index]));
      assert.deepEqual(afterStyleData.nodes, settledNodes, 'style updates must retain node object identity and coordinates');
      assert.deepEqual(afterStyleData.links, settledLinks, 'style updates must retain link object identity');
      assert.deepEqual(nodeCoordinates(afterStyleData.nodes), settledPositions);
      assert.equal(engineTickCount, settledTickCount, 'style updates must not reheat the settled force simulation');
      assert.equal(afterStyleData.links[0].__lineObj, line, 'style updates must reuse the line object');
      assert.equal(afterStyleData.links[0].__arrowObj, arrow, 'style updates must reuse the arrow object');
      assert.equal(colorHex((line.material as THREE.LineBasicMaterial).color), '#00ff00');
      assert.equal(colorHex((arrow.material as THREE.MeshLambertMaterial).color), '#0000ff');
      assert.equal((line.material as THREE.LineBasicMaterial).opacity, 0.7);
      assert.ok(Math.abs((arrow.material as THREE.MeshLambertMaterial).opacity - 2.1) < 1e-12);
    } finally {
      await disposeGraph(graph);
    }
  } finally {
    restoreWindow();
  }
});
