import assert from 'node:assert/strict';
import test from 'node:test';
import { archivePendingCorrection, canArchiveCorrectionWrite, flushPendingWrites, getPendingWrites, queuePendingWrite } from '../src/web/api.js';
import type { RelationReviewRequest } from '../src/shared/relation-reviews.js';
import { createMemoryLockManager } from './helpers/memory-lock-manager.js';

async function browserTest(run: (values: Map<string, string>, failArchive: () => void) => Promise<void>) {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const oldEvent = Object.getOwnPropertyDescriptor(globalThis, 'CustomEvent');
  const oldFetch = globalThis.fetch;
  const values = new Map<string, string>();
  let archiveFailed = false;
  const browser = new EventTarget();
  Object.defineProperties(browser, {
    localStorage: { value: { getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (archiveFailed && key.includes('correction-recovery')) throw new Error('storage unavailable');
        values.set(key, value);
      }, removeItem: (key: string) => values.delete(key) } },
    navigator: { value: { locks: createMemoryLockManager() } },
  });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser });
  if (typeof globalThis.CustomEvent !== 'function') Object.defineProperty(globalThis, 'CustomEvent', { configurable: true,
    value: class extends Event { detail: unknown; constructor(type: string, init?: CustomEventInit) { super(type); this.detail = init?.detail; } } });
  try { await run(values, () => { archiveFailed = !archiveFailed; }); }
  finally {
    globalThis.fetch = oldFetch;
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow); else Reflect.deleteProperty(globalThis, 'window');
    if (oldEvent) Object.defineProperty(globalThis, 'CustomEvent', oldEvent); else Reflect.deleteProperty(globalThis, 'CustomEvent');
  }
}

function payload(): RelationReviewRequest {
  return { eventId: 'review-offline', applicationEventId: 'application-offline', conceptId: 'primary',
    occurredAt: '2026-10-10T10:00:00.000Z', previousEventId: 'old-tail', status: 'dismissed', note: ' original decision ',
    basis: { source: { conceptId: 'primary', current: { conceptId: 'primary', title: 'Primary', path: 'Math/Primary.md', sourceRevision: 'v1' } },
      target: { conceptId: 'missing-secondary', current: null }, beforePresent: null, afterPresent: null } };
}

test('an uncertain relation decision keeps the exact frozen request until duplicate confirmation', async () => browserTest(async () => {
  const original = payload();
  const expected = structuredClone(original);
  const queued = queuePendingWrite('relation-review-space', { eventId: original.eventId, conceptId: original.conceptId,
    path: '/relation-reviews', method: 'POST', label: '关系建议复核', payload: original });
  original.basis.source.current!.sourceRevision = 'later-version';
  original.basis.target.conceptId = 'different-secondary';
  original.note = 'edited after queueing';
  assert.ok(await queued);
  const sent: unknown[] = [];
  globalThis.fetch = async (_input, init) => { sent.push(JSON.parse(String(init?.body))); throw new TypeError('response lost'); };
  assert.equal((await flushPendingWrites('token', 'relation-review-space')).failed, 1);
  const uncertain = getPendingWrites('relation-review-space')[0];
  assert.deepEqual(uncertain.payload, expected);
  assert.equal(canArchiveCorrectionWrite(uncertain), false);
  assert.equal(await archivePendingCorrection('relation-review-space', uncertain), false);
  globalThis.fetch = async (_input, init) => {
    sent.push(JSON.parse(String(init?.body)));
    return Response.json({ status: 'duplicate', eventId: expected.eventId });
  };
  assert.equal((await flushPendingWrites('token', 'relation-review-space')).sent, 1);
  assert.deepEqual(sent, [expected, expected]);
  assert.deepEqual(getPendingWrites('relation-review-space'), []);
}));

test('a deterministic relation conflict is withdrawn only after exact private backup succeeds', async () => browserTest(async (values, failArchive) => {
  const original = payload();
  await queuePendingWrite('relation-conflict-a', { eventId: original.eventId, conceptId: original.conceptId,
    path: '/relation-reviews', method: 'POST', label: '关系建议复核', payload: original });
  await queuePendingWrite('relation-conflict-b', { eventId: original.eventId, conceptId: original.conceptId,
    path: '/relation-reviews', method: 'POST', label: '关系建议复核', payload: original });
  globalThis.fetch = async () => Response.json({ error: { code: 'RELATION_REVIEW_SOURCE_CHANGED', message: 'basis changed' } }, { status: 409 });
  assert.equal((await flushPendingWrites('token', 'relation-conflict-a')).failed, 1);
  const rejected = getPendingWrites('relation-conflict-a')[0];
  assert.equal(canArchiveCorrectionWrite(rejected), true);
  for (const code of ['EVENT_CONFLICT', 'REQUEST_TIMEOUT', 'AUTH_REQUIRED']) {
    const uncertain = { ...rejected, lastError: { ...rejected.lastError!, code } };
    assert.equal(canArchiveCorrectionWrite(uncertain), false);
  }
  failArchive();
  assert.equal(await archivePendingCorrection('relation-conflict-a', rejected), false);
  assert.deepEqual(getPendingWrites('relation-conflict-a'), [rejected]);
  failArchive();
  assert.equal(await archivePendingCorrection('relation-conflict-a', { ...rejected, payload: { ...original, note: 'different snapshot' } }), false);
  assert.equal(await archivePendingCorrection('relation-conflict-a', rejected), true);
  const backupKey = 'living-memory.correction-recovery.v1.relation-conflict-a';
  const backups = JSON.parse(values.get(backupKey)!) as Array<{ write: unknown; archivedAt: string }>;
  assert.deepEqual(backups[0].write, rejected);
  assert.ok(backups[0].archivedAt);
  assert.deepEqual(getPendingWrites('relation-conflict-a'), []);
  assert.equal(getPendingWrites('relation-conflict-b').length, 1);
}));
