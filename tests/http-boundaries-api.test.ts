import { strict as assert } from 'node:assert';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeApp, createApp, type LivingMemoryApp } from '../src/server/app.js';
import type { ExportData, Snapshot } from '../src/shared/types.js';

const NOW = '2026-01-02T01:00:00.000Z';
const ONE_MIB = 1024 * 1024;

interface ResponseData {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
  json: <T>() => T;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  rawBody?: string | Buffer;
  headers?: Record<string, string>;
  cookie?: string;
}

interface RunningApp {
  app: LivingMemoryApp;
  port: number;
  request: (path: string, options?: RequestOptions) => Promise<ResponseData>;
  stop: () => Promise<void>;
}

interface SessionData {
  writeToken: string;
  sourceId: string;
  user?: { role?: string };
}

interface AuthenticatedClient {
  client: RunningApp;
  cookie: string;
  session: SessionData;
}

interface LearningState {
  exportData: ExportData;
  snapshot: Snapshot;
}

function conceptFile(title: string, summary: string): string {
  return [
    '---',
    'type: concept',
    `title: ${title}`,
    `summary: ${summary}`,
    '---',
    '',
    `# ${title}`,
    '',
    summary,
    '',
  ].join('\n');
}

function sourceFixture(): { root: string; dataDir: string; staticDir: string; cleanup: () => void } {
  const workspace = mkdtempSync(join(tmpdir(), 'living-memory-http-boundaries-'));
  const root = join(workspace, 'root');
  const dataDir = join(workspace, 'data');
  const staticDir = join(workspace, 'static');
  mkdirSync(root, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(staticDir, { recursive: true });
  mkdirSync(join(root, 'Math'), { recursive: true });
  writeFileSync(join(root, 'Math', 'Alpha.md'), conceptFile('Alpha', '用于 HTTP 边界测试的第一个概念。'));
  writeFileSync(join(root, 'Math', 'Beta.md'), conceptFile('Beta', '用于 HTTP 边界测试的第二个概念。'));
  return {
    root,
    dataDir,
    staticDir,
    cleanup: () => rmSync(workspace, { recursive: true, force: true }),
  };
}

async function closeListening(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

async function runningApp(): Promise<RunningApp> {
  const fixture = sourceFixture();
  const server = createServer();
  let app: LivingMemoryApp | undefined;
  let listening = false;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    listening = true;
    const port = (server.address() as { port: number }).port;
    app = createApp({
      root: fixture.root,
      dataDir: fixture.dataDir,
      staticDir: fixture.staticDir,
      accountsEnabled: true,
      port,
      now: () => new Date(NOW),
    });
    server.on('request', app);

    const request = (path: string, options: RequestOptions = {}) => new Promise<ResponseData>((resolve, reject) => {
      const body = options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
      const requestHeaders: Record<string, string> = {
        host: `127.0.0.1:${port}`,
        ...(body === undefined ? {} : {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body)),
        }),
        ...(options.cookie ? { cookie: options.cookie } : {}),
        ...(options.headers ?? {}),
      };
      const req = httpRequest({
        hostname: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        headers: requestHeaders,
      }, response => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { text += chunk; });
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

    let stopped = false;
    return {
      app,
      port,
      request,
      stop: async () => {
        if (stopped) return;
        stopped = true;
        try {
          await closeListening(server);
        } finally {
          try {
            closeApp(app!);
          } finally {
            fixture.cleanup();
          }
        }
      },
    };
  } catch (error) {
    try {
      if (listening) await closeListening(server);
    } finally {
      try {
        if (app) closeApp(app);
      } finally {
        fixture.cleanup();
      }
    }
    throw error;
  }
}

function authHeaders(session: SessionData): Record<string, string> {
  return { 'x-lm-token': session.writeToken, 'x-lm-source-id': session.sourceId };
}

function authenticatedRequest(auth: AuthenticatedClient, path: string, options: RequestOptions = {}): Promise<ResponseData> {
  return auth.client.request(path, {
    ...options,
    cookie: auth.cookie,
    headers: { ...authHeaders(auth.session), ...(options.headers ?? {}) },
  });
}

async function authenticate(client: RunningApp): Promise<AuthenticatedClient> {
  const setup = await client.request('/api/auth/setup', {
    method: 'POST',
    body: { username: 'admin', password: 'owner-password-2026' },
  });
  assert.equal(setup.status, 201, setup.body);
  const setCookie = setup.headers['set-cookie']?.find(value => value.startsWith('lm_session='));
  const cookie = setCookie?.split(';', 1)[0] ?? '';
  assert.match(cookie, /^lm_session=/);

  const sessionResponse = await client.request('/api/session', { cookie });
  assert.equal(sessionResponse.status, 200, sessionResponse.body);
  const session = sessionResponse.json<SessionData>();
  assert.equal(session.user?.role, 'admin');
  assert.ok(session.writeToken);
  assert.ok(session.sourceId);
  return { client, cookie, session };
}

async function seedLearning(auth: AuthenticatedClient): Promise<LearningState> {
  const initialResponse = await authenticatedRequest(auth, '/api/snapshot?scope=all');
  assert.equal(initialResponse.status, 200, initialResponse.body);
  const initial = initialResponse.json<Snapshot>();
  const concept = initial.concepts[0];
  assert.ok(concept);

  const review = await authenticatedRequest(auth, '/api/reviews', {
    method: 'POST',
    body: {
      eventId: 'http-boundary-seed-review',
      conceptId: concept.id,
      sourceRevision: concept.source.revision,
      kind: 'review',
      occurredAt: '2026-01-01T00:00:00.000Z',
    },
  });
  assert.equal(review.status, 201, review.body);

  const config = await authenticatedRequest(auth, '/api/config', {
    method: 'PUT',
    body: {
      halfLifeDays: initial.config.halfLifeDays + 1,
      revision: initial.config.revision,
    },
  });
  assert.equal(config.status, 200, config.body);

  const before = await captureState(auth);
  assert.equal(before.exportData.anchors.length, 1);
  assert.ok(before.snapshot.states[concept.id]?.anchor);
  assert.equal(before.snapshot.config.revision, initial.config.revision + 1);
  return before;
}

async function captureState(auth: AuthenticatedClient): Promise<LearningState> {
  const exportResponse = await authenticatedRequest(auth, '/api/export');
  assert.equal(exportResponse.status, 200, exportResponse.body);
  const snapshotResponse = await authenticatedRequest(auth, '/api/snapshot?scope=all');
  assert.equal(snapshotResponse.status, 200, snapshotResponse.body);
  return {
    exportData: exportResponse.json<ExportData>(),
    snapshot: snapshotResponse.json<Snapshot>(),
  };
}

async function assertStateUnchanged(auth: AuthenticatedClient, before: LearningState): Promise<void> {
  const after = await captureState(auth);
  assert.deepEqual(after.exportData, before.exportData);
  assert.deepEqual(after.snapshot, before.snapshot);
}

function errorCode(response: ResponseData): string {
  return response.json<{ error?: { code?: string } }>().error?.code ?? '';
}

function validJsonAtBytes(payload: string, byteLength: number): string {
  const paddingLength = byteLength - Buffer.byteLength(payload);
  assert.ok(paddingLength >= 0);
  return `${payload}${' '.repeat(paddingLength)}`;
}

test('malformed JSON on a non-import write returns INVALID_JSON without changing learning data', async () => {
  const client = await runningApp();
  try {
    const auth = await authenticate(client);
    const before = await seedLearning(auth);
    const response = await authenticatedRequest(auth, '/api/config', {
      method: 'PUT',
      rawBody: '{"halfLifeDays":15,"revision":2',
    });
    assert.equal(response.status, 400);
    assert.equal(errorCode(response), 'INVALID_JSON');
    await assertStateUnchanged(auth, before);
  } finally {
    await client.stop();
  }
});

test('a non-import request accepts exactly 1 MiB of valid JSON and rejects larger bodies', async () => {
  const client = await runningApp();
  try {
    const auth = await authenticate(client);
    const before = await seedLearning(auth);
    const target = before.snapshot.concepts.find(concept => !before.snapshot.states[concept.id]?.anchor);
    assert.ok(target);
    const acceptedEventId = 'http-boundary-limit-review';
    const acceptedReview = {
      eventId: acceptedEventId,
      conceptId: target.id,
      sourceRevision: target.source.revision,
      kind: 'review',
      occurredAt: '2026-01-01T01:00:00.000Z',
    };
    const atLimit = validJsonAtBytes(JSON.stringify(acceptedReview), ONE_MIB);
    assert.equal(Buffer.byteLength(atLimit), ONE_MIB);
    const accepted = await authenticatedRequest(auth, '/api/reviews', {
      method: 'POST',
      rawBody: atLimit,
    });
    assert.equal(accepted.status, 201, accepted.body);
    assert.equal(accepted.json<{ status: string; eventId: string }>().eventId, acceptedEventId);
    const acceptedState = await captureState(auth);
    assert.equal(acceptedState.exportData.anchors.length, before.exportData.anchors.length + 1);
    assert.equal(acceptedState.snapshot.states[target.id]?.anchor?.eventId, acceptedEventId);

    const rejectedReview = { ...acceptedReview, eventId: 'http-boundary-over-limit-review' };
    const overLimit = validJsonAtBytes(JSON.stringify(rejectedReview), ONE_MIB + 1);
    assert.equal(Buffer.byteLength(overLimit), ONE_MIB + 1);
    const rejected = await authenticatedRequest(auth, '/api/reviews', {
      method: 'POST',
      rawBody: overLimit,
    });
    assert.equal(rejected.status, 413);
    assert.equal(errorCode(rejected), 'BODY_TOO_LARGE');
    const rejectedMessage = rejected.json<{ error: { message: string } }>().error.message;
    assert.match(rejectedMessage, /1 MiB/);
    assert.doesNotMatch(rejectedMessage, /20 MiB|学习数据备份/);
    await assertStateUnchanged(auth, acceptedState);
  } finally {
    await client.stop();
  }
});

test('local preflight is allowed while an external origin is rejected without CORS access', async () => {
  const client = await runningApp();
  try {
    const auth = await authenticate(client);
    const before = await seedLearning(auth);
    const localOrigin = 'http://127.0.0.1:5173';
    const local = await client.request('/api/config', {
      method: 'OPTIONS',
      headers: {
        origin: localOrigin,
        'access-control-request-method': 'PUT',
        'access-control-request-headers': 'Content-Type, X-LM-Token, X-LM-Source-ID',
      },
    });
    assert.equal(local.status, 204, local.body);
    assert.equal(local.body, '');
    assert.equal(local.headers['access-control-allow-origin'], localOrigin);
    assert.equal(local.headers.vary, 'Origin');
    assert.equal(local.headers['access-control-allow-methods'], 'GET,POST,PUT,OPTIONS');
    assert.equal(local.headers['access-control-allow-headers'], 'Content-Type, X-LM-Token, X-LM-Source-ID');

    const external = await client.request('/api/config', {
      method: 'OPTIONS',
      headers: {
        origin: 'http://external.example:5173',
        'access-control-request-method': 'PUT',
        'access-control-request-headers': 'Content-Type, X-LM-Token, X-LM-Source-ID',
      },
    });
    assert.equal(external.status, 403);
    assert.equal(errorCode(external), 'ORIGIN_FORBIDDEN');
    assert.equal(external.headers['access-control-allow-origin'], undefined);
    await assertStateUnchanged(auth, before);
  } finally {
    await client.stop();
  }
});

test('an authenticated GET to an unknown API path returns NOT_FOUND without changing learning data', async () => {
  const client = await runningApp();
  try {
    const auth = await authenticate(client);
    const before = await seedLearning(auth);
    const response = await authenticatedRequest(auth, '/api/unknown-http-boundary-path');
    assert.equal(response.status, 404);
    assert.equal(errorCode(response), 'NOT_FOUND');
    await assertStateUnchanged(auth, before);
  } finally {
    await client.stop();
  }
});
