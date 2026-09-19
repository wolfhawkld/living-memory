import * as THREE from 'three';
import type { FocusPoint, NodeFocus } from './graph-focus';

interface OverviewNode {
  id: string;
  x?: number;
  y?: number;
  z?: number;
}

interface OverviewView {
  position: FocusPoint;
  target: FocusPoint;
  up?: FocusPoint;
  fov: number;
  zoom?: number;
  near?: number;
  width: number;
  height: number;
  twoDimensional?: boolean;
}

interface GraphOverview extends NodeFocus {
  /** Far-plane clearance for the entire graph, including an orbit around it. */
  far: number;
}

function finitePoint(point: FocusPoint): boolean {
  return [point.x, point.y, point.z].every(Number.isFinite);
}

function vector(point: FocusPoint): THREE.Vector3 {
  return new THREE.Vector3(point.x, point.y, point.z);
}

function endpointId(endpoint: unknown): string | undefined {
  if (typeof endpoint === 'string') return endpoint;
  if (endpoint && typeof endpoint === 'object' && 'id' in endpoint && typeof endpoint.id === 'string') {
    return endpoint.id;
  }
  return undefined;
}

/** Fit the actual nodes to a density-dependent share of the available viewport.
 * These are visual defaults, unrelated to memory strength or decay estimates.
 * Called only on entry, so subsequent gestures and idle rotation keep their scale.
 */
export function calculateGraphOverview(
  nodes: readonly OverviewNode[],
  links: readonly { source: unknown; target: unknown }[],
  view: OverviewView,
  nodeRadius = 2.2,
): GraphOverview | null {
  const zoom = view.zoom ?? 1;
  const near = view.near ?? 0.1;
  if (![view.width, view.height, view.fov, zoom, nodeRadius, near].every(Number.isFinite)
    || view.width <= 0 || view.height <= 0 || view.fov <= 0 || view.fov >= 180
    || zoom <= 0 || nodeRadius <= 0 || near < 0
    || !finitePoint(view.position) || !finitePoint(view.target)) return null;

  const positions: THREE.Vector3[] = [];
  const ids = new Set<string>();
  const bounds = new THREE.Box3();
  for (const node of nodes) {
    const point = { x: node.x!, y: node.y!, z: view.twoDimensional ? 0 : node.z! };
    if (!finitePoint(point)) continue;
    const position = vector(point);
    positions.push(position);
    bounds.expandByPoint(position);
    ids.add(node.id);
  }
  if (!positions.length) return null;

  // Multiple relation types and reversed edges on the same pair occupy the
  // same line. Count them once; self-links and absent endpoints add no spread.
  const pairs = new Set<string>();
  for (const link of links) {
    const source = endpointId(link.source);
    const target = endpointId(link.target);
    if (!source || !target || source === target || !ids.has(source) || !ids.has(target)) continue;
    pairs.add(JSON.stringify(source < target ? [source, target] : [target, source]));
  }

  // Node count dominates; links add a bounded contribution. Smooth interpolation
  // avoids a sudden zoom jump when a graph crosses a size threshold.
  const load = ids.size + 0.5 * Math.min(pairs.size, ids.size * 3);
  const progress = THREE.MathUtils.clamp((load - 10) / 100, 0, 1);
  const density = progress * progress * (3 - 2 * progress);
  const occupancy = 0.46 + 0.42 * density;
  const padding = Math.min(32, Math.min(view.width, view.height) * 0.05);
  const horizontalFill = occupancy * (1 - 2 * padding / view.width);
  const verticalFill = occupancy * (1 - 2 * padding / view.height);
  const tanY = Math.tan(THREE.MathUtils.degToRad(view.fov / 2)) / zoom;
  const tanX = tanY * view.width / view.height;

  const target = bounds.getCenter(new THREE.Vector3());
  const direction = view.twoDimensional
    ? new THREE.Vector3(0, 0, view.position.z < view.target.z ? -1 : 1)
    : vector(view.position).sub(vector(view.target));
  if (direction.lengthSq() === 0) direction.set(0, 0, 1);
  direction.normalize();
  const up = view.up && finitePoint(view.up) ? vector(view.up) : new THREE.Vector3(0, 1, 0);
  if (up.lengthSq() === 0) up.set(0, 1, 0);
  const orientation = new THREE.Matrix4().lookAt(direction, new THREE.Vector3(), up);
  const right = new THREE.Vector3().setFromMatrixColumn(orientation, 0);
  const screenUp = new THREE.Vector3().setFromMatrixColumn(orientation, 1);
  // lookAt also handles a direction parallel to the camera's up vector.
  direction.setFromMatrixColumn(orientation, 2);

  // A single node or coincident nodes still need a comfortable overview distance.
  // Keep the closest node's natural screen radius around 4–6 px, before the
  // existing per-frame cap, and keep the camera outside the near plane.
  const minimumDepth = Math.max(180, near + nodeRadius,
    nodeRadius * view.height / (2 * tanY * (4 + 2 * density)));
  let distance = 0;
  for (const position of positions) {
    const offset = position.clone().sub(target);
    const depthOffset = offset.dot(direction) + nodeRadius;
    distance = Math.max(distance, depthOffset + Math.max(
      (Math.abs(offset.dot(right)) + nodeRadius) / (tanX * horizontalFill),
      (Math.abs(offset.dot(screenUp)) + nodeRadius) / (tanY * verticalFill),
      minimumDepth,
    ));
  }
  const position = target.clone().addScaledVector(direction, distance);
  const far = distance + bounds.getSize(new THREE.Vector3()).length() / 2 + nodeRadius * 6;
  if (!finitePoint(target) || !finitePoint(position) || !Number.isFinite(distance) || !Number.isFinite(far)) return null;
  return { position: { x: position.x, y: position.y, z: position.z },
    target: { x: target.x, y: target.y, z: target.z }, distance, far };
}

/** Allow the controls and depth range to accommodate unusually spread-out graphs. */
export function accommodateGraphOverview(
  camera: THREE.PerspectiveCamera, controls: { maxDistance: number }, overview: GraphOverview,
): void {
  controls.maxDistance = Math.max(controls.maxDistance, overview.distance * 1.1);
  if (camera.far < overview.far) {
    camera.far = overview.far * 1.1;
    camera.updateProjectionMatrix();
  }
}
