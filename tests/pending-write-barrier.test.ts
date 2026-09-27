import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createPendingWriteBarrier } from '../src/web/pending-write-barrier.js';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((success, failure) => { resolve = success; reject = failure; });
  return { promise, resolve, reject };
}

test('restore waits for every outstanding write including one started during the wait', async () => {
  const barrier = createPendingWriteBarrier();
  const first = deferred();
  barrier.track(first.promise);
  let finished = false;
  const wait = barrier.settle().then(() => { finished = true; });
  const second = deferred();
  barrier.track(second.promise);
  first.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  second.resolve();
  await wait;
  assert.equal(finished, true);
});

test('failed writes finish draining so the caller can inspect its pending queue', async () => {
  const barrier = createPendingWriteBarrier();
  const failed = deferred();
  barrier.track(failed.promise);
  const wait = barrier.settle();
  failed.reject(new Error('network failed; queued by caller'));
  await wait;
  await barrier.settle();
});
