import { strict as assert } from 'node:assert';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Concept, ConceptHistory, Snapshot } from '../src/shared/types.js';
import { selectBriefReviewCandidates } from '../src/core/brief-review.js';
import { domainIdOf } from '../src/core/domain-view.js';
import {
  advanceBriefReview,
  briefReviewCounts,
  completeBriefReviewItem,
  resolveBriefReviewItem,
  type BriefReviewSession,
} from '../src/web/brief-review-session.js';
import { closeApp, createApp, type LivingMemoryApp } from '../src/server/app.js';

interface ResponseData {
  status: number;
  body: string;
  json: <T>() => T;
}

interface RunningApp {
  request: (path: string, options?: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  }) => Promise<ResponseData>;
  stop: () => Promise<void>;
}

interface SessionData {
  writeToken: string;
  sourceId: string;
}

const NOW = '2026-01-15T00:00:00.000Z';

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
  const root = mkdtempSync(join(tmpdir(), 'living-memory-brief-review-source-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'living-memory-brief-review-data-'));
  mkdirSync(join(root, 'Math'), { recursive: true });
  mkdirSync(join(root, 'Model'), { recursive: true });
  writeFileSync(join(root, 'Math', 'Alpha.md'), conceptFile('相同标题', '数学领域的旧锚点。'));
  writeFileSync(join(root, 'Math', 'Beta.md'), conceptFile('Beta', '数学领域的再访候选。'));
  writeFileSync(join(root, 'Math', 'Retained.md'), conceptFile('Retained', '已长期保持。'));
  writeFileSync(join(root, 'Model', 'Alpha.md'), conceptFile('相同标题', '另一个领域的同标题概念。'));
  return {
    root,
    dataDir,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function runningApp(): Promise<RunningApp> {
  const fixture = sourceFixture();
  const app = createApp({
    root: fixture.root,
    dataDir: fixture.dataDir,
    limit: 1,
    port: 4317,
    now: () => new Date(NOW),
    staticDir: join(fixture.dataDir, 'no-dist'),
  });
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  let stopped = false;
  const request = (
    path: string,
    options: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<ResponseData> => new Promise((resolve, reject) => {
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
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        body: text,
        json: <T>() => JSON.parse(text) as T,
      }));
    });
    req.once('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });

  return {
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

function tokenHeaders(token: string): Record<string, string> {
  return { 'x-lm-token': token };
}

async function session(client: RunningApp): Promise<SessionData> {
  const response = await client.request('/api/session');
  assert.equal(response.status, 200);
  return response.json<SessionData>();
}

async function fullSnapshot(client: RunningApp): Promise<Snapshot> {
  const response = await client.request('/api/snapshot?scope=all');
  assert.equal(response.status, 200);
  return response.json<Snapshot>();
}

function findConcept(snapshot: Snapshot, path: string): Concept {
  const concept = snapshot.concepts.find((item) => item.source.path === path);
  assert.ok(concept, `fixture concept ${path} should be present`);
  return concept;
}

async function postReview(
  client: RunningApp,
  token: string,
  concept: Concept,
  eventId: string,
  occurredAt: string,
): Promise<ResponseData> {
  return client.request('/api/reviews', {
    method: 'POST',
    headers: tokenHeaders(token),
    body: {
      eventId,
      conceptId: concept.id,
      sourceRevision: concept.source.revision,
      kind: 'review',
      occurredAt,
    },
  });
}

async function history(client: RunningApp, conceptId: string): Promise<ConceptHistory> {
  const response = await client.request(`/api/concepts/${encodeURIComponent(conceptId)}/history`);
  assert.equal(response.status, 200);
  return response.json<ConceptHistory>();
}

function makeSession(
  snapshot: Snapshot,
  sourceId: string,
  domainId: string,
): BriefReviewSession {
  const candidates = selectBriefReviewCandidates(snapshot, domainId, { limit: 5 });
  const concepts = new Map(snapshot.concepts.map((concept) => [concept.id, concept]));
  return {
    id: 'brief-review-session-1',
    sourceId,
    domainId,
    items: candidates.map((candidate) => ({
      ...candidate,
      title: concepts.get(candidate.conceptId)?.title ?? candidate.conceptId,
    })),
    index: 0,
    results: {},
    reviews: {},
  };
}

test('real snapshot selection and skip/end session do not write history', async () => {
  const client = await runningApp();
  try {
    const currentSession = await session(client);
    const initial = await fullSnapshot(client);
    const alpha = findConcept(initial, 'Math/Alpha.md');
    const beta = findConcept(initial, 'Math/Beta.md');
    const retained = findConcept(initial, 'Math/Retained.md');
    const sameTitleOtherDomain = findConcept(initial, 'Model/Alpha.md');
    assert.equal(domainIdOf(alpha), 'Math');
    assert.equal(domainIdOf(sameTitleOtherDomain), 'Model');
    assert.equal(initial.source.limit, 1);
    assert.ok(initial.concepts.length > initial.source.limit);

    assert.equal((await postReview(client, currentSession.writeToken, alpha, 'seed-alpha', '2026-01-01T00:00:00Z')).status, 201);
    assert.equal((await postReview(client, currentSession.writeToken, beta, 'seed-beta', '2026-01-08T00:00:00Z')).status, 201);
    assert.equal((await postReview(client, currentSession.writeToken, retained, 'seed-retained', '2026-01-01T00:00:00Z')).status, 201);
    assert.equal((await postReview(client, currentSession.writeToken, sameTitleOtherDomain, 'seed-model-alpha', '2026-01-01T00:00:00Z')).status, 201);
    assert.equal((await client.request('/api/retentions', {
      method: 'POST',
      headers: tokenHeaders(currentSession.writeToken),
      body: {
        eventId: 'retain-math',
        conceptId: retained.id,
        sourceRevision: retained.source.revision,
        occurredAt: '2026-01-02T00:00:00Z',
        active: true,
        previousEventId: null,
      },
    })).status, 201);

    const projected = await fullSnapshot(client);
    const candidates = selectBriefReviewCandidates(projected, 'Math', { limit: 5 });
    assert.deepEqual(candidates.map((candidate) => candidate.conceptId), [alpha.id, beta.id]);
    assert.deepEqual(candidates.map((candidate) => candidate.status), ['stale', 'revisit']);
    assert.equal(projected.states[retained.id].status, 'retained');
    assert.equal(candidates.some((candidate) => candidate.conceptId === sameTitleOtherDomain.id), false);

    const beforeHistory = {
      alpha: (await history(client, alpha.id)).total,
      beta: (await history(client, beta.id)).total,
    };
    const reviewSession = makeSession(projected, currentSession.sourceId, 'Math');
    assert.equal(reviewSession.items.length, 2);
    assert.ok(resolveBriefReviewItem(reviewSession, projected, new Set()));

    const skipped = completeBriefReviewItem(reviewSession, reviewSession.id, reviewSession.items[0].conceptId, 'skipped');
    assert.ok(skipped);
    const next = advanceBriefReview(skipped);
    const ended = completeBriefReviewItem(next, next.id, next.items[next.index].conceptId, 'skipped');
    assert.ok(ended);
    const afterEnd = advanceBriefReview(ended);
    assert.deepEqual(briefReviewCounts(afterEnd), { saved: 0, queued: 0, skipped: 2 });
    assert.equal(afterEnd.index, 1, 'ending on the final item does not advance past the session');
    assert.equal((await history(client, alpha.id)).total, beforeHistory.alpha);
    assert.equal((await history(client, beta.id)).total, beforeHistory.beta);
  } finally {
    await client.stop();
  }
});

test('observation preserves anchor and decay; review updates once and removes the candidate', async () => {
  const client = await runningApp();
  try {
    const currentSession = await session(client);
    const initial = await fullSnapshot(client);
    const alpha = findConcept(initial, 'Math/Alpha.md');
    assert.equal((await postReview(client, currentSession.writeToken, alpha, 'seed-observation-alpha', '2026-01-01T00:00:00Z')).status, 201);

    const beforeObservation = await fullSnapshot(client);
    const beforeState = beforeObservation.states[alpha.id];
    assert.equal(beforeState.status, 'stale');
    assert.ok(beforeState.anchor);
    const selectedBefore = selectBriefReviewCandidates(beforeObservation, 'Math', { limit: 5 });
    assert.deepEqual(selectedBefore.map((candidate) => candidate.conceptId), [alpha.id]);
    const beforeHistory = (await history(client, alpha.id)).total;

    const observation = {
      eventId: 'remember-alpha',
      conceptId: alpha.id,
      sourceRevision: alpha.source.revision,
      observedAt: NOW,
      configRevision: beforeObservation.config.revision,
      anchorEventId: beforeState.anchor!.eventId,
      answer: '我能解释这个概念。',
      rating: 'clear',
      exposure: 'unexposed',
      observedExposure: false,
      learning: {
        task: 'concept',
        confidence: 70,
        confidenceAt: '2026-01-14T00:00:00Z',
        cue: 'independent',
        outcome: 'success',
        basis: 'self-check',
      },
    };
    assert.equal((await client.request('/api/observations', {
      method: 'POST',
      headers: tokenHeaders(currentSession.writeToken),
      body: observation,
    })).status, 201);
    assert.equal((await client.request('/api/observations', {
      method: 'POST',
      headers: tokenHeaders(currentSession.writeToken),
      body: observation,
    })).status, 200);

    const afterObservation = await fullSnapshot(client);
    const afterObservationState = afterObservation.states[alpha.id];
    assert.deepEqual(
      {
        status: afterObservationState.status,
        anchor: afterObservationState.anchor,
        elapsedDays: afterObservationState.elapsedDays,
        decay: afterObservationState.decay,
      },
      {
        status: beforeState.status,
        anchor: beforeState.anchor,
        elapsedDays: beforeState.elapsedDays,
        decay: beforeState.decay,
      },
    );
    assert.equal((await history(client, alpha.id)).total, beforeHistory + 1);
    assert.deepEqual(selectBriefReviewCandidates(afterObservation, 'Math', { limit: 5 }).map((candidate) => candidate.conceptId), [alpha.id]);

    const review = {
      eventId: 'confirm-alpha-after-observation',
      conceptId: alpha.id,
      sourceRevision: alpha.source.revision,
      kind: 'review',
      occurredAt: NOW,
    };
    assert.equal((await client.request('/api/reviews', {
      method: 'POST',
      headers: tokenHeaders(currentSession.writeToken),
      body: review,
    })).status, 201);
    const afterReview = await fullSnapshot(client);
    assert.equal(afterReview.states[alpha.id].anchor?.eventId, review.eventId);
    assert.equal(afterReview.states[alpha.id].status, 'recent');
    assert.deepEqual(selectBriefReviewCandidates(afterReview, 'Math', { limit: 5 }), []);
    assert.equal((await history(client, alpha.id)).total, beforeHistory + 2);

    assert.equal((await client.request('/api/reviews', {
      method: 'POST',
      headers: tokenHeaders(currentSession.writeToken),
      body: review,
    })).status, 200);
    assert.equal((await history(client, alpha.id)).total, beforeHistory + 2);
  } finally {
    await client.stop();
  }
});
