import assert from 'node:assert/strict';
import test from 'node:test';
import { DARK_THEME, LIGHT_UI, themeCssVariables } from '../src/web/theme-palette.js';
import { darkGraphVariables, LIGHT_COMPONENT_VARIABLES, LIGHT_MEMORY_COLORS, lightWorkspaceVariables } from '../src/web/theme-workspace.js';

function luminance(hex: string): number {
  const channels = hex.slice(1).match(/../g)!.map((value) => parseInt(value, 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

test('light state text and ordinary UI text stay readable on both panel and page backgrounds', () => {
  assert.deepEqual(Object.keys(LIGHT_MEMORY_COLORS).sort(), Object.keys(DARK_THEME.memory).sort());
  const foregrounds = {
    ...LIGHT_MEMORY_COLORS,
    text: LIGHT_UI.text,
    muted: LIGHT_UI.textMuted,
    subtle: LIGHT_UI.textSubtle,
    accent: LIGHT_UI.accent,
    error: LIGHT_UI.error,
  };
  for (const [name, color] of Object.entries(foregrounds)) {
    for (const background of [LIGHT_UI.panel, LIGHT_UI.background]) {
      assert.ok(contrast(color, background) >= 4.5, `${name} on ${background} needs readable small text`);
    }
  }
  assert.ok(contrast(LIGHT_UI.onAccent, LIGHT_UI.accent) >= 4.5);
});

test('page state colors and badge colors agree, while the staged graph boundary retains the dark palette', () => {
  const page = lightWorkspaceVariables();
  const graph = darkGraphVariables();
  for (const [status, color] of Object.entries(LIGHT_MEMORY_COLORS)) {
    assert.equal(page[`--memory-${status}`], color);
    assert.equal(page[`--memory-badge-${status}`], color);
  }
  for (const [key, value] of Object.entries(themeCssVariables(DARK_THEME))) {
    assert.equal(graph[key as `--${string}`], value);
  }
  // A pale page must not leak component overrides into the still-dark canvas
  // overlays; `initial` restores each component's original var() fallback.
  for (const key of Object.keys(LIGHT_COMPONENT_VARIABLES)) {
    assert.equal(graph[key as `--${string}`], 'initial');
  }
  assert.equal(page['--bg'], LIGHT_UI.background);
  assert.equal(graph['--bg'], DARK_THEME.ui.background);
});
