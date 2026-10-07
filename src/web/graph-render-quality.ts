export type GraphRenderQuality = 'standard' | 'low';

const PREFIX = 'living-memory.graph-render-quality.v1:';

export function parseGraphRenderQuality(value: unknown): GraphRenderQuality {
  return value === 'low' ? 'low' : 'standard';
}

export function graphRenderQualityKey(accountId: string | undefined, sourceId: string): string | null {
  if (typeof sourceId !== 'string' || !sourceId.trim()) return null;
  if (accountId === undefined) return `${PREFIX}${JSON.stringify(['local', sourceId])}`;
  if (typeof accountId !== 'string' || !accountId.trim()) return null;
  return `${PREFIX}${JSON.stringify(['account', accountId, sourceId])}`;
}

export function readGraphRenderQuality(key: string | null, storage?: Pick<Storage, 'getItem'>): GraphRenderQuality {
  if (key === null) return 'standard';
  try {
    return parseGraphRenderQuality((storage ?? window.localStorage).getItem(key));
  } catch {
    return 'standard';
  }
}

export function writeGraphRenderQuality(
  key: string | null,
  value: GraphRenderQuality,
  storage?: Pick<Storage, 'setItem' | 'removeItem'>,
): boolean {
  if (key === null || (value !== 'standard' && value !== 'low')) return false;
  try {
    const target = storage ?? window.localStorage;
    if (value === 'standard') target.removeItem(key);
    else target.setItem(key, 'low');
    return true;
  } catch {
    return false;
  }
}

export function resolveGraphPixelRatio(quality: GraphRenderQuality, devicePixelRatio: unknown): number {
  const ratio = typeof devicePixelRatio === 'number' && Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
    ? devicePixelRatio : 1;
  return Math.min(quality === 'low' ? 1 : 2, ratio);
}

export function applyGraphPixelRatio(
  renderer: { setPixelRatio: (n: number) => void },
  composer: { setPixelRatio: (n: number) => void },
  ratio: number,
): void {
  renderer.setPixelRatio(ratio);
  composer.setPixelRatio(ratio);
}
