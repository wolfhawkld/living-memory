import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionRecovery, type LocalSession } from '../src/web/session-recovery.ts';

const initial: LocalSession = { writeToken: 'old-token', sourceId: 'kg-a' };
const refreshed: LocalSession = { writeToken: 'new-token', sourceId: 'kg-a' };

function expired(): Error & { status: number } {
  return Object.assign(new Error('token expired'), { status: 401 });
}

function recovery(getSession: () => Promise<LocalSession>) {
  return createSessionRecovery({
    getSession,
    isExpired: (error) => error instanceof Error && 'status' in error && error.status === 401,
  });
}

test('retries one expired write with a renewed session', async () => {
  let sessionCalls = 0;
  const used: string[] = [];
  const recovered: LocalSession[] = [];
  const retry = createSessionRecovery({
    getSession: async () => {
      sessionCalls += 1;
      return refreshed;
    },
    isExpired: (error) => error instanceof Error && 'status' in error && error.status === 401,
    onRecovered: (session) => recovered.push(session),
  });
  const result = await retry.run(initial, async (session) => {
    used.push(session.writeToken);
    if (used.length === 1) throw expired();
    return 'saved';
  });

  assert.equal(result, 'saved');
  assert.equal(sessionCalls, 1);
  assert.deepEqual(used, ['old-token', 'new-token']);
  assert.deepEqual(recovered, [refreshed]);
});

test('coalesces concurrent expired writes into one session renewal', async () => {
  let sessionCalls = 0;
  let release!: (session: LocalSession) => void;
  const renewed = new Promise<LocalSession>((resolve) => { release = resolve; });
  const used: string[][] = [[], []];
  let firstAttempts = 0;
  const retry = recovery(async () => {
    sessionCalls += 1;
    return renewed;
  });
  const send = (slot: number) => retry.run(initial, async (session) => {
    used[slot].push(session.writeToken);
    if (session.writeToken === initial.writeToken) {
      firstAttempts += 1;
      throw expired();
    }
    return slot;
  });

  const first = send(0);
  const second = send(1);
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  assert.equal(sessionCalls, 1);
  release(refreshed);
  assert.deepEqual(await Promise.all([first, second]), [0, 1]);
  assert.equal(firstAttempts, 2);
  assert.deepEqual(used, [['old-token', 'new-token'], ['old-token', 'new-token']]);
});

test('rejects a renewed session from another source without a second write', async () => {
  const writes: LocalSession[] = [];
  const actualSourceIds: string[] = [];
  const retry = createSessionRecovery({
    getSession: async () => ({ writeToken: 'other-token', sourceId: 'kg-b' }),
    isExpired: (error) => error instanceof Error && 'status' in error && error.status === 401,
    onSourceMismatch: (sourceId) => actualSourceIds.push(sourceId),
    sourceMismatchError: () => new Error('namespace changed'),
  });
  const error = await retry
    .run(initial, async (session) => {
      writes.push(session);
      throw expired();
    })
    .catch((reason: unknown) => reason as Error & { code?: string });

  assert.equal(error.code, 'SOURCE_MISMATCH');
  assert.deepEqual(actualSourceIds, ['kg-b']);
  assert.deepEqual(writes, [initial]);
});

test('does not renew after the retried write expires again', async () => {
  let sessionCalls = 0;
  let writes = 0;
  await assert.rejects(
    recovery(async () => {
      sessionCalls += 1;
      return refreshed;
    }).run(initial, async () => {
      writes += 1;
      throw expired();
    }),
    (error: unknown) => error instanceof Error && error.message === 'token expired',
  );
  assert.equal(sessionCalls, 1);
  assert.equal(writes, 2);
});

test('passes through non-expiration errors without renewing', async () => {
  let sessionCalls = 0;
  const failure = new Error('validation failed');
  await assert.rejects(
    recovery(async () => {
      sessionCalls += 1;
      return refreshed;
    }).run(initial, async () => { throw failure; }),
    failure,
  );
  assert.equal(sessionCalls, 0);
});

test('preserves a session renewal failure and does not replay the write', async () => {
  const renewalFailure = new Error('server unavailable');
  let writes = 0;
  await assert.rejects(
    recovery(async () => { throw renewalFailure; }).run(initial, async () => {
      writes += 1;
      throw expired();
    }),
    renewalFailure,
  );
  assert.equal(writes, 1);
});

test('rejects blank sessions before any write or blank renewal can be used', async () => {
  let writes = 0;
  const retry = recovery(async () => ({ writeToken: '  ', sourceId: 'kg-a' }));
  await assert.rejects(
    retry.run({ writeToken: '', sourceId: 'kg-a' }, async () => {
      writes += 1;
      return 'unexpected';
    }),
    (error: unknown) => (error as { code?: string }).code === 'SESSION_INVALID',
  );
  assert.equal(writes, 0);

  await assert.rejects(
    recovery(async () => ({ writeToken: '  ', sourceId: 'kg-a' })).run(initial, async () => {
      writes += 1;
      throw expired();
    }),
    (error: unknown) => (error as { code?: string }).code === 'SESSION_INVALID',
  );
  assert.equal(writes, 1);
});
