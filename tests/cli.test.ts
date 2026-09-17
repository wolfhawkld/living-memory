import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeApp, createApp, type LivingMemoryApp } from '../src/server/app.js';
import { CliError, runCli } from '../src/cli/index.js';

interface RunningApp {
  app: LivingMemoryApp;
  server: Server;
  url: string;
  root: string;
  dataDir: string;
  stateDir: string;
  setNow: (value: string) => void;
  stop: () => Promise<void>;
}

function conceptFile(title: string, aliases: string[], summary: string, body: string): string {
  return [
    '---',
    'type: concept',
    `title: ${title}`,
    'aliases:',
    ...aliases.map((alias) => `  - ${alias}`),
    `summary: ${summary}`,
    '---',
    '',
    body,
    '',
  ].join('\n');
}

function fixture(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'living-memory-cli-source-'));
  writeFileSync(join(root, 'Alpha.md'), conceptFile('Alpha', ['common', 'first'], 'searchable alpha', '正文 Alpha\n\n## 关系网络\n- 相关：[[Beta]] — alpha to beta'));
  writeFileSync(join(root, 'Beta.md'), conceptFile('Beta', ['common', 'second'], 'searchable beta', '正文 Beta'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

async function listen(server: Server, port?: number): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port ?? 0, '127.0.0.1', () => resolve());
  });
  return (server.address() as { port: number }).port;
}

async function reservePort(): Promise<number> {
  const probe = createServer();
  const port = await listen(probe);
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function runningApp(viewLimit?: number): Promise<RunningApp> {
  const source = fixture();
  const dataDir = mkdtempSync(join(tmpdir(), 'living-memory-cli-data-'));
  const stateDir = mkdtempSync(join(tmpdir(), 'living-memory-cli-state-'));
  const port = await reservePort();
  let currentNow = '2026-01-03T00:00:00.000Z';
  const app = createApp({
    root: source.root,
    dataDir,
    port,
    limit: viewLimit,
    now: () => new Date(currentNow),
    staticDir: join(dataDir, 'no-dist'),
  });
  const server = createServer(app);
  await listen(server, port);
  return {
    app,
    server,
    url: `http://127.0.0.1:${port}`,
    root: source.root,
    dataDir,
    stateDir,
    setNow: (value) => { currentNow = value; },
    stop: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      closeApp(app);
      source.cleanup();
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

function options(client: RunningApp): Parameters<typeof runCli>[1] {
  return { url: client.url, sourceRoot: client.root, stateDir: client.stateDir };
}

async function expectCliError(action: () => Promise<unknown>, code: string): Promise<CliError> {
  let error: unknown;
  try {
    await action();
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof Error);
  assert.ok(error instanceof CliError);
  assert.equal(error.code, code);
  return error;
}

test('query refreshes before reading the snapshot and returns source revisions and states', async () => {
  const client = await runningApp();
  try {
    const result = await runCli(['query', 'alpha'], options(client)) as Record<string, any>;
    assert.equal(result.command, 'query');
    assert.equal(result.hits.length, 1);
    assert.equal(result.hits[0].title, 'Alpha');
    assert.match(result.hits[0].sourceRevision, /^sha256:/);
    assert.equal(result.hits[0].state.status, 'unknown');
    assert.equal(client.app.livingMemory.store.getAnchors().length, 0);

    const status = await runCli(['status'], options(client)) as Record<string, any>;
    assert.equal(status.counts.concepts, 2);
    assert.equal(status.stateCounts.unknown, 2);
    assert.equal(status.config.revision, 1);
    assert.equal(typeof status.asOf, 'string');
  } finally {
    await client.stop();
  }
});

test('show resolves full concepts and reports ambiguity with candidate IDs', async () => {
  const client = await runningApp();
  try {
    const error = await expectCliError(() => runCli(['show', 'common'], options(client)), 'AMBIGUOUS_SELECTOR');
    assert.equal((error.details.candidateIds as string[]).length, 2);

    const result = await runCli(['show', 'Alpha'], options(client)) as Record<string, any>;
    assert.equal(result.concept.title, 'Alpha');
    assert.equal(result.concept.body.includes('正文 Alpha'), true);
    assert.equal(result.state.status, 'unknown');
    assert.equal(result.incidentLinks.length, 1);
    assert.equal(result.incidentLinks[0].source, result.concept.id);
  } finally {
    await client.stop();
  }
});

test('CLI query, show and confirmed review reach concepts outside the default display cap', async () => {
  const client = await runningApp(1);
  try {
    const legacy = await fetch(`${client.url}/api/snapshot`).then((response) => response.json()) as { concepts: { title: string }[] };
    assert.deepEqual(legacy.concepts.map((concept) => concept.title), ['Alpha']);
    const query = await runCli(['query', 'Beta'], options(client)) as Record<string, any>;
    assert.equal(query.scope.kind, 'all');
    assert.equal(query.scope.viewLimit, 1);
    assert.equal(query.hits[0].title, 'Beta');
    const shown = await runCli(['show', 'Beta'], options(client)) as Record<string, any>;
    assert.equal(shown.concept.title, 'Beta');
    assert.equal(shown.incidentLinks.length, 1);
    const before = await runCli(['status'], options(client)) as Record<string, any>;
    assert.equal(before.counts.concepts, 2);
    assert.equal(client.app.livingMemory.store.getAnchors().length, 0);
    const review = await runCli(['review', 'Beta', '--confirm', '--event-id', 'outside-view', '--at', '2026-01-03T00:00:00.000Z'], options(client)) as Record<string, any>;
    assert.equal(review.response.status, 'accepted');
    assert.equal(client.app.livingMemory.store.getAnchors()[0].conceptId, shown.concept.id);
  } finally {
    await client.stop();
  }
});

test('review stores a private frozen receipt and retries the exact request idempotently', async () => {
  const client = await runningApp();
  try {
    const first = await runCli([
      'review', 'Alpha', '--confirm', '--event-id', 'frozen-review', '--at', '2026-01-01T08:00:00+08:00',
    ], options(client)) as Record<string, any>;
    assert.equal(first.response.status, 'accepted');
    assert.equal(first.request.occurredAt, '2026-01-01T00:00:00.000Z');
    assert.equal(client.app.livingMemory.store.getAnchors().length, 1);
    assert.equal((statSync(first.receipt.path).mode & 0o777), 0o600);

    const duplicate = await runCli([
      'review', 'Alpha', '--confirm', '--event-id', 'frozen-review', '--at', '2026-01-01T00:00:00Z',
    ], options(client)) as Record<string, any>;
    assert.equal(duplicate.response.status, 'duplicate');
    assert.equal(duplicate.request.occurredAt, '2026-01-01T00:00:00.000Z');

    client.setNow('2026-01-20T00:00:00.000Z');
    const retry = await runCli(['retry', 'frozen-review'], options(client)) as Record<string, any>;
    assert.equal(retry.response.status, 'duplicate');
    assert.equal(retry.request.occurredAt, '2026-01-01T00:00:00.000Z');
    assert.equal(client.app.livingMemory.store.getAnchors().length, 1);
    assert.equal(client.app.livingMemory.store.getAnchors()[0].occurredAt, '2026-01-01T00:00:00.000Z');

    await expectCliError(() => runCli([
      'review', 'Alpha', '--confirm', '--event-id', 'frozen-review', '--at', '2026-01-02T00:00:00Z',
    ], options(client)), 'EVENT_CONFLICT');
  } finally {
    await client.stop();
  }
});

test('after reports a successful workflow through refresh without creating a learning event', async () => {
  const client = await runningApp();
  try {
    const result = await runCli(['after', 'ingest', '--operation-id', 'op-123'], options(client)) as Record<string, any>;
    assert.equal(result.status, 'refreshed');
    assert.equal(result.reportedWorkflowStatus, 'succeeded');
    assert.equal(result.operationId, 'op-123');
    assert.equal(result.operationType, 'ingest');
    assert.equal(client.app.livingMemory.store.getAnchors().length, 0);
  } finally {
    await client.stop();
  }
});

test('source-root mismatch blocks refresh before it can write or refresh', async () => {
  const client = await runningApp();
  const other = fixture();
  try {
    await expectCliError(() => runCli(['refresh'], { ...options(client), sourceRoot: other.root }), 'SOURCE_MISMATCH');
    await expectCliError(() => runCli(['show', 'Alpha'], { ...options(client), sourceRoot: other.root }), 'SOURCE_MISMATCH');
    await expectCliError(() => runCli(['status'], { ...options(client), sourceRoot: other.root }), 'SOURCE_MISMATCH');
    assert.equal(client.app.livingMemory.store.getAnchors().length, 0);
  } finally {
    other.cleanup();
    await client.stop();
  }
});

test('redirect responses are rejected by the CLI HTTP client', async () => {
  const redirect = createServer((_request, response) => {
    response.writeHead(302, { location: '/api/session' });
    response.end();
  });
  const port = await listen(redirect);
  try {
    await expectCliError(() => runCli(['status'], { url: `http://127.0.0.1:${port}` }), 'REDIRECT_REJECTED');
  } finally {
    await new Promise<void>((resolve) => redirect.close(() => resolve()));
  }
});

test('help is available as a subcommand for local workflow bridges', async () => {
  const result = await runCli(['help']);
  assert.equal(typeof result, 'string');
  assert.match(result as string, /after <query\|ingest\|consolidate>/);
});

test('a lost review response leaves a pending receipt and retry posts the frozen request', async () => {
  const client = await runningApp();
  try {
    let dropped = false;
    const flakyFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (!dropped && String(input).endsWith('/api/reviews')) {
        dropped = true;
        await response.text();
        throw new Error('simulated lost response');
      }
      return response;
    };
    const error = await expectCliError(() => runCli([
      'review', 'Alpha', '--confirm', '--event-id', 'lost-response', '--at', '2026-01-01T00:00:00Z',
    ], { ...options(client), fetchImpl: flakyFetch }), 'NETWORK_ERROR');
    assert.equal(error.details.eventId, 'lost-response');
    assert.match(String(error.details.retryCommand), /retry lost-response/);
    assert.equal(client.app.livingMemory.store.getAnchors().length, 1);

    const retry = await runCli(['retry', 'lost-response'], options(client)) as Record<string, any>;
    assert.equal(retry.response.status, 'duplicate');
    assert.equal(retry.request.occurredAt, '2026-01-01T00:00:00.000Z');
    assert.equal(client.app.livingMemory.store.getAnchors().length, 1);
  } finally {
    await client.stop();
  }
});

test('retry refuses a receipt from another source namespace', async () => {
  const first = await runningApp();
  const second = await runningApp();
  try {
    let dropped = false;
    const flakyFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (!dropped && String(input).endsWith('/api/reviews')) {
        dropped = true;
        await response.text();
        throw new Error('simulated lost response');
      }
      return response;
    };
    await expectCliError(() => runCli([
      'review', 'Alpha', '--confirm', '--event-id', 'cross-source', '--at', '2026-01-01T00:00:00Z',
    ], { ...options(first), fetchImpl: flakyFetch }), 'NETWORK_ERROR');

    await expectCliError(() => runCli(['retry', 'cross-source'], {
      ...options(second),
      stateDir: first.stateDir,
    }), 'SOURCE_MISMATCH');
    assert.equal(second.app.livingMemory.store.getAnchors().length, 0);
  } finally {
    await second.stop();
    await first.stop();
  }
});

test('request timeout covers a response body that never finishes', async () => {
  let calls = 0;
  const hangingFetch: typeof fetch = async () => {
    calls += 1;
    if (calls === 1) return new Response(JSON.stringify({ writeToken: 'secret', sourceId: 'kg_test' }), { status: 200 });
    return new Response(new ReadableStream({ start() { /* deliberately pending */ } }), { status: 200 });
  };
  await expectCliError(() => runCli(['status'], {
    url: 'http://127.0.0.1:4317',
    timeoutMs: 20,
    fetchImpl: hangingFetch,
  }), 'TIMEOUT');
  assert.equal(calls, 2);
});
