import type { MemoryState } from '../shared/types';

type MemoryColors = Readonly<Record<MemoryState['status'], string>>;

/** Presentation only: these values never participate in memory calculations. */
export interface ThemePalette {
  readonly id: 'dark' | 'light';
  readonly ui: Readonly<{
    background: string;
    panel: string;
    panelRaised: string;
    panelSoft: string;
    border: string;
    borderStrong: string;
    text: string;
    textMuted: string;
    textSubtle: string;
    accent: string;
    onAccent: string;
    error: string;
    shadow: string;
  }>;
  readonly memory: MemoryColors;
  readonly memoryBadge: MemoryColors;
  readonly graph: Readonly<{
    background: string;
    link: string;
    linkMuted: string;
    linkSelected: string;
    linkOpacity: number;
    node: Readonly<{
      selectedRing: string;
      emissiveWithGlow: number;
      emissiveWithoutGlow: number;
      ringOpacity: number;
      selectedRingOpacity: number;
      unknownHaloOpacity: number;
      haloOpacity: number;
      haloBlending: 'additive' | 'normal';
    }>;
    label: Readonly<{ border: string; background: string; shadow: string; text: string }>;
    labelEmphasized: Readonly<{ border: string; background: string; shadow: string; text: string }>;
    bloom: Readonly<{ strength: number; radius: number; threshold: number }>;
    ambientLight: Readonly<{ color: string; intensity: number }>;
    directionalLight: Readonly<{ color: string; intensity: number }>;
  }>;
}

const darkMemory: MemoryColors = {
  unknown: '#4175af',
  recent: '#5ce3d0',
  revisit: '#f4bd70',
  stale: '#ff817d',
  pending: '#a4a9b6',
  retained: '#b49aea',
};

// Preserve the original dark appearance while sharing state meanings with light.
export const DARK_THEME: ThemePalette = {
  id: 'dark',
  ui: {
    background: '#060a13',
    panel: 'rgba(11, 18, 31, 0.92)',
    panelRaised: 'rgba(18, 29, 48, 0.96)',
    panelSoft: 'rgba(23, 38, 62, 0.62)',
    border: 'rgba(126, 155, 199, 0.16)',
    borderStrong: 'rgba(138, 174, 230, 0.28)',
    text: '#ecf3ff',
    textMuted: '#8496b5',
    textSubtle: '#596b89',
    accent: '#78aaff',
    onAccent: '#07111e',
    error: '#ff817d',
    shadow: '0 24px 80px rgba(0, 0, 0, .32)',
  },
  memory: darkMemory,
  // Existing detail badges have quieter unknown/pending variants. Keep them
  // explicit here instead of leaving a second, hidden status palette in CSS.
  memoryBadge: { ...darkMemory, unknown: '#7f8da9', pending: '#a7adbd' },
  graph: {
    background: '#070c18',
    // Relationships are blue; memory state belongs to the nodes.
    link: '#456b94',
    linkMuted: '#3e5e80',
    linkSelected: '#b5edff',
    linkOpacity: 0.65,
    node: {
      selectedRing: '#cbefff',
      emissiveWithGlow: 0.32,
      emissiveWithoutGlow: 0.06,
      ringOpacity: 0.8,
      selectedRingOpacity: 0.75,
      unknownHaloOpacity: 0.09,
      haloOpacity: 0.19,
      haloBlending: 'additive',
    },
    label: {
      border: 'rgba(132, 167, 211, 0.24)',
      background: 'rgba(7, 14, 27, 0.76)',
      shadow: '0 2px 8px rgba(0, 0, 0, 0.18)',
      text: '#cfddf2',
    },
    labelEmphasized: {
      border: 'rgba(132, 211, 255, 0.72)',
      background: 'rgba(5, 15, 31, 0.9)',
      shadow: '0 3px 14px rgba(0, 0, 0, 0.28)',
      text: '#edf7ff',
    },
    bloom: { strength: 0.85, radius: 0.45, threshold: 0.3 },
    ambientLight: { color: '#ffffff', intensity: 1.6 },
    directionalLight: { color: '#ecf5ff', intensity: 2 },
  },
};

// Shared by both page styles and graph materials.
export const LIGHT_UI: ThemePalette['ui'] = {
  background: '#eef2f7',
  panel: '#ffffff',
  panelRaised: '#f7f9fc',
  panelSoft: '#e6edf6',
  border: '#d4ddea',
  borderStrong: '#a7b8ce',
  text: '#24344c',
  textMuted: '#50637c',
  textSubtle: '#5b6b82',
  accent: '#285eaa',
  onAccent: '#ffffff',
  error: '#b13d40',
  shadow: '0 24px 80px rgba(35, 54, 81, .12)',
};

export const LIGHT_MEMORY_COLORS: ThemePalette['memory'] = {
  unknown: '#386796', recent: '#12796c', revisit: '#96620f',
  stale: '#bb404b', pending: '#606b7b', retained: '#7953a3',
};

export const LIGHT_THEME: ThemePalette = {
  id: 'light',
  ui: LIGHT_UI,
  memory: LIGHT_MEMORY_COLORS,
  memoryBadge: LIGHT_MEMORY_COLORS,
  graph: {
    background: '#eef2f7',
    link: '#607c9d', linkMuted: '#a4b1c2', linkSelected: '#254c93', linkOpacity: 0.8,
    node: {
      selectedRing: '#254c93',
      emissiveWithGlow: 0.1, emissiveWithoutGlow: 0.02,
      ringOpacity: 0.9, selectedRingOpacity: 0.96,
      unknownHaloOpacity: 0.08, haloOpacity: 0.14, haloBlending: 'normal',
    },
    label: {
      border: '#bdcadc', background: 'rgba(255, 255, 255, 0.92)',
      shadow: '0 2px 8px rgba(35, 54, 81, 0.1)', text: '#344a66',
    },
    labelEmphasized: {
      border: '#597fae', background: 'rgba(255, 255, 255, 0.98)',
      shadow: '0 3px 14px rgba(35, 54, 81, 0.18)', text: '#203b63',
    },
    // Whole-scene Bloom also brightens the pale background. The glow toggle
    // controls local node halos/emission here, while dark retains Bloom.
    bloom: { strength: 0, radius: 0.45, threshold: 1 },
    ambientLight: { color: '#ffffff', intensity: 1.2 },
    directionalLight: { color: '#ffffff', intensity: 1.4 },
  },
};

export function themePalette(id: ThemePalette['id']): ThemePalette {
  return id === 'light' ? LIGHT_THEME : DARK_THEME;
}

export function themeUiCssVariables(ui: ThemePalette['ui']): Record<`--${string}`, string> {
  return {
    '--bg': ui.background,
    '--page-backdrop': ui.background,
    '--panel': ui.panel,
    '--panel-raised': ui.panelRaised,
    '--panel-soft': ui.panelSoft,
    '--line': ui.border,
    '--line-strong': ui.borderStrong,
    '--text': ui.text,
    '--muted': ui.textMuted,
    '--subtle': ui.textSubtle,
    '--accent': ui.accent,
    '--on-accent': ui.onAccent,
    '--error': ui.error,
    '--shadow': ui.shadow,
  };
}

/** Shared by the initial stylesheet and, later, the runtime theme controller. */
export function themeCssVariables(theme: ThemePalette): Record<`--${string}`, string> {
  const { ui, memory, memoryBadge } = theme;
  const variables: Record<`--${string}`, string> = {
    ...themeUiCssVariables(ui),
    '--graph-background': theme.graph.background,
    '--graph-tooltip-background': theme.graph.labelEmphasized.background,
    '--graph-tooltip-text': theme.graph.labelEmphasized.text,
    '--graph-tooltip-border': theme.graph.labelEmphasized.border,
    // Compatibility aliases until the full component CSS migration (THEME-03).
    '--mint': memory.recent,
    '--amber': memory.revisit,
    '--coral': memory.stale,
    '--unknown': memoryBadge.unknown,
  };
  for (const status of Object.keys(memory) as (keyof MemoryColors)[]) {
    variables[`--memory-${status}`] = memory[status];
    variables[`--memory-badge-${status}`] = memoryBadge[status];
  }
  return variables;
}

/** Only serialize trusted, repository-owned palettes, never user-provided CSS. */
export function themeRootCss(theme: ThemePalette): string {
  return themeCssRule(':root', themeCssVariables(theme));
}

export function themeCssRule(selector: string, variables: Record<`--${string}`, string>): string {
  return `${selector} {\n${Object.entries(variables).map(([key, value]) => `  ${key}: ${value};`).join('\n')}\n}`;
}
