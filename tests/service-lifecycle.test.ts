import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServiceLifecycle } from '../src/server/service-lifecycle.js';
import { createFeishuConnector } from '../src/integrations/feishu-connector.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => { resolve = yes; });
  return { promise, resolve };
}

test('connector starts once only after HTTP listen notification', async () => {
  const calls: string[] = [];
  const lifecycle = createServiceLifecycle({
    connector: { start: async () => { calls.push('start'); }, stop: async () => { calls.push('stop'); } },
    closeChanges: () => { calls.push('changes'); }, closeHttp: async () => { calls.push('http'); },
    closeStores: () => { calls.push('stores'); },
  });
  assert.deepEqual(calls, []);
  lifecycle.onListening();
  lifecycle.onListening();
  assert.deepEqual(calls, ['start']);
  await lifecycle.shutdown();
  assert.deepEqual(calls, ['start', 'stop', 'changes', 'http', 'stores']);
});

test('shutdown waits for connector stop, is idempotent and prevents late listen startup', async () => {
  const gate = deferred();
  const entered = deferred();
  const calls: string[] = [];
  const lifecycle = createServiceLifecycle({
    connector: { start: async () => { calls.push('start'); }, stop: async () => { calls.push('stop'); entered.resolve(); await gate.promise; } },
    closeChanges: () => { calls.push('changes'); }, closeHttp: async () => { calls.push('http'); },
    closeStores: () => { calls.push('stores'); },
  });
  const first = lifecycle.shutdown();
  assert.strictEqual(first, lifecycle.shutdown());
  lifecycle.onListening();
  await entered.promise;
  assert.deepEqual(calls, ['stop']);
  gate.resolve();
  await first;
  lifecycle.onListening();
  assert.deepEqual(calls, ['stop', 'changes', 'http', 'stores']);
});

test('HTTP and stores still close if connector stop rejects', async () => {
  const calls: string[] = [];
  const lifecycle = createServiceLifecycle({
    connector: { start: async () => {}, stop: async () => { throw new Error('stop failure'); } },
    closeChanges: () => { calls.push('changes'); }, closeHttp: async () => { calls.push('http'); },
    closeStores: () => { calls.push('stores'); },
  });
  await assert.rejects(lifecycle.shutdown(), /stop failure/);
  assert.deepEqual(calls, ['changes', 'http', 'stores']);
});

test('stores still close if HTTP shutdown rejects', async () => {
  let closed = false;
  const lifecycle = createServiceLifecycle({
    connector: { start: async () => {}, stop: async () => {} }, closeChanges: () => {},
    closeHttp: async () => { throw new Error('http failure'); }, closeStores: () => { closed = true; },
  });
  await assert.rejects(lifecycle.shutdown(), /http failure/);
  assert.equal(closed, true);
});

test('HTTP and stores still close if change feed cleanup throws', async () => {
  const calls: string[] = [];
  const lifecycle = createServiceLifecycle({
    connector: { start: async () => {}, stop: async () => {} },
    closeChanges: () => { throw new Error('feed failure'); },
    closeHttp: async () => { calls.push('http'); }, closeStores: () => { calls.push('stores'); },
  });
  await assert.rejects(lifecycle.shutdown(), /feed failure/);
  assert.deepEqual(calls, ['http', 'stores']);
});

test('bad Feishu configuration leaves the HTTP lifecycle active and performs no SDK work', async () => {
  let factories = 0;
  let httpClosed = false;
  const connector = createFeishuConnector({
    env: { LM_FEISHU_ENABLED: '1' },
    driverFactory: async () => { factories++; assert.fail('invalid config must not load'); },
  });
  const lifecycle = createServiceLifecycle({
    connector, closeChanges: () => {}, closeHttp: async () => { httpClosed = true; }, closeStores: () => {},
  });
  lifecycle.onListening();
  await connector.start();
  assert.deepEqual(connector.getStatus(), { state: 'error', code: 'invalid-app-id' });
  assert.equal(httpClosed, false);
  assert.equal(factories, 0);
  await lifecycle.shutdown();
  assert.equal(httpClosed, true);
});
