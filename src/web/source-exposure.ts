import type { Concept } from '../shared/types';

export const SOURCE_EXPOSURE_STORAGE_KEY = 'living-memory.source-viewed.v1';

/** Session exposure belongs to this knowledge source and content revision. */
export function sourceExposureKey(sourceId: string, concept: Pick<Concept, 'id' | 'source'>): string {
  return JSON.stringify([sourceId, concept.id, concept.source.revision]);
}

export function parseSourceExposure(value: string | null): string[] {
  try {
    const parsed: unknown = JSON.parse(value ?? 'null');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => {
      if (typeof item !== 'string') return false;
      try {
        const tuple: unknown = JSON.parse(item);
        return Array.isArray(tuple) && tuple.length === 3 && tuple.every((part) => typeof part === 'string' && part.trim());
      } catch { return false; }
    });
  } catch { return []; }
}
