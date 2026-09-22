import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConceptHistory, ConceptHistoryEntry } from '../src/shared/types.ts';
import { createConceptHistoryLoader, type HistoryFetcher } from '../src/web/concept-history-loader.ts';
import { api } from '../src/web/api.ts';

const scope = { sourceId: 'synthetic-source', conceptId: 'math/布尔 & logic', sourceRevision: 'rev-1' };
const asOf = '2026-09-22T10:00:00.000Z';
const entry = (id: string): ConceptHistoryEntry => ({ type: 'anchor', event: {
  eventId: id, conceptId: scope.conceptId, sourceRevision: scope.sourceRevision,
  occurredAt: asOf, recordedAt: asOf, kind: 'review',
} });
function page(ids: string[] = [], total = ids.length, nextCursor: string | null = null): ConceptHistory {
  return { ...scope, asOf, total, nextCursor, entries: ids.map(entry),
    state: { conceptId: scope.conceptId, status: 'unknown', decay: null, elapsedDays: null, anchor: null, reason: null, asOf } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('history API encodes concept paths and sends a source-bound, uncached read with cancellation', async (t) => {
  let calls = 0;
  const signal = new AbortController().signal;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    const url = new URL(String(input), 'http://synthetic.invalid');
    assert.equal(decodeURIComponent(url.pathname.slice('/api/concepts/'.length, -'/history'.length)), scope.conceptId);
    assert.equal(url.searchParams.get('cursor'), 'opaque+/?=');
    assert.equal(url.searchParams.get('limit'), '7');
    assert.equal(init?.method ?? 'GET', 'GET');
    assert.equal(new Headers(init?.headers).get('x-lm-source-id'), scope.sourceId);
    assert.equal(init?.cache, 'no-store');
    assert.equal(init?.signal, signal);
    assert.equal(init?.body, undefined);
    return new Response(JSON.stringify(page()), { status: 200 });
  });
  assert.deepEqual(await api.getConceptHistory(scope.conceptId, scope.sourceId, { limit: 7, cursor: 'opaque+/?=', signal }), page());
  await assert.rejects(api.getConceptHistory(scope.conceptId, ''), /缺少当前知识源/);
  assert.equal(calls, 1);
});

test('clearing on concept/source switch or recall/demo entry aborts and discards late responses', async () => {
  const pending = deferred<ConceptHistory>();
  let signal: AbortSignal | undefined;
  const loader = createConceptHistoryLoader(scope, async (_id, _source, options) => { signal = options.signal; return pending.promise; });
  const loading = loader.refresh();
  assert.equal(loader.getSnapshot().loading, true);
  loader.clear();
  assert.equal(signal?.aborted, true);
  pending.resolve(page(['old-selection']));
  await loading;
  assert.equal(loader.getSnapshot().history, null);
  assert.equal(loader.getSnapshot().error, null);
});

test('a retry supersedes slow requests even if transport ignores abort', async () => {
  const first = deferred<ConceptHistory>();
  let calls = 0;
  const loader = createConceptHistoryLoader(scope, async () => ++calls === 1 ? first.promise : page(['fresh']));
  const old = loader.refresh();
  await loader.retry();
  first.resolve(page(['obsolete']));
  await old;
  assert.equal(loader.getSnapshot().history?.entries[0].event.eventId, 'fresh');
});

test('rejects cross-source, cross-concept and changed-version responses', async () => {
  for (const invalid of [{ sourceId: 'other' }, { conceptId: 'other' }, { sourceRevision: 'other' }]) {
    const loader = createConceptHistoryLoader(scope, async () => ({ ...page(['private']), ...invalid }));
    await loader.refresh();
    assert.equal(loader.getSnapshot().history, null);
    assert.match(loader.getSnapshot().error ?? '', /来源或版本已变化/);
  }
});

test('pagination failures retain history; retry uses the failed cursor and suppresses duplicates', async () => {
  let fail = true;
  const cursors: Array<string | undefined> = [];
  const fetcher: HistoryFetcher = async (_id, _source, options) => {
    cursors.push(options.cursor);
    if (!options.cursor) return page(['a'], 2, 'next');
    if (fail) { fail = false; throw new Error('temporary outage'); }
    return page(['a', 'b'], 2);
  };
  const loader = createConceptHistoryLoader(scope, fetcher);
  await loader.refresh();
  await loader.loadMore();
  assert.equal(loader.getSnapshot().history?.entries.length, 1);
  assert.equal(loader.getSnapshot().error, 'temporary outage');
  await loader.retry();
  assert.deepEqual(cursors, [undefined, 'next', 'next']);
  assert.deepEqual(loader.getSnapshot().history?.entries.map((item) => item.event.eventId), ['a', 'b']);
  assert.equal(loader.getSnapshot().history?.nextCursor, null);
});

test('clock refresh retains loaded pages and updates current state without overwriting stored events', async () => {
  let tick = 0;
  const loader = createConceptHistoryLoader(scope, async (_id, _source, options) => {
    if (options.cursor) return page(['b'], 2);
    const next = page(['a'], 2, 'next');
    next.asOf = String(++tick);
    next.state.reason = `projection-${tick}`;
    return next;
  });
  await loader.refresh();
  await loader.loadMore();
  const events = loader.getSnapshot().history?.entries;
  await loader.refresh();
  assert.equal(loader.getSnapshot().history?.entries, events);
  assert.equal(loader.getSnapshot().history?.state.reason, 'projection-2');
  assert.equal(loader.getSnapshot().history?.nextCursor, null);
});

test('a backdated insertion during pagination reloads the head to avoid skipped records', async () => {
  let changed = false;
  const loader = createConceptHistoryLoader(scope, async (_id, _source, options) => {
    if (options.cursor) { changed = true; return page(['old'], 3); }
    return changed ? page(['head', 'backdated', 'old'], 3) : page(['head'], 2, 'next');
  });
  await loader.refresh();
  await loader.loadMore();
  assert.deepEqual(loader.getSnapshot().history?.entries.map((item) => item.event.eventId), ['head', 'backdated', 'old']);
  assert.equal(loader.getSnapshot().loading, false);
  assert.equal(loader.getSnapshot().loadingMore, false);
});

test('duplicate load-more actions share the in-flight page', async () => {
  const next = deferred<ConceptHistory>();
  let count = 0;
  const loader = createConceptHistoryLoader(scope, async () => ++count === 1 ? page(['a'], 2, 'next') : next.promise);
  await loader.refresh();
  const more = loader.loadMore();
  await loader.loadMore();
  assert.equal(count, 2);
  next.resolve(page(['b'], 2));
  await more;
  assert.equal(loader.getSnapshot().history?.entries.length, 2);
});

test('a learning change arriving during a read queues a refresh instead of losing the invalidation', async () => {
  const old = deferred<ConceptHistory>();
  let count = 0;
  const loader = createConceptHistoryLoader(scope, async () => ++count === 1 ? old.promise : page(['new-review']));
  const read = loader.refresh();
  await loader.refresh();
  old.resolve(page());
  await read;
  await Promise.resolve();
  assert.equal(count, 2);
  assert.equal(loader.getSnapshot().history?.entries[0].event.eventId, 'new-review');
});
