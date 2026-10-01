/**
 * Keep nodes whose visible degree is zero close to the visible graph.
 *
 * The force deliberately has no knowledge of concepts, domains or memory
 * state.  It only looks at the nodes and the visible links supplied by the
 * graph engine.  A force instance is therefore cheap to recreate when the
 * topology changes (for example, after expanding a cross-domain relation).
 */

export interface GraphIsolationNode {
  id?: string;
  x?: number;
  y?: number;
  z?: number;
  vx?: number;
  vy?: number;
  vz?: number;
  fx?: number;
  fy?: number;
  fz?: number;
}

export interface GraphIsolationLink {
  source: unknown;
  target: unknown;
}

export type IsolatedNodeForce = ((alpha: number) => void) & {
  initialize: (nodes: GraphIsolationNode[]) => void;
};

type Point = { x: number; y: number; z: number };

const MIN_BOUNDARY_RADIUS = 96;
const MAX_EMPTY_BOUNDARY_RADIUS = 420;
const CORE_MARGIN_RATIO = 0.24;
const CORE_MARGIN_MIN = 24;
const CORE_MARGIN_MAX = 240;
const INITIAL_PULL_THRESHOLD = 1.5;
const INITIAL_PULL_ABSOLUTE_MARGIN = 240;
const TICK_STRENGTH = 0.075;
const MAX_TICK_PULL = 42;

function endpointId(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'id' in value) {
    const id = (value as { id?: unknown }).id;
    return typeof id === 'string' ? id : undefined;
  }
  return undefined;
}

function isFiniteCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isFixed(node: GraphIsolationNode): boolean {
  // d3-force treats null as an unset fixed coordinate.  Any actual value,
  // including zero, means the user has pinned part of the node.
  return node.fx != null || node.fy != null || node.fz != null;
}

function positionOf(node: GraphIsolationNode, twoDimensional: boolean): Point | null {
  if (!isFiniteCoordinate(node.x) || !isFiniteCoordinate(node.y)) return null;
  if (twoDimensional) return { x: node.x, y: node.y, z: 0 };
  if (!isFiniteCoordinate(node.z)) return null;
  return { x: node.x, y: node.y, z: node.z };
}

function distanceBetween(a: Point, b: Point, twoDimensional: boolean): number {
  const z = twoDimensional ? 0 : a.z - b.z;
  return Math.hypot(a.x - b.x, a.y - b.y, z);
}

function lowerMedian(values: number[]): number {
  values.sort((left, right) => left - right);
  // The lower median avoids moving the centre halfway toward a lone extreme
  // point when an even-sized all-isolated graph contains one old coordinate.
  return values[Math.floor((values.length - 1) / 2)];
}

function robustCentre(nodes: readonly GraphIsolationNode[], twoDimensional: boolean): Point | null {
  const candidates = nodes
    .filter((node) => !isFixed(node))
    .map((node) => positionOf(node, twoDimensional))
    .filter((point): point is Point => point !== null);
  const positions = candidates.length
    ? candidates
    : nodes.map((node) => positionOf(node, twoDimensional)).filter((point): point is Point => point !== null);
  if (!positions.length) return null;
  return {
    x: lowerMedian(positions.map((point) => point.x)),
    y: lowerMedian(positions.map((point) => point.y)),
    z: twoDimensional ? 0 : lowerMedian(positions.map((point) => point.z)),
  };
}

function coreCentre(
  nodes: readonly GraphIsolationNode[],
  connected: ReadonlySet<GraphIsolationNode>,
  twoDimensional: boolean,
): { centre: Point; extent: number } | null {
  const positions = nodes
    .filter((node) => connected.has(node))
    .map((node) => positionOf(node, twoDimensional))
    .filter((point): point is Point => point !== null);
  if (!positions.length) return null;

  const centre = {
    x: positions.reduce((sum, point) => sum + point.x, 0) / positions.length,
    y: positions.reduce((sum, point) => sum + point.y, 0) / positions.length,
    z: twoDimensional
      ? 0
      : positions.reduce((sum, point) => sum + point.z, 0) / positions.length,
  };
  const extent = positions.reduce(
    (maximum, point) => Math.max(maximum, distanceBetween(point, centre, twoDimensional)),
    0,
  );
  return { centre, extent };
}

function finiteAlpha(alpha: number): number {
  return Number.isFinite(alpha) ? Math.max(0, alpha) : 1;
}

function addVelocity(node: GraphIsolationNode, axis: 'x' | 'y' | 'z', amount: number): void {
  const velocityAxis = `v${axis}` as 'vx' | 'vy' | 'vz';
  const current = node[velocityAxis];
  node[velocityAxis] = (isFiniteCoordinate(current) ? current : 0) + amount;
}

function setPosition(node: GraphIsolationNode, point: Point, twoDimensional: boolean): void {
  node.x = point.x;
  node.y = point.y;
  if (!twoDimensional) node.z = point.z;
}

/**
 * Create a d3-force-3d compatible force for visible degree-zero nodes.
 *
 * Connected nodes are used only as an immovable geometric core.  The force
 * never changes their coordinates or velocities and never edits the supplied
 * link list.  An isolated node outside the core's soft boundary receives a
 * small inward velocity; a clearly stale, very distant coordinate is clamped
 * once during initialize so it cannot distort the camera overview.
 */
export function createIsolatedNodeForce(
  links: readonly GraphIsolationLink[],
  twoDimensional = false,
): IsolatedNodeForce {
  let nodes: GraphIsolationNode[] = [];
  let isolated: GraphIsolationNode[] = [];
  let connected = new Set<GraphIsolationNode>();
  let centre: Point | null = null;
  let boundaryRadius = MIN_BOUNDARY_RADIUS;

  const refreshBoundary = (): boolean => {
    const core = coreCentre(nodes, connected, twoDimensional);
    if (core) {
      centre = core.centre;
      const margin = Math.min(
        CORE_MARGIN_MAX,
        Math.max(CORE_MARGIN_MIN, core.extent * CORE_MARGIN_RATIO),
      );
      boundaryRadius = Math.max(MIN_BOUNDARY_RADIUS, core.extent + margin);
      return true;
    }

    centre = robustCentre(nodes, twoDimensional);
    // There is no topology to establish a scale.  Keep the fallback bounded
    // while allowing a larger all-isolated graph a little more breathing room.
    const countRadius = 84 + Math.sqrt(Math.max(1, nodes.length)) * 24;
    boundaryRadius = Math.min(MAX_EMPTY_BOUNDARY_RADIUS, Math.max(MIN_BOUNDARY_RADIUS, countRadius));
    return centre !== null;
  };

  const initialize = (nextNodes: GraphIsolationNode[]): void => {
    nodes = nextNodes;
    const byId = new Map<string, GraphIsolationNode>();
    for (const node of nodes) {
      if (typeof node.id === 'string' && !byId.has(node.id)) byId.set(node.id, node);
    }

    connected = new Set<GraphIsolationNode>();
    for (const link of links) {
      const sourceId = endpointId(link.source);
      const targetId = endpointId(link.target);
      if (sourceId === undefined || targetId === undefined || sourceId === targetId) continue;
      const source = byId.get(sourceId);
      const target = byId.get(targetId);
      if (!source || !target || source === target) continue;
      connected.add(source);
      connected.add(target);
    }

    isolated = nodes.filter((node) => !connected.has(node));
    if (!refreshBoundary()) return;
    const currentCentre = centre;
    if (!currentCentre) return;

    for (const node of isolated) {
      if (isFixed(node)) continue;
      const position = positionOf(node, twoDimensional);
      if (!position) continue;
      const distance = distanceBetween(position, currentCentre, twoDimensional);
      const clearlyOutside = distance > boundaryRadius * INITIAL_PULL_THRESHOLD
        || distance > boundaryRadius + INITIAL_PULL_ABSOLUTE_MARGIN;
      if (!clearlyOutside || distance === 0) continue;
      const ratio = boundaryRadius / distance;
      setPosition(node, {
        x: currentCentre.x + (position.x - currentCentre.x) * ratio,
        y: currentCentre.y + (position.y - currentCentre.y) * ratio,
        z: currentCentre.z + (position.z - currentCentre.z) * ratio,
      }, twoDimensional);
      // An old outward velocity would immediately undo the one-time repair.
      // Preserve absent optional fields, while resetting finite d3 velocities.
      if (isFiniteCoordinate(node.vx)) node.vx = 0;
      if (isFiniteCoordinate(node.vy)) node.vy = 0;
      if (!twoDimensional && isFiniteCoordinate(node.vz)) node.vz = 0;
    }
  };

  const force = ((alpha: number): void => {
    if (isolated.length === 0 || !refreshBoundary() || !centre) return;
    const currentCentre = centre;
    const tickAlpha = finiteAlpha(alpha);
    for (const node of isolated) {
      if (isFixed(node)) continue;
      const position = positionOf(node, twoDimensional);
      if (!position) continue;
      const distance = distanceBetween(position, currentCentre, twoDimensional);
      // Interior nodes are deliberately untouched: they are free to settle
      // under the ordinary link/charge/center forces without this force bias.
      if (distance <= boundaryRadius || distance === 0) continue;

      const overshoot = distance - boundaryRadius;
      const strength = Math.min(MAX_TICK_PULL, overshoot * TICK_STRENGTH * tickAlpha);
      const inverseDistance = 1 / distance;
      addVelocity(node, 'x', (currentCentre.x - position.x) * inverseDistance * strength);
      addVelocity(node, 'y', (currentCentre.y - position.y) * inverseDistance * strength);
      if (!twoDimensional) {
        addVelocity(node, 'z', (currentCentre.z - position.z) * inverseDistance * strength);
      }
    }
  }) as IsolatedNodeForce;

  force.initialize = initialize;
  return force;
}
