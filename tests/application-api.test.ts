import { strict as assert } from 'node:assert';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeApp, createApp, type LivingMemoryApp } from '../src/server/app.js';
import type { ApplicationRecordRequest, Concept, ConceptHistory, ExportData, Snapshot } from '../src/shared/types.js';
import { api, type SessionResponse } from '../src/web/api.ts';

interface ResponseData {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
  json: <T>() => T;
}

interface RunningApp {
  app: LivingMemoryApp;
  root: string;
  dataDir: string;
  port: number;
  request: (path: string, options?: {
    method?: string;
    body?: unknown;
    cookie?: string;
    headers?: Record<string, string>;
  }) => Promise<ResponseData>;
  stop: () => Promise<void>;
}

interface SessionData {
  writeToken: string;
  sourceId: string;
}

interface ChangeEvent {
  sourceId: string;
  revision: number;
  reason: string;
}

interface ChangeFeed {
  next: (timeoutMs?: number) => Promise<ChangeEvent>;
  close: () => Promise<void>;
}

interface FetchCall {
  path: string;
  method: string;
  headers: Headers;
  body?: string;
}

const NOW = '2026-01-10T00:00:00.000Z';

function conceptFile(title: string, summary: string): string {
  return [
    '---',
    'type: concept',
    `title: ${title}`,
    'aliases: []',
    `summary: ${summary}`,
    '---',
    '',
    `# ${title}`,
    '',
    summary,
    '',
  ].join('\n');
}

function sourceFixture(): { root: string; dataDir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'living-memory-application-source-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'living-memory-application-data-'));
  mkdirSync(join(root, 'Math'), { recursive: true });
  writeFileSync(join(root, 'Math', 'Alpha.md'), conceptFile('Alpha', '数学中的一个概念。'));
  writeFileSync(join(root, 'Math', 'Beta.md'), conceptFile('Beta', '另一个可用于测试的概念。'));
  return {
    root,
    dataDir,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function running(options: {
  accountsEnabled?: boolean;
  root?: string;
  dataDir?: string;
  now?: string;
} = {}): Promise<RunningApp> {
  const fixture = options.root && options.dataDir
    ? { root: options.root, dataDir: options.dataDir, cleanup: () => undefined }
    : sourceFixture();
  const now = options.now ?? NOW;
  // Bind the real HTTP server first, then construct the app with that exact
  // bound port. This avoids a released-probe-port race when the full test
  // suite starts several HTTP workers in parallel.
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as { port: number }).port;
  const app = createApp({
    root: fixture.root,
    dataDir: fixture.dataDir,
    accountsEnabled: options.accountsEnabled,
    port,
    now: () => new Date(now),
    staticDir: join(fixture.dataDir, 'no-dist'),
  });
  server.on('request', app);
  let stopped = false;
  const request = (path: string, options: {
    method?: string;
    body?: unknown;
    cookie?: string;
    headers?: Record<string, string>;
  } = {}) => new Promise<ResponseData>((resolve, reject) => {
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path,
      method: options.method ?? 'GET',
      headers: {
        host: `127.0.0.1:${port}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(options.cookie ? { cookie: options.cookie } : {}),
        ...(options.headers ?? {}),
      },
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: text,
        json: <T>() => JSON.parse(text) as T,
      }));
    });
    req.once('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
  return {
    app,
    root: fixture.root,
    dataDir: fixture.dataDir,
    port,
    request,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      closeApp(app);
      fixture.cleanup();
    },
  };
}

function tokenHeaders(session: SessionData): Record<string, string> {
  return { 'x-lm-token': session.writeToken, 'x-lm-source-id': session.sourceId };
}

async function session(client: RunningApp, cookie?: string): Promise<SessionData> {
  const response = await client.request('/api/session', { cookie });
  assert.equal(response.status, 200);
  return response.json<SessionData>();
}

async function snapshot(client: RunningApp, cookie?: string): Promise<Snapshot> {
  const response = await client.request('/api/snapshot?scope=all', { cookie });
  assert.equal(response.status, 200);
  return response.json<Snapshot>();
}

function conceptAt(snapshotValue: Snapshot, path = 'Math/Alpha.md'): Concept {
  const concept = snapshotValue.concepts.find((item) => item.source.path === path);
  assert.ok(concept, `fixture concept ${path} should be present`);
  return concept;
}

function baseApplication(concept: Concept, overrides: Partial<ApplicationRecordRequest> = {}): ApplicationRecordRequest {
  return {
    eventId: 'application-1',
    conceptId: concept.id,
    sourceRevision: concept.source.revision,
    occurredAt: '2026-01-09T00:00:00Z',
    kind: 'application',
    context: '为一个需要强校验的编排器设计概念模型。',
    content: '我把问题拆为输入范围、风险约束和决策路径。',
    outcome: 'partial',
    assistance: 'independent',
    result: '完成了初版模型和边界列表。',
    limitations: '仍需用真实业务数据验证覆盖范围。',
    insight: '先区分校验层和推理层，有助于减少概念混用。',
    correction: '将“记得名称”与“能在场景中调用”分开记录。',
    references: '内部设计笔记。',
    ...overrides,
  };
}

function errorCode(response: ResponseData): string {
  return response.json<{ error?: { code?: string } }>().error?.code ?? '';
}

function openChanges(client: RunningApp, cookie?: string): Promise<ChangeFeed> {
  return new Promise<ChangeFeed>((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1',
      port: client.port,
      path: '/api/changes',
      headers: { host: `127.0.0.1:${client.port}`, ...(cookie ? { cookie } : {}) },
    }, (response: IncomingMessage) => {
      if (response.statusCode !== 200) {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => reject(new Error(`changes expected 200, got ${response.statusCode}: ${body}`)));
        return;
      }
      response.setEncoding('utf8');
      let buffer = '';
      let closed = false;
      const queue: ChangeEvent[] = [];
      const waiters: Array<{
        resolve: (event: ChangeEvent) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }> = [];
      const parseFrames = (): void => {
        while (true) {
          const boundary = buffer.indexOf('\n\n');
          if (boundary < 0) return;
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame.split('\n').filter((line) => line.startsWith('data:'))
            .map((line) => line.slice('data:'.length).trim()).join('\n');
          if (!data) continue;
          const waiter = waiters.shift();
          const event = JSON.parse(data) as ChangeEvent;
          if (waiter) {
            clearTimeout(waiter.timer);
            waiter.resolve(event);
          } else {
            queue.push(event);
          }
        }
      };
      response.on('data', (chunk) => { buffer += chunk; parseFrames(); });
      response.on('close', () => {
        closed = true;
        while (waiters.length) {
          const waiter = waiters.shift()!;
          clearTimeout(waiter.timer);
          waiter.reject(new Error('SSE closed'));
        }
      });
      resolve({
        next: (timeoutMs = 1_000) => {
          if (queue.length) return Promise.resolve(queue.shift()!);
          if (closed) return Promise.reject(new Error('SSE closed'));
          return new Promise<ChangeEvent>((nextResolve, nextReject) => {
            const timer = setTimeout(() => {
              const index = waiters.findIndex((item) => item.resolve === nextResolve);
              if (index >= 0) waiters.splice(index, 1);
              nextReject(new Error('SSE timed out waiting for notification'));
            }, timeoutMs);
            waiters.push({ resolve: nextResolve, reject: nextReject, timer });
          });
        },
        close: async () => {
          response.destroy();
        },
      });
    });
    req.once('error', reject);
    req.end();
  });
}

function installFetchProxy(client: RunningApp): { calls: FetchCall[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const inputUrl = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    const url = new URL(inputUrl, `http://127.0.0.1:${client.port}`);
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    for (const [key, value] of new Headers(init?.headers)) headers.set(key, value);
    headers.set('host', `127.0.0.1:${client.port}`);
    calls.push({
      path: `${url.pathname}${url.search}`,
      method: init?.method ?? (input instanceof Request ? input.method : 'GET'),
      headers,
      ...(typeof init?.body === 'string' ? { body: init.body } : {}),
    });
    return original(url, { ...init, headers });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('application and summary records are private history events independent from memory state', async () => {
  const client = await running();
  let feed: ChangeFeed | undefined;
  try {
    const currentSession = await session(client);
    const initial = await snapshot(client);
    const concept = conceptAt(initial);
    const headers = tokenHeaders(currentSession);
    const before = (await client.request('/api/export')).json<ExportData>();
    const beforeState = initial.states[concept.id];
    const beforeObservations = initial.observationsCount;

    feed = await openChanges(client);
    const connected = await feed.next();
    assert.deepEqual(connected, { sourceId: currentSession.sourceId, revision: 0, reason: 'connected' });

    const application = baseApplication(concept);
    const accepted = await client.request('/api/applications', { method: 'POST', headers, body: application });
    assert.equal(accepted.status, 201);
    assert.deepEqual(accepted.json(), { status: 'accepted', eventId: application.eventId });
    const applicationChange = await feed.next();
    assert.equal(applicationChange.sourceId, currentSession.sourceId);
    assert.equal(applicationChange.reason, 'application');
    assert.deepEqual(Object.keys(applicationChange).sort(), ['reason', 'revision', 'sourceId']);

    const duplicate = await client.request('/api/applications', { method: 'POST', headers, body: application });
    assert.equal(duplicate.status, 200);
    assert.deepEqual(duplicate.json(), { status: 'duplicate', eventId: application.eventId });
    await assert.rejects(feed.next(150), /timed out/);

    const summary = baseApplication(concept, {
      eventId: 'summary-1',
      kind: 'summary',
      occurredAt: '2026-01-08T00:00:00Z',
      context: '完成一轮关于校验模型的阅读。',
      content: '用自己的话总结了布尔逻辑、决策表和有向图之间的联系。',
      outcome: 'success',
      assistance: 'resources',
    });
    assert.equal((await client.request('/api/applications', { method: 'POST', headers, body: summary })).status, 201);

    const after = await snapshot(client);
    assert.deepEqual(after.states[concept.id], beforeState, 'application records do not advance decay or anchors');
    assert.equal(after.observationsCount, beforeObservations);
    const exported = (await client.request('/api/export')).json<ExportData>();
    assert.equal(exported.applications?.length, 2);
    assert.deepEqual(exported.anchors, before.anchors);
    assert.deepEqual(exported.observations, before.observations);
    assert.deepEqual(exported.retentions, before.retentions);

    const history = (await client.request(`/api/concepts/${encodeURIComponent(concept.id)}/history`)).json<ConceptHistory>();
    assert.equal(history.total, 2);
    assert.deepEqual(history.entries.map((entry) => entry.type), ['application', 'application']);
    const first = history.entries[0];
    assert.equal(first.type, 'application');
    if (first.type === 'application') {
      assert.equal(first.event.eventId, application.eventId);
      assert.equal(first.event.kind, 'application');
      assert.equal(first.event.occurredAt, '2026-01-09T00:00:00.000Z');
      assert.equal(first.event.recordedAt, NOW);
      assert.equal(first.event.content, application.content);
    }
  } finally {
    await feed?.close();
    await client.stop();
  }
});

test('application writes enforce source, date, required fields, length, authorization and event idempotency', async () => {
  const client = await running();
  try {
    const currentSession = await session(client);
    const initial = await snapshot(client);
    const concept = conceptAt(initial);
    const headers = tokenHeaders(currentSession);
    const body = baseApplication(concept, { eventId: 'validation-application' });

    const noToken = await client.request('/api/applications', { method: 'POST', body });
    assert.equal(noToken.status, 401);
    assert.equal(errorCode(noToken), 'TOKEN_REQUIRED');

    const wrongSource = await client.request('/api/applications', {
      method: 'POST',
      headers: { ...headers, 'x-lm-source-id': 'wrong-source' },
      body: { ...body, eventId: 'wrong-source-application' },
    });
    assert.equal(wrongSource.status, 409);

    const future = await client.request('/api/applications', {
      method: 'POST', headers,
      body: { ...body, eventId: 'future-application', occurredAt: '2026-01-11T00:00:00Z' },
    });
    assert.equal(future.status, 400);
    assert.equal(errorCode(future), 'FUTURE_EVENT');

    const missingContext = await client.request('/api/applications', {
      method: 'POST', headers,
      body: { ...body, eventId: 'missing-context', context: '' },
    });
    assert.equal(missingContext.status, 400);

    const tooLongContent = await client.request('/api/applications', {
      method: 'POST', headers,
      body: { ...body, eventId: 'long-content', content: 'x'.repeat(12_001) },
    });
    assert.equal(tooLongContent.status, 400);

    const tooLongContext = await client.request('/api/applications', {
      method: 'POST', headers,
      body: { ...body, eventId: 'long-context', context: 'x'.repeat(4_001) },
    });
    assert.equal(tooLongContext.status, 400);

    assert.equal((await client.request('/api/applications', { method: 'POST', headers, body })).status, 201);
    const changedPayload = await client.request('/api/applications', {
      method: 'POST', headers,
      body: { ...body, content: '同一事件 ID 的不同内容。' },
    });
    assert.equal(changedPayload.status, 409);
    assert.equal(errorCode(changedPayload), 'EVENT_CONFLICT');

    const reviewConflict = await client.request('/api/reviews', {
      method: 'POST', headers,
      body: { eventId: 'review-shared-id', conceptId: concept.id, sourceRevision: concept.source.revision, kind: 'review', occurredAt: '2026-01-09T00:00:00Z' },
    });
    assert.equal(reviewConflict.status, 201);
    const applicationConflict = await client.request('/api/applications', {
      method: 'POST', headers,
      body: { ...body, eventId: 'review-shared-id' },
    });
    assert.equal(applicationConflict.status, 409);
    assert.equal(errorCode(applicationConflict), 'EVENT_CONFLICT');

    const wrongRevision = await client.request('/api/applications', {
      method: 'POST', headers,
      body: { ...body, eventId: 'wrong-revision', sourceRevision: 'stale-source-revision' },
    });
    assert.equal(wrongRevision.status, 409);
    assert.equal(errorCode(wrongRevision), 'SOURCE_REVISION_MISMATCH');
    const after = (await client.request('/api/export')).json<ExportData>();
    assert.equal(after.applications?.filter((item) => item.eventId === 'wrong-revision').length, 0);
  } finally {
    await client.stop();
  }
});

test('an application duplicate remains retryable after source revision changes, while a new stale write is rejected', async () => {
  const client = await running();
  try {
    const currentSession = await session(client);
    const initial = await snapshot(client);
    const concept = conceptAt(initial);
    const headers = tokenHeaders(currentSession);
    const application = baseApplication(concept, { eventId: 'source-refresh-application' });
    assert.equal((await client.request('/api/applications', { method: 'POST', headers, body: application })).status, 201);

    writeFileSync(join(client.root, 'Math', 'Alpha.md'), conceptFile('Alpha', '源内容发生了变化。'));
    assert.equal((await client.request('/api/refresh', { method: 'POST', headers, body: {} })).status, 200);
    const refreshed = await snapshot(client);
    const current = conceptAt(refreshed);
    assert.notEqual(current.source.revision, concept.source.revision);

    const duplicate = await client.request('/api/applications', { method: 'POST', headers, body: application });
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.json<{ status: string }>().status, 'duplicate');

    const staleNew = await client.request('/api/applications', {
      method: 'POST', headers,
      body: { ...application, eventId: 'new-stale-application' },
    });
    assert.equal(staleNew.status, 409);
    assert.equal(errorCode(staleNew), 'SOURCE_REVISION_MISMATCH');
  } finally {
    await client.stop();
  }
});

test('account sessions isolate application records, exports and concept permissions', async () => {
  const fixture = sourceFixture();
  let client: RunningApp | undefined;
  try {
    client = await running({ accountsEnabled: true, root: fixture.root, dataDir: fixture.dataDir });
    const setup = await client.request('/api/auth/setup', {
      method: 'POST',
      body: { username: 'owner', password: 'owner-password-2026' },
    });
    assert.equal(setup.status, 201);
    const ownerCookie = String(setup.headers['set-cookie'] ?? '').split(';', 1)[0];
    assert.match(ownerCookie, /^lm_session=/);
    const owner = await session(client, ownerCookie);
    const ownerHeaders = tokenHeaders(owner);
    const ownerSnapshot = await snapshot(client, ownerCookie);
    const ownerConcept = conceptAt(ownerSnapshot);
    const ownerApplication = baseApplication(ownerConcept, {
      eventId: 'owner-private-application',
      content: '只属于 owner 的应用记录。',
    });
    assert.equal((await client.request('/api/applications', {
      method: 'POST', cookie: ownerCookie, headers: ownerHeaders, body: ownerApplication,
    })).status, 201);

    const created = await client.request('/api/admin/users', {
      method: 'POST', cookie: ownerCookie, headers: ownerHeaders,
      body: { username: 'member', password: 'member-password-2026' },
    });
    assert.equal(created.status, 201);
    const memberId = created.json<{ user: { id: string } }>().user.id;
    const memberRoot = join(fixture.dataDir, 'users', memberId, 'knowledge');
    mkdirSync(join(memberRoot, 'Math'), { recursive: true });
    writeFileSync(join(memberRoot, 'Math', 'Alpha.md'), conceptFile('Alpha', 'member 的私有概念。'));

    const login = await client.request('/api/auth/login', {
      method: 'POST',
      body: { username: 'member', password: 'member-password-2026' },
    });
    assert.equal(login.status, 200);
    const memberCookie = String(login.headers['set-cookie'] ?? '').split(';', 1)[0];
    assert.match(memberCookie, /^lm_session=/);
    const member = await session(client, memberCookie);
    const memberHeaders = tokenHeaders(member);
    assert.notEqual(owner.sourceId, member.sourceId);
    assert.equal((await client.request('/api/refresh', {
      method: 'POST', cookie: memberCookie, headers: memberHeaders, body: {},
    })).status, 200);
    const memberSnapshot = await snapshot(client, memberCookie);
    const memberConcept = conceptAt(memberSnapshot);
    assert.notEqual(memberConcept.id, ownerConcept.id);
    const memberApplication = baseApplication(memberConcept, {
      eventId: 'member-private-application',
      content: '只属于 member 的应用记录。',
    });
    assert.equal((await client.request('/api/applications', {
      method: 'POST', cookie: memberCookie, headers: memberHeaders, body: memberApplication,
    })).status, 201);

    const ownerExport = (await client.request('/api/export', { cookie: ownerCookie })).json<ExportData>();
    const memberExport = (await client.request('/api/export', { cookie: memberCookie })).json<ExportData>();
    assert.deepEqual(ownerExport.applications?.map((item) => item.eventId), ['owner-private-application']);
    assert.deepEqual(memberExport.applications?.map((item) => item.eventId), ['member-private-application']);
    assert.match(JSON.stringify(ownerExport), /只属于 owner/);
    assert.doesNotMatch(JSON.stringify(ownerExport), /只属于 member/);
    assert.match(JSON.stringify(memberExport), /只属于 member/);
    assert.doesNotMatch(JSON.stringify(memberExport), /只属于 owner/);

    const ownerHistoryFromMember = await client.request(`/api/concepts/${encodeURIComponent(ownerConcept.id)}/history`, { cookie: memberCookie });
    assert.equal(ownerHistoryFromMember.status, 404);
    const memberHistoryFromOwner = await client.request(`/api/concepts/${encodeURIComponent(memberConcept.id)}/history`, { cookie: ownerCookie });
    assert.equal(memberHistoryFromOwner.status, 404);
    const forbiddenWrite = await client.request('/api/applications', {
      method: 'POST', cookie: memberCookie, headers: memberHeaders,
      body: baseApplication(ownerConcept, { eventId: 'member-forbidden-owner-concept' }),
    });
    assert.equal(forbiddenWrite.status, 404);
  } finally {
    if (client) await client.stop();
    fixture.cleanup();
  }
});

test('web api renews a stale session and replays one frozen application without duplicating it', async () => {
  const fixture = sourceFixture();
  let first: RunningApp | undefined;
  let restarted: RunningApp | undefined;
  let restoreFetch: (() => void) | undefined;
  try {
    first = await running({ root: fixture.root, dataDir: fixture.dataDir });
    const firstProxy = installFetchProxy(first);
    restoreFetch = firstProxy.restore;
    const oldSession: SessionResponse = await api.getSession();
    const initial = await api.getSnapshot(undefined, oldSession.sourceId);
    const concept = conceptAt(initial);
    const frozen = baseApplication(concept, {
      eventId: 'web-api-application-replay',
      occurredAt: '2026-01-08T12:34:56Z',
      content: '浏览器客户端在服务重启后仍使用这份冻结的应用记录。',
    });

    await first.stop();
    first = undefined;
    firstProxy.restore();
    restoreFetch = undefined;

    restarted = await running({ root: fixture.root, dataDir: fixture.dataDir });
    const proxy = installFetchProxy(restarted);
    restoreFetch = proxy.restore;
    assert.deepEqual(await api.postApplication(frozen, oldSession.writeToken, oldSession.sourceId), {
      status: 'accepted',
      eventId: frozen.eventId,
    });
    assert.deepEqual(await api.postApplication(frozen, oldSession.writeToken, oldSession.sourceId), {
      status: 'duplicate',
      eventId: frozen.eventId,
    });

    const applicationCalls = proxy.calls.filter((call) => call.path === '/api/applications');
    assert.equal(applicationCalls.length, 4, 'each write replays exactly once with the renewed token');
    assert.deepEqual(applicationCalls.map((call) => call.body), [
      JSON.stringify(frozen), JSON.stringify(frozen), JSON.stringify(frozen), JSON.stringify(frozen),
    ]);
    const currentSession = await api.getSession();
    assert.deepEqual(applicationCalls.map((call) => call.headers.get('x-lm-token')), [
      oldSession.writeToken,
      currentSession.writeToken,
      oldSession.writeToken,
      currentSession.writeToken,
    ]);
    assert.deepEqual(applicationCalls.map((call) => call.headers.get('x-lm-source-id')), [
      oldSession.sourceId, oldSession.sourceId, oldSession.sourceId, oldSession.sourceId,
    ]);

    const exported = JSON.parse(await (await api.exportData(currentSession.writeToken, currentSession.sourceId)).text()) as ExportData;
    assert.equal(exported.applications?.filter((item) => item.eventId === frozen.eventId).length, 1);
  } finally {
    restoreFetch?.();
    if (first) await first.stop();
    if (restarted) await restarted.stop();
    fixture.cleanup();
  }
});
