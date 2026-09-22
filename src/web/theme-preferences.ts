export type ThemePreference = 'dark' | 'light' | 'system';
export type ResolvedTheme = 'dark' | 'light';

export interface ThemeSnapshot {
  readonly preference: ThemePreference;
  readonly resolvedTheme: ResolvedTheme;
}

/** The small part of Storage that this module needs. */
export interface ThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface CreateThemePreferencesOptions {
  storage?: () => ThemeStorage;
  systemDark?: () => boolean;
}

const STORAGE_PREFIX = 'living-memory.theme.v1:';

export function themeStorageKey(userId: string | null): string {
  return `${STORAGE_PREFIX}${userId === null ? 'anonymous' : `user:${encodeURIComponent(userId)}`}`;
}

export function normalizeThemePreference(value: unknown): ThemePreference {
  if (value === 'light' || value === 'system' || value === 'dark') return value;
  return 'dark';
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  if (preference === 'light') return 'light';
  if (preference === 'system') return systemDark ? 'dark' : 'light';
  return 'dark';
}

export const DEFAULT_THEME_SNAPSHOT: ThemeSnapshot = Object.freeze({
  preference: 'dark',
  resolvedTheme: 'dark',
});

const LIGHT_THEME_SNAPSHOT: ThemeSnapshot = Object.freeze({
  preference: 'light',
  resolvedTheme: 'light',
});
const SYSTEM_DARK_SNAPSHOT: ThemeSnapshot = Object.freeze({
  preference: 'system',
  resolvedTheme: 'dark',
});
const SYSTEM_LIGHT_SNAPSHOT: ThemeSnapshot = Object.freeze({
  preference: 'system',
  resolvedTheme: 'light',
});

interface ScopeState {
  readonly key: string;
  preference: ThemePreference;
  snapshot: ThemeSnapshot;
}

interface StorageRead {
  readonly ok: boolean;
  readonly preference?: ThemePreference;
}

function snapshotFor(preference: ThemePreference, systemDark: boolean): ThemeSnapshot {
  const resolvedTheme = resolveTheme(preference, systemDark);
  if (preference === 'dark') return DEFAULT_THEME_SNAPSHOT;
  if (preference === 'light') return LIGHT_THEME_SNAPSHOT;
  return resolvedTheme === 'dark' ? SYSTEM_DARK_SNAPSHOT : SYSTEM_LIGHT_SNAPSHOT;
}

export function createThemePreferences(options: CreateThemePreferencesOptions = {}) {
  const scopes = new Map<string, ScopeState>();
  const listeners = new Set<() => void>();

  function readSystemDark(): boolean {
    try {
      const value = options.systemDark?.();
      return value === undefined ? true : Boolean(value);
    } catch {
      return true;
    }
  }

  function storageOrNull(): ThemeStorage | null {
    if (!options.storage) return null;
    try {
      const storage = options.storage();
      return storage ?? null;
    } catch {
      return null;
    }
  }

  function readFromStorage(storage: ThemeStorage, key: string): StorageRead {
    try {
      return { ok: true, preference: normalizeThemePreference(storage.getItem(key)) };
    } catch {
      return { ok: false };
    }
  }

  function readPreference(key: string): ThemePreference {
    const storage = storageOrNull();
    if (!storage) return 'dark';
    const result = readFromStorage(storage, key);
    return result.ok && result.preference !== undefined ? result.preference : 'dark';
  }

  function snapshotChanged(previous: ThemeSnapshot, next: ThemeSnapshot): boolean {
    return previous.preference !== next.preference || previous.resolvedTheme !== next.resolvedTheme;
  }

  function snapshotForPreference(preference: ThemePreference): ThemeSnapshot {
    return preference === 'system' ? snapshotFor(preference, readSystemDark()) : snapshotFor(preference, true);
  }

  function updateScope(scope: ScopeState, preference: ThemePreference, nextSnapshot = snapshotForPreference(preference)): boolean {
    const changed = snapshotChanged(scope.snapshot, nextSnapshot);
    scope.preference = preference;
    if (changed) scope.snapshot = nextSnapshot;
    return changed;
  }

  function createScope(key: string, preference: ThemePreference): ScopeState {
    const scope: ScopeState = {
      key,
      preference,
      snapshot: snapshotForPreference(preference),
    };
    scopes.set(key, scope);
    return scope;
  }

  function getOrCreateScope(userId: string | null): ScopeState {
    const key = themeStorageKey(userId);
    const existing = scopes.get(key);
    if (existing) return existing;
    return createScope(key, readPreference(key));
  }

  function notify(): void {
    for (const listener of [...listeners]) listener();
  }

  function writePreference(key: string, preference: ThemePreference): void {
    const storage = storageOrNull();
    if (!storage) return;
    try {
      storage.setItem(key, preference);
    } catch {
      // The in-memory scope remains usable when browser storage is restricted.
    }
  }

  return {
    getSnapshot(userId: string | null): ThemeSnapshot {
      const scope = getOrCreateScope(userId);
      if (scope.preference === 'system') {
        updateScope(scope, 'system');
      }
      return scope.snapshot;
    },

    setPreference(userId: string | null, preference: ThemePreference): void {
      const key = themeStorageKey(userId);
      const normalized = normalizeThemePreference(preference);
      const existing = scopes.get(key);
      if (!existing) {
        createScope(key, normalized);
        writePreference(key, normalized);
        return;
      }
      const nextSnapshot = snapshotForPreference(normalized);
      const changed = existing.preference !== normalized || snapshotChanged(existing.snapshot, nextSnapshot);
      if (changed) {
        updateScope(existing, normalized, nextSnapshot);
        notify();
      } else {
        existing.preference = normalized;
      }
      writePreference(key, normalized);
    },

    refreshSystem(): void {
      const systemScopes = [...scopes.values()].filter((scope) => scope.preference === 'system');
      if (systemScopes.length === 0) return;
      const nextSystemDark = readSystemDark();
      let changed = false;
      const nextSnapshot = snapshotFor('system', nextSystemDark);
      for (const scope of systemScopes) {
        if (snapshotChanged(scope.snapshot, nextSnapshot)) {
          scope.snapshot = nextSnapshot;
          changed = true;
        }
      }
      if (changed) notify();
    },

    refreshStorage(key: string | null): void {
      if (key !== null && !scopes.has(key)) return;
      if (key === null && scopes.size === 0) return;
      const storage = storageOrNull();
      if (!storage) return;

      let changed = false;
      if (key !== null) {
        const scope = scopes.get(key);
        if (!scope) return;
        const result = readFromStorage(storage, key);
        if (result.ok && result.preference !== undefined) changed = updateScope(scope, result.preference);
      } else {
        for (const scope of scopes.values()) {
          const result = readFromStorage(storage, scope.key);
          if (result.ok && result.preference !== undefined) {
            changed = updateScope(scope, result.preference) || changed;
          }
        }
      }
      if (changed) notify();
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
