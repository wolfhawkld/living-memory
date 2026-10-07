import assert from 'node:assert/strict';
import test from 'node:test';
import { createGraphActivityController } from '../src/web/graph-activity.js';

function fixture(onFrame?: (now: number) => void) {
  let nextId = 0; let starts = 0; let stops = 0;
  const callbacks = new Map<number, (now: number) => void>();
  const queued = new Set<number>(); const cancelled: number[] = []; const frames: number[] = [];
  const controller = createGraphActivityController({
    requestFrame(callback) { const id = ++nextId; callbacks.set(id, callback); queued.add(id); return id; },
    cancelFrame(id) { queued.delete(id); cancelled.push(id); },
    onStart() { starts++; }, onStop() { stops++; },
    onFrame(now) { frames.push(now); onFrame?.(now); },
  });
  return { controller, queued, cancelled, frames, get starts() { return starts; }, get stops() { return stops; },
    fire(id: number, now = id) { queued.delete(id); callbacks.get(id)!(now); } };
}

test('initial true starts once and maintains exactly one frame; repeat sync is inert', () => {
  const f = fixture(); assert.equal(f.queued.size, 0);
  f.controller.setActive(true); f.controller.setActive(true);
  assert.equal(f.starts, 1); assert.deepEqual([...f.queued], [1]);
  f.fire(1, 12); assert.deepEqual(f.frames, [12]); assert.deepEqual([...f.queued], [2]);
  f.fire(1, 13); assert.deepEqual(f.frames, [12]); assert.deepEqual([...f.queued], [2]);
});

test('initial false stops the initially running library once without scheduling', () => {
  const f = fixture(); f.controller.setActive(false); f.controller.setActive(false);
  assert.equal(f.starts, 0); assert.equal(f.stops, 1); assert.equal(f.queued.size, 0);
  f.controller.setActive(true); assert.equal(f.starts, 1); assert.equal(f.queued.size, 1);
});

test('pause/resume invalidates late callbacks without clearing the new ticket', () => {
  const f = fixture(); f.controller.setActive(true); f.controller.setActive(false);
  assert.deepEqual(f.cancelled, [1]); assert.equal(f.queued.size, 0);
  f.controller.setActive(true); assert.deepEqual([...f.queued], [2]);
  f.fire(1); assert.deepEqual(f.frames, []); assert.deepEqual([...f.queued], [2]);
  f.fire(2); assert.deepEqual(f.frames, [2]); assert.deepEqual([...f.queued], [3]);
  assert.equal(f.starts, 2); assert.equal(f.stops, 1);
});

test('pausing inside a frame prevents the next frame', () => {
  const f = fixture(() => f.controller.setActive(false));
  f.controller.setActive(true); f.fire(1);
  assert.equal(f.queued.size, 0); assert.equal(f.stops, 1); assert.deepEqual(f.cancelled, []);
});

test('restarting inside a frame creates one new cycle and no old continuation', () => {
  const f = fixture(() => { f.controller.setActive(false); f.controller.setActive(true); });
  f.controller.setActive(true); f.fire(1);
  assert.deepEqual([...f.queued], [2]); assert.equal(f.starts, 2); assert.equal(f.stops, 1);
  f.fire(1); assert.deepEqual(f.frames, [1]); assert.deepEqual([...f.queued], [2]);
});

test('dispose inside frame is permanent and idempotent', () => {
  const f = fixture(() => f.controller.dispose()); f.controller.setActive(true); f.fire(1);
  f.controller.dispose(); f.controller.setActive(true); f.controller.setActive(false); f.fire(1);
  assert.equal(f.queued.size, 0); assert.equal(f.stops, 1); assert.equal(f.starts, 1);
  assert.deepEqual(f.frames, [1]);
});

test('dispose cancels a pending frame and inactive dispose does not repeat stop', () => {
  const f = fixture(); f.controller.setActive(true); f.controller.dispose(); f.controller.dispose(); f.fire(1);
  assert.deepEqual(f.cancelled, [1]); assert.equal(f.stops, 1); assert.deepEqual(f.frames, []);
  const inactive = fixture(); inactive.controller.setActive(false); inactive.controller.dispose();
  assert.equal(inactive.stops, 1); assert.equal(inactive.queued.size, 0);
});

test('throwing frame leaves no continuation and a later restart has only one loop', () => {
  const f = fixture(() => { throw new Error('frame failed'); });
  f.controller.setActive(true); assert.throws(() => f.fire(1), /frame failed/);
  assert.equal(f.queued.size, 0);
  f.controller.setActive(false); f.controller.setActive(true);
  assert.deepEqual([...f.queued], [2]);
});
