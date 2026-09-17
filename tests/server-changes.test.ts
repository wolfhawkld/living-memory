import { strict as assert } from 'node:assert';
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeApp, createApp, type LivingMemoryApp } from '../src/server/app.js';

interface ResponseData {
  status: number;
  body: string;
  json: <T>() => T;
}

interface ChangeNotification {
  sourceId: string;
  revision: number;
  reason: 'connected' | 'source' | 'review' | 'observation' | 'config';
}

interface RunningApp {
  app: LivingMemoryApp;
  port: number;
  root: string;
  request: (path: string, options?: { method?: string; body?: unknown; headers?: Record<string, string> }) => Promise<ResponseData>;
  closeApp: () => void;
  stop: () => Promise<void>;
}

interface ChangeFeed {
  response: IncomingMessage;
  next: (timeoutMs?: number) => Promise<ChangeNotification>;
  disconnect: () => Promise<void>;
  closed: Promise<void>;
}

interface Snapshot {
  concepts: Array<{ id: string; source: { path: string; revision: string }; summary: string }>;
  config: { revision: number; halfLifeDays: number };
  states: Record<string, { status: string; anchor: { eventId: string } | null }>;
}

const conceptFile = (summary: string): string => [
  '---',
  'type: concept',
  'title: Alpha',
  'aliases: [A]',
  `summary: ${summary}`,
  '---',
  '',
  '# Alpha',
  '',
  `> ${summary}`,
  '',
].join('\n');

function sourceFixture(): { root: string; dataDir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'living-memory-changes-source-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'living-memory-changes-data-'));
  writeFileSync(join(root, 'Alpha.md'), conceptFile('初始内容'));
  return {
    root,
    dataDir,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function running(): Promise<RunningApp> {
  const fixture = sourceFixture();
  const app = createApp({
    root: fixture.root,
    dataDir: fixture.dataDir,
    port: 4317,
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    staticDir: join(fixture.dataDir, 'no-dist'),
  });
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  let appClosed = false;

  const send = (path: string, options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) => new Promise<ResponseData>((resolve, reject) => {
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path,
      method: options.method ?? 'GET',
      headers: {
        host: '127.0.0.1:4317',
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(options.headers ?? {}),
      },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        body: text,
        json: <T>() => JSON.parse(text) as T,
      }));
    });
    req.once('error', reject);
    if (body) req.write(body);
    req.end();
  });

  const shutdownApp = (): void => {
    if (appClosed) return;
    appClosed = true;
    closeApp(app);
  };

  return {
    app,
    port,
    root: fixture.root,
    request: send,
    closeApp: shutdownApp,
    stop: async () => {
      shutdownApp();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      fixture.cleanup();
    },
  };
}

const tokenHeaders = (token: string): Record<string, string> => ({ 'x-lm-token': token });

async function openChanges(client: RunningApp, headers: Record<string, string> = {}): Promise<ChangeFeed> {
  return new Promise<ChangeFeed>((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1',
      port: client.port,
      path: '/api/changes',
      headers: { host: '127.0.0.1:4317', ...headers },
    }, (response) => {
      if (response.statusCode !== 200) {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => reject(new Error(`changes expected 200, got ${response.statusCode}: ${body}`)));
        return;
      }

      response.setEncoding('utf8');
      let buffer = '';
      let didClose = false;
      const queue: ChangeNotification[] = [];
      const waiters: Array<{
        resolve: (event: ChangeNotification) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }> = [];
      let resolveClosed!: () => void;
      const closed = new Promise<void>((closedResolve) => { resolveClosed = closedResolve; });

      const rejectWaiters = (error: Error): void => {
        while (waiters.length) {
          const waiter = waiters.shift()!;
          clearTimeout(waiter.timer);
          waiter.reject(error);
        }
      };

      const enqueue = (event: ChangeNotification): void => {
        const waiter = waiters.shift();
        if (waiter) {
          clearTimeout(waiter.timer);
          waiter.resolve(event);
        } else {
          queue.push(event);
        }
      };

      const parseFrames = (): void => {
        while (true) {
          const boundary = buffer.indexOf('\n\n');
          if (boundary < 0) return;
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice('data:'.length).trim())
            .join('\n');
          if (data) enqueue(JSON.parse(data) as ChangeNotification);
        }
      };

      response.on('data', (chunk) => {
        buffer += chunk;
        parseFrames();
      });
      response.on('close', () => {
        if (didClose) return;
        didClose = true;
        rejectWaiters(new Error('SSE closed'));
        resolveClosed();
      });
      response.on('error', (error) => {
        if (!didClose) rejectWaiters(error instanceof Error ? error : new Error(String(error)));
      });

      const feed: ChangeFeed = {
        response,
        next: (timeoutMs = 1_000) => {
          if (queue.length) return Promise.resolve(queue.shift()!);
          if (didClose) return Promise.reject(new Error('SSE closed'));
          return new Promise<ChangeNotification>((nextResolve, nextReject) => {
            const timer = setTimeout(() => {
              const index = waiters.findIndex((item) => item.resolve === nextResolve);
              if (index >= 0) waiters.splice(index, 1);
              nextReject(new Error('SSE timed out waiting for notification'));
            }, timeoutMs);
            waiters.push({ resolve: nextResolve, reject: nextReject, timer });
          });
        },
        disconnect: async () => {
          response.destroy();
          await closed;
        },
        closed,
      };
      resolve(feed);
    });
    req.once('error', reject);
    req.end();
  });
}

async function session(client: RunningApp): Promise<{ writeToken: string; sourceId: string }> {
  const response = await client.request('/api/session');
  assert.equal(response.status, 200);
  return response.json();
}

function snapshot(client: RunningApp): Promise<Snapshot> {
  return client.request('/api/snapshot').then((response) => {
    assert.equal(response.status, 200);
    return response.json<Snapshot>();
  });
}

function alpha(snapshotValue: Snapshot) {
  const concept = snapshotValue.concepts.find((item) => item.source.path === 'Alpha.md');
  assert.ok(concept, 'fixture concept should be present');
  return concept;
}

async function expectNoNotification(feed: ChangeFeed): Promise<void> {
  await assert.rejects(feed.next(150), /SSE timed out/);
}

test('change feed publishes source and accepted write reasons while snapshots stay synchronized', async () => {
  const client = await running();
  let feed: ChangeFeed | undefined;
  try {
    feed = await openChanges(client);
    const connected = await feed.next();
    const currentSession = await session(client);
    assert.deepEqual(connected, { sourceId: currentSession.sourceId, revision: 0, reason: 'connected' });

    const before = await snapshot(client);
    const original = alpha(before);
    const originalRevision = original.source.revision;
    const initialExport = (await client.request('/api/export')).json<{ anchors: unknown[] }>();
    assert.equal(initialExport.anchors.length, 0);
    assert.equal(before.states[original.id].anchor, null);

    assert.equal((await client.request('/api/refresh', { method: 'POST', body: {} })).status, 401);
    assert.equal((await client.request('/api/reviews', { method: 'POST', body: {} })).status, 401);
    await expectNoNotification(feed);

    writeFileSync(join(client.root, 'Alpha.md'), conceptFile('刷新后的内容'));
    const refreshed = await client.request('/api/refresh', { method: 'POST', headers: tokenHeaders(currentSession.writeToken), body: {} });
    assert.equal(refreshed.status, 200);
    const sourceEvent = await feed.next();
    assert.deepEqual(sourceEvent, { sourceId: currentSession.sourceId, revision: 1, reason: 'source' });

    const afterRefresh = await snapshot(client);
    const changed = alpha(afterRefresh);
    assert.notEqual(changed.source.revision, originalRevision);
    assert.equal(changed.summary, '刷新后的内容');
    assert.equal(afterRefresh.states[changed.id].anchor, null, 'refresh must not create an anchor');
    assert.equal((await client.request('/api/export')).json<{ anchors: unknown[] }>().anchors.length, 0);

    const review = {
      eventId: 'confirm-revisit',
      conceptId: changed.id,
      sourceRevision: changed.source.revision,
      kind: 'review' as const,
      occurredAt: '2026-01-01T00:00:00.000Z',
    };
    const accepted = await client.request('/api/reviews', {
      method: 'POST',
      headers: tokenHeaders(currentSession.writeToken),
      body: review,
    });
    assert.equal(accepted.status, 201);
    assert.deepEqual(await feed.next(), { sourceId: currentSession.sourceId, revision: 2, reason: 'review' });

    const afterReview = await snapshot(client);
    assert.equal(afterReview.states[changed.id].anchor?.eventId, review.eventId);
    assert.equal(afterReview.states[changed.id].status, 'recent');

    const duplicate = await client.request('/api/reviews', {
      method: 'POST',
      headers: tokenHeaders(currentSession.writeToken),
      body: review,
    });
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.json<{ status: string; eventId: string }>().status, 'duplicate');
    await expectNoNotification(feed);
    assert.equal((await client.request('/api/export')).json<{ anchors: unknown[] }>().anchors.length, 1);

    const config = await client.request('/api/config', {
      method: 'PUT',
      headers: tokenHeaders(currentSession.writeToken),
      body: { halfLifeDays: 14, revision: afterReview.config.revision },
    });
    assert.equal(config.status, 200);
    assert.deepEqual(await feed.next(), { sourceId: currentSession.sourceId, revision: 3, reason: 'config' });

    const afterConfig = await snapshot(client);
    const observation = await client.request('/api/observations', {
      method: 'POST',
      headers: tokenHeaders(currentSession.writeToken),
      body: {
        eventId: 'synced-observation',
        conceptId: changed.id,
        sourceRevision: changed.source.revision,
        observedAt: '2026-01-01T00:00:00.000Z',
        configRevision: afterConfig.config.revision,
        anchorEventId: review.eventId,
        answer: 'clear',
        rating: 'clear',
        exposure: 'unexposed',
        observedExposure: false,
      },
    });
    assert.equal(observation.status, 201);
    assert.deepEqual(await feed.next(), { sourceId: currentSession.sourceId, revision: 4, reason: 'observation' });

    const afterObservation = await snapshot(client);
    assert.equal(afterObservation.states[changed.id].anchor?.eventId, review.eventId);
    assert.equal((await client.request('/api/export')).json<{ anchors: unknown[]; observations: unknown[] }>().anchors.length, 1);
    assert.equal((await client.request('/api/export')).json<{ anchors: unknown[]; observations: unknown[] }>().observations.length, 1);
  } finally {
    if (feed) await feed.disconnect();
    await client.stop();
  }
});

test('token and source guards reject writes without changing the projection or feed revision', async () => {
  const client = await running();
  let feed: ChangeFeed | undefined;
  try {
    const currentSession = await session(client);
    feed = await openChanges(client);
    assert.deepEqual(await feed.next(), { sourceId: currentSession.sourceId, revision: 0, reason: 'connected' });
    const before = await snapshot(client);
    const concept = alpha(before);

    const wrongSource = `${currentSession.sourceId}-wrong`;
    const changesGuard = await client.request('/api/changes', { headers: { 'x-lm-source-id': wrongSource } });
    assert.equal(changesGuard.status, 409);
    assert.equal(changesGuard.json<{ error: { code: string } }>().error.code, 'SOURCE_MISMATCH');

    writeFileSync(join(client.root, 'Alpha.md'), conceptFile('guarded edit must not be loaded'));
    const refreshGuard = await client.request('/api/refresh', {
      method: 'POST',
      headers: { ...tokenHeaders(currentSession.writeToken), 'x-lm-source-id': wrongSource },
      body: {},
    });
    assert.equal(refreshGuard.status, 409);
    assert.equal(refreshGuard.json<{ error: { code: string } }>().error.code, 'SOURCE_MISMATCH');
    await expectNoNotification(feed);

    const afterRefreshGuard = await snapshot(client);
    assert.equal(alpha(afterRefreshGuard).summary, concept.summary);
    assert.equal((await client.request('/api/export')).json<{ anchors: unknown[] }>().anchors.length, 0);

    const reviewGuard = await client.request('/api/reviews', {
      method: 'POST',
      headers: { ...tokenHeaders(currentSession.writeToken), 'x-lm-source-id': wrongSource },
      body: {
        eventId: 'guarded-review',
        conceptId: concept.id,
        sourceRevision: concept.source.revision,
        kind: 'review',
      },
    });
    assert.equal(reviewGuard.status, 409);
    assert.equal(reviewGuard.json<{ error: { code: string } }>().error.code, 'SOURCE_MISMATCH');
    await expectNoNotification(feed);
    assert.equal((await client.request('/api/export')).json<{ anchors: unknown[] }>().anchors.length, 0);
  } finally {
    if (feed) await feed.disconnect();
    await client.stop();
  }
});

test('disconnecting and reconnecting reads the current revision, and closeApp closes SSE without hanging', async () => {
  const client = await running();
  let first: ChangeFeed | undefined;
  let second: ChangeFeed | undefined;
  try {
    const currentSession = await session(client);
    first = await openChanges(client, { 'x-lm-source-id': currentSession.sourceId });
    assert.deepEqual(await first.next(), { sourceId: currentSession.sourceId, revision: 0, reason: 'connected' });
    await first.disconnect();

    writeFileSync(join(client.root, 'Alpha.md'), conceptFile('reconnected source state'));
    const refresh = await client.request('/api/refresh', { method: 'POST', headers: tokenHeaders(currentSession.writeToken), body: {} });
    assert.equal(refresh.status, 200);

    second = await openChanges(client, { 'x-lm-source-id': currentSession.sourceId });
    assert.deepEqual(await second.next(), { sourceId: currentSession.sourceId, revision: 1, reason: 'connected' });
    const current = await snapshot(client);
    assert.equal(alpha(current).summary, 'reconnected source state');
    await expectNoNotification(second);

    client.closeApp();
    await second.closed;
    await assert.rejects(second.next(50), /SSE closed/);
  } finally {
    if (first) await first.disconnect().catch(() => undefined);
    if (second) await second.disconnect().catch(() => undefined);
    await client.stop();
  }
});
