import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import {
  ApiRequestError,
  api,
  flushPendingWrites,
  getPendingWrites,
  queuePendingWrite,
  type PendingWrite,
  type PendingSyncResult,
} from '../src/web/api.ts';

interface LastError {
  code: string;
  status: number;
  message: string;
  retryable: boolean;
  attemptedAt: string;
}

type StoredPendingWrite = PendingWrite & { lastError?: LastError };

interface FlushFailure {
  id: string;
  label: string;
  code: string;
  status: number;
  message: string;
  retryable: boolean;
}

interface FlushResult {
  sent: number;
  failed: number;
  failures: FlushFailure[];
  repairs?: Array<{ id: string; skippedPositions: number }>;
}

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  failSet = false;
  failGet = false;
  failRemove = false;
  readonly failSetKeys = new Set<string>();
  readonly failGetKeys = new Set<string>();
  readonly failRemoveKeys = new Set<string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    if (this.failGet || this.failGetKeys.has(key)) throw new Error('localStorage.getItem failed');
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    if (this.failRemove || this.failRemoveKeys.has(key)) throw new Error('localStorage.removeItem failed');
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    if (this.failSet || this.failSetKeys.has(key)) throw new Error('localStorage.setItem failed');
    this.values.set(key, value);
  }
}

interface FetchCall {
  path: string;
  method: string;
  headers: Headers;
  body: string | undefined;
}

type FetchHandler = (call: FetchCall) => Response | Promise<Response>;

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalCustomEventDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'CustomEvent');
const originalFetch = globalThis.fetch;
let storage: MemoryStorage;
let calls: FetchCall[];

function installBrowserStubs(): void {
  storage = new MemoryStorage();
  const windowStub = new EventTarget();
  Object.defineProperty(windowStub, 'localStorage', {
    configurable: true,
    value: storage,
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: windowStub,
  });

  if (typeof globalThis.CustomEvent !== 'function') {
    class TestCustomEvent extends Event {
      readonly detail: unknown;

      constructor(type: string, init: { detail?: unknown } = {}) {
        super(type);
        this.detail = init.detail;
      }
    }
    Object.defineProperty(globalThis, 'CustomEvent', {
      configurable: true,
      writable: true,
      value: TestCustomEvent,
    });
  }
}

function restoreBrowserStubs(): void {
  if (originalWindowDescriptor) Object.defineProperty(globalThis, 'window', originalWindowDescriptor);
  else Reflect.deleteProperty(globalThis, 'window');
  if (originalCustomEventDescriptor) Object.defineProperty(globalThis, 'CustomEvent', originalCustomEventDescriptor);
  else Reflect.deleteProperty(globalThis, 'CustomEvent');
  globalThis.fetch = originalFetch;
}

function installFetch(handler: FetchHandler): void {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    for (const [key, value] of new Headers(init?.headers)) headers.set(key, value);
    const call: FetchCall = {
      path: new URL(url, 'http://living-memory.test').pathname,
      method,
      headers,
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function enqueue(sourceId: string, id: string, label = `记录 ${id}`): { write: PendingWrite; payload: Record<string, unknown> } {
  const payload = {
    eventId: id,
    conceptId: `concept-${id}`,
    sourceRevision: `revision-${id}`,
    kind: 'review',
    occurredAt: '2026-09-20T08:30:00.000Z',
  };
  const write = queuePendingWrite(sourceId, {
    id,
    method: 'POST',
    path: '/reviews',
    payload,
    eventId: id,
    conceptId: payload.conceptId,
    label,
  });
  assert.ok(write, 'test queue write should be stored');
  return { write, payload };
}

function resultOf(value: PendingSyncResult): FlushResult {
  return value as FlushResult;
}

function stored(sourceId: string): StoredPendingWrite[] {
  return getPendingWrites(sourceId) as StoredPendingWrite[];
}

function assertFailure(result: FlushResult, expected: Partial<FlushFailure>): void {
  assert.equal(result.failed, 1);
  const failure = result.failures[0];
  assert.ok(failure);
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(failure[key as keyof FlushFailure], value, `failure.${key}`);
  }
}

beforeEach(() => {
  installBrowserStubs();
});

afterEach(() => {
  restoreBrowserStubs();
});

test('retains a 409 failure with the original payload, event, timestamp, and lastError', async () => {
  const sourceId = 'source-conflict';
  const { write, payload } = enqueue(sourceId, 'event-conflict', '冲突复习');
  installFetch(() => jsonResponse({
    error: { code: 'EVENT_CONFLICT', message: 'eventId 已被其他事件使用。' },
  }, 409));

  const result = resultOf(await flushPendingWrites('token-old', sourceId));

  assert.deepEqual(result, {
    sent: 0,
    failed: 1,
    failures: [{
      id: write.id,
      label: '冲突复习',
      code: 'EVENT_CONFLICT',
      status: 409,
      message: 'eventId 已被其他事件使用。',
      retryable: false,
    }],
  });
  const retained = stored(sourceId);
  assert.equal(retained.length, 1);
  assert.equal(retained[0].id, write.id);
  assert.equal(retained[0].eventId, write.eventId);
  assert.equal(retained[0].createdAt, write.createdAt);
  assert.deepEqual(retained[0].payload, payload);
  assert.deepEqual(retained[0].lastError && {
    code: retained[0].lastError.code,
    status: retained[0].lastError.status,
    message: retained[0].lastError.message,
    retryable: retained[0].lastError.retryable,
  }, {
    code: 'EVENT_CONFLICT',
    status: 409,
    message: 'eventId 已被其他事件使用。',
    retryable: false,
  });
  assert.ok(retained[0].lastError && Number.isFinite(Date.parse(retained[0].lastError.attemptedAt)));
});

test('keeps an offline write queued and records a retryable network failure', async () => {
  const sourceId = 'source-offline';
  const { write, payload } = enqueue(sourceId, 'event-offline', '离线复习');
  installFetch(() => Promise.reject(new TypeError('fetch failed')));

  const result = resultOf(await flushPendingWrites('token', sourceId));

  assert.deepEqual(result, {
    sent: 0,
    failed: 1,
    failures: [{
      id: write.id,
      label: '离线复习',
      code: 'NETWORK_OFFLINE',
      status: 0,
      message: '本地服务暂时不可达，请检查服务是否正在运行。',
      retryable: true,
    }],
  });
  const retained = stored(sourceId);
  assert.equal(retained.length, 1);
  assert.deepEqual(retained[0].payload, payload);
  assert.equal(retained[0].eventId, write.eventId);
  assert.equal(retained[0].lastError?.code, 'NETWORK_OFFLINE');
  assert.equal(retained[0].lastError?.retryable, true);
});

test('a storage read failure during cleanup cannot erase the queue as if it were empty', async () => {
  const sourceId = 'source-storage-read';
  enqueue(sourceId, 'first');
  enqueue(sourceId, 'second');
  const original = stored(sourceId);
  installFetch(() => {
    storage.failGet = true;
    return jsonResponse({ status: 'accepted' });
  });
  const result = await flushPendingWrites('token', sourceId);
  storage.failGet = false;
  assert.equal(result.sent, 0);
  assert.equal(result.failed, 2);
  assert.ok(result.failures.every((failure) => failure.code === 'PENDING_STORAGE_FAILED'));
  assert.deepEqual(stored(sourceId), original);
});

test('reports mixed accepted, duplicate, and failed writes while retaining only the failure', async () => {
  const sourceId = 'source-mixed';
  const accepted = enqueue(sourceId, 'event-accepted', '已接受');
  const duplicate = enqueue(sourceId, 'event-duplicate', '幂等重复');
  const failed = enqueue(sourceId, 'event-failed', '待重试');
  installFetch((call) => {
    const eventId = JSON.parse(call.body ?? '{}').eventId;
    if (eventId === accepted.write.eventId) return jsonResponse({ status: 'accepted', eventId });
    if (eventId === duplicate.write.eventId) return jsonResponse({ status: 'duplicate', eventId });
    return jsonResponse({ error: { code: 'EVENT_CONFLICT', message: '需要稍后重试。' } }, 409);
  });

  const result = resultOf(await flushPendingWrites('token', sourceId));

  assert.equal(result.sent, 2);
  assertFailure(result, {
    id: failed.write.id,
    label: '待重试',
    code: 'EVENT_CONFLICT',
    status: 409,
    retryable: false,
  });
  assert.deepEqual(stored(sourceId).map((item) => item.id), [failed.write.id]);
  assert.deepEqual(calls.map((call) => JSON.parse(call.body ?? '{}').eventId), [
    accepted.write.eventId,
    duplicate.write.eventId,
    failed.write.eventId,
  ]);
});

test('keeps a successfully accepted write when storage cleanup fails and does not count it as sent', async () => {
  const sourceId = 'source-storage-failure';
  const { write, payload } = enqueue(sourceId, 'event-storage-failure', '存储失败');
  installFetch(() => jsonResponse({ status: 'accepted', eventId: write.eventId }));
  storage.failSet = true;
  storage.failRemove = true;

  const result = resultOf(await flushPendingWrites('token', sourceId));

  assert.equal(result.sent, 0);
  assertFailure(result, {
    id: write.id,
    label: '存储失败',
    code: 'PENDING_STORAGE_FAILED',
  });
  const retained = stored(sourceId);
  assert.equal(retained.length, 1);
  assert.equal(retained[0].id, write.id);
  assert.equal(retained[0].eventId, write.eventId);
  assert.deepEqual(retained[0].payload, payload);
});

test('shares one in-flight flush for concurrent calls on the same source', async () => {
  const sourceId = 'source-concurrent';
  const { write } = enqueue(sourceId, 'event-concurrent', '并发复习');
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const requestStarted = new Promise<void>((resolve) => { started = resolve; });
  installFetch(async (call) => {
    started();
    await gate;
    return jsonResponse({ status: 'accepted', eventId: JSON.parse(call.body ?? '{}').eventId });
  });

  const first = flushPendingWrites('token', sourceId);
  await requestStarted;
  const second = flushPendingWrites('token', sourceId);
  release();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(calls.length, 1);
  assert.deepEqual(resultOf(firstResult), { sent: 1, failed: 0, failures: [] });
  assert.deepEqual(resultOf(secondResult), { sent: 1, failed: 0, failures: [] });
  assert.deepEqual(stored(sourceId), []);
  assert.equal(calls[0].headers.get('x-lm-source-id'), sourceId);
  assert.equal(JSON.parse(calls[0].body ?? '{}').eventId, write.eventId);
});

test('isolates pending queues by source namespace', async () => {
  const sourceA = 'source-a';
  const sourceB = 'source-b';
  const pendingA = enqueue(sourceA, 'same-event-id', '来源 A');
  const pendingB = enqueue(sourceB, 'same-event-id', '来源 B');
  installFetch((call) => jsonResponse({ status: 'accepted', eventId: JSON.parse(call.body ?? '{}').eventId }));

  const resultA = resultOf(await flushPendingWrites('token-a', sourceA));

  assert.deepEqual(resultA, { sent: 1, failed: 0, failures: [] });
  assert.deepEqual(stored(sourceA), []);
  assert.deepEqual(stored(sourceB).map((item) => item.id), [pendingB.write.id]);
  assert.deepEqual(JSON.parse(calls[0].body ?? '{}'), pendingA.payload);
  assert.equal(calls[0].headers.get('x-lm-source-id'), sourceA);

  const resultB = resultOf(await flushPendingWrites('token-b', sourceB));
  assert.deepEqual(resultB, { sent: 1, failed: 0, failures: [] });
  assert.deepEqual(stored(sourceB), []);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].headers.get('x-lm-source-id'), sourceB);
});

test('renews an expired token for the same source, retries once, and preserves the original payload', async () => {
  const sourceId = 'source-expired-token';
  const { write, payload } = enqueue(sourceId, 'event-expired-token', '过期令牌');
  let postCount = 0;
  installFetch((call) => {
    if (call.path === '/api/session') {
      assert.equal(call.method, 'GET');
      return jsonResponse({ writeToken: 'token-renewed', sourceId });
    }
    assert.equal(call.path, '/api/reviews');
    postCount += 1;
    if (postCount === 1) {
      return jsonResponse({ error: { code: 'TOKEN_REQUIRED', message: '令牌已过期。' } }, 401);
    }
    return jsonResponse({ status: 'accepted', eventId: write.eventId });
  });

  const result = resultOf(await flushPendingWrites('token-expired', sourceId));

  assert.deepEqual(result, { sent: 1, failed: 0, failures: [] });
  assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), [
    'POST /api/reviews',
    'GET /api/session',
    'POST /api/reviews',
  ]);
  assert.deepEqual(calls.filter((call) => call.path === '/api/reviews').map((call) => call.body), [
    JSON.stringify(payload),
    JSON.stringify(payload),
  ]);
  assert.equal(calls[0].headers.get('x-lm-token'), 'token-expired');
  assert.equal(calls[2].headers.get('x-lm-token'), 'token-renewed');
  assert.equal(calls[0].headers.get('x-lm-source-id'), sourceId);
  assert.equal(calls[2].headers.get('x-lm-source-id'), sourceId);
  assert.deepEqual(stored(sourceId), []);
});

test('rejects NaN, Infinity, and null layout positions before making a network request', async () => {
  const payload = {
    valid: { x: 1, y: -2, z: 3 },
    nan: { x: Number.NaN, y: 2, z: 3 },
    infinity: { x: 1, y: Number.POSITIVE_INFINITY, z: 3 },
    nullPosition: null,
  };
  installFetch(() => { throw new Error('invalid layout must not reach fetch'); });

  await assert.rejects(
    api.putLayout(payload as never, 'token', 'source-invalid-layout'),
    (error: unknown) => error instanceof ApiRequestError && error.code === 'INVALID_LAYOUT',
  );
  assert.equal(calls.length, 0);
});

test('backs up a malformed layout before sending only finite positions and retains the recovery archive after cleanup', async () => {
  const sourceId = 'source/layout-repair';
  const { write } = enqueueLayout(sourceId, 'layout-repair', {
    valid: { x: 1, y: 2, z: 3 },
    nullPosition: null,
    missingY: { x: 4, z: 6 },
    nonFinite: { x: 7, y: null, z: 9 },
  });
  const original = stored(sourceId)[0];
  const recoveryKey = layoutRecoveryKey(sourceId);
  let backupBeforeSend: string | null = null;
  installFetch((call) => {
    backupBeforeSend = storage.getItem(recoveryKey);
    return jsonResponse({ status: 'accepted' });
  });

  const result = resultOf(await flushPendingWrites('token', sourceId));

  assert.deepEqual(result, {
    sent: 1,
    failed: 0,
    failures: [],
    repairs: [{ id: write.id, skippedPositions: 3 }],
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/layout');
  assert.equal(calls[0].method, 'PUT');
  assert.deepEqual(JSON.parse(calls[0].body ?? ''), {
    valid: { x: 1, y: 2, z: 3 },
  });
  assert.ok(backupBeforeSend, 'the original layout must be backed up before fetch');
  const backups = JSON.parse(backupBeforeSend) as Array<{ write: PendingWrite; invalidIds: string[]; repairedAt: string }>;
  assert.equal(backups.length, 1);
  assert.deepEqual(backups[0].write, original);
  assert.deepEqual(backups[0].invalidIds, ['nullPosition', 'missingY', 'nonFinite']);
  assert.ok(Number.isFinite(Date.parse(backups[0].repairedAt)));
  assert.ok(storage.getItem(recoveryKey), 'successful acknowledgement keeps the recovery archive');
  assert.deepEqual(stored(sourceId), []);
});

test('sends valid layouts and non-layout writes unchanged without adding repair metadata', async () => {
  const sourceId = 'source-layout-normal';
  const layout = enqueueLayout(sourceId, 'layout-normal', {
    first: { x: 0, y: 1.5, z: -2 },
  });
  const review = enqueue(sourceId, 'review-normal', '普通复习');
  installFetch((call) => jsonResponse({ status: 'accepted', eventId: JSON.parse(call.body ?? '{}').eventId }));

  const result = resultOf(await flushPendingWrites('token', sourceId));

  assert.equal(result.repairs, undefined);
  assert.deepEqual(result, { sent: 2, failed: 0, failures: [] });
  assert.deepEqual(calls.map((call) => call.path), ['/api/layout', '/api/reviews']);
  assert.deepEqual(JSON.parse(calls[0].body ?? ''), layout.payload);
  assert.deepEqual(JSON.parse(calls[1].body ?? ''), review.payload);
  assert.equal(storage.getItem(layoutRecoveryKey(sourceId)), null);
  assert.deepEqual(stored(sourceId), []);
});

test('leaves null, array, and oversized top-level layout payloads unchanged when the service rejects them', async () => {
  const sourceId = 'source-layout-boundaries';
  const nullPayload = enqueueLayout(sourceId, 'layout-null', null);
  const arrayPayload = enqueueLayout(sourceId, 'layout-array', [{ x: 1, y: 2, z: 3 }]);
  const oversizedPayload = Object.fromEntries(Array.from({ length: 10_001 }, (_, index) => [
    `position-${index}`,
    { x: index, y: index + 1, z: index + 2 },
  ]));
  const oversized = enqueueLayout(sourceId, 'layout-oversized', oversizedPayload);
  installFetch(() => jsonResponse({
    error: { code: 'INVALID_LAYOUT', message: '布局格式无效。' },
  }, 400));

  const result = resultOf(await flushPendingWrites('token', sourceId));

  assert.equal(result.sent, 0);
  assert.equal(result.failed, 3);
  assert.equal(result.repairs, undefined);
  assert.deepEqual(result.failures.map((failure) => ({ id: failure.id, code: failure.code, status: failure.status })), [
    { id: nullPayload.write.id, code: 'INVALID_LAYOUT', status: 400 },
    { id: arrayPayload.write.id, code: 'INVALID_LAYOUT', status: 400 },
    { id: oversized.write.id, code: 'INVALID_LAYOUT', status: 400 },
  ]);
  assert.deepEqual(calls.map((call) => JSON.parse(call.body ?? '')), [
    nullPayload.payload,
    arrayPayload.payload,
    oversized.payload,
  ]);
  assert.equal(storage.getItem(layoutRecoveryKey(sourceId)), null);
  assert.deepEqual(stored(sourceId).map((item) => item.id), [
    nullPayload.write.id,
    arrayPayload.write.id,
    oversized.write.id,
  ]);
});

test('sends an all-invalid layout as an empty merge and retains its recovery archive', async () => {
  const sourceId = 'source-layout-all-invalid';
  const { write } = enqueueLayout(sourceId, 'layout-all-invalid', {
    nullPosition: null,
    missingAxis: { x: 1, z: 2 },
    nonFiniteAfterPersistence: { x: 3, y: null, z: 4 },
  });
  installFetch((call) => jsonResponse({ status: 'accepted' }));

  const result = resultOf(await flushPendingWrites('token', sourceId));

  assert.deepEqual(result, {
    sent: 1,
    failed: 0,
    failures: [],
    repairs: [{ id: write.id, skippedPositions: 3 }],
  });
  assert.deepEqual(JSON.parse(calls[0].body ?? 'not-json'), {});
  const backups = JSON.parse(storage.getItem(layoutRecoveryKey(sourceId)) ?? '[]') as Array<{ write: PendingWrite; invalidIds: string[] }>;
  assert.equal(backups.length, 1);
  assert.deepEqual(backups[0].write, write);
  assert.deepEqual(backups[0].invalidIds, ['nullPosition', 'missingAxis', 'nonFiniteAfterPersistence']);
  assert.deepEqual(stored(sourceId), []);
});

test('does not send a malformed layout when recovery backup writing fails', async () => {
  const sourceId = 'source-layout-backup-write-failure';
  const { write, payload } = enqueueLayout(sourceId, 'layout-backup-write-failure', {
    valid: { x: 1, y: 2, z: 3 },
    invalid: null,
  });
  const recoveryKey = layoutRecoveryKey(sourceId);
  const original = stored(sourceId)[0];
  storage.failSetKeys.add(recoveryKey);
  installFetch(() => jsonResponse({ status: 'must-not-send' }));

  const result = resultOf(await flushPendingWrites('token', sourceId));

  assert.equal(calls.length, 0);
  assertFailure(result, {
    id: write.id,
    label: '保存图谱布局',
    code: 'PENDING_LAYOUT_BACKUP_FAILED',
  });
  const retained = stored(sourceId)[0];
  assert.equal(retained.id, original.id);
  assert.deepEqual(retained.payload, payload);
  assert.equal(retained.lastError?.code, 'PENDING_LAYOUT_BACKUP_FAILED');
  assert.equal(storage.getItem(recoveryKey), null);
});

test('preserves an existing recovery backup when reading that backup fails', async () => {
  const sourceId = 'source-layout-backup-read-failure';
  const { write, payload } = enqueueLayout(sourceId, 'layout-backup-read-failure', {
    valid: { x: 1, y: 2, z: 3 },
    invalid: null,
  });
  const recoveryKey = layoutRecoveryKey(sourceId);
  const originalBackup = JSON.stringify([{
    write,
    invalidIds: ['invalid'],
    repairedAt: '2026-09-20T09:00:00.000Z',
  }]);
  storage.setItem(recoveryKey, originalBackup);
  storage.failGetKeys.add(recoveryKey);
  installFetch(() => jsonResponse({ status: 'must-not-send' }));

  const result = resultOf(await flushPendingWrites('token', sourceId));

  storage.failGetKeys.delete(recoveryKey);
  assert.equal(calls.length, 0);
  assertFailure(result, {
    id: write.id,
    code: 'PENDING_LAYOUT_BACKUP_FAILED',
  });
  assert.deepEqual(stored(sourceId)[0].payload, payload);
  assert.equal(storage.getItem(recoveryKey), originalBackup);
});

test('does not overwrite a recovery backup when the same pending id has changed payload', async () => {
  const sourceId = 'source-layout-backup-conflict';
  const { write, payload } = enqueueLayout(sourceId, 'layout-backup-conflict', {
    valid: { x: 1, y: 2, z: 3 },
    invalid: null,
  });
  const recoveryKey = layoutRecoveryKey(sourceId);
  const conflictingBackup = JSON.stringify([{
    write: { ...write, payload: { other: { x: 9, y: 9, z: 9 } } },
    invalidIds: ['other'],
    repairedAt: '2026-09-20T09:05:00.000Z',
  }]);
  storage.setItem(recoveryKey, conflictingBackup);
  installFetch(() => jsonResponse({ status: 'must-not-send' }));

  const result = resultOf(await flushPendingWrites('token', sourceId));

  assert.equal(calls.length, 0);
  assertFailure(result, {
    id: write.id,
    code: 'PENDING_LAYOUT_BACKUP_FAILED',
  });
  assert.deepEqual(stored(sourceId)[0].payload, payload);
  assert.equal(storage.getItem(recoveryKey), conflictingBackup);
});

test('backs up one layout pending id once across a failed retry and retains one archive after recovery', async () => {
  const sourceId = 'source-layout-retry';
  const { write } = enqueueLayout(sourceId, 'layout-retry', {
    valid: { x: 1, y: 2, z: 3 },
    invalid: null,
  });
  const recoveryKey = layoutRecoveryKey(sourceId);
  const original = stored(sourceId)[0];
  let attempt = 0;
  installFetch(() => {
    attempt += 1;
    if (attempt === 1) return Promise.reject(new TypeError('offline'));
    return jsonResponse({ status: 'accepted' });
  });

  const first = resultOf(await flushPendingWrites('token', sourceId));
  assertFailure(first, { id: write.id, code: 'NETWORK_OFFLINE' });
  const firstBackup = storage.getItem(recoveryKey);
  assert.ok(firstBackup);
  const firstEntries = JSON.parse(firstBackup) as Array<{ write: PendingWrite; invalidIds: string[] }>;
  assert.equal(firstEntries.length, 1);
  assert.deepEqual(firstEntries[0].write, original);

  let backupDuringRetry: string | null = null;
  installFetch(() => {
    backupDuringRetry = storage.getItem(recoveryKey);
    return jsonResponse({ status: 'accepted' });
  });
  const second = resultOf(await flushPendingWrites('token', sourceId));

  assert.deepEqual(second, {
    sent: 1,
    failed: 0,
    failures: [],
    repairs: [{ id: write.id, skippedPositions: 1 }],
  });
  assert.ok(backupDuringRetry);
  assert.equal((JSON.parse(backupDuringRetry) as unknown[]).length, 1);
  const retainedBackups = JSON.parse(storage.getItem(recoveryKey) ?? '[]') as unknown[];
  assert.equal(retainedBackups.length, 1);
  assert.deepEqual(stored(sourceId), []);
});

test('keeps layout recovery backups isolated for different sources', async () => {
  const sourceA = 'source/layout-A';
  const sourceB = 'source/layout B';
  const pendingA = enqueueLayout(sourceA, 'same-layout-id', {
    valid: { x: 1, y: 2, z: 3 },
    invalidA: null,
  });
  const pendingB = enqueueLayout(sourceB, 'same-layout-id', {
    valid: { x: 4, y: 5, z: 6 },
    invalidB: null,
  });
  installFetch((call) => {
    if (call.headers.get('x-lm-source-id') === sourceA) return Promise.reject(new TypeError('offline'));
    return jsonResponse({ status: 'accepted' });
  });

  const resultA = resultOf(await flushPendingWrites('token-a', sourceA));
  const resultB = resultOf(await flushPendingWrites('token-b', sourceB));

  assertFailure(resultA, { id: pendingA.write.id, code: 'NETWORK_OFFLINE' });
  assert.deepEqual(resultB, {
    sent: 1,
    failed: 0,
    failures: [],
    repairs: [{ id: pendingB.write.id, skippedPositions: 1 }],
  });
  assert.ok(storage.getItem(layoutRecoveryKey(sourceA)));
  assert.ok(storage.getItem(layoutRecoveryKey(sourceB)));
  assert.deepEqual(stored(sourceA).map((item) => item.id), [pendingA.write.id]);
  assert.deepEqual(stored(sourceB), []);
});

test('rejects the initial pending queue read instead of treating storage failure as an empty success', async () => {
  const sourceId = 'source-first-scan-storage-failure';
  storage.failGet = true;
  installFetch(() => jsonResponse({ status: 'must-not-send' }));

  await assert.rejects(
    flushPendingWrites('token', sourceId),
    (error: unknown) => error instanceof ApiRequestError && error.code === 'PENDING_STORAGE_UNAVAILABLE',
  );
  assert.equal(calls.length, 0);
});

function layoutRecoveryKey(sourceId: string): string {
  return `living-memory.layout-recovery.v1.${encodeURIComponent(sourceId)}`;
}

function enqueueLayout(sourceId: string, id: string, payload: unknown, label = '保存图谱布局'): { write: PendingWrite; payload: unknown } {
  const write = queuePendingWrite(sourceId, {
    id,
    method: 'PUT',
    path: '/layout',
    payload,
    eventId: null,
    conceptId: null,
    label,
  });
  assert.ok(write, 'test layout queue write should be stored');
  return { write, payload };
}
