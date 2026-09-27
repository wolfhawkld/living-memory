import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LearningOverview, LearningOverviewItem } from '../src/shared/learning-overview';
import type { Concept, Snapshot } from '../src/shared/types';
import { createLearningOverviewLoader, resolveOverviewSelection } from '../src/web/learning-overview-loader';
import { api, ApiRequestError } from '../src/web/api';

const sourceId = 'private-space';
function overview(asOf = '2026-09-27T10:00:00Z'): LearningOverview { return { sourceId, asOf, items: [] }; }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test('overview read is namespace-bound, uncached and cancellable, without a write token or payload', async (t) => {
  const signal = new AbortController().signal;
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    assert.equal(url, '/api/learning-overview');
    assert.equal(init?.method ?? 'GET', 'GET');
    assert.equal(new Headers(init?.headers).get('x-lm-source-id'), sourceId);
    assert.equal(new Headers(init?.headers).get('x-lm-token'), null);
    assert.equal(init?.cache, 'no-store');
    assert.equal(init?.signal, signal);
    assert.equal(init?.body, undefined);
    return new Response(JSON.stringify(overview()));
  });
  assert.deepEqual(await api.getLearningOverview(sourceId, signal), overview());
  await assert.rejects(api.getLearningOverview(''), /缺少当前知识源/);
  assert.equal(calls, 1);
});

test('closing or changing scope aborts the request and discards late overview data', async () => {
  const pending = deferred<LearningOverview>();
  let signal: AbortSignal | undefined;
  const loader = createLearningOverviewLoader(sourceId, async (_source, nextSignal) => { signal = nextSignal; return pending.promise; });
  const reading = loader.refresh();
  loader.clear();
  assert.equal(signal?.aborted, true);
  pending.resolve(overview());
  await reading;
  assert.deepEqual(loader.getSnapshot(), { overview: null, loading: false, error: null });
});

test('a fresh read wins over a superseded response, and ordinary failures preserve clearly stale data', async () => {
  const slow = deferred<LearningOverview>();
  let calls = 0;
  const latest = overview('2026-09-27T11:00:00Z');
  const loader = createLearningOverviewLoader(sourceId, async () => {
    calls += 1;
    if (calls === 1) return slow.promise;
    if (calls === 2) return latest;
    throw new Error('暂时离线');
  });
  const first = loader.refresh();
  await loader.refresh();
  slow.resolve(overview());
  await first;
  assert.deepEqual(loader.getSnapshot().overview, latest);
  await loader.refresh();
  assert.deepEqual(loader.getSnapshot(), { overview: latest, loading: false, error: '暂时离线' });
});

test('source mismatch and authentication loss clear previously loaded private data', async () => {
  for (const mismatch of ['response', 'SOURCE_MISMATCH', 'AUTH_REQUIRED']) {
    let calls = 0;
    const loader = createLearningOverviewLoader(sourceId, async () => {
      if (++calls === 1) return overview();
      if (mismatch === 'response') return { ...overview(), sourceId: 'other-space' };
      throw new ApiRequestError('账号或来源变化', { code: mismatch });
    });
    await loader.refresh();
    assert.ok(loader.getSnapshot().overview);
    await loader.refresh();
    assert.equal(loader.getSnapshot().overview, null);
    assert.equal(loader.getSnapshot().loading, false);
    assert.ok(loader.getSnapshot().error);
  }
});

test('navigation checks fresh full-index identity and source version before selecting a node', () => {
  const concept: Concept = { id: 'beyond-graph-limit', title: '目标概念', domain: 'ignored', aliases: [], body: '', summary: '', source: { path: 'Other/Target.md', revision: 'v1' } };
  // This test exercises identity guards only; no other row metadata is consumed by navigation.
  const item = { conceptId: concept.id, sourceRevision: 'v1' } as LearningOverviewItem;
  const data = { ...overview(), items: [item] };
  const snapshot: Snapshot = { concepts: [concept], links: [], source: { name: 'test', mode: 'local', conceptCount: 1, limit: 1, diagnostics: [] },
    config: { modelVersion: 'time-only-v0', revision: 1, halfLifeDays: 7 }, states: {}, observationsCount: 0, asOf: data.asOf };
  assert.equal(resolveOverviewSelection(sourceId, data, item, snapshot), concept);
  assert.throws(() => resolveOverviewSelection('another-account', data, item, snapshot), /知识空间已变化/);
  assert.throws(() => resolveOverviewSelection(sourceId, overview(), item, snapshot), /不在当前总览/);
  assert.throws(() => resolveOverviewSelection(sourceId, data, item, { ...snapshot, concepts: [] }), /移除或更新/);
  assert.throws(() => resolveOverviewSelection(sourceId, data, item, { ...snapshot, concepts: [{ ...concept, source: { ...concept.source, revision: 'v2' } }] }), /移除或更新/);
});
