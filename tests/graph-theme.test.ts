import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import type { MemoryState } from '../src/shared/types.js';
import {
  DARK_THEME,
  LIGHT_THEME,
  type ThemePalette,
} from '../src/web/theme-palette.js';
import {
  applyNodeTheme,
  applySceneTheme,
  type GraphThemeResources,
  type NodeVisual,
} from '../src/web/graph-theme.js';

const statuses: MemoryState['status'][] = [
  'unknown', 'recent', 'revisit', 'stale', 'pending', 'retained',
];
const themes: ThemePalette[] = [DARK_THEME, LIGHT_THEME];

function colorHex(color: THREE.Color): string {
  return `#${color.getHexString()}`;
}

function createNodeVisual(): {
  group: THREE.Group;
  visual: NodeVisual;
  texture: THREE.Texture;
} {
  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(1, 8, 6),
    new THREE.MeshLambertMaterial(),
  );
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.96, 1.08, 12),
    new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }),
  );
  const texture = new THREE.Texture();
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }));
  const group = new THREE.Group();
  group.add(halo, ring, sphere);
  return { group, visual: { sphere, halo, ring }, texture };
}

test('node themes preserve each state color while handling hollow and selected nodes', () => {
  for (const theme of themes) {
    for (const status of statuses) {
      for (const selected of [false, true]) {
        const { visual } = createNodeVisual();
        applyNodeTheme(visual, status, theme, true, selected);
        const nodePalette = theme.graph.node;
        const stateColor = theme.memory[status];

        assert.equal(colorHex(visual.sphere.material.color), stateColor);
        assert.equal(colorHex(visual.sphere.material.emissive), stateColor);
        assert.equal(
          visual.sphere.material.emissiveIntensity,
          nodePalette.emissiveWithGlow,
        );
        assert.equal(visual.sphere.visible, status !== 'unknown');
        assert.equal(visual.ring.visible, status === 'unknown' || selected);
        assert.equal(
          colorHex(visual.ring.material.color),
          selected ? nodePalette.selectedRing : stateColor,
        );
        assert.equal(
          visual.ring.material.opacity,
          selected ? nodePalette.selectedRingOpacity : nodePalette.ringOpacity,
        );
        assert.equal(colorHex(visual.halo.material.color), stateColor);
        assert.equal(
          visual.halo.material.opacity,
          status === 'unknown' ? nodePalette.unknownHaloOpacity : nodePalette.haloOpacity,
        );
        assert.equal(
          visual.halo.material.blending,
          nodePalette.haloBlending === 'normal' ? THREE.NormalBlending : THREE.AdditiveBlending,
        );
        assert.equal(visual.halo.visible, true);

        if (selected && status !== 'unknown') {
          // Selection is carried by the ring; it must not recolor the solid
          // state-bearing sphere beneath it.
          assert.equal(colorHex(visual.sphere.material.color), stateColor);
          assert.equal(visual.ring.visible, true);
        }
      }
    }
  }
});

test('disabling glow hides only the halo and keeps the selection ring', () => {
  for (const theme of themes) {
    for (const status of statuses) {
      const { visual } = createNodeVisual();
      applyNodeTheme(visual, status, theme, false, true);

      assert.equal(visual.halo.visible, false);
      assert.equal(visual.ring.visible, true);
      assert.equal(visual.sphere.visible, status !== 'unknown');
      assert.equal(
        visual.sphere.material.emissiveIntensity,
        theme.graph.node.emissiveWithoutGlow,
      );
    }
  }
});

test('switching themes reuses node resources and preserves coordinates and memory state', () => {
  const { group, visual, texture } = createNodeVisual();
  const state = {
    conceptId: 'same-node',
    status: 'revisit' as const,
    decay: 0.42,
    elapsedDays: 12,
    anchor: null,
    reason: 'test state',
    asOf: '2026-09-26T00:00:00.000Z',
  };
  group.position.set(18, -7, 31);
  group.rotation.set(0.1, -0.2, 0.3);
  visual.halo.position.set(1, 2, 3);
  visual.ring.position.set(-4, 5, -6);
  visual.sphere.position.set(7, -8, 9);

  const original = {
    children: [...group.children],
    groupPosition: group.position.clone(),
    groupRotation: group.rotation.clone(),
    childPositions: [visual.halo.position.clone(), visual.ring.position.clone(), visual.sphere.position.clone()],
    sphereGeometry: visual.sphere.geometry,
    sphereMaterial: visual.sphere.material,
    sphereColor: visual.sphere.material.color,
    sphereEmissive: visual.sphere.material.emissive,
    ringGeometry: visual.ring.geometry,
    ringMaterial: visual.ring.material,
    ringColor: visual.ring.material.color,
    haloMaterial: visual.halo.material,
    haloColor: visual.halo.material.color,
    haloTexture: visual.halo.material.map,
  };
  const stateBefore = structuredClone(state);

  applyNodeTheme(visual, state.status, DARK_THEME, true, false);
  applyNodeTheme(visual, state.status, LIGHT_THEME, false, true);
  applyNodeTheme(visual, state.status, DARK_THEME, true, false);
  applyNodeTheme(visual, state.status, LIGHT_THEME, true, true);

  assert.deepEqual(group.children, original.children);
  assert.deepEqual(group.position, original.groupPosition);
  assert.deepEqual(group.rotation.toArray(), original.groupRotation.toArray());
  assert.deepEqual(
    [visual.halo.position, visual.ring.position, visual.sphere.position],
    original.childPositions,
  );
  assert.equal(visual.sphere.geometry, original.sphereGeometry);
  assert.equal(visual.sphere.material, original.sphereMaterial);
  assert.equal(visual.sphere.material.color, original.sphereColor);
  assert.equal(visual.sphere.material.emissive, original.sphereEmissive);
  assert.equal(visual.ring.geometry, original.ringGeometry);
  assert.equal(visual.ring.material, original.ringMaterial);
  assert.equal(visual.ring.material.color, original.ringColor);
  assert.equal(visual.halo.material, original.haloMaterial);
  assert.equal(visual.halo.material.color, original.haloColor);
  assert.equal(visual.halo.material.map, original.haloTexture);
  assert.equal(visual.halo.material.map, texture);
  assert.deepEqual(state, stateBefore);
});

type ThemeGraph = Parameters<typeof applySceneTheme>[0];

interface SceneFixture {
  graph: ThemeGraph;
  scene: THREE.Scene;
  background: THREE.Color;
  ambient: THREE.AmbientLight;
  directional: THREE.DirectionalLight;
  resources: GraphThemeResources;
  calls: Record<string, number>;
  backgroundColors: string[];
}

function createSceneFixture(
  bloom: GraphThemeResources['bloom'] = { strength: 9, radius: 9, threshold: 9, enabled: true },
  output: GraphThemeResources['output'] = { enabled: true },
): SceneFixture {
  const scene = new THREE.Scene();
  const background = new THREE.Color('#102030');
  scene.background = background;
  const ambient = new THREE.AmbientLight('#000000', 0);
  const directional = new THREE.DirectionalLight('#000000', 0);
  const resources: GraphThemeResources = { ambient, directional, bloom, output };
  const calls: Record<string, number> = {};
  const backgroundColors: string[] = [];
  const count = (name: string): void => {
    calls[name] = (calls[name] ?? 0) + 1;
  };
  const forbidden = (name: string): (() => never) => () => {
    count(name);
    throw new Error(`applySceneTheme must not call ${name}`);
  };
  const graph = {
    scene: () => {
      count('scene');
      return scene;
    },
    backgroundColor: (color: string) => {
      count('backgroundColor');
      backgroundColors.push(color);
      return undefined;
    },
    camera: forbidden('camera'),
    graphData: forbidden('graphData'),
    d3Force: forbidden('d3Force'),
    cameraPosition: forbidden('cameraPosition'),
    controls: forbidden('controls'),
    rotation: forbidden('rotation'),
    lights: forbidden('lights'),
  } as unknown as ThemeGraph;
  return { graph, scene, background, ambient, directional, resources, calls, backgroundColors };
}

function assertNoGraphLifecycleCalls(calls: Record<string, number>): void {
  for (const name of ['camera', 'graphData', 'd3Force', 'cameraPosition', 'controls', 'rotation', 'lights']) {
    assert.equal(calls[name] ?? 0, 0, `${name} must not be touched by a theme update`);
  }
}

test('scene themes update appearance in place and synchronize Bloom and Output', () => {
  const fixture = createSceneFixture();
  const { graph, scene, background, ambient, directional, resources } = fixture;

  applySceneTheme(graph, resources, LIGHT_THEME, false);
  assert.equal(fixture.calls.scene, 1);
  assert.equal(fixture.calls.backgroundColor, 1);
  assert.equal(scene.background, background);
  assert.equal(colorHex(background), LIGHT_THEME.graph.background);
  assert.deepEqual(fixture.backgroundColors, [LIGHT_THEME.graph.background]);
  assert.equal(resources.ambient, ambient);
  assert.equal(resources.directional, directional);
  assert.equal(colorHex(ambient.color), LIGHT_THEME.graph.ambientLight.color);
  assert.equal(ambient.intensity, LIGHT_THEME.graph.ambientLight.intensity);
  assert.equal(colorHex(directional.color), LIGHT_THEME.graph.directionalLight.color);
  assert.equal(directional.intensity, LIGHT_THEME.graph.directionalLight.intensity);
  assert.equal(resources.bloom?.strength, LIGHT_THEME.graph.bloom.strength);
  assert.equal(resources.bloom?.radius, LIGHT_THEME.graph.bloom.radius);
  assert.equal(resources.bloom?.threshold, LIGHT_THEME.graph.bloom.threshold);
  assert.equal(resources.bloom?.enabled, false);
  assert.equal(resources.output?.enabled, false);
  assertNoGraphLifecycleCalls(fixture.calls);

  // Light mode keeps Bloom disabled even when the local glow toggle is on;
  // the pale scene background should not be brightened by post-processing.
  applySceneTheme(graph, resources, LIGHT_THEME, true);
  assert.equal(scene.background, background);
  assert.equal(colorHex(background), LIGHT_THEME.graph.background);
  assert.equal(resources.bloom?.strength, LIGHT_THEME.graph.bloom.strength);
  assert.equal(resources.bloom?.radius, LIGHT_THEME.graph.bloom.radius);
  assert.equal(resources.bloom?.threshold, LIGHT_THEME.graph.bloom.threshold);
  assert.equal(resources.bloom?.enabled, false);
  assert.equal(resources.output?.enabled, false);
  assertNoGraphLifecycleCalls(fixture.calls);

  // A dark theme restores its Bloom parameters after a light-theme update.
  applySceneTheme(graph, resources, DARK_THEME, true);
  assert.equal(scene.background, background);
  assert.equal(colorHex(background), DARK_THEME.graph.background);
  assert.equal(resources.bloom?.strength, DARK_THEME.graph.bloom.strength);
  assert.equal(resources.bloom?.radius, DARK_THEME.graph.bloom.radius);
  assert.equal(resources.bloom?.threshold, DARK_THEME.graph.bloom.threshold);
  assert.equal(resources.bloom?.enabled, true);
  assert.equal(resources.output?.enabled, true);
  assertNoGraphLifecycleCalls(fixture.calls);

  applySceneTheme(graph, resources, DARK_THEME, false);
  assert.equal(resources.bloom?.strength, DARK_THEME.graph.bloom.strength);
  assert.equal(resources.bloom?.enabled, false);
  assert.equal(resources.output?.enabled, false);
  assertNoGraphLifecycleCalls(fixture.calls);
});

test('scene themes degrade cleanly when either post-processing pass is missing', () => {
  const cases: Array<{
    bloom: GraphThemeResources['bloom'];
    output: GraphThemeResources['output'];
  }> = [
    { bloom: null, output: { enabled: true } },
    { bloom: { strength: 2, radius: 2, threshold: 2, enabled: true }, output: null },
    { bloom: null, output: null },
  ];

  for (const { bloom, output } of cases) {
    const fixture = createSceneFixture(bloom, output);
    assert.doesNotThrow(() => applySceneTheme(fixture.graph, fixture.resources, DARK_THEME, true));
    if (fixture.resources.bloom) assert.equal(fixture.resources.bloom.enabled, false);
    if (fixture.resources.output) assert.equal(fixture.resources.output.enabled, false);
    assert.equal(fixture.scene.background, fixture.background);
    assertNoGraphLifecycleCalls(fixture.calls);
  }
});
