import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { TrackballControls } from 'three/examples/jsm/controls/TrackballControls.js';
import {
  ROTATION_IDLE_MS,
  ROTATION_TURN_MS,
  createIdleRotationClock,
  rotateCameraClockwise,
  readRotationStatus,
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

test('focus and visibility notifications do not restart the manual inactivity deadline', () => {
  const clock = createIdleRotationClock();
  const page = new EventTarget();
  const viewport = new EventTarget();
  let now = 0;
  const cleanup = trackRotationActivity(page, viewport, clock, () => now);
  try {
    viewport.dispatchEvent(new Event('focus'));
    page.dispatchEvent(new Event('visibilitychange'));
    clock.step(0, true);
    assert.ok(clock.step(16, true) > 0, 'initial focus must not defer startup for two minutes');
    now = 100;
    page.dispatchEvent(new Event('click'));
    now = 119_100;
    viewport.dispatchEvent(new Event('blur'));
    viewport.dispatchEvent(new Event('focus'));
    page.dispatchEvent(new Event('visibilitychange'));
    assert.equal(clock.inspect(now).remainingMs, 1_000);
    clock.step(120_100, true);
    assert.ok(clock.step(120_116, true) > 0);
  } finally { cleanup(); }
});

test('unchanged pointer notifications do not postpone rotation but a real movement does', () => {
  const clock = createIdleRotationClock();
  const page = new EventTarget();
  const viewport = new EventTarget();
  let now = 100;
  const cleanup = trackRotationActivity(page, viewport, clock, () => now);
  const move = (x: number) => {
    const event = pointerEvent('pointermove', 1);
    Object.defineProperties(event, {
      clientX: { value: x }, clientY: { value: 20 }, screenX: { value: x }, screenY: { value: 40 },
    });
    page.dispatchEvent(event);
  };
  try {
    move(10);
    now = 119_100;
    move(10);
    assert.equal(clock.inspect(now).remainingMs, 1_000);
    move(11);
    assert.equal(clock.inspect(now).remainingMs, 120_000);
  } finally { cleanup(); }
});

test('visible rotation status follows the gate and an explicit start clears the wait', () => {
  const clock = createIdleRotationClock();
  const view = { enabled: true, ready: true, twoDimensional: false, hidden: false, paused: false };
  clock.interact(1_000);
  assert.deepEqual(readRotationStatus(clock, 1_000, view), { kind: 'waiting', text: '旋转暂停 · 2:00 后恢复' });
  assert.equal(readRotationStatus(clock, 61_000, view).text, '旋转暂停 · 1:00 后恢复');
  assert.equal(readRotationStatus(clock, 121_000, view).kind, 'rotating');
  clock.interact(121_001);
  clock.resume();
  assert.equal(readRotationStatus(clock, 121_001, view).kind, 'rotating');
  assert.equal(clock.step(121_001, true), 0);
  assert.ok(clock.step(121_017, true) > 0);
  assert.equal(readRotationStatus(clock, 121_017, { ...view, enabled: false }).kind, 'disabled');
  assert.equal(readRotationStatus(clock, 121_017, { ...view, ready: false }).kind, 'preparing');
  assert.equal(readRotationStatus(clock, 121_017, { ...view, paused: true }).kind, 'paused');
  assert.equal(readRotationStatus(clock, 121_017, { ...view, twoDimensional: true }).kind, 'flat');
  clock.hold(1, 122_000);
  clock.resume();
  assert.equal(readRotationStatus(clock, 122_000, view).kind, 'holding');
  assert.equal(clock.step(122_100, true), 0, 'an explicit start must not interrupt a held gesture');
});

test('explicit start is not immediately cancelled by a stationary pointer notification', () => {
  const clock = createIdleRotationClock();
  const page = new EventTarget();
  const viewport = new EventTarget();
  let now = 0;
  const cleanup = trackRotationActivity(page, viewport, clock, () => now);
  const pointer = (type: string) => {
    const event = pointerEvent(type, 1);
    Object.defineProperties(event, {
      clientX: { value: 10 }, clientY: { value: 20 }, screenX: { value: 10 }, screenY: { value: 40 },
    });
    return event;
  };
  try {
    page.dispatchEvent(pointer('pointerdown'));
    now = 50;
    viewport.dispatchEvent(pointer('pointerup'));
    page.dispatchEvent(new Event('click'));
    clock.resume(); // The button's explicit handler runs after capture listeners.
    now = 66;
    page.dispatchEvent(pointer('pointermove'));
    assert.deepEqual(clock.inspect(now), { holding: false, remainingMs: 0 });
    clock.step(now, true);
    assert.ok(clock.step(now + 16, true) > 0);
  } finally { cleanup(); }
});

test('the installed Trackball controller preserves camera rotation over repeated render updates', () => {
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 2_000);
  camera.position.set(10, 50, 300);
  // No DOM element means no browser, WebGL renderer, or event listeners.
  const controls = new TrackballControls(camera, null);
  controls.target.set(10, 0, 0);
  const clock = createIdleRotationClock();
  const initial = camera.position.clone();
  const radius = initial.distanceTo(controls.target);
  for (let frame = 0; frame <= 600; frame += 1) {
    controls.update();
    const angle = clock.step(frame * 1_000 / 60, true);
    const position = rotateCameraClockwise(camera.position, controls.target, angle);
    camera.position.set(position.x, position.y, position.z);
    camera.lookAt(controls.target);
  }
  controls.update();
  assert.ok(camera.position.distanceTo(initial) > 50, 'the controller must not restore the original camera');
  assertClose(camera.position.distanceTo(controls.target), radius, 1e-8);
  camera.updateMatrixWorld();
  const target = controls.target.clone().project(camera);
  assertClose(target.x, 0);
  assertClose(target.y, 0);
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
