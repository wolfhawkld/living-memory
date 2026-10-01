import { DARK_THEME, LIGHT_UI } from './theme-palette';
import { themeStorageKey, type ThemeSnapshot } from './theme-preferences';

export const SYSTEM_THEME_QUERY = '(prefers-color-scheme: dark)';
export const THEME_BROWSER_COLORS = { dark: DARK_THEME.ui.background, light: LIGHT_UI.background } as const;

export function applyDocumentTheme(documentRef: Document, snapshot: ThemeSnapshot): void {
  const root = documentRef.documentElement;
  root.dataset.theme = snapshot.resolvedTheme;
  root.dataset.themePreference = snapshot.preference;
  root.style.colorScheme = snapshot.resolvedTheme;
  documentRef.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_BROWSER_COLORS[snapshot.resolvedTheme]);
}

interface BootstrapConfig {
  key: string;
  query: string;
  colors: typeof THEME_BROWSER_COLORS;
}

// Keep this function self-contained: its compiled body runs in the HTML head
// before React or a network request. An account is only selected after auth.
function bootstrapAnonymousTheme(config: BootstrapConfig): void {
  let preference = 'dark';
  try {
    const stored = window.localStorage.getItem(config.key);
    if (stored === 'dark' || stored === 'light' || stored === 'system') preference = stored;
  } catch { /* Storage is optional. */ }
  let darkSystem = true;
  if (preference === 'system') {
    try { darkSystem = window.matchMedia(config.query).matches; } catch { /* Default to dark. */ }
  }
  const theme = preference === 'system' ? (darkSystem ? 'dark' : 'light') : (preference === 'light' ? 'light' : 'dark');
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.themePreference = preference;
  root.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', config.colors[theme]);
}

export function themeBootstrapScript(): string {
  return `(${bootstrapAnonymousTheme.toString()})(${JSON.stringify({
    key: themeStorageKey(null), query: SYSTEM_THEME_QUERY, colors: THEME_BROWSER_COLORS,
  } satisfies BootstrapConfig)});`;
}
