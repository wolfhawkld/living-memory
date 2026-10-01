import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { DARK_THEME, themeCssRule, themeRootCss } from '../src/web/theme-palette.js';
import { SYSTEM_THEME_QUERY, THEME_BROWSER_COLORS } from '../src/web/theme-bootstrap.js';
import { themeStorageKey, type ThemePreference, type ResolvedTheme } from '../src/web/theme-preferences.js';
import { lightWorkspaceVariables } from '../src/web/theme-workspace.js';

// Check the production HTML, including the bootstrap compiled by Vite. Source
// unit tests alone cannot detect a missing injection or a transpiler closure.
const html = await readFile(new URL('../dist/index.html', import.meta.url), 'utf8');
const head = html.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i)?.[1];
assert.ok(head, 'Production HTML must contain a head');
assert.match(html.slice(0, 1024), /<meta\s+charset="UTF-8"\s*\/?\s*>/i);
const browserMetas = [...html.matchAll(/<meta\b[^>]*\bname="theme-color"[^>]*>/g)];
assert.equal(browserMetas.length, 1, 'Production HTML must contain one browser theme-color meta');
assert.ok(head.includes(browserMetas[0][0]), 'Browser theme-color meta must be in head');
assert.equal(browserMetas[0][0].match(/\bcontent="([^"]*)"/)?.[1], THEME_BROWSER_COLORS.dark,
  'Static browser theme-color must match the default dark palette');

function injectedContent(tag: 'style' | 'script', id: string): string {
  const matches = [...html.matchAll(new RegExp(`<${tag}\\b[^>]*\\bid="${id}"[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'g'))];
  assert.equal(matches.length, 1, `Expected one ${id} in production HTML`);
  assert.ok(head!.includes(matches[0][0]), `${id} must run before the body is parsed`);
  if (tag === 'script') {
    const opening = matches[0][0].slice(0, matches[0][0].indexOf('>'));
    assert.doesNotMatch(opening, /\b(?:src|type|async|defer)\b/i, 'Theme bootstrap must remain an inline classic script');
  }
  return matches[0][1];
}

const css = injectedContent('style', 'lm-default-theme');
const expectedCss = `${themeRootCss(DARK_THEME)}\n${themeCssRule(':root[data-theme="light"]', lightWorkspaceVariables())}`;
assert.equal(css.replace(/\s+/g, ' ').trim(), expectedCss.replace(/\s+/g, ' ').trim(),
  'Production HTML must contain the current dark and light palettes without obsolete graph overrides');
const bootstrap = injectedContent('script', 'lm-theme-init');

interface Scenario {
  name: string;
  stored: string | null;
  preference: ThemePreference;
  theme: ResolvedTheme;
  systemDark?: boolean;
  storageDenied?: boolean;
  mediaDenied?: boolean;
}

const scenarios: Scenario[] = [
  { name: 'default', stored: null, preference: 'dark', theme: 'dark' },
  { name: 'explicit dark', stored: 'dark', preference: 'dark', theme: 'dark' },
  { name: 'explicit light', stored: 'light', preference: 'light', theme: 'light' },
  { name: 'system dark', stored: 'system', preference: 'system', theme: 'dark', systemDark: true },
  { name: 'system light', stored: 'system', preference: 'system', theme: 'light', systemDark: false },
  { name: 'invalid preference', stored: 'invalid', preference: 'dark', theme: 'dark' },
  { name: 'storage unavailable', stored: null, preference: 'dark', theme: 'dark', storageDenied: true },
  { name: 'media unavailable', stored: 'system', preference: 'system', theme: 'dark', mediaDenied: true },
];

for (const scenario of scenarios) {
  const root = { dataset: {} as Record<string, string>, style: { colorScheme: '' } };
  const reads: string[] = [];
  let writes = 0;
  let mediaReads = 0;
  let browserColor = '';
  const document = {
    documentElement: root,
    querySelector: (selector: string) => {
      assert.equal(selector, 'meta[name="theme-color"]');
      return { setAttribute: (key: string, value: string) => {
        assert.equal(key, 'content');
        browserColor = value;
      } };
    },
  };
  const window = {
    get localStorage() {
      if (scenario.storageDenied) throw new Error('Storage unavailable');
      return {
        getItem: (key: string) => { reads.push(key); return scenario.stored; },
        setItem: () => { writes += 1; },
        removeItem: () => { writes += 1; },
        clear: () => { writes += 1; },
      };
    },
    matchMedia: (query: string) => {
      assert.equal(query, SYSTEM_THEME_QUERY);
      mediaReads += 1;
      if (scenario.mediaDenied) throw new Error('Media query unavailable');
      return { matches: scenario.systemDark ?? true };
    },
  };
  runInNewContext(bootstrap, { document, window }, { timeout: 1000 });
  assert.deepEqual(root.dataset, { theme: scenario.theme, themePreference: scenario.preference }, scenario.name);
  assert.equal(root.style.colorScheme, scenario.theme, scenario.name);
  assert.equal(browserColor, THEME_BROWSER_COLORS[scenario.theme], scenario.name);
  assert.deepEqual(reads, scenario.storageDenied ? [] : [themeStorageKey(null)], scenario.name);
  assert.equal(writes, 0, `${scenario.name}: first paint must not write preferences`);
  assert.equal(mediaReads, scenario.preference === 'system' ? 1 : 0, scenario.name);
}

console.log(`Production theme check passed: head styles and ${scenarios.length} compiled bootstrap scenarios (no browser).`);
