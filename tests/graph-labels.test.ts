import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import {
  chineseMainName,
  labelRectsOverlap,
  placeLabelCandidates,
  projectGraphLabelPoint,
  shortGraphLabel,
} from '../src/web/graph-labels.js';

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
