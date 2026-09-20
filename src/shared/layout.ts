import type { Layout, LayoutPosition } from './types';

const MAX_LAYOUT_ENTRIES = 10_000;

function isOrdinaryObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

export function isFiniteLayoutPosition(value: unknown): value is LayoutPosition {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  try {
    if (
      !Object.prototype.hasOwnProperty.call(value, 'x') ||
      !Object.prototype.hasOwnProperty.call(value, 'y') ||
      !Object.prototype.hasOwnProperty.call(value, 'z')
    ) {
      return false;
    }

    const position = value as Record<string, unknown>;
    return (
      typeof position.x === 'number' &&
      Number.isFinite(position.x) &&
      typeof position.y === 'number' &&
      Number.isFinite(position.y) &&
      typeof position.z === 'number' &&
      Number.isFinite(position.z)
    );
  } catch {
    return false;
  }
}

export function inspectLayout(
  value: unknown,
): { layout: Layout; invalidIds: string[] } | null {
  if (!isOrdinaryObject(value)) {
    return null;
  }

  let entries: Array<[string, unknown]>;
  try {
    entries = Object.entries(value);
  } catch {
    return null;
  }

  if (entries.length > MAX_LAYOUT_ENTRIES) {
    return null;
  }

  const validEntries: Array<[string, LayoutPosition]> = [];
  const invalidIds: string[] = [];

  for (const [id, candidate] of entries) {
    if (!isFiniteLayoutPosition(candidate)) {
      invalidIds.push(id);
      continue;
    }

    validEntries.push([
      id,
      {
        x: candidate.x,
        y: candidate.y,
        z: candidate.z,
      },
    ]);
  }

  return {
    layout: Object.fromEntries(validEntries) as Layout,
    invalidIds,
  };
}
