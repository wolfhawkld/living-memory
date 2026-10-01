import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { TrackballControls } from 'three/examples/jsm/controls/TrackballControls.js';
import { accommodateGraphOverview, calculateGraphOverview } from '../src/web/graph-overview.js';

type Point = { x: number; y: number; z: number };
type OverviewNode = { id: string; x?: number; y?: number; z?: number };
type OverviewLink = { source: unknown; target: unknown };
type OverviewView = {
  position: Point;
  target: Point;
  up?: Point;
  fov: number;
  zoom?: number;
  near?: number;
  width: number;
  height: number;
  twoDimensional?: boolean;
};
type Overview = {
  position: Point;
  target: Point;
  distance: number;
};

function view(overrides: Partial<OverviewView> = {}): OverviewView {
  const defaults: OverviewView = {
    position: { x: 130, y: 70, z: 210 },
    target: { x: 8, y: -6, z: 12 },
    up: { x: 0, y: 1, z: 0 },
    fov: 50,
    zoom: 1,
    near: 0.1,
    width: 1200,
    height: 800,
    twoDimensional: false,
  };
  return {
    ...defaults,
    ...overrides,
    position: { ...defaults.position, ...overrides.position },
    target: { ...defaults.target, ...overrides.target },
    up: overrides.up === undefined
      ? defaults.up
      : { ...defaults.up, ...overrides.up },
  };
}

function requireOverview(
  nodes: readonly OverviewNode[],
  links: readonly OverviewLink[],
  currentView: OverviewView,
): Overview {
  const result = calculateGraphOverview(nodes, links, currentView);
  assert.ok(result, 'expected a camera overview');
  return result as Overview;
}

function assertClose(actual: number, expected: number, tolerance = 1e-8): void {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${actual} to be within ${tolerance} of ${expected}`,
  );
}

function assertFiniteOverview(result: Overview): void {
  assert.ok(Number.isFinite(result.distance));
  for (const coordinate of Object.values(result.position)) assert.ok(Number.isFinite(coordinate));
  for (const coordinate of Object.values(result.target)) assert.ok(Number.isFinite(coordinate));
}

function cameraFor(result: Overview, currentView: OverviewView): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(
    currentView.fov,
    currentView.width / currentView.height,
    currentView.near ?? 0.1,
    1_000_000,
  );
  camera.zoom = currentView.zoom ?? 1;
  const up = currentView.up ?? { x: 0, y: 1, z: 0 };
  camera.up.set(up.x, up.y, up.z);
  camera.position.set(result.position.x, result.position.y, result.position.z);
  camera.lookAt(result.target.x, result.target.y, result.target.z);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  return camera;
}

function project(camera: THREE.PerspectiveCamera, point: Point): THREE.Vector3 {
  return new THREE.Vector3(point.x, point.y, point.z).project(camera);
}

function assertCentered(camera: THREE.PerspectiveCamera, target: Point): void {
  const projected = project(camera, target);
  assertClose(projected.x, 0, 1e-8);
  assertClose(projected.y, 0, 1e-8);
}

function assertVisible(
  camera: THREE.PerspectiveCamera,
  nodes: readonly OverviewNode[],
  twoDimensional = false,
): void {
  for (const node of nodes) {
    if (![node.x, node.y].every(Number.isFinite)) continue;
    const point = {
      x: node.x as number,
      y: node.y as number,
      z: twoDimensional ? 0 : node.z as number,
    };
    if (!Number.isFinite(point.z)) continue;
    const projected = project(camera, point);
    assert.ok(Number.isFinite(projected.x) && Number.isFinite(projected.y) && Number.isFinite(projected.z));
    assert.ok(projected.x >= -1 - 1e-8 && projected.x <= 1 + 1e-8, `${node.id} is outside horizontal clip`);
    assert.ok(projected.y >= -1 - 1e-8 && projected.y <= 1 + 1e-8, `${node.id} is outside vertical clip`);
    assert.ok(projected.z >= -1 - 1e-8 && projected.z <= 1 + 1e-8, `${node.id} is outside depth clip`);
  }
}

function projectedSpan(
  result: Overview,
  currentView: OverviewView,
  nodes: readonly OverviewNode[],
): number {
  const camera = cameraFor(result, currentView);
  const points = nodes.map((node) => project(camera, {
    x: node.x as number,
    y: node.y as number,
    z: node.z as number,
  }));
  const x = points.map((point) => point.x);
  const y = points.map((point) => point.y);
  return Math.max(Math.max(...x) - Math.min(...x), Math.max(...y) - Math.min(...y));
}

function frameNodes(count: number): OverviewNode[] {
  const nodes: OverviewNode[] = [
    { id: 'n-0', x: -250, y: -180, z: -120 },
    { id: 'n-1', x: 250, y: 180, z: 120 },
  ];
  for (let index = nodes.length; index < count; index += 1) {
    const angle = index * 0.71;
    nodes.push({
      id: `n-${index}`,
      x: Math.cos(angle) * 185,
      y: Math.sin(angle * 1.17) * 135,
      z: Math.sin(angle * 0.83) * 95,
    });
  }
  return nodes;
}

function link(source: string, target: string): OverviewLink {
  return { source, target };
}

test('centers the finite bounding box and fits its points in a real perspective camera', () => {
  const nodes: OverviewNode[] = [
    { id: 'west', x: -250, y: 8, z: -60 },
    { id: 'east', x: 250, y: 8, z: 60 },
    { id: 'north', x: 12, y: 180, z: 0 },
    { id: 'south', x: 12, y: -180, z: 0 },
  ];
  const currentView = view();
  const result = requireOverview(nodes, [], currentView);

  assert.deepEqual(result.target, { x: 0, y: 0, z: 0 });
  assertFiniteOverview(result);
  const camera = cameraFor(result, currentView);
  assertCentered(camera, result.target);
  assertVisible(camera, nodes);

  const requestedDirection = new THREE.Vector3(
    currentView.position.x - currentView.target.x,
    currentView.position.y - currentView.target.y,
    currentView.position.z - currentView.target.z,
  ).normalize();
  const returnedDirection = new THREE.Vector3(
    result.position.x - result.target.x,
    result.position.y - result.target.y,
    result.position.z - result.target.z,
  ).normalize();
  assertClose(requestedDirection.dot(returnedDirection), 1, 1e-8);
});

test('increasing the number of nodes smoothly brings a same-range overview closer', () => {
  const currentView = view();
  const sparse = frameNodes(12);
  const medium = frameNodes(48);
  const dense = frameNodes(150);
  const sparseResult = requireOverview(sparse, [], currentView);
  const mediumResult = requireOverview(medium, [], currentView);
  const denseResult = requireOverview(dense, [], currentView);

  assert.ok(sparseResult.distance > mediumResult.distance);
  assert.ok(mediumResult.distance > denseResult.distance);
  assert.ok(projectedSpan(sparseResult, currentView, sparse)
    < projectedSpan(mediumResult, currentView, medium));
  assert.ok(projectedSpan(mediumResult, currentView, medium)
    < projectedSpan(denseResult, currentView, dense));
});

test('independent undirected edges increase coverage while duplicate and invalid edges do not', () => {
  const nodes = frameNodes(24);
  const sparseLinks = [link('n-0', 'n-1')];
  const denseLinks = [
    link('n-0', 'n-1'), link('n-0', 'n-2'), link('n-0', 'n-3'), link('n-0', 'n-4'),
    link('n-1', 'n-2'), link('n-1', 'n-3'), link('n-1', 'n-4'), link('n-1', 'n-5'),
    link('n-2', 'n-3'), link('n-2', 'n-4'), link('n-2', 'n-5'), link('n-2', 'n-6'),
    link('n-3', 'n-4'), link('n-3', 'n-5'), link('n-3', 'n-6'), link('n-4', 'n-5'),
    link('n-6', 'n-7'), link('n-7', 'n-8'), link('n-8', 'n-9'), link('n-9', 'n-10'),
  ];
  const noisyLinks: OverviewLink[] = [
    ...denseLinks,
    { source: 'n-1', target: 'n-0' },
    { source: { id: 'n-2' }, target: { id: 'n-0' } },
    { source: 'n-3', target: 'n-3' },
    { source: 'missing', target: 'n-0' },
    { source: 'n-0', target: 'missing' },
  ];
  const currentView = view();
  const sparse = requireOverview(nodes, sparseLinks, currentView);
  const dense = requireOverview(nodes, denseLinks, currentView);
  const noisy = requireOverview(nodes, noisyLinks, currentView);

  assert.ok(sparse.distance > dense.distance);
  assertClose(noisy.distance, dense.distance, 1e-8);
  assert.deepEqual(noisy.target, dense.target);
  assertClose(noisy.position.x, dense.position.x, 1e-8);
  assertClose(noisy.position.y, dense.position.y, 1e-8);
  assertClose(noisy.position.z, dense.position.z, 1e-8);
});

test('fits all node centers in both horizontal and vertical narrow viewports', () => {
  const nodes: OverviewNode[] = [
    { id: 'a', x: -150, y: -120, z: -80 },
    { id: 'b', x: 150, y: 120, z: 80 },
    { id: 'c', x: -100, y: 120, z: 50 },
    { id: 'd', x: 100, y: -120, z: -50 },
  ];
  for (const dimensions of [{ width: 180, height: 1000 }, { width: 1000, height: 180 }]) {
    const currentView = view(dimensions);
    const result = requireOverview(nodes, [], currentView);
    const camera = cameraFor(result, currentView);
    assertCentered(camera, result.target);
    assertVisible(camera, nodes);
  }
});

test('changes in FOV and zoom change the fitting distance while keeping the center fixed', () => {
  const nodes = frameNodes(32);
  const wideFovView = view({ fov: 70 });
  const narrowFovView = view({ fov: 35 });
  const regularZoomView = view({ zoom: 1 });
  const zoomedView = view({ zoom: 2 });
  const wideFov = requireOverview(nodes, [], wideFovView);
  const narrowFov = requireOverview(nodes, [], narrowFovView);
  const regularZoom = requireOverview(nodes, [], regularZoomView);
  const zoomed = requireOverview(nodes, [], zoomedView);

  assert.ok(narrowFov.distance > wideFov.distance);
  assert.ok(zoomed.distance > regularZoom.distance);
  assert.deepEqual(narrowFov.target, wideFov.target);
  assert.deepEqual(zoomed.target, regularZoom.target);
});

test('uses the current camera direction and a rotated up vector for projection', () => {
  const nodes = frameNodes(18);
  const currentView = view({
    position: { x: 180, y: -95, z: 235 },
    target: { x: 35, y: -18, z: 28 },
    up: { x: 0.72, y: 0.31, z: 0.62 },
  });
  const result = requireOverview(nodes, [], currentView);
  const camera = cameraFor(result, currentView);
  assertCentered(camera, result.target);
  assertVisible(camera, nodes);

  const requestedDirection = new THREE.Vector3(
    currentView.position.x - currentView.target.x,
    currentView.position.y - currentView.target.y,
    currentView.position.z - currentView.target.z,
  ).normalize();
  const returnedDirection = new THREE.Vector3(
    result.position.x - result.target.x,
    result.position.y - result.target.y,
    result.position.z - result.target.z,
  ).normalize();
  assertClose(requestedDirection.dot(returnedDirection), 1, 1e-8);
});

test('keeps a safe distance for single and coincident nodes', () => {
  const point = { x: 11, y: -7, z: 6 };
  const nodes = [point, point, point].map((value, index) => ({ id: `same-${index}`, ...value }));
  const currentView = view({ position: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: 0 } });
  const result = requireOverview(nodes, [], currentView);

  assert.deepEqual(result.target, point);
  assert.ok(result.distance > 0);
  assert.ok(result.position.x !== result.target.x
    || result.position.y !== result.target.y
    || result.position.z !== result.target.z);
  assertFiniteOverview(result);
});

test('rejects empty or invalid 3D inputs while accepting missing Z in 2D', () => {
  const currentView = view();
  assert.equal(calculateGraphOverview([], [], currentView), null);
  assert.equal(calculateGraphOverview([{ id: 'missing-z', x: 0, y: 0 }], [], currentView), null);
  assert.equal(calculateGraphOverview([{ id: 'bad-x', x: Number.NaN, y: 0, z: 0 }], [], currentView), null);
  assert.equal(calculateGraphOverview([{ id: 'bad-y', x: 0, y: Number.POSITIVE_INFINITY, z: 0 }], [], currentView), null);
  assert.equal(calculateGraphOverview([{ id: 'valid', x: 10, y: 20, z: 30 }], [], { ...currentView, width: 0 }), null);
  assert.equal(calculateGraphOverview([{ id: 'valid', x: 10, y: 20, z: 30 }], [], { ...currentView, height: -1 }), null);

  const mixed = requireOverview([
    { id: 'valid', x: 10, y: 20, z: 30 },
    { id: 'missing-z', x: 200, y: 200 },
    { id: 'bad-x', x: Number.NaN, y: 0, z: 0 },
  ], [], currentView);
  assert.deepEqual(mixed.target, { x: 10, y: 20, z: 30 });

  const twoDimensionalView = view({
    position: { x: 80, y: 40, z: -100 },
    target: { x: 5, y: 7, z: 25 },
    twoDimensional: true,
  });
  const twoDimensionalNodes: OverviewNode[] = [
    { id: 'left', x: -25, y: -10 },
    { id: 'right', x: 30, y: 35, z: 999 },
  ];
  const twoDimensional = requireOverview(twoDimensionalNodes, [], twoDimensionalView);
  assert.deepEqual(twoDimensional.target, { x: 2.5, y: 12.5, z: 0 });
  assertClose(twoDimensional.position.x, twoDimensional.target.x);
  assertClose(twoDimensional.position.y, twoDimensional.target.y);
  assert.ok(Math.sign(twoDimensional.position.z - twoDimensional.target.z)
    === Math.sign(twoDimensionalView.position.z - twoDimensionalView.target.z));
  assertVisible(cameraFor(twoDimensional, twoDimensionalView), twoDimensionalNodes, true);
});

test('does not mutate nodes, links, or the view object', () => {
  const nodes = frameNodes(18);
  const links: OverviewLink[] = [
    { source: 'n-0', target: 'n-1' },
    { source: { id: 'n-2' }, target: { id: 'n-3' } },
  ];
  const currentView = view({ up: { x: 0.4, y: 0.8, z: 0.3 } });
  const nodesBefore = structuredClone(nodes);
  const linksBefore = structuredClone(links);
  const viewBefore = structuredClone(currentView);

  requireOverview(nodes, links, currentView);

  assert.deepEqual(nodes, nodesBefore);
  assert.deepEqual(links, linksBefore);
  assert.deepEqual(currentView, viewBefore);
});

test('spread-out graphs remain visible and are not clamped by the actual Trackball controller', () => {
  for (const fixture of [{ extent: 3_000, width: 180 }, { extent: 50_000, width: 1200 }]) {
    const nodes = [
      { id: 'left', x: -fixture.extent, y: -100, z: -200 },
      { id: 'right', x: fixture.extent, y: 100, z: 200 },
    ];
    const currentView = view({ position: { x: 0, y: 0, z: 1000 }, target: { x: 0, y: 0, z: 0 },
      width: fixture.width, height: 1000 });
    const overview = calculateGraphOverview(nodes, [], currentView);
    assert.ok(overview);
    assert.ok(overview.distance > 50_000, 'fixture must exceed the library navigation limit');

    const camera = new THREE.PerspectiveCamera(50, fixture.width / 1000, 0.1, 125_000);
    const controls = new TrackballControls(camera, null);
    controls.maxDistance = 50_000;
    accommodateGraphOverview(camera, controls, overview);
    camera.position.set(overview.position.x, overview.position.y, overview.position.z);
    controls.target.set(overview.target.x, overview.target.y, overview.target.z);
    controls.update();
    camera.updateMatrixWorld(true);

    assertClose(camera.position.distanceTo(controls.target), overview.distance, 1e-6);
    assertCentered(camera, overview.target);
    assertVisible(camera, nodes);
    assert.ok(camera.far >= 125_000, 'overview limits should never reduce the existing depth range');
  }
});
