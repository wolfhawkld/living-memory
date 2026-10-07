export type GraphLimitPreference = 'server' | 20 | 50 | 100 | 200 | 300;

const LIMITS = [20, 50, 100, 200, 300] as const;
const PREFIX = 'living-memory.graph-display.v1:';

/** Select values and persisted values use only the fixed decimal representations. */
export function parseGraphLimitPreference(value: unknown): GraphLimitPreference {
  for (const limit of LIMITS) {
    if (value === limit || value === String(limit)) return limit;
  }
  return 'server';
}

/** One preference for every domain within an account and knowledge source. */
export function graphDisplayPreferenceKey(accountId: string | undefined, sourceId: string): string | null {
  if (typeof sourceId !== 'string' || !sourceId.trim()) return null;
  if (accountId === undefined) return `${PREFIX}${JSON.stringify(['local', sourceId])}`;
  if (typeof accountId !== 'string' || !accountId.trim()) return null;
  return `${PREFIX}${JSON.stringify(['account', accountId, sourceId])}`;
}

export function readGraphLimitPreference(
  key: string | null,
  storage?: Pick<Storage, 'getItem'>,
): GraphLimitPreference {
  if (key === null) return 'server';
  try {
    const target = storage ?? window.localStorage;
    return parseGraphLimitPreference(target.getItem(key));
  } catch {
    return 'server';
  }
}

/** False means the choice could not be persisted; the caller may keep it in memory. */
export function writeGraphLimitPreference(
  key: string | null,
  value: GraphLimitPreference,
  storage?: Pick<Storage, 'setItem' | 'removeItem'>,
): boolean {
  if (key === null || (value !== 'server' && !LIMITS.some(limit => limit === value))) return false;
  try {
    const target = storage ?? window.localStorage;
    if (value === 'server') target.removeItem(key);
    else target.setItem(key, String(value));
    return true;
  } catch {
    return false;
  }
}
