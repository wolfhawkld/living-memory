import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { applyDocumentTheme, SYSTEM_THEME_QUERY } from './theme-bootstrap';
import { createThemePreferences, DEFAULT_THEME_SNAPSHOT, type ThemePreference, type ThemeSnapshot } from './theme-preferences';

interface ThemeContextValue extends ThemeSnapshot {
  setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue>({ ...DEFAULT_THEME_SNAPSHOT, setPreference: () => undefined });

function createEnvironment() {
  let media: MediaQueryList | null = null;
  if (typeof window !== 'undefined') {
    try { media = window.matchMedia(SYSTEM_THEME_QUERY); } catch { /* System theme is optional. */ }
  }
  return {
    media,
    preferences: createThemePreferences({
      storage: () => window.localStorage,
      systemDark: () => media?.matches ?? true,
    }),
  };
}

/** One lifetime across auth transitions; a different preference never remounts App. */
export function ThemeProvider({ userId, children }: { userId: string | null; children: ReactNode }) {
  const [{ preferences, media }] = useState(createEnvironment);
  const getSnapshot = useCallback(() => preferences.getSnapshot(userId), [preferences, userId]);
  const snapshot = useSyncExternalStore(preferences.subscribe, getSnapshot, () => DEFAULT_THEME_SNAPSHOT);
  const setPreference = useCallback((preference: ThemePreference) => {
    preferences.setPreference(userId, preference);
  }, [preferences, userId]);
  const value = useMemo(() => ({ ...snapshot, setPreference }), [snapshot, setPreference]);

  // Auth resolves asynchronously. Apply the verified user's preference before
  // that user's workspace (including its Suspense fallback) can be painted.
  useLayoutEffect(() => applyDocumentTheme(document, snapshot), [snapshot]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      try {
        if (event.storageArea && event.storageArea !== window.localStorage) return;
      } catch { return; }
      preferences.refreshStorage(event.key);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [preferences]);

  useEffect(() => {
    if (snapshot.preference !== 'system' || !media) return;
    const onChange = () => preferences.refreshSystem();
    media.addEventListener('change', onChange);
    onChange();
    return () => media.removeEventListener('change', onChange);
  }, [media, preferences, snapshot.preference]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

/** Synthetic benchmark only: an in-memory theme, with no account preferences. */
export function ThemePreviewProvider({ theme, children }: { theme: 'dark' | 'light'; children: ReactNode }) {
  const snapshot = useMemo(() => ({ preference: theme, resolvedTheme: theme }), [theme]);
  useLayoutEffect(() => {
    const root = document.documentElement, meta = document.querySelector('meta[name="theme-color"]');
    const previous = { theme: root.dataset.theme, preference: root.dataset.themePreference,
      scheme: root.style.colorScheme, color: meta?.getAttribute('content') ?? null };
    applyDocumentTheme(document, snapshot);
    return () => {
      if (previous.theme === undefined) delete root.dataset.theme; else root.dataset.theme = previous.theme;
      if (previous.preference === undefined) delete root.dataset.themePreference; else root.dataset.themePreference = previous.preference;
      root.style.colorScheme = previous.scheme;
      if (previous.color === null) meta?.removeAttribute('content'); else meta?.setAttribute('content', previous.color);
    };
  }, [snapshot]);
  return <ThemeContext.Provider value={{ ...snapshot, setPreference: () => undefined }}>{children}</ThemeContext.Provider>;
}
