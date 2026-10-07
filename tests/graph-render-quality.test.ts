import assert from 'node:assert/strict';
import test from 'node:test';
import { Vector2, type WebGLRenderer } from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { Pass } from 'three/examples/jsm/postprocessing/Pass.js';
import { graphDisplayPreferenceKey } from '../src/web/graph-display-preference.js';
import { applyGraphPixelRatio, graphRenderQualityKey, parseGraphRenderQuality, readGraphRenderQuality,
  resolveGraphPixelRatio, writeGraphRenderQuality, type GraphRenderQuality } from '../src/web/graph-render-quality.js';

test('quality parser accepts exact choices and defaults corrupt values to standard', () => {
  assert.equal(parseGraphRenderQuality('low'), 'low');
  for (const value of ['standard', 'LOW', ' low', '', null, undefined, true, 1, {}, []]) {
    assert.equal(parseGraphRenderQuality(value), 'standard');
  }
});

test('DPR is capped per quality while preserving positive ratios below one', () => {
  for (const [dpr, standard, low] of [[2, 2, 1], [3, 2, 1], [1, 1, 1], [0.75, 0.75, 0.75], [1.5, 1.5, 1]]) {
    assert.equal(resolveGraphPixelRatio('standard', dpr), standard);
    assert.equal(resolveGraphPixelRatio('low', dpr), low);
  }
  for (const dpr of [0, -1, NaN, Infinity, -Infinity, '2', null, undefined, {}, true]) {
    assert.equal(resolveGraphPixelRatio('standard', dpr), 1);
    assert.equal(resolveGraphPixelRatio('low', dpr), 1);
  }
});

test('keys isolate account, source, local mode and display preferences', () => {
  const scopes: Array<[string | undefined, string]> = [
    [undefined, 'source'], ['local', 'source'], ['a', 'source'], ['b', 'source'],
    ['a', 'other'], ['a:b', 'c'], ['a', 'b:c'], ['中文/"[]', 'source'],
  ];
  const keys = scopes.map(([account, source]) => graphRenderQualityKey(account, source));
  assert.equal(new Set(keys).size, scopes.length);
  for (const [account, source] of scopes) {
    assert.notEqual(graphRenderQualityKey(account, source), graphDisplayPreferenceKey(account, source));
  }
  assert.equal(graphRenderQualityKey('a', 'source'), graphRenderQualityKey('a', 'source'));
  assert.equal(graphRenderQualityKey(undefined, ''), null);
  assert.equal(graphRenderQualityKey('a', ' \n'), null);
  assert.equal(graphRenderQualityKey('', 'source'), null);
});

test('only low persists; standard removes its scope and corrupt reads do not rewrite', () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); } };
  const a = graphRenderQualityKey('a', 'source')!;
  const b = graphRenderQualityKey('b', 'source')!;
  const other = graphRenderQualityKey('a', 'other')!;
  assert.equal(readGraphRenderQuality(a, storage), 'standard');
  for (const key of [a, b, other]) assert.equal(writeGraphRenderQuality(key, 'low', storage), true);
  assert.equal(values.get(a), 'low');
  assert.equal(readGraphRenderQuality(a, storage), 'low');
  assert.equal(writeGraphRenderQuality(a, 'standard', storage), true);
  assert.equal(values.has(a), false);
  assert.equal(readGraphRenderQuality(b, storage), 'low');
  assert.equal(readGraphRenderQuality(other, storage), 'low');
  values.set(a, '{"quality":"low"}');
  assert.equal(readGraphRenderQuality(a, storage), 'standard');
  assert.equal(values.get(a), '{"quality":"low"}');
  assert.equal(writeGraphRenderQuality(a, 'bad' as GraphRenderQuality, storage), false);
});

test('storage failures are contained and null keys never access storage or getters', () => {
  let accesses = 0;
  const failing = { getItem() { accesses++; throw new Error('blocked'); },
    setItem() { accesses++; throw new Error('full'); },
    removeItem() { accesses++; throw new Error('blocked'); } };
  assert.equal(readGraphRenderQuality(null, failing), 'standard');
  assert.equal(writeGraphRenderQuality(null, 'low', failing), false);
  assert.equal(writeGraphRenderQuality(null, 'standard', failing), false);
  assert.equal(accesses, 0);
  assert.equal(readGraphRenderQuality('key', failing), 'standard');
  assert.equal(writeGraphRenderQuality('key', 'low', failing), false);
  assert.equal(writeGraphRenderQuality('key', 'standard', failing), false);
  assert.equal(accesses, 3);
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window'); let getters = 0;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    get localStorage() { getters++; throw new Error('blocked'); },
  } });
  try {
    assert.equal(readGraphRenderQuality(null), 'standard');
    assert.equal(writeGraphRenderQuality(null, 'low'), false);
    assert.equal(writeGraphRenderQuality(null, 'standard'), false);
    assert.equal(getters, 0);
    assert.equal(readGraphRenderQuality('key'), 'standard');
    assert.equal(writeGraphRenderQuality('key', 'low'), false);
    assert.equal(writeGraphRenderQuality('key', 'standard'), false);
    assert.equal(getters, 3);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('real EffectComposer buffers and passes follow quality through reset and resize without changing CSS size', () => {
  let ratio = 3; let width = 640; let height = 360;
  const renderer = {
    getPixelRatio: () => ratio,
    getSize: (target: Vector2) => target.set(width, height),
    setPixelRatio: (next: number) => { ratio = next; },
  };
  const composer = new EffectComposer(renderer as unknown as WebGLRenderer);
  class SizePass extends Pass {
    size: [number, number] = [0, 0];
    override setSize(w: number, h: number) { this.size = [w, h]; }
  }
  const pass = new SizePass(); composer.addPass(pass);
  const check = (expectedRatio: number) => {
    assert.equal(renderer.getPixelRatio(), expectedRatio);
    assert.deepEqual(renderer.getSize(new Vector2()).toArray(), [width, height]);
    for (const target of [composer.renderTarget1, composer.renderTarget2]) {
      assert.equal(target.width, width * expectedRatio);
      assert.equal(target.height, height * expectedRatio);
    }
    assert.deepEqual(pass.size, [width * expectedRatio, height * expectedRatio]);
  };
  try {
    check(3);
    applyGraphPixelRatio(renderer, composer, resolveGraphPixelRatio('standard', 3)); check(2);
    applyGraphPixelRatio(renderer, composer, resolveGraphPixelRatio('low', 3)); check(1);
    composer.reset(); composer.setSize(width, height); check(1);
    width = 800; height = 500; composer.setSize(width, height); check(1);
    applyGraphPixelRatio(renderer, composer, resolveGraphPixelRatio('standard', 3)); check(2);
    composer.reset(); composer.setSize(width, height); check(2);
    applyGraphPixelRatio(renderer, composer, resolveGraphPixelRatio('low', 0.75)); check(0.75);
  } finally { composer.dispose(); }
});
