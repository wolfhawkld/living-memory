import { LIGHT_THEME, LIGHT_UI, LIGHT_MEMORY_COLORS, themeCssVariables } from './theme-palette';
export { LIGHT_MEMORY_COLORS } from './theme-palette';

// Component styles keep their original dark values as var() fallbacks. Only
// light mode supplies these semantic overrides, preserving the established dark
// appearance without duplicating entire selectors or any layout declarations.
export const LIGHT_COMPONENT_VARIABLES = {
  '--ui-bg': LIGHT_UI.background,
  '--ui-panel': LIGHT_UI.panel,
  '--ui-raised': LIGHT_UI.panelRaised,
  '--ui-input': '#ffffff',
  '--ui-hover': '#edf3fc',
  '--ui-selected': '#e1ecfc',
  '--ui-border': LIGHT_UI.border,
  '--ui-border-strong': LIGHT_UI.borderStrong,
  '--ui-text': LIGHT_UI.text,
  '--ui-text-muted': LIGHT_UI.textMuted,
  '--ui-text-subtle': LIGHT_UI.textSubtle,
  '--ui-accent': LIGHT_UI.accent,
  '--ui-on-accent': LIGHT_UI.onAccent,
  '--ui-accent-soft': '#e8f0fc',
  '--ui-accent-border': '#9bb8e0',
  '--ui-success': LIGHT_MEMORY_COLORS.recent,
  '--ui-success-soft': '#e9f5f1',
  '--ui-success-border': '#9bcabe',
  '--ui-warning': LIGHT_MEMORY_COLORS.revisit,
  '--ui-warning-soft': '#fff4df',
  '--ui-warning-border': '#dcc08a',
  '--ui-error': LIGHT_UI.error,
  '--ui-error-soft': '#fff0f0',
  '--ui-error-border': '#dfaaaa',
  '--ui-retained': LIGHT_MEMORY_COLORS.retained,
  '--ui-retained-soft': '#f1ecf8',
  '--ui-retained-border': '#c8b5e0',
  '--ui-shadow': '0 14px 44px rgba(35, 54, 81, .14)',
  '--ui-focus-shadow': '0 0 0 3px rgba(40, 94, 170, .16)',
  '--ui-backdrop': 'rgba(38, 51, 72, .36)',
  '--ui-code-bg': '#edf2f8',
  '--ui-code-text': '#294668',
  '--ui-decoration': 'rgba(62, 92, 134, .09)',
  '--ui-glow': 'none',
} satisfies Record<`--ui-${string}`, string>;

export function lightWorkspaceVariables(): Record<`--${string}`, string> {
  return {
    ...themeCssVariables(LIGHT_THEME),
    ...LIGHT_COMPONENT_VARIABLES,
  };
}
