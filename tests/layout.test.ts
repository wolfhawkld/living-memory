import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectLayout, isFiniteLayoutPosition } from '../src/shared/layout.ts';

test('accepts finite numeric coordinates, including zero, negative, and large values', () => {
  assert.equal(
    isFiniteLayoutPosition({ x: 0, y: -12.5, z: Number.MAX_VALUE }),
    true,
  );
});

test('rejects missing, null, non-numeric, and non-finite coordinates', () => {
  assert.equal(isFiniteLayoutPosition(null), false);
  assert.equal(isFiniteLayoutPosition(undefined), false);
  assert.equal(isFiniteLayoutPosition({ x: 1, y: 2 }), false);
  assert.equal(isFiniteLayoutPosition({ x: '1', y: 2, z: 3 }), false);
  assert.equal(isFiniteLayoutPosition({ x: Number.NaN, y: 2, z: 3 }), false);
  assert.equal(isFiniteLayoutPosition({ x: 1, y: Number.POSITIVE_INFINITY, z: 3 }), false);
  assert.equal(isFiniteLayoutPosition({ x: 1, y: 2, z: Number.NEGATIVE_INFINITY }), false);
  assert.equal(isFiniteLayoutPosition([1, 2, 3]), false);
});

test('keeps valid entries and reports invalid IDs without coercing values', () => {
  const result = inspectLayout({
    origin: { x: 0, y: -4, z: 8 },
    missing: { x: 1, y: 2 },
    nan: { x: Number.NaN, y: 2, z: 3 },
    infinity: { x: 1, y: Number.POSITIVE_INFINITY, z: 3 },
    stringValue: { x: '1', y: 2, z: 3 },
  });

  assert.deepEqual(result, {
    layout: { origin: { x: 0, y: -4, z: 8 } },
    invalidIds: ['missing', 'nan', 'infinity', 'stringValue'],
  });
});

test('rejects non-ordinary top-level values', () => {
  assert.equal(inspectLayout(null), null);
  assert.equal(inspectLayout([]), null);
  assert.equal(inspectLayout(new Date()), null);

  const customPrototype = Object.create({ inherited: { x: 1, y: 2, z: 3 } });
  customPrototype.node = { x: 1, y: 2, z: 3 };
  assert.equal(inspectLayout(customPrototype), null);
});

test('accepts 10000 entries and rejects larger layouts', () => {
  const entries = Array.from({ length: 10_000 }, (_, index) => [
    `node-${index}`,
    { x: index, y: -index, z: 0 },
  ] as const);
  const atLimit = inspectLayout(Object.fromEntries(entries));

  assert.ok(atLimit);
  assert.equal(atLimit.invalidIds.length, 0);
  assert.deepEqual(atLimit.layout['node-9999'], { x: 9999, y: -9999, z: 0 });

  const overLimit = inspectLayout(
    Object.fromEntries([...entries, ['node-10000', { x: 0, y: 0, z: 0 }]]),
  );
  assert.equal(overLimit, null);
});

test('preserves special IDs without changing the output prototype', () => {
  const input = Object.fromEntries([
    ['__proto__', { x: 1, y: 0, z: -1 }],
    ['constructor', { x: 2, y: 0, z: -2 }],
  ]);
  const result = inspectLayout(input);

  assert.ok(result);
  assert.equal(Object.getPrototypeOf(result.layout), Object.prototype);
  assert.equal(Object.prototype.hasOwnProperty.call(result.layout, '__proto__'), true);
  assert.deepEqual(result.layout['__proto__'], { x: 1, y: 0, z: -1 });
  assert.deepEqual(result.layout.constructor, { x: 2, y: 0, z: -2 });
  assert.equal((Object.prototype as Record<string, unknown>).polluted, undefined);
});
