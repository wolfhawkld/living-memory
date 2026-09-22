import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { DARK_THEME, themeCssVariables, themeRootCss, type ThemePalette } from '../src/web/theme-palette.js';

test('the initial palette supplies the variables used by existing stylesheets', () => {
  const webDirectory = new URL('../src/web/', import.meta.url);
  const styles = readdirSync(webDirectory)
    .filter((file) => file.endsWith('.css'))
    .map((file) => readFileSync(new URL(file, webDirectory), 'utf8'))
    .join('\n');
  const initialCss = themeRootCss(DARK_THEME);
  const declared = new Set(
    [...`${initialCss}\n${styles}`.matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1]),
  );
  // Per-element values supplied by React, not application-wide theme tokens.
  declared.add('--status-color');
  declared.add('--reader-font-size');
  const referenced = new Set([...styles.matchAll(/var\((--[\w-]+)/g)].map((match) => match[1]));
  assert.deepEqual([...referenced].filter((name) => !declared.has(name)), []);
  assert.ok(initialCss.startsWith(':root {'), 'the variables must be available before React mounts');

  // Preserve the pre-migration page and graph state signals, including all six
  // states and the two intentionally quieter detail-badge variants.
  assert.equal(themeCssVariables(DARK_THEME)['--bg'], '#060a13');
  assert.deepEqual(DARK_THEME.memory, {
    unknown: '#4175af', recent: '#5ce3d0', revisit: '#f4bd70',
    stale: '#ff817d', pending: '#a4a9b6', retained: '#b49aea',
  });
  assert.equal(themeCssVariables(DARK_THEME)['--memory-badge-unknown'], '#7f8da9');
  assert.equal(themeCssVariables(DARK_THEME)['--memory-badge-pending'], '#a7adbd');
});

test('CSS serialization uses the supplied palette without retaining or mutating the default', () => {
  const original = structuredClone(DARK_THEME);
  const alternative: ThemePalette = {
    ...DARK_THEME,
    ui: { ...DARK_THEME.ui, background: '#f0f1f2' },
    memory: { ...DARK_THEME.memory, recent: '#126655', retained: '#775588' },
    memoryBadge: { ...DARK_THEME.memoryBadge, unknown: '#334455' },
  };
  const css = themeRootCss(alternative);
  assert.ok(css.includes('--bg: #f0f1f2;'));
  assert.ok(css.includes('--mint: #126655;'), 'compatibility aliases must not keep the old theme');
  assert.ok(css.includes('--unknown: #334455;'));
  for (const [status, color] of Object.entries(alternative.memory)) {
    assert.ok(css.includes(`--memory-${status}: ${color};`), `${status} must share the graph palette`);
  }
  for (const [status, color] of Object.entries(alternative.memoryBadge)) {
    assert.ok(css.includes(`--memory-badge-${status}: ${color};`));
  }
  assert.deepEqual(DARK_THEME, original);
});
