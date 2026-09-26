import * as THREE from 'three';
import type { MemoryState } from '../shared/types';
import type { ThemePalette } from './theme-palette';

export interface NodeVisual {
  sphere: THREE.Mesh<THREE.SphereGeometry, THREE.MeshLambertMaterial>;
  halo: THREE.Sprite;
  ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
}

/** Mutate existing materials only; theme changes allocate no geometry or texture. */
export function applyNodeTheme(
  visual: NodeVisual, status: MemoryState['status'], theme: ThemePalette,
  glowEnabled: boolean, selected: boolean,
): void {
  const color = theme.memory[status];
  const palette = theme.graph.node;
  visual.sphere.material.color.set(color);
  visual.sphere.material.emissive.set(color);
  visual.sphere.material.emissiveIntensity = glowEnabled
    ? palette.emissiveWithGlow : palette.emissiveWithoutGlow;
  const unknown = status === 'unknown';
  visual.sphere.visible = !unknown;
  visual.ring.visible = unknown || selected;
  visual.ring.material.color.set(selected ? palette.selectedRing : color);
  visual.ring.material.opacity = selected ? palette.selectedRingOpacity : palette.ringOpacity;
  const halo = visual.halo.material;
  halo.color.set(color);
  halo.opacity = unknown ? palette.unknownHaloOpacity : palette.haloOpacity;
  halo.blending = palette.haloBlending === 'normal' ? THREE.NormalBlending : THREE.AdditiveBlending;
  visual.halo.visible = glowEnabled;
}

export interface GraphThemeResources {
  ambient: THREE.AmbientLight;
  directional: THREE.DirectionalLight;
  bloom: { strength: number; radius: number; threshold: number; enabled: boolean } | null;
  output: { enabled: boolean } | null;
}

/** Deliberately excludes camera, data, forces and animation lifecycle methods. */
export function applySceneTheme(
  graph: { scene: () => THREE.Scene; backgroundColor: (color: string) => unknown },
  resources: GraphThemeResources, theme: ThemePalette, glowEnabled: boolean,
): void {
  const palette = theme.graph;
  const scene = graph.scene();
  if (scene.background instanceof THREE.Color) scene.background.set(palette.background);
  else scene.background = new THREE.Color(palette.background);
  // Scene background clears correctly both in linear composer targets and in
  // the screen framebuffer; keep the library's clear color in agreement.
  graph.backgroundColor(palette.background);
  resources.ambient.color.set(palette.ambientLight.color);
  resources.ambient.intensity = palette.ambientLight.intensity;
  resources.directional.color.set(palette.directionalLight.color);
  resources.directional.intensity = palette.directionalLight.intensity;
  const useBloom = glowEnabled && palette.bloom.strength > 0 && Boolean(resources.bloom && resources.output);
  if (resources.bloom) {
    Object.assign(resources.bloom, palette.bloom);
    resources.bloom.enabled = useBloom;
  }
  // With Bloom disabled RenderPass renders directly to the screen and performs
  // output conversion itself. With Bloom active OutputPass must run last.
  if (resources.output) resources.output.enabled = useBloom;
}
