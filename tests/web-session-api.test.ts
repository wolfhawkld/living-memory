import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeApp, createApp, type LivingMemoryApp } from '../src/server/app.js';
import { api, subscribeToSessionRecovery, type SessionResponse } from '../src/web/api.ts';

interface RunningApp {
  app: LivingMemoryApp;
  server: Server;
  port: number;
  root: string;
  dataDir: string;
  stop: () => Promise<void>;
}

interface FetchCall {
  path: string;
  method: string;
  cache?: RequestCache;
  headers: Headers;
  body?: string;
  responseHeaders?: Headers;
}

const conceptFile = (title: string, summary: string): string => [
  '---',
  'type: concept',
  `title: ${title}`,
  'aliases: [alias]',
  `summary: ${summary}`,
  '---',
  '',
  `正文：${summary}`,
  '',
].join('\n');

function sourceFixture(prefix = 'living-memory-web-api-'): { root: string; dataDir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), `${prefix}source-`));
  const dataDir = mkdtempSync(join(tmpdir(), `${prefix}data-`));
  writeFileSync(join(root, 'Boolean.md'), conceptFile('布尔逻辑', '真值判断'));
  writeFileSync(join(root, 'Decision.md'), conceptFile('决策表', '条件组合'));
  return {
    root,
    dataDir,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function startApp(root: string, dataDir: string, now = '2026-09-17T10:00:00.000Z'): Promise<RunningApp> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  let currentNow = now;
  const app = createApp({
    root,
    dataDir,
    port,
    now: () => new Date(currentNow),
    staticDir: join(dataDir, 'no-dist'),
  });
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  return {
    app,
    server,
    port,
    root,
    dataDir,
    stop: async () => {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
      closeApp(app);
    },
  };
}

function installFetchProxy(running: RunningApp): { calls: FetchCall[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const inputUrl = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    const url = new URL(inputUrl, `http://127.0.0.1:${running.port}`);
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    for (const [key, value] of new Headers(init?.headers)) headers.set(key, value);
    // The app validates the configured service port. The test server itself
    // uses the same ephemeral port, so this also exercises that guard.
    headers.set('host', `127.0.0.1:${running.port}`);
    const call: FetchCall = {
      path: `${url.pathname}${url.search}`,
      method: init?.method ?? (input instanceof Request ? input.method : 'GET'),
      cache: init?.cache,
      headers,
      ...(typeof init?.body === 'string' ? { body: init.body } : {}),
    };
    calls.push(call);
    const response = await original(url, { ...init, headers });
    call.responseHeaders = new Headers(response.headers);
    return response;
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

async function session(): Promise<SessionResponse> {
  return api.getSession();
}

function reviewCalls(calls: FetchCall[]): FetchCall[] {
  return calls.filter((call) => call.path === '/api/reviews');
}

function assertSourceOnApiCalls(calls: FetchCall[], sourceId: string): void {
  for (const call of calls.filter((item) => item.path !== '/api/session')) {
    assert.equal(call.headers.get('x-lm-source-id'), sourceId, `${call.method} ${call.path} must carry the source namespace`);
  }
}

test('renews a stale Web session and replays one frozen review without duplicating its anchor', async () => {
  const fixture = sourceFixture();
  let first: RunningApp | undefined;
  let restarted: RunningApp | undefined;
  let restoreFetch: (() => void) | undefined;
  const recoveryEvents: Array<{ kind: string; sourceId?: string }> = [];
  const unsubscribe = subscribeToSessionRecovery((event) => recoveryEvents.push(event));
  try {
    first = await startApp(fixture.root, fixture.dataDir);
    const firstProxy = installFetchProxy(first);
    restoreFetch = firstProxy.restore;
    const oldSession = await session();
    assert.equal(firstProxy.calls.at(-1)?.path, '/api/session');
    assert.equal(firstProxy.calls.at(-1)?.cache, 'no-store');
    assert.equal(firstProxy.calls.at(-1)?.responseHeaders?.get('cache-control'), 'no-store');
    const initial = await api.getSnapshot(undefined, oldSession.sourceId);
    const concept = initial.concepts[0];
    await first.stop();
    firstProxy.restore();
    restoreFetch = undefined;
    first = undefined;

    restarted = await startApp(fixture.root, fixture.dataDir, '2026-09-20T10:00:00.000Z');
    const proxy = installFetchProxy(restarted);
    restoreFetch = proxy.restore;
    const frozenReview = {
      eventId: 'web-restart-review',
      conceptId: concept.id,
      sourceRevision: concept.source.revision,
      kind: 'review' as const,
      occurredAt: '2026-09-15T12:34:56Z',
    };
    const accepted = await api.postReview(frozenReview, oldSession.writeToken, oldSession.sourceId);
    assert.deepEqual(accepted, { status: 'accepted', eventId: frozenReview.eventId });
    const duplicate = await api.postReview(frozenReview, oldSession.writeToken, oldSession.sourceId);
    assert.deepEqual(duplicate, { status: 'duplicate', eventId: frozenReview.eventId });

    const reviewRequests = reviewCalls(proxy.calls);
    assert.equal(reviewRequests.length, 4, 'both the original and duplicate call should have one stale attempt and one retry');
    assert.deepEqual(reviewRequests.map((call) => call.body), [
      JSON.stringify(frozenReview),
      JSON.stringify(frozenReview),
      JSON.stringify(frozenReview),
      JSON.stringify(frozenReview),
    ]);
    const currentSession = await api.getSession();
    assert.deepEqual(reviewRequests.map((call) => call.headers.get('x-lm-token')), [
      oldSession.writeToken,
      currentSession.writeToken,
      oldSession.writeToken,
      currentSession.writeToken,
    ]);
    assertSourceOnApiCalls(proxy.calls, oldSession.sourceId);
    assert.equal(recoveryEvents.filter((event) => event.kind === 'recovered').length, 2);

    const after = await api.getSnapshot(undefined, currentSession.sourceId);
    const state = after.states[concept.id];
    assert.equal(state.anchor?.eventId, frozenReview.eventId);
    assert.equal(state.anchor?.occurredAt, '2026-09-15T12:34:56.000Z');
    const exported = JSON.parse(await (await api.exportData(currentSession.writeToken, currentSession.sourceId)).text()) as { anchors: unknown[] };
    assert.equal(exported.anchors.filter((anchor) => (anchor as { eventId?: string }).eventId === frozenReview.eventId).length, 1);
    proxy.restore();
    restoreFetch = undefined;
  } finally {
    unsubscribe();
    restoreFetch?.();
    if (first) await first.stop();
    if (restarted) await restarted.stop();
    fixture.cleanup();
  }
});

test('recovers an expired session for layout autosave and keeps the exact payload', async () => {
  const fixture = sourceFixture('living-memory-layout-');
  let first: RunningApp | undefined;
  let restarted: RunningApp | undefined;
  let restoreFetch: (() => void) | undefined;
  try {
    first = await startApp(fixture.root, fixture.dataDir);
    const oldProxy = installFetchProxy(first);
    restoreFetch = oldProxy.restore;
    const oldSession = await session();
    const snapshot = await api.getSnapshot(undefined, oldSession.sourceId);
    const layout = { [snapshot.concepts[0].id]: { x: 1.25, y: -2, z: 3.5 } };
    await first.stop();
    oldProxy.restore();
    restoreFetch = undefined;
    first = undefined;

    restarted = await startApp(fixture.root, fixture.dataDir);
    const proxy = installFetchProxy(restarted);
    restoreFetch = proxy.restore;
    assert.deepEqual(await api.putLayout(layout, oldSession.writeToken, oldSession.sourceId), layout);
    const layoutRequests = proxy.calls.filter((call) => call.path === '/api/layout' && call.method === 'PUT');
    assert.equal(layoutRequests.length, 2);
    assert.deepEqual(layoutRequests.map((call) => call.body), [JSON.stringify(layout), JSON.stringify(layout)]);
    assert.deepEqual(layoutRequests.map((call) => call.headers.get('x-lm-source-id')), [oldSession.sourceId, oldSession.sourceId]);
    assert.deepEqual(await api.getLayout(oldSession.sourceId), layout);
    proxy.restore();
    restoreFetch = undefined;
  } finally {
    restoreFetch?.();
    if (first) await first.stop();
    if (restarted) await restarted.stop();
    fixture.cleanup();
  }
});

test('rejects an old source session before writing into a restarted service with another source', async () => {
  const firstFixture = sourceFixture('living-memory-source-a-');
  const secondFixture = sourceFixture('living-memory-source-b-');
  let first: RunningApp | undefined;
  let second: RunningApp | undefined;
  let restoreFetch: (() => void) | undefined;
  const events: Array<{ kind: string; sourceId?: string }> = [];
  const unsubscribe = subscribeToSessionRecovery((event) => events.push(event));
  try {
    first = await startApp(firstFixture.root, firstFixture.dataDir);
    const firstProxy = installFetchProxy(first);
    restoreFetch = firstProxy.restore;
    const oldSession = await session();
    const initial = await api.getSnapshot(undefined, oldSession.sourceId);
    const concept = initial.concepts[0];
    const review = {
      eventId: 'source-a-review',
      conceptId: concept.id,
      sourceRevision: concept.source.revision,
      kind: 'review' as const,
      occurredAt: '2026-09-16T12:00:00Z',
    };
    await api.postReview(review, oldSession.writeToken, oldSession.sourceId);
    await first.stop();
    firstProxy.restore();
    restoreFetch = undefined;
    first = undefined;

    second = await startApp(secondFixture.root, firstFixture.dataDir);
    const proxy = installFetchProxy(second);
    restoreFetch = proxy.restore;
    await assert.rejects(
      api.postReview(review, oldSession.writeToken, oldSession.sourceId),
      (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'SOURCE_MISMATCH',
    );
    const rejectedReview = proxy.calls.filter((call) => call.path === '/api/reviews');
    assert.equal(rejectedReview.length, 1, 'the stale write may reach the source guard, but must be rejected before the route writes');
    assert.equal(rejectedReview[0].headers.get('x-lm-source-id'), oldSession.sourceId);
    assert.equal(rejectedReview[0].headers.get('x-lm-token'), oldSession.writeToken);
    assert.equal(rejectedReview[0].body, JSON.stringify(review));
    const newSession = await api.getSession();
    const newSnapshot = await api.getSnapshot(undefined, newSession.sourceId);
    assert.equal(newSnapshot.states[newSnapshot.concepts[0].id].anchor, null);
    assert.ok(events.some((event) => event.kind === 'source-mismatch'));
    for (const call of proxy.calls.filter((item) => item.path !== '/api/session' && item.path !== '/api/reviews')) {
      assert.equal(call.headers.get('x-lm-source-id'), newSession.sourceId);
    }
    proxy.restore();
    restoreFetch = undefined;
  } finally {
    unsubscribe();
    restoreFetch?.();
    if (first) await first.stop();
    if (second) await second.stop();
    firstFixture.cleanup();
    secondFixture.cleanup();
  }
});
