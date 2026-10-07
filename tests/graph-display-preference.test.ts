import assert from 'node:assert/strict';
import test from 'node:test';
import { graphDisplayPreferenceKey, parseGraphLimitPreference, readGraphLimitPreference, writeGraphLimitPreference,
  type GraphLimitPreference } from '../src/web/graph-display-preference.js';

function memoryStorage() {
  const values = new Map<string, string>(); let reads = 0; let writes = 0; let removals = 0;
  return { values, get reads() { return reads; }, get writes() { return writes; }, get removals() { return removals; },
    storage: { getItem(key: string) { reads++; return values.get(key) ?? null; },
      setItem(key: string, value: string) { writes++; values.set(key, value); },
      removeItem(key: string) { removals++; values.delete(key); } } };
}

test('limits accept only fixed numbers or their exact decimal strings', () => {
  for (const value of [20, 50, 100, 200, 300] as const) {
    assert.equal(parseGraphLimitPreference(value), value);
    assert.equal(parseGraphLimitPreference(String(value)), value);
  }
  for (const value of [undefined, null, false, true, {}, [], '', 'server', '020', '20.0', '+20', ' 20', '20 ', '2e1', '0x14', 0, 21, 301, Infinity, NaN]) {
    assert.equal(parseGraphLimitPreference(value), 'server');
  }
});

test('keys isolate accounts, sources, local mode and delimiter-like identities', () => {
  const combinations: Array<[string | undefined, string]> = [
    [undefined, 'source'], ['local', 'source'], ['account-a', 'source'], ['account-b', 'source'],
    ['account-a', 'other-source'], ['a:b', 'c'], ['a', 'b:c'], ['中文/"[]', 'source/"[]'],
  ];
  const keys = combinations.map(([account, source]) => graphDisplayPreferenceKey(account, source));
  assert.equal(new Set(keys).size, combinations.length);
  assert.equal(graphDisplayPreferenceKey('account-a', 'source'), graphDisplayPreferenceKey('account-a', 'source'));
  assert.equal(graphDisplayPreferenceKey(undefined, ''), null);
  assert.equal(graphDisplayPreferenceKey('account-a', ' \n'), null);
  assert.equal(graphDisplayPreferenceKey('', 'source'), null);
});

test('fixed preferences persist per account and source, and server removes only that scope', () => {
  const fixture = memoryStorage(); const a = graphDisplayPreferenceKey('account-a', 'source')!;
  const b = graphDisplayPreferenceKey('account-b', 'source')!;
  const other = graphDisplayPreferenceKey('account-a', 'other-source')!;
  assert.equal(readGraphLimitPreference(a, fixture.storage), 'server');
  assert.equal(writeGraphLimitPreference(a, 100, fixture.storage), true);
  assert.equal(writeGraphLimitPreference(b, 20, fixture.storage), true);
  assert.equal(writeGraphLimitPreference(other, 300, fixture.storage), true);
  assert.equal(fixture.values.get(a), '100');
  assert.equal(readGraphLimitPreference(a, fixture.storage), 100);
  assert.equal(readGraphLimitPreference(b, fixture.storage), 20);
  assert.equal(readGraphLimitPreference(other, fixture.storage), 300);
  assert.equal(writeGraphLimitPreference(a, 'server', fixture.storage), true);
  assert.equal(fixture.values.has(a), false);
  assert.equal(readGraphLimitPreference(a, fixture.storage), 'server');
  assert.equal(readGraphLimitPreference(b, fixture.storage), 20);
  assert.equal(fixture.removals, 1);
});

test('corrupt values and storage exceptions fall back without modifying persisted data', () => {
  const fixture = memoryStorage(); fixture.values.set('key', '{"limit":300}');
  assert.equal(readGraphLimitPreference('key', fixture.storage), 'server');
  assert.equal(fixture.writes, 0); assert.equal(fixture.removals, 0);
  assert.equal(readGraphLimitPreference('key', { getItem() { throw new Error('blocked'); } }), 'server');
  const failures = { setItem() { throw new Error('full'); }, removeItem() { throw new Error('blocked'); } };
  assert.equal(writeGraphLimitPreference('key', 50, failures), false);
  assert.equal(writeGraphLimitPreference('key', 'server', failures), false);
  assert.equal(writeGraphLimitPreference('key', '20' as unknown as GraphLimitPreference, fixture.storage), false);
  assert.equal(fixture.values.get('key'), '{"limit":300}');
});

test('null keys never touch injected storage or default window.localStorage getters', () => {
  const fixture = memoryStorage();
  assert.equal(readGraphLimitPreference(null, fixture.storage), 'server');
  assert.equal(writeGraphLimitPreference(null, 20, fixture.storage), false);
  assert.equal(writeGraphLimitPreference(null, 'server', fixture.storage), false);
  assert.equal(fixture.reads + fixture.writes + fixture.removals, 0);
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window'); let getters = 0;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { get localStorage() { getters++; throw new Error('blocked'); } } });
  try {
    assert.equal(readGraphLimitPreference(null), 'server');
    assert.equal(writeGraphLimitPreference(null, 100), false);
    assert.equal(getters, 0);
    assert.equal(readGraphLimitPreference('key'), 'server');
    assert.equal(writeGraphLimitPreference('key', 200), false);
    assert.equal(writeGraphLimitPreference('key', 'server'), false);
    assert.equal(getters, 3);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
