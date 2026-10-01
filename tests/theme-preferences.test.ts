import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createThemePreferences,
  DEFAULT_THEME_SNAPSHOT,
  normalizeThemePreference,
  resolveTheme,
  themeStorageKey,
  type ThemeStorage,
} from '../src/web/theme-preferences.js';

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  let reads = 0;
  let writes = 0;
  const storage: ThemeStorage = {
    getItem(key) {
      reads += 1;
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      writes += 1;
      values.set(key, value);
    },
  };
  return {
    storage,
    values,
    get reads() { return reads; },
    get writes() { return writes; },
  };
}

test('keys, normalization, resolution, and the default snapshot are stable', () => {
  assert.equal(themeStorageKey(null), 'living-memory.theme.v1:anonymous');
  assert.equal(themeStorageKey('anonymous'), 'living-memory.theme.v1:user:anonymous');
  assert.equal(themeStorageKey('a/b?中文'), 'living-memory.theme.v1:user:a%2Fb%3F%E4%B8%AD%E6%96%87');
  assert.notEqual(themeStorageKey(null), themeStorageKey('anonymous'));

  assert.equal(normalizeThemePreference('dark'), 'dark');
  assert.equal(normalizeThemePreference('light'), 'light');
  assert.equal(normalizeThemePreference('system'), 'system');
  assert.equal(normalizeThemePreference(''), 'dark');
  assert.equal(normalizeThemePreference('sepia'), 'dark');
  assert.equal(normalizeThemePreference(null), 'dark');
  assert.equal(resolveTheme('system', true), 'dark');
  assert.equal(resolveTheme('system', false), 'light');
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(DEFAULT_THEME_SNAPSHOT.preference, 'dark');
  assert.equal(DEFAULT_THEME_SNAPSHOT.resolvedTheme, 'dark');
});

test('reads each scope once, isolates accounts, and does not write while reading', () => {
  const anonymousKey = themeStorageKey(null);
  const accountKey = themeStorageKey('account/a');
  const fixture = memoryStorage({ [anonymousKey]: 'light', [accountKey]: 'system' });
  const store = createThemePreferences({ storage: () => fixture.storage, systemDark: () => false });

  const anonymous = store.getSnapshot(null);
  assert.equal(anonymous.preference, 'light');
  assert.equal(store.getSnapshot(null), anonymous);
  assert.equal(store.getSnapshot('account/a').preference, 'system');
  assert.equal(store.getSnapshot('other-account'), DEFAULT_THEME_SNAPSHOT);
  assert.equal(fixture.reads, 3);
  assert.equal(fixture.writes, 0);
});

test('keeps in-memory choices usable when storage is unavailable across scope switches', () => {
  const store = createThemePreferences({
    storage: () => { throw new Error('storage blocked'); },
    systemDark: () => { throw new Error('media query blocked'); },
  });

  store.setPreference(null, 'light');
  const anonymous = store.getSnapshot(null);
  assert.equal(anonymous.preference, 'light');
  assert.equal(store.getSnapshot('account').preference, 'dark');
  assert.equal(store.getSnapshot(null), anonymous);

  store.setPreference('account', 'system');
  assert.deepEqual(store.getSnapshot('account'), { preference: 'system', resolvedTheme: 'dark' });
});

test('refreshes cached scopes from storage events and clear without importing another scope', () => {
  const anonymousKey = themeStorageKey(null);
  const accountKey = themeStorageKey('account');
  const fixture = memoryStorage({ [anonymousKey]: 'light', [accountKey]: 'dark' });
  const store = createThemePreferences({ storage: () => fixture.storage });
  const anonymous = store.getSnapshot(null);
  const account = store.getSnapshot('account');
  const listenerCalls: number[] = [];
  store.subscribe(() => listenerCalls.push(1));

  fixture.values.set(accountKey, 'light');
  store.refreshStorage(accountKey);
  assert.equal(store.getSnapshot('account').preference, 'light');
  assert.equal(store.getSnapshot(null), anonymous);

  fixture.values.clear();
  store.refreshStorage(null);
  assert.equal(store.getSnapshot(null), DEFAULT_THEME_SNAPSHOT);
  assert.equal(store.getSnapshot('account'), DEFAULT_THEME_SNAPSHOT);
  assert.equal(listenerCalls.length, 2);

  fixture.values.set(anonymousKey, 'system');
  store.refreshStorage(themeStorageKey('uncached'));
  assert.equal(store.getSnapshot(null), DEFAULT_THEME_SNAPSHOT);
});

test('system refresh notifies only cached system scopes whose resolved theme changed', () => {
  let systemDark = false;
  const fixture = memoryStorage({ [themeStorageKey('system-user')]: 'system' });
  const store = createThemePreferences({ storage: () => fixture.storage, systemDark: () => systemDark });
  let calls = 0;
  store.subscribe(() => { calls += 1; });

  const system = store.getSnapshot('system-user');
  const fixed = store.getSnapshot('fixed-user');
  assert.equal(system.resolvedTheme, 'light');
  assert.equal(fixed, DEFAULT_THEME_SNAPSHOT);

  store.refreshSystem();
  assert.equal(calls, 0);
  systemDark = true;
  store.refreshSystem();
  assert.equal(calls, 1);
  assert.equal(store.getSnapshot('system-user').resolvedTheme, 'dark');
  assert.equal(store.getSnapshot('fixed-user'), fixed);

  systemDark = false;
  store.refreshSystem();
  assert.equal(calls, 2);
  const unsubscribe = store.subscribe(() => { calls += 10; });
  unsubscribe();
  systemDark = true;
  store.refreshSystem();
  assert.equal(calls, 3);
});

test('system snapshots use the current system value after switching away and back', () => {
  let systemDark = true;
  const fixture = memoryStorage({ [themeStorageKey('account-a')]: 'system' });
  const store = createThemePreferences({ storage: () => fixture.storage, systemDark: () => systemDark });

  assert.equal(store.getSnapshot('account-a').resolvedTheme, 'dark');
  store.setPreference('account-b', 'dark');
  systemDark = false;
  assert.equal(store.getSnapshot('account-a').resolvedTheme, 'light');
  assert.equal(store.getSnapshot('account-b'), DEFAULT_THEME_SNAPSHOT);
});

test('choosing system again resolves against the current system value', () => {
  let systemDark = false;
  const store = createThemePreferences({ systemDark: () => systemDark });

  store.setPreference('account', 'light');
  assert.equal(store.getSnapshot('account').preference, 'light');
  systemDark = true;
  store.setPreference('account', 'system');
  assert.deepEqual(store.getSnapshot('account'), { preference: 'system', resolvedTheme: 'dark' });
});

test('a recreated store restores persisted scopes without inheritance and normalizes invalid values', () => {
  const fixture = memoryStorage();
  const firstStore = createThemePreferences({ storage: () => fixture.storage, systemDark: () => false });
  firstStore.setPreference(null, 'light');
  firstStore.setPreference('account-a', 'system');
  firstStore.setPreference('account-b', 'light');
  fixture.values.set(themeStorageKey('invalid-account'), 'sepia');

  const recreatedStore = createThemePreferences({ storage: () => fixture.storage, systemDark: () => false });
  assert.deepEqual(recreatedStore.getSnapshot(null), { preference: 'light', resolvedTheme: 'light' });
  assert.deepEqual(recreatedStore.getSnapshot('account-a'), { preference: 'system', resolvedTheme: 'light' });
  assert.deepEqual(recreatedStore.getSnapshot('account-b'), { preference: 'light', resolvedTheme: 'light' });
  assert.equal(recreatedStore.getSnapshot('invalid-account'), DEFAULT_THEME_SNAPSHOT);
  assert.equal(recreatedStore.getSnapshot('uncached-account'), DEFAULT_THEME_SNAPSHOT);
});

test('separate storage read and write failures preserve the page selection', () => {
  const readFailKey = themeStorageKey(null);
  const readFailStorage: ThemeStorage = {
    getItem() { throw new Error('read blocked'); },
    setItem() { /* writes are available in this case */ },
  };
  const readFailStore = createThemePreferences({ storage: () => readFailStorage });
  assert.equal(readFailStore.getSnapshot(null), DEFAULT_THEME_SNAPSHOT);
  readFailStore.setPreference(null, 'light');
  readFailStore.refreshStorage(readFailKey);
  assert.equal(readFailStore.getSnapshot('other-account'), DEFAULT_THEME_SNAPSHOT);
  assert.deepEqual(readFailStore.getSnapshot(null), { preference: 'light', resolvedTheme: 'light' });

  const writeFailStorage: ThemeStorage = {
    getItem() { return null; },
    setItem() { throw new Error('write blocked'); },
  };
  const writeFailStore = createThemePreferences({ storage: () => writeFailStorage });
  assert.equal(writeFailStore.getSnapshot(null), DEFAULT_THEME_SNAPSHOT);
  writeFailStore.setPreference(null, 'light');
  assert.equal(writeFailStore.getSnapshot('other-account'), DEFAULT_THEME_SNAPSHOT);
  assert.deepEqual(writeFailStore.getSnapshot(null), { preference: 'light', resolvedTheme: 'light' });
});
