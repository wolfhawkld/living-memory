import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RequestDeadlineError,
  withRequestDeadline,
} from '../src/web/request-deadline.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  let reject!: Deferred<T>['reject'];
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function assertRequestTimeout(error: unknown): boolean {
  assert.ok(error instanceof RequestDeadlineError);
  assert.equal(error.name, 'RequestDeadlineError');
  assert.equal(error.code, 'REQUEST_TIMEOUT');
  return true;
}

async function nextTurn(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}

test('does not start a request when the caller signal is already aborted', async () => {
  const caller = new AbortController();
  const reason = new Error('cancelled before start');
  caller.abort(reason);
  let calls = 0;

  const pending = withRequestDeadline(async () => {
    calls += 1;
    return 'unexpected';
  }, { signal: caller.signal, timeoutMs: 1 });

  await assert.rejects(pending, error => {
    assert.strictEqual(error, reason);
    return true;
  });
  assert.equal(calls, 0);
});

test('propagates a caller abort after start and aborts the active signal', async () => {
  const caller = new AbortController();
  const run = deferred<string>();
  let runSignal!: AbortSignal;
  const pending = withRequestDeadline(signal => {
    runSignal = signal;
    return run.promise;
  }, { signal: caller.signal, timeoutMs: 100 });
  await Promise.resolve();

  const reason = new Error('cancelled while running');
  caller.abort(reason);

  await assert.rejects(pending, error => {
    assert.strictEqual(error, reason);
    return true;
  });
  assert.equal(runSignal.aborted, true);
  assert.strictEqual(runSignal.reason, reason);
  run.resolve('late result');
});

test('uses the fifteen second default deadline even when run ignores abort', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const run = deferred<string>();
  let runSignal!: AbortSignal;
  let outcome: 'fulfilled' | 'rejected' | undefined;
  const pending = withRequestDeadline(signal => {
    runSignal = signal;
    return run.promise;
  });
  void pending.then(
    () => { outcome = 'fulfilled'; },
    () => { outcome = 'rejected'; },
  );

  t.mock.timers.tick(14_999);
  await Promise.resolve();
  assert.equal(outcome, undefined);

  t.mock.timers.tick(1);
  await assert.rejects(pending, error => {
    assertRequestTimeout(error);
    assert.strictEqual(runSignal.reason, error);
    return true;
  });
  assert.equal(runSignal.aborted, true);
  run.resolve('late result');
});

test('keeps the deadline running while asynchronous body work is pending', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const body = deferred<string>();
  let runSignal!: AbortSignal;
  const pending = withRequestDeadline(async signal => {
    runSignal = signal;
    await Promise.resolve('headers');
    return body.promise;
  }, { timeoutMs: 25 });

  await Promise.resolve();
  t.mock.timers.tick(25);
  await assert.rejects(pending, error => {
    assertRequestTimeout(error);
    assert.strictEqual(runSignal.reason, error);
    return true;
  });
  body.resolve('late body');
});

test('cleans the timer and caller listener after a successful run', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const caller = new AbortController();
  let runSignal!: AbortSignal;
  const result = await withRequestDeadline(async signal => {
    runSignal = signal;
    return 'ok';
  }, { signal: caller.signal, timeoutMs: 20 });

  assert.equal(result, 'ok');
  const reason = new Error('too late to cancel');
  caller.abort(reason);
  t.mock.timers.tick(20);
  await Promise.resolve();
  assert.equal(runSignal.aborted, false);
});

test('cleans the timer and caller listener after a failed run', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const caller = new AbortController();
  const failure = new Error('request failed');
  let runSignal!: AbortSignal;
  const pending = withRequestDeadline(async signal => {
    runSignal = signal;
    throw failure;
  }, { signal: caller.signal, timeoutMs: 20 });

  await assert.rejects(pending, error => {
    assert.strictEqual(error, failure);
    return true;
  });
  caller.abort(new Error('too late to cancel'));
  t.mock.timers.tick(20);
  await Promise.resolve();
  assert.equal(runSignal.aborted, false);
});

test('ignores late run settlement after timeout without an unhandled rejection', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const lateSuccess = deferred<string>();
  const timedOutSuccess = withRequestDeadline(() => lateSuccess.promise, { timeoutMs: 10 });
  t.mock.timers.tick(10);
  await assert.rejects(timedOutSuccess, assertRequestTimeout);
  lateSuccess.resolve('late success');
  await Promise.resolve();

  const lateFailure = deferred<string>();
  const timedOutFailure = withRequestDeadline(() => lateFailure.promise, { timeoutMs: 10 });
  t.mock.timers.tick(10);
  await assert.rejects(timedOutFailure, assertRequestTimeout);

  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  const lateReason = new Error('late failure');
  lateFailure.reject(lateReason);
  await nextTurn();
  process.off('unhandledRejection', onUnhandled);
  assert.deepEqual(unhandled, []);
});
