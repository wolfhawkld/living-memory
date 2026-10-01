import assert from 'node:assert/strict';
import test from 'node:test';
import { DARK_THEME, LIGHT_THEME, LIGHT_UI, themeCssVariables } from '../src/web/theme-palette.js';
import { LIGHT_COMPONENT_VARIABLES, LIGHT_MEMORY_COLORS, lightWorkspaceVariables } from '../src/web/theme-workspace.js';

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
    graphLabel: LIGHT_THEME.graph.label.text,
    graphLabelEmphasized: LIGHT_THEME.graph.labelEmphasized.text,
  };
  for (const [name, color] of Object.entries(foregrounds)) {
    for (const background of [LIGHT_UI.panel, LIGHT_UI.background, LIGHT_THEME.graph.background]) {
      assert.ok(contrast(color, background) >= 4.5, `${name} on ${background} needs readable small text`);
    }
  }
  assert.ok(contrast(LIGHT_UI.onAccent, LIGHT_UI.accent) >= 4.5);
});

test('page state colors and graph variables share LIGHT_THEME', () => {
  const page = lightWorkspaceVariables();
  const graph = themeCssVariables(LIGHT_THEME);
  for (const [status, color] of Object.entries(LIGHT_MEMORY_COLORS)) {
    assert.equal(page[`--memory-${status}`], color);
    assert.equal(page[`--memory-${status}`], LIGHT_THEME.memory[status as keyof typeof LIGHT_THEME.memory]);
    assert.equal(page[`--memory-badge-${status}`], LIGHT_THEME.memoryBadge[status as keyof typeof LIGHT_THEME.memoryBadge]);
  }
  for (const [key, value] of Object.entries(graph)) {
    assert.equal(page[key as `--${string}`], value, `${key} must be shared by page and graph`);
  }
  assert.equal(page['--bg'], LIGHT_UI.background);
  assert.equal(graph['--bg'], LIGHT_THEME.ui.background);
  assert.equal(page['--graph-background'], LIGHT_THEME.graph.background);
  assert.equal(page['--graph-tooltip-text'], LIGHT_THEME.graph.labelEmphasized.text);
  assert.equal(page['--graph-tooltip-background'], LIGHT_THEME.graph.labelEmphasized.background);
  assert.equal(page['--graph-tooltip-border'], LIGHT_THEME.graph.labelEmphasized.border);

  // Component-only overrides remain part of the page workspace layer and do
  // not replace any of the shared palette variables above.
  for (const [key, value] of Object.entries(LIGHT_COMPONENT_VARIABLES)) {
    assert.equal(page[key as `--${string}`], value);
  }
});
