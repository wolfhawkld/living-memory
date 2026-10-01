import type { Layout, LayoutPosition } from '../shared/types';

export interface GraphPositionNode {
  id?: string;
  x?: number;
  y?: number;
  z?: number;
}

/**
 * Return the renderable position for one graph node.
 *
 * A 2D force graph owns a flat plane, so persisted or stale z coordinates are
 * deliberately ignored. In 3D every coordinate must be finite before it is
 * handed to Three.js or the force graph.
 */
export function graphNodePosition(
  node: Pick<GraphPositionNode, 'x' | 'y' | 'z'>,
  twoDimensional = false,
): LayoutPosition | null {
  const { x, y, z } = node;
  if (typeof x !== 'number' || !Number.isFinite(x) || typeof y !== 'number' || !Number.isFinite(y)) return null;
  if (twoDimensional) return { x, y, z: 0 };
  if (typeof z !== 'number' || !Number.isFinite(z)) return null;
  return { x, y, z };
}

/** Collect only finite 3D positions for persistence. A 2D view never writes layout. */
export function collectGraphLayout(
  nodes: readonly GraphPositionNode[],
  twoDimensional = false,
): Layout {
  if (twoDimensional) return {};
  const entries: Array<[string, LayoutPosition]> = [];
  for (const node of nodes) {
    if (typeof node.id !== 'string') continue;
    const position = graphNodePosition(node);
    if (position) entries.push([node.id, position]);
  }
  return Object.fromEntries(entries) as Layout;
}
