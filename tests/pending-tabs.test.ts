import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import * as first from '../src/web/api.ts';
import { MemoryLockManager } from './helpers/memory-lock-manager';

// Independent module instances have independent in-page flush maps, as two
// tabs do. Only the mock browser lock manager and storage are shared.
const second: typeof first = await import(new URL('../src/web/api.ts?pending-tab=second', import.meta.url).href);
class SharedStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalFetch = globalThis.fetch;
let storage: SharedStorage;
let host: EventTarget;
let manager: MemoryLockManager;
const key = (space: string) => `living-memory.pending-writes.v1.${encodeURIComponent(space)}`;
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
const pending = (id: string) => ({ id, path: '/config', method: 'PUT' as const,
  eventId: null, conceptId: null, label: '模型参数', payload: { revision: 1, halfLifeDays: 7 } });
const ok = () => new Response(JSON.stringify({ revision: 2 }), { headers: { 'content-type': 'application/json' } });
beforeEach(() => {
  storage = new SharedStorage();
  manager = new MemoryLockManager();
  host = new EventTarget();
  Object.defineProperties(host, {
    localStorage: { value: storage, configurable: true },
    navigator: { value: { locks: manager }, configurable: true },
  });
  Object.defineProperty(globalThis, 'window', { value: host, configurable: true });
});
afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
  globalThis.fetch = originalFetch;
});

test('independent pages elect one sender and reread the queue after the other page finishes', async () => {
  assert.notEqual(first.flushPendingWrites, second.flushPendingWrites);
  const write = await first.queuePendingWrite('space', pending('config'));
  assert.ok(write);
  const started = gate();
  const finish = gate();
  let sends = 0;
  globalThis.fetch = async () => { sends++; started.release(); await finish.promise; return ok(); };
  const syncing = first.flushPendingWrites('token', 'space');
  await started.promise;
  const busy = await second.flushPendingWrites('token', 'space');
  assert.deepEqual(busy, { sent: 0, failed: 0, failures: [], busy: true });
  assert.equal(sends, 1);
  finish.release();
  assert.equal((await syncing).sent, 1);
  assert.deepEqual(await second.flushPendingWrites('token', 'space'), { sent: 0, failed: 0, failures: [] });
  assert.equal(sends, 1, 'an acknowledged config update must not be resent by a stale batch');
});

test('sync locks are isolated by knowledge space and do not block another account queue', async () => {
  await first.queuePendingWrite('one', pending('same-id'));
  await second.queuePendingWrite('two', pending('same-id'));
  const started = gate();
  const finish = gate();
  const sentSources: string[] = [];
  globalThis.fetch = async (_input, init) => {
    const source = new Headers(init?.headers).get('x-lm-source-id')!;
    sentSources.push(source);
    if (source === 'one') { started.release(); await finish.promise; }
    return ok();
  };
  const syncing = first.flushPendingWrites('token-one', 'one');
  await started.promise;
  assert.equal((await second.flushPendingWrites('token-two', 'two')).sent, 1);
  assert.equal(first.getPendingWrites('one').length, 1);
  finish.release();
  await syncing;
  assert.deepEqual(sentSources, ['one', 'two']);
});

test('a failed batch releases the browser lock so another page can retry the original payload', async () => {
  const write = await first.queuePendingWrite('space', pending('config'));
  globalThis.fetch = async () => { throw new TypeError('offline'); };
  assert.equal((await first.flushPendingWrites('token', 'space')).failed, 1);
  const retained = second.getPendingWrites('space')[0];
  assert.equal(retained.createdAt, write?.createdAt);
  globalThis.fetch = async (_input, init) => {
    assert.deepEqual(JSON.parse(String(init?.body)), write?.payload);
    return ok();
  };
  assert.equal((await second.flushPendingWrites('token', 'space')).sent, 1);
  assert.equal(first.getPendingWrites('space').length, 0);
});

test('a late acknowledgment or error cannot erase or annotate a replaced pending request', async () => {
  for (const accepted of [true, false]) {
    const space = `late-${accepted}`;
    const write = (await first.queuePendingWrite(space, pending('config')))!;
    const replacement = { ...write, payload: { revision: 2, halfLifeDays: 30 } };
    globalThis.fetch = async () => {
      // Simulate an old page which does not follow the new locking protocol.
      storage.setItem(key(space), JSON.stringify([replacement]));
      if (!accepted) throw new TypeError('offline');
      return ok();
    };
    const result = await first.flushPendingWrites('token', space);
    assert.equal(result.sent, 0);
    assert.equal(result.failed, 1);
    assert.deepEqual(second.getPendingWrites(space), [replacement]);
  }
});

test('source-scoped storage notifications update other pages and unsubscribe cleanly', async () => {
  let updates = 0;
  const unsubscribe = first.subscribePendingWrites('space', () => updates++);
  const dispatch = (changedKey: string | null, area: Storage = storage) => {
    const event = new Event('storage');
    Object.defineProperties(event, { key: { value: changedKey }, storageArea: { value: area } });
    host.dispatchEvent(event);
  };
  dispatch(key('elsewhere'));
  dispatch(key('space'), new SharedStorage());
  assert.equal(updates, 0);
  dispatch(key('space'));
  dispatch(null);
  assert.equal(updates, 2);
  await first.queuePendingWrite('elsewhere', pending('other'));
  assert.equal(updates, 2);
  await second.queuePendingWrite('space', pending('current'));
  assert.equal(updates, 3);
  unsubscribe();
  dispatch(key('space'));
  await second.removePendingWrite('space', 'current');
  assert.equal(updates, 3);
});

test('missing browser coordination refuses unsafe writes and retries without altering old queues', async () => {
  await first.queuePendingWrite('space', pending('existing'));
  const original = storage.getItem(key('space'));
  Object.defineProperty(host, 'navigator', { value: {}, configurable: true });
  let requests = 0;
  globalThis.fetch = async () => { requests++; return ok(); };
  assert.equal(await second.queuePendingWrite('space', pending('new')), null);
  await assert.rejects(second.flushPendingWrites('token', 'space'), { code: 'PENDING_COORDINATION_UNAVAILABLE' });
  assert.equal(storage.getItem(key('space')), original);
  assert.equal(requests, 0);
});

test('enqueue freezes caller content before waiting for a storage lock', async () => {
  const ready = gate();
  const finish = gate();
  const held = manager.request('living-memory.pending.storage.v1.space', { mode: 'exclusive' }, async () => {
    ready.release(); await finish.promise;
  });
  await ready.promise;
  const request = pending('frozen');
  const queued = first.queuePendingWrite('space', request);
  request.payload.halfLifeDays = 90;
  finish.release();
  await held;
  assert.equal(((await queued)!.payload as { halfLifeDays: number }).halfLifeDays, 7);
});
