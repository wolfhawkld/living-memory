import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { applyDocumentTheme, SYSTEM_THEME_QUERY, THEME_BROWSER_COLORS, themeBootstrapScript } from '../src/web/theme-bootstrap.js';
import { normalizeThemePreference, resolveTheme, themeStorageKey } from '../src/web/theme-preferences.js';

function documentFixture() {
  const documentElement = { dataset: {} as Record<string, string>, style: { colorScheme: '' } };
  let browserColor = '';
  const meta = { setAttribute: (key: string, value: string) => { if (key === 'content') browserColor = value; } };
  return {
    documentElement,
    querySelector: (selector: string) => selector === 'meta[name="theme-color"]' ? meta : null,
    get browserColor() { return browserColor; },
  };
}

test('the standalone head script resolves anonymous preferences before React without reading account keys', () => {
  // Execute the exact generated script in a fresh context, so accidental
  // module closures or transpiler helpers cannot hide a broken first paint.
  for (const stored of [null, 'dark', 'light', 'system', 'invalid', '{"theme":"light"}']) {
    for (const systemDark of [true, false]) {
      const document = documentFixture();
      const reads: string[] = [];
      let mediaReads = 0;
      const window = {
        localStorage: {
          getItem: (key: string) => { reads.push(key); return stored; },
          setItem: () => { throw new Error('bootstrap must not write preferences'); },
        },
        matchMedia: (query: string) => { assert.equal(query, SYSTEM_THEME_QUERY); mediaReads += 1; return { matches: systemDark }; },
      };
      runInNewContext(themeBootstrapScript(), { document, window });
      const preference = normalizeThemePreference(stored);
      const effective = resolveTheme(preference, systemDark);
      assert.deepEqual(reads, [themeStorageKey(null)]);
      assert.equal(mediaReads, preference === 'system' ? 1 : 0);
      assert.equal(document.documentElement.dataset.themePreference, preference);
      assert.equal(document.documentElement.dataset.theme, effective);
      assert.equal(document.documentElement.style.colorScheme, effective);
      assert.equal(document.browserColor, THEME_BROWSER_COLORS[effective]);
    }
  }
});

test('first paint tolerates unavailable storage and unavailable system appearance', () => {
  const document = documentFixture();
  runInNewContext(themeBootstrapScript(), {
    document,
    window: { get localStorage() { throw new Error('disabled'); } },
  });
  assert.equal(document.documentElement.dataset.theme, 'dark');

  runInNewContext(themeBootstrapScript(), {
    document,
    window: { localStorage: { getItem: () => 'system' }, matchMedia: () => { throw new Error('unsupported'); } },
  });
  assert.equal(document.documentElement.dataset.themePreference, 'system');
  assert.equal(document.documentElement.dataset.theme, 'dark');
});

test('runtime updates replace first-paint attributes without replacing the root or unrelated styles', () => {
  const document = documentFixture();
  document.documentElement.dataset.accountView = 'ready';
  const root = document.documentElement;
  applyDocumentTheme(document as unknown as Document, { preference: 'system', resolvedTheme: 'light' });
  assert.equal(document.documentElement, root);
  assert.equal(root.dataset.accountView, 'ready');
  assert.equal(root.dataset.themePreference, 'system');
  assert.equal(root.style.colorScheme, 'light');
  assert.equal(document.browserColor, THEME_BROWSER_COLORS.light);
  applyDocumentTheme(document as unknown as Document, { preference: 'dark', resolvedTheme: 'dark' });
  assert.equal(root.dataset.theme, 'dark');
  assert.equal(root.dataset.themePreference, 'dark');
  assert.equal(document.browserColor, THEME_BROWSER_COLORS.dark);
});
