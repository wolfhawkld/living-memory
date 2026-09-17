import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { calculateNodeFocus, type FocusPoint } from '../src/web/graph-focus.js';

function point(x: number, y: number, z: number): FocusPoint {
  return { x, y, z };
}

function assertFiniteFocus(result: ReturnType<typeof calculateNodeFocus>): void {
  assert.ok(Number.isFinite(result.distance));
  for (const coordinate of Object.values(result.position)) assert.ok(Number.isFinite(coordinate));
  for (const coordinate of Object.values(result.target)) assert.ok(Number.isFinite(coordinate));
}

test('focus moves a distant camera toward the node and keeps the target centered', () => {
  const target = point(12, -8, 4);
  const result = calculateNodeFocus(point(12, -8, 1004), target, 2);

  assert.equal(result.distance, 180);
  assert.deepEqual(result.target, target);
  assert.deepEqual(result.position, point(12, -8, 184));
  assert.ok(result.distance < 1000);
  assert.deepEqual(calculateNodeFocus(result.position, target, 2), result);
  assertFiniteFocus(result);
});

test('focus uses the node-safe lower bound when the camera is already close', () => {
  const target = point(-4, 3, 9);
  const result = calculateNodeFocus(point(-4, 3, 19), target, 5);

  assert.equal(result.distance, 40);
  assert.deepEqual(result.position, point(-4, 3, 49));
  assert.deepEqual(result.target, target);
  assertFiniteFocus(result);
});

test('focus projects the target to the center of a Three perspective camera', () => {
  const target = point(18, -7, 11);
  const result = calculateNodeFocus(point(-142, 53, 211), target, 3);
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 2_000);
  camera.position.set(result.position.x, result.position.y, result.position.z);
  camera.lookAt(result.target.x, result.target.y, result.target.z);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();

  const projected = new THREE.Vector3(target.x, target.y, target.z).project(camera);
  assert.ok(Math.abs(projected.x) < 1e-10);
  assert.ok(Math.abs(projected.y) < 1e-10);
  assertFiniteFocus(result);
});

test('focus handles coincident cameras and keeps 2D views on the original Z side', () => {
  const target = point(2, 4, -6);
  const coincident = calculateNodeFocus(target, target, 1);
  assert.equal(coincident.distance, 32);
  assert.deepEqual(coincident.position, point(2, 4, 26));

  const twoDimensional = calculateNodeFocus(point(2, 4, -106), target, 2, true);
  assert.ok(Math.abs(twoDimensional.distance - 100) < 1e-12);
  assert.ok(Math.abs(twoDimensional.position.x - 2) < 1e-12);
  assert.ok(Math.abs(twoDimensional.position.y - 4) < 1e-12);
  assert.ok(Math.abs(twoDimensional.position.z + 106) < 1e-12);
  assert.deepEqual(twoDimensional.target, target);
  assertFiniteFocus(coincident);
  assertFiniteFocus(twoDimensional);
});

test('focus rejects non-finite coordinates and non-positive radii', () => {
  assert.throws(() => calculateNodeFocus(point(Number.NaN, 0, 1), point(0, 0, 0), 1), /finite/);
  assert.throws(() => calculateNodeFocus(point(0, 0, 1), point(0, Number.POSITIVE_INFINITY, 0), 1), /finite/);
  assert.throws(() => calculateNodeFocus(point(0, 0, 1), point(0, 0, 0), 0), /positive/);
  assert.throws(() => calculateNodeFocus(point(0, 0, 1), point(0, 0, 0), -1), /positive/);
  assert.throws(() => calculateNodeFocus(point(0, 0, 1), point(0, 0, 0), Number.POSITIVE_INFINITY), /finite/);
});
