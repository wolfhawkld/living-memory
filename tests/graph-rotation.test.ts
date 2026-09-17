import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import {
  ROTATION_IDLE_MS,
  ROTATION_TURN_MS,
  createIdleRotationClock,
  rotateCameraClockwise,
  trackRotationActivity,
} from '../src/web/graph-rotation.ts';

const ROTATION_RATE = (2 * Math.PI) / ROTATION_TURN_MS;

function assertClose(actual: number, expected: number, tolerance = 1e-10): void {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${actual} to be within ${tolerance} of ${expected}`,
  );
}

function pointerEvent(type: string, pointerId: number): Event {
  const event = new Event(type);
  Object.defineProperty(event, 'pointerId', { value: pointerId });
  return event;
}

test('camera rotation changes only its orbit and keeps the focused point centered', () => {
  const target = { x: 4, y: -3, z: 7 };
  const position = { x: 14, y: 9, z: 7 };
  const rotated = rotateCameraClockwise(position, target, Math.PI / 2);

  assertClose(rotated.x, target.x);
  assert.equal(rotated.y, position.y);
  assertClose(rotated.z, target.z - 10);

  const beforeOffset = new THREE.Vector3(position.x - target.x, position.y - target.y, position.z - target.z);
  const afterOffset = new THREE.Vector3(rotated.x - target.x, rotated.y - target.y, rotated.z - target.z);
  assertClose(afterOffset.length(), beforeOffset.length());
  assertClose(afterOffset.y, beforeOffset.y);
  assertClose(Math.hypot(afterOffset.x, afterOffset.z), Math.hypot(beforeOffset.x, beforeOffset.z));

  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 2_000);
  camera.position.set(rotated.x, rotated.y, rotated.z);
  camera.lookAt(target.x, target.y, target.z);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  const projected = new THREE.Vector3(target.x, target.y, target.z).project(camera);
  assertClose(projected.x, 0, 1e-9);
  assertClose(projected.y, 0, 1e-9);
});

test('rotation uses elapsed time across frame rates and caps long or disabled gaps', () => {
  const run = (frameTimes: number[]): number => {
    const clock = createIdleRotationClock();
    return frameTimes.reduce((angle, now) => angle + clock.step(now, true), 0);
  };

  const sixtyFps = Array.from({ length: 61 }, (_, index) => (index * 1_000) / 60);
  const thirtyFps = Array.from({ length: 31 }, (_, index) => (index * 1_000) / 30);
  const expected = 1_000 * ROTATION_RATE;
  assertClose(run(sixtyFps), expected, 1e-12);
  assertClose(run(thirtyFps), expected, 1e-12);

  const capped = createIdleRotationClock();
  capped.step(0, true);
  assertClose(capped.step(1_000, true), 100 * ROTATION_RATE, 1e-12);

  const disabled = createIdleRotationClock();
  disabled.step(0, true);
  assert.equal(disabled.step(16, false), 0);
  assert.equal(disabled.step(1_000, true), 0, 'reenabling must not replay the disabled interval');
  assertClose(disabled.step(1_100, true), 100 * ROTATION_RATE, 1e-12);
});

test('manual activity pauses until the idle deadline and a held pointer blocks rotation', () => {
  assert.equal(ROTATION_IDLE_MS, 120_000);
  const clock = createIdleRotationClock();
  assert.equal(clock.step(0, true), 0);
  assert.ok(clock.step(50, true) > 0);

  clock.interact(100);
  clock.step(100, true);
  assert.equal(clock.step(100 + 119_000, true), 0);
  clock.interact(119_100);
  assert.equal(clock.step(119_100 + 1_000, true), 0, 'a later interaction must cancel the first deadline');
  assert.equal(clock.step(119_100 + ROTATION_IDLE_MS, true), 0);
  assert.ok(clock.step(119_100 + ROTATION_IDLE_MS + 100, true) > 0);

  clock.hold(7, 240_000);
  assert.equal(clock.step(241_000, true), 0);
  assert.equal(clock.step(241_100, true), 0);

  clock.release(7, 241_100);
  assert.equal(clock.step(241_100 + ROTATION_IDLE_MS, true), 0);
  assert.ok(clock.step(241_100 + ROTATION_IDLE_MS + 100, true) > 0);
});

test('page activity listeners cover input categories and cleanup detaches them', () => {
  for (const eventType of ['click', 'pointermove', 'keydown', 'wheel']) {
    const page = new EventTarget();
    const viewport = new EventTarget();
    const clock = createIdleRotationClock();
    let now = 100;
    const cleanup = trackRotationActivity(page, viewport, clock, () => now);

    clock.step(0, true);
    page.dispatchEvent(new Event(eventType));
    assert.equal(clock.step(now + ROTATION_IDLE_MS, true), 0, `${eventType} should reset idle time`);
    assert.ok(clock.step(now + ROTATION_IDLE_MS + 100, true) > 0, `${eventType} should eventually resume`);
    cleanup();
  }

  const page = new EventTarget();
  const viewport = new EventTarget();
  const clock = createIdleRotationClock();
  let now = 100;
  const cleanup = trackRotationActivity(page, viewport, clock, () => now);
  clock.step(0, true);
  cleanup();
  page.dispatchEvent(new Event('click'));
  assert.ok(clock.step(now, true) > 0, 'cleanup should remove page activity listeners');
});

test('pointer listeners and one clock survive a graph tracker remount', () => {
  const clock = createIdleRotationClock();
  let now = 1;
  const firstPage = new EventTarget();
  const firstViewport = new EventTarget();
  const stopFirst = trackRotationActivity(firstPage, firstViewport, clock, () => now);

  clock.step(0, true);
  firstPage.dispatchEvent(new Event('click'));
  stopFirst();

  const secondPage = new EventTarget();
  const secondViewport = new EventTarget();
  const stopSecond = trackRotationActivity(secondPage, secondViewport, clock, () => now);
  assert.equal(clock.step(ROTATION_IDLE_MS + 1, true), 0);
  assert.ok(clock.step(ROTATION_IDLE_MS + 101, true) > 0);

  now = ROTATION_IDLE_MS + 500;
  secondPage.dispatchEvent(new Event('keydown'));
  assert.equal(clock.step(now + ROTATION_IDLE_MS, true), 0);
  assert.ok(clock.step(now + ROTATION_IDLE_MS + 100, true) > 0);

  now += ROTATION_IDLE_MS + 200;
  secondPage.dispatchEvent(pointerEvent('pointerdown', 42));
  const heldFrame = now + ROTATION_IDLE_MS + 1_000;
  assert.equal(clock.step(heldFrame, true), 0);
  now = heldFrame + 1_000;
  secondViewport.dispatchEvent(pointerEvent('pointerup', 42));
  assert.equal(clock.step(now + ROTATION_IDLE_MS, true), 0);
  assert.ok(clock.step(now + ROTATION_IDLE_MS + 100, true) > 0);
  stopSecond();
});
