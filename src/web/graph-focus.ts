export interface FocusPoint {
  x: number;
  y: number;
  z: number;
}

export interface NodeFocus {
  position: FocusPoint;
  target: FocusPoint;
  distance: number;
}

function requireFinitePoint(point: FocusPoint, name: string): void {
  if (
    !point ||
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y) ||
    !Number.isFinite(point.z)
  ) {
    throw new RangeError(`${name} must contain only finite coordinates.`);
  }
}

function requirePositiveRadius(nodeRadius: number): void {
  if (!Number.isFinite(nodeRadius) || nodeRadius <= 0) {
    throw new RangeError('nodeRadius must be a finite positive number.');
  }
}

function requireFiniteResult(point: FocusPoint, distance: number): void {
  if (
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y) ||
    !Number.isFinite(point.z) ||
    !Number.isFinite(distance)
  ) {
    throw new RangeError('Focus result is outside the finite coordinate range.');
  }
}

/**
 * Calculate a camera position that brings one graph node into focus.
 *
 * The current camera-to-target direction is retained while the distance is
 * reduced to a local view. In 2D mode the camera stays on the target's Z axis
 * so the graph remains a readable plane.
 */
export function calculateNodeFocus(
  cameraPosition: FocusPoint,
  target: FocusPoint,
  nodeRadius: number,
  twoDimensional = false,
): NodeFocus {
  requireFinitePoint(cameraPosition, 'cameraPosition');
  requireFinitePoint(target, 'target');
  requirePositiveRadius(nodeRadius);

  const offset = {
    x: cameraPosition.x - target.x,
    y: cameraPosition.y - target.y,
    z: cameraPosition.z - target.z,
  };
  const currentDistance = Math.hypot(offset.x, offset.y, offset.z);
  const minimumDistance = Math.max(32, nodeRadius * 8);
  // Bring an overview into a local view. Once close, keep the user's scale when
  // recentering so successive selections do not compound into an extreme zoom.
  const distance = Math.max(minimumDistance, Math.min(180, currentDistance));

  if (!Number.isFinite(currentDistance) || !Number.isFinite(distance)) {
    throw new RangeError('Focus distance must be finite.');
  }

  let direction: FocusPoint;
  if (twoDimensional) {
    direction = { x: 0, y: 0, z: offset.z < 0 ? -1 : 1 };
  } else if (currentDistance === 0) {
    direction = { x: 0, y: 0, z: 1 };
  } else {
    direction = {
      x: offset.x / currentDistance,
      y: offset.y / currentDistance,
      z: offset.z / currentDistance,
    };
  }

  const position = {
    x: target.x + direction.x * distance,
    y: target.y + direction.y * distance,
    z: target.z + direction.z * distance,
  };
  requireFiniteResult(position, distance);

  return {
    position,
    target: { ...target },
    distance,
  };
}
