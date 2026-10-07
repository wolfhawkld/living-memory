import assert from 'node:assert/strict';
import test from 'node:test';
import { queuePendingWrite, getPendingWrites, flushPendingWrites } from '../src/web/api.js';
import type { ApplicationRecordRequest } from '../src/shared/types.js';
import { createMemoryLockManager } from './helpers/memory-lock-manager.js';

test('offline relation suggestions freeze nested endpoint and before/after metadata and replay the same JSON after failure', async () => {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const oldEvent = Object.getOwnPropertyDescriptor(globalThis, 'CustomEvent'); const oldFetch = globalThis.fetch;
  const values = new Map<string, string>(); const browser = new EventTarget();
  Object.defineProperties(browser, {
    localStorage: { value: { getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) } },
    navigator: { value: { locks: createMemoryLockManager() } },
  });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser });
  if (typeof globalThis.CustomEvent !== 'function') Object.defineProperty(globalThis, 'CustomEvent', { configurable: true,
    value: class extends Event { detail: unknown; constructor(type: string, init?: CustomEventInit) { super(type); this.detail = init?.detail; } } });
  try {
    const payload: ApplicationRecordRequest = { eventId: 'frozen-relation', conceptId: 'primary', sourceRevision: 'primary-v1',
      occurredAt: '2026-10-01T10:00:00Z', kind: 'summary', context: '', content: 'relation only', outcome: 'unverified',
      assistance: 'resources', result: '', limitations: '', insight: '', correction: '', references: '',
      relationSuggestion: { operation: 'change',
        source: { conceptId: 'primary', sourceRevision: 'primary-v1', title: '原始名称', path: 'Math/Alpha.md' },
        target: { conceptId: 'secondary', sourceRevision: 'secondary-v1', title: 'Secondary', path: 'AI/Beta.md' },
        before: { type: 'related', description: '  original\n description ' },
        after: { type: 'application', description: '  proposed\n description ' } } };
    const frozen = JSON.parse(JSON.stringify(payload));
    const enqueue = queuePendingWrite('relation-space', { id: 'fixed-pending-id', eventId: payload.eventId,
      conceptId: payload.conceptId, path: '/applications', method: 'POST', label: '关系建议', payload });
    payload.relationSuggestion!.target.sourceRevision = 'new-current-version';
    payload.relationSuggestion!.target.title = 'new-current-title';
    if (payload.relationSuggestion?.operation === 'change') payload.relationSuggestion.after.description = 'edited after enqueue';
    assert.ok(await enqueue);
    assert.deepEqual(getPendingWrites('relation-space')[0].payload, frozen);
    const sent: unknown[] = [];
    globalThis.fetch = async (_input, init) => { sent.push(JSON.parse(String(init?.body))); throw new TypeError('offline'); };
    assert.equal((await flushPendingWrites('token', 'relation-space')).failed, 1);
    assert.deepEqual(getPendingWrites('relation-space')[0].payload, frozen);
    assert.deepEqual(sent, [frozen]);
    globalThis.fetch = async (_input, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ status: 'duplicate', eventId: payload.eventId }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    assert.equal((await flushPendingWrites('token', 'relation-space')).sent, 1);
    assert.deepEqual(sent, [frozen, frozen]); assert.equal(getPendingWrites('relation-space').length, 0);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow); else Reflect.deleteProperty(globalThis, 'window');
    if (oldEvent) Object.defineProperty(globalThis, 'CustomEvent', oldEvent); else Reflect.deleteProperty(globalThis, 'CustomEvent');
  }
});
