import { strict as assert } from 'node:assert';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeApp, createApp, type LivingMemoryApp } from '../src/server/app.js';
import type { ConceptHistory } from '../src/shared/types.js';

interface ResponseData {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
  json: <T>() => T;
}

interface Fixture {
  root: string;
  dataDir: string;
  cleanup: () => void;
}

interface RunningApp {
  app: LivingMemoryApp;
  root: string;
  request: (path: string, options?: { method?: string; body?: unknown; headers?: Record<string, string> }) => Promise<ResponseData>;
  setNow: (value: string) => void;
  stop: () => Promise<void>;
}

function conceptFile(title: string, summary: string): string {
  return [
    '---',
    'type: concept',
    `title: ${title}`,
    `summary: ${summary}`,
    '---',
    '',
    summary,
    '',
  ].join('\n');
}

function sourceFixture(
  dataDir = mkdtempSync(join(tmpdir(), 'living-memory-history-data-')),
  removeData = true,
): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'living-memory-history-source-'));
  mkdirSync(join(root, 'Cognition', 'Math'), { recursive: true });
  mkdirSync(join(root, 'Cognition', 'Model'), { recursive: true });
  writeFileSync(join(root, 'Cognition', 'Math', 'Boolean.md'), conceptFile('布尔逻辑', '真值判断'));
  writeFileSync(join(root, 'Cognition', 'Math', 'Decision.md'), conceptFile('决策表', '条件组合'));
  writeFileSync(join(root, 'Cognition', 'Model', 'Classifier.md'), conceptFile('分类器', '模型分类'));
  writeFileSync(join(root, 'Loose.md'), conceptFile('根概念', '根目录概念'));
  return {
    root,
    dataDir,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
      if (removeData) rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function running(options: { fixture?: Fixture; now?: string; sharedDataDir?: string } = {}): Promise<RunningApp> {
  const fixture = options.fixture ?? sourceFixture(options.sharedDataDir);
  let currentNow = options.now ?? '2026-02-01T00:00:00.000Z';
  const app = createApp({
    root: fixture.root,
    dataDir: fixture.dataDir,
    includePrefix: 'Cognition/Math',
    limit: 1,
    port: 4317,
    now: () => new Date(currentNow),
    staticDir: join(fixture.dataDir, 'no-dist'),
  });
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  let stopped = false;
  const request = (path: string, options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) => new Promise<ResponseData>((resolve, reject) => {
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path,
      method: options.method ?? 'GET',
      headers: {
        host: '127.0.0.1:4317',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(options.headers ?? {}),
      },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
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
    request,
    setNow: (value: string) => { currentNow = value; },
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      closeApp(app);
      fixture.cleanup();
    },
  };
}

const tokenHeaders = (token: string, sourceId?: string): Record<string, string> => ({
  'x-lm-token': token,
  ...(sourceId ? { 'x-lm-source-id': sourceId } : {}),
});

async function session(client: RunningApp): Promise<{ writeToken: string; sourceId: string }> {
  return (await client.request('/api/session')).json<{ writeToken: string; sourceId: string }>();
}

function historyPath(conceptId: string, query = ''): string {
  return `/api/concepts/${encodeURIComponent(conceptId)}/history${query}`;
}

function errorCode(response: ResponseData): string {
  return response.json<{ error?: { code?: string } }>().error?.code ?? '';
}

test('concept history returns empty state, full-index concepts, cache policy, and guards', async () => {
  const client = await running();
  try {
    const currentSession = await session(client);
    const all = (await client.request('/api/snapshot?scope=all')).json<any>();
    const hidden = all.concepts.find((concept: any) => concept.title === '分类器');
    assert.ok(hidden);

    const empty = await client.request(historyPath(hidden.id));
    assert.equal(empty.status, 200);
    assert.equal(empty.headers['cache-control'], 'no-store');
    const history = empty.json<ConceptHistory>();
    assert.equal(history.sourceId, currentSession.sourceId);
    assert.equal(history.conceptId, hidden.id);
    assert.equal(history.sourceRevision, hidden.source.revision);
    assert.equal(history.asOf, '2026-02-01T00:00:00.000Z');
    assert.equal(history.state.status, 'unknown');
    assert.deepEqual(history.entries, []);
    assert.equal(history.total, 0);
    assert.equal(history.nextCursor, null);

    for (const query of ['?limit=0', '?limit=101', '?limit=1.5', '?limit=abc', '?limit=']) {
      const response = await client.request(historyPath(hidden.id, query));
      assert.equal(response.status, 400, query);
      assert.equal(errorCode(response), 'INVALID_HISTORY_LIMIT', query);
    }
    const repeatedLimit = await client.request(historyPath(hidden.id, '?limit=1&limit=1'));
    assert.equal(repeatedLimit.status, 400);
    assert.equal(errorCode(repeatedLimit), 'INVALID_HISTORY_LIMIT');

    for (const query of ['?cursor=bad', '?cursor=', '?cursor=%%%']) {
      const response = await client.request(historyPath(hidden.id, query));
      assert.equal(response.status, 400, query);
      assert.equal(errorCode(response), 'INVALID_HISTORY_CURSOR', query);
    }
    const unknown = await client.request(historyPath('concept_missing'));
    assert.equal(unknown.status, 404);
    assert.equal(errorCode(unknown), 'CONCEPT_NOT_FOUND');
    const wrongSource = await client.request(historyPath(hidden.id), {
      headers: { 'x-lm-source-id': 'kg_wrong-source' },
    });
    assert.equal(wrongSource.status, 409);
    assert.equal(errorCode(wrongSource), 'SOURCE_MISMATCH');
  } finally {
    await client.stop();
  }
});

test('concept history orders anchors deterministically and paginates with a bound cursor', async () => {
  const client = await running();
  try {
    const currentSession = await session(client);
    const all = (await client.request('/api/snapshot?scope=all')).json<any>();
    const concept = all.concepts.find((item: any) => item.title === '布尔逻辑');
    const other = all.concepts.find((item: any) => item.title === '分类器');
    const headers = tokenHeaders(currentSession.writeToken, currentSession.sourceId);
    const occurredAt = '2026-01-10T00:00:00Z';
    for (const eventId of ['tie-a', 'tie-m', 'tie-z']) {
      const response = await client.request('/api/reviews', {
        method: 'POST',
        headers,
        body: { eventId, conceptId: concept.id, sourceRevision: concept.source.revision, kind: 'review', occurredAt },
      });
      assert.equal(response.status, 201, eventId);
    }
    const duplicate = await client.request('/api/reviews', {
      method: 'POST',
      headers,
      body: { eventId: 'tie-m', conceptId: concept.id, sourceRevision: concept.source.revision, kind: 'review', occurredAt },
    });
    assert.equal(duplicate.status, 200);
    const older = await client.request('/api/reviews', {
      method: 'POST',
      headers,
      body: { eventId: 'older', conceptId: concept.id, sourceRevision: concept.source.revision, kind: 'review', occurredAt: '2026-01-09T00:00:00Z' },
    });
    assert.equal(older.status, 201);

    const beforeRead = (await client.request('/api/export')).json<any>();
    const first = await client.request(historyPath(concept.id, '?limit=2'));
    const firstPage = first.json<ConceptHistory>();
    assert.equal(first.status, 200);
    assert.equal(firstPage.total, 4);
    assert.deepEqual(firstPage.entries.map((entry) => entry.event.eventId), ['tie-z', 'tie-m']);
    assert.ok(firstPage.nextCursor);
    assert.equal(first.body.includes('request_payload'), false);

    // A newly inserted recent event must not shift an existing keyset page.
    const recent = await client.request('/api/reviews', {
      method: 'POST',
      headers,
      body: { eventId: 'newer', conceptId: concept.id, sourceRevision: concept.source.revision, kind: 'review', occurredAt: '2026-01-11T00:00:00Z' },
    });
    assert.equal(recent.status, 201);
    const second = await client.request(historyPath(concept.id, `?limit=2&cursor=${encodeURIComponent(firstPage.nextCursor!)}`));
    const secondPage = second.json<ConceptHistory>();
    assert.deepEqual(secondPage.entries.map((entry) => entry.event.eventId), ['tie-a', 'older']);
    assert.equal(secondPage.nextCursor, null);

    const crossConcept = await client.request(historyPath(other.id, `?cursor=${encodeURIComponent(firstPage.nextCursor!)}`));
    assert.equal(crossConcept.status, 400);
    assert.equal(errorCode(crossConcept), 'INVALID_HISTORY_CURSOR');
    const afterRead = (await client.request('/api/export')).json<any>();
    assert.deepEqual(afterRead.anchors.map((event: any) => event.eventId), [...beforeRead.anchors.map((event: any) => event.eventId), 'newer']);
  } finally {
    await client.stop();
  }
});

test('concept history preserves stored observation values and projects current state against source revisions', async () => {
  const client = await running({ now: '2026-01-05T00:00:00.000Z' });
  try {
    const currentSession = await session(client);
    const all = (await client.request('/api/snapshot?scope=all')).json<any>();
    const concept = all.concepts.find((item: any) => item.title === '布尔逻辑');
    const headers = tokenHeaders(currentSession.writeToken, currentSession.sourceId);
    const review = {
      eventId: 'history-anchor',
      conceptId: concept.id,
      sourceRevision: concept.source.revision,
      kind: 'review',
      occurredAt: '2026-01-01T00:00:00Z',
    };
    assert.equal((await client.request('/api/reviews', { method: 'POST', headers, body: review })).status, 201);
    const observation = {
      eventId: 'history-observation',
      conceptId: concept.id,
      sourceRevision: concept.source.revision,
      observedAt: '2026-01-03T00:00:00Z',
      configRevision: 1,
      anchorEventId: review.eventId,
      answer: '我记得真值会保持一致。',
      rating: 'partial',
      exposure: 'unexposed',
      observedExposure: false,
    };
    assert.equal((await client.request('/api/observations', { method: 'POST', headers, body: observation })).status, 201);
    const before = (await client.request(historyPath(concept.id))).json<ConceptHistory>();
    const storedObservation = before.entries.find((entry) => entry.type === 'observation');
    assert.ok(storedObservation && storedObservation.type === 'observation');

    assert.equal((await client.request('/api/config', { method: 'PUT', headers, body: { halfLifeDays: 14, revision: 1 } })).status, 200);
    client.setNow('2026-01-06T00:00:00.000Z');
    const newerReview = {
      eventId: 'history-new-anchor',
      conceptId: concept.id,
      sourceRevision: concept.source.revision,
      kind: 'review',
      occurredAt: '2026-01-04T00:00:00Z',
    };
    assert.equal((await client.request('/api/reviews', { method: 'POST', headers, body: newerReview })).status, 201);
    const afterConfigAndAnchor = (await client.request(historyPath(concept.id))).json<ConceptHistory>();
    const unchangedObservation = afterConfigAndAnchor.entries.find((entry) => entry.type === 'observation');
    assert.ok(unchangedObservation && unchangedObservation.type === 'observation');
    assert.equal(unchangedObservation.event.configRevision, storedObservation.event.configRevision);
    assert.equal(unchangedObservation.event.halfLifeDays, storedObservation.event.halfLifeDays);
    assert.equal(unchangedObservation.event.elapsedDays, storedObservation.event.elapsedDays);
    assert.equal(unchangedObservation.event.decay, storedObservation.event.decay);
    assert.equal(afterConfigAndAnchor.state.anchor?.eventId, newerReview.eventId);
    assert.equal(afterConfigAndAnchor.asOf, '2026-01-06T00:00:00.000Z');

    writeFileSync(join(client.root, 'Cognition', 'Math', 'Boolean.md'), conceptFile('布尔逻辑', '真值判断已经改变'));
    assert.equal((await client.request('/api/refresh', { method: 'POST', headers, body: {} })).status, 200);
    const afterSourceChange = (await client.request(historyPath(concept.id))).json<ConceptHistory>();
    assert.notEqual(afterSourceChange.sourceRevision, before.sourceRevision);
    assert.equal(afterSourceChange.state.status, 'pending');
    assert.ok(afterSourceChange.entries.some((entry) => entry.event.eventId === review.eventId));
  } finally {
    await client.stop();
  }
});

test('concept history remains isolated by source namespace and does not mutate records', async () => {
  const sharedDataDir = mkdtempSync(join(tmpdir(), 'living-memory-history-shared-data-'));
  const firstFixture = sourceFixture(sharedDataDir, false);
  const first = await running({ fixture: firstFixture });
  let secondFixture: Fixture | undefined;
  try {
    const currentSession = await session(first);
    const all = (await first.request('/api/snapshot?scope=all')).json<any>();
    const firstConcept = all.concepts.find((item: any) => item.title === '布尔逻辑');
    const headers = tokenHeaders(currentSession.writeToken, currentSession.sourceId);
    assert.equal((await first.request('/api/reviews', {
      method: 'POST',
      headers,
      body: { eventId: 'source-one-review', conceptId: firstConcept.id, sourceRevision: firstConcept.source.revision, kind: 'review' },
    })).status, 201);
    const sourceOneBefore = (await first.request('/api/export')).json<any>();
    const sourceOneHistory = (await first.request(historyPath(firstConcept.id))).json<ConceptHistory>();
    assert.equal(sourceOneHistory.total, 1);

    secondFixture = sourceFixture(sharedDataDir, false);
    const second = await running({ fixture: secondFixture });
    try {
      const secondAll = (await second.request('/api/snapshot?scope=all')).json<any>();
      const secondConcept = secondAll.concepts.find((item: any) => item.title === '布尔逻辑');
      const secondHistory = (await second.request(historyPath(secondConcept.id))).json<ConceptHistory>();
      assert.equal(secondHistory.total, 0);
      const sourceOneAfter = (await first.request('/api/export')).json<any>();
      assert.deepEqual(sourceOneAfter.anchors, sourceOneBefore.anchors);
    } finally {
      await second.stop();
      secondFixture = undefined;
    }
  } finally {
    await first.stop();
    if (secondFixture) secondFixture.cleanup();
    rmSync(sharedDataDir, { recursive: true, force: true });
  }
});
