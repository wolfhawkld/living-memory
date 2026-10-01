import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import {
  chineseMainName,
  createGraphLabels,
  estimateGraphLabelWidth,
  labelRectsOverlap,
  placeLabelCandidates,
  projectGraphLabelPoint,
  shortGraphLabel,
} from '../src/web/graph-labels.js';
import { DARK_THEME, type ThemePalette } from '../src/web/theme-palette.js';

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly ownerDocument: FakeDocument;
  parentNode: FakeElement | null = null;
  className = '';
  textContent = '';
  title = '';

  constructor(ownerDocument: FakeDocument) {
    this.ownerDocument = ownerDocument;
  }

  appendChild(child: FakeElement): FakeElement {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  remove(): void {
    if (!this.parentNode) return;
    const index = this.parentNode.children.indexOf(this);
    if (index >= 0) this.parentNode.children.splice(index, 1);
    this.parentNode = null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getContext(_contextId: string): CanvasRenderingContext2D | null {
    return null;
  }
}

class FakeCanvasElement extends FakeElement {
  override getContext(_contextId: string): CanvasRenderingContext2D | null {
    return {
      font: '',
      measureText: (text: string) => ({ width: estimateGraphLabelWidth(text) }),
    } as unknown as CanvasRenderingContext2D;
  }
}

class FakeDocument {
  createElement(tagName: string): FakeElement {
    return tagName === 'canvas' ? new FakeCanvasElement(this) : new FakeElement(this);
  }
}

function alternativeLabelTheme(): ThemePalette {
  return {
    ...DARK_THEME,
    id: 'light',
    graph: {
      ...DARK_THEME.graph,
      label: {
        ...DARK_THEME.graph.label,
        border: 'rgb(16, 32, 48)',
        background: 'rgb(240, 244, 248)',
        shadow: '0 2px 8px rgb(120, 130, 140)',
        text: 'rgb(20, 30, 40)',
      },
      labelEmphasized: {
        ...DARK_THEME.graph.labelEmphasized,
        border: 'rgb(24, 48, 72)',
        background: 'rgb(255, 255, 255)',
        shadow: '0 3px 14px rgb(100, 110, 120)',
        text: 'rgb(10, 20, 30)',
      },
    },
  };
}

test('short labels keep a Chinese main name when the title explains an English term', () => {
  assert.equal(chineseMainName('主成分分析（PCA）'), '主成分分析');
  assert.equal(shortGraphLabel({ title: '主成分分析（PCA）', aliases: ['PCA'] }), '主成分分析');
  assert.equal(chineseMainName('概率分布 (distribution)'), '概率分布');
  assert.equal(chineseMainName('矩阵 (3×3)'), null);
});
test('short labels use an existing compact alias and never invent an abbreviation', () => {
  assert.equal(shortGraphLabel({ title: 'Principal Component Analysis', aliases: ['PCA'] }), 'PCA');
  assert.equal(shortGraphLabel({ title: 'An unusually long concept title', aliases: [] }), 'An unusually long concept title');
  assert.equal(shortGraphLabel({ title: 'PCA', aliases: ['Principal Component Analysis'] }), 'PCA');
});

test('candidate placement respects priority, bounds, and a breathing-room gap', () => {
  const placements = placeLabelCandidates([
    { id: 'selected', x: 120, y: 100, width: 90, height: 22, priority: 4 },
    { id: 'neighbor', x: 120, y: 100, width: 90, height: 22, priority: 2 },
    { id: 'context', x: 280, y: 100, width: 70, height: 22, priority: 1 },
  ], 360, 220, 3);

  assert.equal(placements[0]?.id, 'selected');
  assert.equal(placements.length, 3);
  for (const placement of placements) {
    assert.ok(placement.left >= 0);
    assert.ok(placement.top >= 0);
    assert.ok(placement.left + placement.width <= 360);
    assert.ok(placement.top + placement.height <= 220);
  }
  for (let left = 0; left < placements.length; left += 1) {
    for (let right = left + 1; right < placements.length; right += 1) {
      assert.equal(labelRectsOverlap(placements[left], placements[right], 6), false);
    }
  }
});

test('projection rejects points behind the camera and returns layer pixels for visible points', () => {
  const camera = new THREE.PerspectiveCamera(60, 2, 0.1, 1000);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();

  assert.equal(projectGraphLabelPoint({ x: 0, y: 0, z: 20 }, camera, 800, 400), null);
  const projected = projectGraphLabelPoint({ x: 0, y: 0, z: 0 }, camera, 800, 400);
  assert.ok(projected);
  assert.ok(Math.abs(projected.x - 400) < 1e-9);
  assert.ok(Math.abs(projected.y - 200) < 1e-9);
});

test('2D projection accepts missing z and ignores stale 3D depth', () => {
  const camera = new THREE.PerspectiveCamera(60, 2, 0.1, 1000);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();

  const missingZ = projectGraphLabelPoint({ x: 0, y: 0 }, camera, 800, 400, true);
  const staleZ = projectGraphLabelPoint({ x: 0, y: 0, z: 700 }, camera, 800, 400, true);
  assert.ok(missingZ);
  assert.ok(staleZ);
  assert.deepEqual(missingZ, staleZ);
  assert.ok(Math.abs(missingZ.x - 400) < 1e-9);
  assert.ok(Math.abs(missingZ.y - 200) < 1e-9);
});

test('2D projection skips invalid xy while 3D still rejects invalid z', () => {
  const camera = new THREE.PerspectiveCamera(60, 2, 0.1, 1000);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();

  assert.equal(projectGraphLabelPoint({ x: Number.NaN, y: 0 }, camera, 800, 400, true), null);
  assert.equal(projectGraphLabelPoint({ x: 0, y: Number.POSITIVE_INFINITY }, camera, 800, 400, true), null);
  assert.equal(projectGraphLabelPoint({ x: 0, y: 0, z: Number.NaN }, camera, 800, 400), null);
  assert.equal(projectGraphLabelPoint({ x: 0, y: 0 }, camera, 800, 400), null);
});

test('graph label theme updates reuse DOM and replace cached colors', async () => {
  const documentRef = new FakeDocument();
  const host = new FakeElement(documentRef);
  const layer = createGraphLabels(host as unknown as HTMLElement);
  const camera = new THREE.OrthographicCamera(-400, 400, 220, -220, 0.1, 1000);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  const nodes = [{ id: 'same-label', title: 'Same label', x: 0, y: 0, z: 0 }];
  const update = (theme?: ThemePalette) => layer.update({
    nodes,
    camera,
    width: 800,
    height: 440,
    theme,
    twoDimensional: true,
  });
  const lightTheme = alternativeLabelTheme();

  update();
  assert.equal(host.children.length, 1);
  const label = host.children[0]?.children[0];
  assert.ok(label);
  const initialGeometry = {
    left: label.style.left,
    top: label.style.top,
    width: label.style.width,
    height: label.style.height,
    text: label.textContent,
    priority: label.dataset.priority,
  };
  assert.equal(label.style.color, DARK_THEME.graph.label.text);
  assert.equal(label.style.background, DARK_THEME.graph.label.background);
  assert.equal(label.style.border, `1px solid ${DARK_THEME.graph.label.border}`);

  await new Promise((resolve) => setTimeout(resolve, 45));
  update(lightTheme);
  assert.equal(host.children[0]?.children[0], label, 'theme updates must reuse the label element');
  assert.deepEqual({
    left: label.style.left,
    top: label.style.top,
    width: label.style.width,
    height: label.style.height,
    text: label.textContent,
    priority: label.dataset.priority,
  }, initialGeometry, 'theme updates must preserve geometry, title, and priority');
  assert.equal(label.style.color, lightTheme.graph.label.text);
  assert.equal(label.style.background, lightTheme.graph.label.background);
  assert.equal(label.style.border, `1px solid ${lightTheme.graph.label.border}`);
  assert.notEqual(label.style.color, DARK_THEME.graph.label.text, 'the style cache must not retain the old text color');
  assert.notEqual(label.style.background, DARK_THEME.graph.label.background, 'the style cache must not retain the old background');

  await new Promise((resolve) => setTimeout(resolve, 45));
  update();
  assert.equal(host.children[0]?.children[0], label, 'switching back must keep the same label element');
  assert.equal(label.style.color, DARK_THEME.graph.label.text);
  assert.equal(label.style.background, DARK_THEME.graph.label.background);
  assert.equal(label.style.border, `1px solid ${DARK_THEME.graph.label.border}`);

  layer.dispose();
  assert.equal(host.children.length, 0, 'dispose must remove the label layer');
  update(lightTheme);
  assert.equal(host.children.length, 0, 'disposed layers must ignore later updates');
});
