import assert from 'node:assert/strict';
import test from 'node:test';
import { collectGraphLayout, graphNodePosition } from '../src/web/graph-position.js';

test('2D positions require finite xy and always normalize z to zero', () => {
  assert.deepEqual(graphNodePosition({ x: 4, y: -3 }, true), { x: 4, y: -3, z: 0 });
  assert.deepEqual(graphNodePosition({ x: 4, y: -3, z: 999 }, true), { x: 4, y: -3, z: 0 });
  assert.deepEqual(graphNodePosition({ x: 4, y: -3, z: Number.NaN }, true), { x: 4, y: -3, z: 0 });
  assert.equal(graphNodePosition({ x: Number.NaN, y: 0, z: 0 }, true), null);
  assert.equal(graphNodePosition({ x: 0, y: Number.POSITIVE_INFINITY, z: 0 }, true), null);
});

test('3D positions require finite xyz and preserve a valid position', () => {
  assert.deepEqual(graphNodePosition({ x: 1.5, y: -2, z: 3 }, false), { x: 1.5, y: -2, z: 3 });
  assert.equal(graphNodePosition({ x: 1, y: 2 }, false), null);
  assert.equal(graphNodePosition({ x: 1, y: 2, z: Number.NaN }, false), null);
  assert.equal(graphNodePosition({ x: 1, y: 2, z: Number.NEGATIVE_INFINITY }, false), null);
});

test('2D collection never persists a temporary flat layout', () => {
  assert.deepEqual(collectGraphLayout([
    { id: 'flat', x: 1, y: 2, z: 300 },
    { id: 'missing-z', x: 3, y: 4 },
  ], true), {});
});

test('3D collection keeps finite nodes, skips invalid coordinates, and protects ids', () => {
  const layout = collectGraphLayout([
    { id: 'valid', x: 1, y: 2, z: 3 },
    { id: 'missing-z', x: 4, y: 5 },
    { id: 'bad-x', x: Number.NaN, y: 2, z: 3 },
    { id: '__proto__', x: -1, y: -2, z: -3 },
  ]);

  assert.deepEqual(layout, Object.fromEntries([
    ['valid', { x: 1, y: 2, z: 3 }],
    ['__proto__', { x: -1, y: -2, z: -3 }],
  ]));
  assert.deepEqual(Object.getPrototypeOf(layout), Object.prototype);
  assert.deepEqual(layout['__proto__'], { x: -1, y: -2, z: -3 });
});
