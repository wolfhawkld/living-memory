import { strict as assert } from 'node:assert';
import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeApp, createApp } from '../src/server/app.js';
import type { ImportPreview } from '../src/shared/import-data.js';
import { DEFAULT_IMPORT_OPTIONS } from '../src/shared/import-data.js';
import type {
  PracticeAttemptRequest,
  PracticeCardRequest,
  PracticeCardsResponse,
  PracticeHistoryResponse,
} from '../src/shared/practice.js';
import type { ExportData, Snapshot } from '../src/shared/types.js';

const NOW = '2026-10-02T12:00:00.000Z';
const SOURCE_NAMES = ['Alpha', 'Beta', 'Gamma', 'Delta'] as const;

function note(title: string, body: string): string {
  return `---\ntype: concept\ntitle: ${title}\nsummary: ${body}\n---\n\n# ${title}\n\n${body}\n`;
}

interface ResponseData {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
  json: <T>() => T;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  cookie?: string;
}

interface RunningClient {
  root: string;
  dataDir: string;
  request: (path: string, options?: RequestOptions) => Promise<ResponseData>;
  restart: () => void;
  stop: () => Promise<void>;
}

interface Session {
  value: { writeToken: string; sourceId: string };
  headers: { 'x-lm-token': string; 'x-lm-source-id': string };
}

async function running(accountsEnabled = false): Promise<RunningClient> {
  const root = mkdtempSync(join(tmpdir(), 'lm-scenario-card-source-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'lm-scenario-card-data-'));
  for (const name of SOURCE_NAMES) writeFileSync(join(root, `${name}.md`), note(name, `${name} synthetic source`));

  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as { port: number }).port;
  let app = createApp({
    root,
    dataDir,
    port,
    accountsEnabled,
    limit: 10,
    now: () => new Date(NOW),
    staticDir: join(dataDir, 'no-dist'),
  });
  server.on('request', app);

  const request = (path: string, options: RequestOptions = {}) => new Promise<ResponseData>((resolve, reject) => {
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
    root,
    dataDir,
    request,
    restart: () => {
      server.removeListener('request', app);
      closeApp(app);
      app = createApp({
        root,
        dataDir,
        port,
        accountsEnabled,
        limit: 10,
        now: () => new Date(NOW),
        staticDir: join(dataDir, 'no-dist'),
      });
      server.on('request', app);
    },
    stop: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      closeApp(app);
      rmSync(root, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function session(client: RunningClient, cookie?: string): Promise<Session> {
  const response = await client.request('/api/session', cookie ? { cookie } : {});
  assert.equal(response.status, 200, response.body);
  const value = response.json<{ writeToken: string; sourceId: string }>();
  return { value, headers: { 'x-lm-token': value.writeToken, 'x-lm-source-id': value.sourceId } };
}

function cookieFrom(response: ResponseData): string {
  const cookie = response.headers['set-cookie']?.[0];
  assert.ok(cookie, 'authentication response must issue a session cookie');
  return cookie.split(';')[0];
}

function sources(snapshot: Snapshot): PracticeCardRequest['sources'] {
  return snapshot.concepts.slice(0, 4).map((concept) => ({
    conceptId: concept.id,
    sourceRevision: concept.source.revision,
  }));
}

function makeScenarioCard(
  snapshot: Snapshot,
  eventId = 'scenario-card-v1',
  previousEventId: string | null = null,
  occurredAt = '2026-09-24T10:00:00.000Z',
  paused = false,
): PracticeCardRequest {
  return {
    eventId,
    cardId: 'scenario-family-card',
    previousEventId,
    occurredAt,
    kind: 'scenario',
    title: '事故响应场景',
    prompt: '面对一组相互影响的变更，先说出独立判断，再说明结构和名称。',
    referenceAnswer: '先确认边界，再拆解结构，最后给出稳定命名。',
    referenceNotes: '四份合成来源共同构成这张人工场景卡的核对依据。',
    sources: sources(snapshot),
    sourceChecked: true,
    paused,
    scenario: {
      caseFamily: 'family',
      structureHint: '先列出约束、关系和可观测结果。',
      nameHint: '回忆这个结构在资料中的稳定名称。',
    },
  };
}

function makeScenarioAttempt(card: PracticeCardRequest, eventId = 'scenario-attempt-v1'): PracticeAttemptRequest {
  const stages = [
    {
      stage: 'independent' as const,
      answer: '首答：我先确认边界和影响范围。',
      answeredAt: '2026-09-25T10:01:00.000Z',
      hintShownAt: null,
      recallOutcome: 'partial' as const,
      applicabilityOutcome: 'failure' as const,
    },
    {
      stage: 'structure' as const,
      answer: '结构答：我把约束、关系和结果分开核对。',
      answeredAt: '2026-09-25T10:05:00.000Z',
      hintShownAt: '2026-09-25T10:03:00.000Z',
      recallOutcome: 'success' as const,
      applicabilityOutcome: 'partial' as const,
    },
    {
      stage: 'name' as const,
      answer: '名称答：这是一个稳定的案例族。',
      answeredAt: '2026-09-25T10:08:00.000Z',
      hintShownAt: '2026-09-25T10:06:00.000Z',
      recallOutcome: 'success' as const,
      applicabilityOutcome: 'success' as const,
    },
  ];
  return {
    eventId,
    cardId: card.cardId,
    cardEventId: card.eventId,
    answeredAt: stages[0].answeredAt,
    answer: stages[0].answer,
    confidence: null,
    confidenceAt: null,
    exposure: 'unexposed',
    observedExposure: false,
    // The first answer was blind, but later stages used authored hints. The
    // service must preserve the safer aggregate cue instead of independent.
    cue: 'independent',
    outcome: 'unverified',
    checkNotes: '四份资料逐阶段人工核对。',
    scenario: {
      stages,
      caseExposure: 'seen',
      observedCaseExposure: true,
    },
  };
}

async function seedLegacyEvidence(client: RunningClient, headers: Session['headers']): Promise<Snapshot> {
  const initial = (await client.request('/api/snapshot?scope=all')).json<Snapshot>();
  const concept = initial.concepts[0];
  assert.ok(concept);
  assert.equal((await client.request('/api/reviews', {
    method: 'POST',
    headers,
    body: {
      eventId: 'legacy-anchor',
      conceptId: concept.id,
      sourceRevision: concept.source.revision,
      kind: 'review',
      occurredAt: '2026-09-18T10:00:00.000Z',
    },
  })).status, 201);
  assert.equal((await client.request('/api/retentions', {
    method: 'POST',
    headers,
    body: {
      eventId: 'legacy-retention',
      conceptId: concept.id,
      sourceRevision: concept.source.revision,
      occurredAt: '2026-09-19T10:00:00.000Z',
      active: true,
      previousEventId: null,
    },
  })).status, 201);
  assert.equal((await client.request('/api/config', {
    method: 'PUT',
    headers,
    body: { halfLifeDays: initial.config.halfLifeDays + 1, revision: initial.config.revision },
  })).status, 200);
  const current = (await client.request('/api/snapshot?scope=all')).json<Snapshot>();
  assert.equal((await client.request('/api/observations', {
    method: 'POST',
    headers,
    body: {
      eventId: 'legacy-observation',
      conceptId: concept.id,
      sourceRevision: concept.source.revision,
      observedAt: '2026-09-20T10:00:00.000Z',
      configRevision: current.config.revision,
      anchorEventId: 'legacy-anchor',
      answer: '旧版概念回忆',
      rating: 'partial',
      exposure: 'unexposed',
      observedExposure: false,
    },
  })).status, 201);
  return (await client.request('/api/snapshot?scope=all')).json<Snapshot>();
}

function assertLegacyEvidenceUnchanged(after: ExportData, before: ExportData): void {
  assert.deepEqual(after.anchors, before.anchors);
  assert.deepEqual(after.retentions, before.retentions);
  assert.deepEqual(after.config, before.config);
  assert.deepEqual(after.configHistory, before.configHistory);
  assert.deepEqual(after.observations, before.observations);
}

test('scenario cards persist staged answers, preserve legacy projections, and survive restart', async () => {
  const client = await running();
  try {
    const currentSession = await session(client);
    await seedLegacyEvidence(client, currentSession.headers);
    const baselineExport = (await client.request('/api/export')).json<ExportData>();
    const baselineOverview = await client.request('/api/learning-overview');
    const baselinePlan = await client.request('/api/review-plan?timeZone=UTC');
    const snapshot = (await client.request('/api/snapshot?scope=all')).json<Snapshot>();
    assert.equal(snapshot.concepts.length, 4);

    const card = makeScenarioCard(snapshot);
    const created = await client.request('/api/practice-cards', { method: 'POST', headers: currentSession.headers, body: card });
    assert.equal(created.status, 201, created.body);
    const duplicateCard = await client.request('/api/practice-cards', { method: 'POST', headers: currentSession.headers, body: card });
    assert.equal(duplicateCard.status, 200, duplicateCard.body);
    assert.deepEqual(duplicateCard.json(), { status: 'duplicate', eventId: card.eventId });
    const cardConflict = await client.request('/api/practice-cards', {
      method: 'POST',
      headers: currentSession.headers,
      body: { ...card, prompt: '同一 eventId 的冲突题干。' },
    });
    assert.equal(cardConflict.status, 409, cardConflict.body);

    const attempt = makeScenarioAttempt(card);
    const acceptedAttempt = await client.request('/api/practice-attempts', {
      method: 'POST', headers: currentSession.headers, body: attempt,
    });
    assert.equal(acceptedAttempt.status, 201, acceptedAttempt.body);
    const duplicateAttempt = await client.request('/api/practice-attempts', {
      method: 'POST', headers: currentSession.headers, body: attempt,
    });
    assert.equal(duplicateAttempt.status, 200, duplicateAttempt.body);
    assert.deepEqual(duplicateAttempt.json(), { status: 'duplicate', eventId: attempt.eventId });
    const attemptConflict = await client.request('/api/practice-attempts', {
      method: 'POST',
      headers: currentSession.headers,
      body: { ...attempt, checkNotes: '冲突的核对备注。' },
    });
    assert.equal(attemptConflict.status, 409, attemptConflict.body);

    const listing = await client.request('/api/practice-cards', { headers: currentSession.headers });
    assert.equal(listing.status, 200);
    assert.equal(listing.headers['cache-control'], 'no-store');
    const item = listing.json<PracticeCardsResponse>().items[0];
    assert.ok(item);
    assert.equal(item.card.kind, 'scenario');
    assert.deepEqual(item.card.scenario, card.scenario);
    assert.equal(item.card.sources.length, 4);
    assert.equal(item.status, 'ready');
    assert.equal(item.currentAttempts, 1);
    assert.equal(item.totalAttempts, 1);
    assert.equal(item.scenarioHistory?.sameCardAttempts, 1);
    assert.equal(item.scenarioHistory?.sameFamilyAttempts, 1);
    assert.ok(item.latest);
    assert.equal(item.latest.outcome, 'unverified');
    assert.equal(item.latest.answer, attempt.scenario!.stages[0].answer);
    assert.equal(item.latest.answeredAt, attempt.scenario!.stages[0].answeredAt);
    assert.equal(item.latest.cue, 'hinted');
    assert.deepEqual(item.latest.scenario, attempt.scenario);
    assert.equal(item.latest.scenario!.stages[0].hintShownAt, null);
    assert.ok(item.latest.scenario!.stages[1].hintShownAt);
    assert.ok(item.latest.scenario!.stages[2].hintShownAt);

    const historyResponse = await client.request('/api/practice-cards/scenario-family-card/history');
    assert.equal(historyResponse.status, 200, historyResponse.body);
    assert.equal(historyResponse.headers['cache-control'], 'no-store');
    const history = historyResponse.json<PracticeHistoryResponse>();
    assert.equal(history.cards.length, 1);
    assert.equal(history.attempts.length, 1);
    assert.deepEqual(history.attempts[0].scenario?.stages, attempt.scenario?.stages);

    const exported = (await client.request('/api/export')).json<ExportData>();
    assertLegacyEvidenceUnchanged(exported, baselineExport);
    assert.deepEqual(exported.practice?.cards[0].scenario, card.scenario);
    assert.deepEqual(exported.practice?.attempts[0].scenario?.stages, attempt.scenario?.stages);
    assert.equal((await client.request('/api/learning-overview')).body, baselineOverview.body);
    assert.equal((await client.request('/api/review-plan?timeZone=UTC')).body, baselinePlan.body);

    client.restart();
    const restartedListing = (await client.request('/api/practice-cards')).json<PracticeCardsResponse>();
    assert.equal(restartedListing.items.length, 1);
    assert.equal(restartedListing.items[0].card.eventId, card.eventId);
    assert.deepEqual(restartedListing.items[0].card.scenario, card.scenario);
    const restartedHistory = (await client.request('/api/practice-cards/scenario-family-card/history')).json<PracticeHistoryResponse>();
    assert.equal(restartedHistory.cards.length, 1);
    assert.equal(restartedHistory.attempts.length, 1);
    assert.deepEqual(restartedHistory.attempts[0].scenario?.stages, attempt.scenario?.stages);
  } finally {
    await client.stop();
  }
});

test('scenario source changes require a fresh card revision and paused cards reject new staged answers', async () => {
  const client = await running();
  try {
    const currentSession = await session(client);
    const snapshot = (await client.request('/api/snapshot?scope=all')).json<Snapshot>();
    const card = makeScenarioCard(snapshot, 'scenario-source-root');
    assert.equal((await client.request('/api/practice-cards', {
      method: 'POST', headers: currentSession.headers, body: card,
    })).status, 201);

    const changedConcept = snapshot.concepts[0];
    writeFileSync(join(client.root, changedConcept.source.path), note(changedConcept.title, 'changed synthetic source requiring recheck'));
    assert.equal((await client.request('/api/refresh', {
      method: 'POST', headers: currentSession.headers, body: {},
    })).status, 200);
    const changedListing = (await client.request('/api/practice-cards')).json<PracticeCardsResponse>();
    assert.equal(changedListing.items[0].status, 'source-changed');
    assert.equal(changedListing.items[0].currentAttempts, 0);
    assert.equal((await client.request('/api/practice-attempts', {
      method: 'POST',
      headers: currentSession.headers,
      body: makeScenarioAttempt(card, 'scenario-stale-answer'),
    })).status, 409);

    const refreshed = (await client.request('/api/snapshot?scope=all')).json<Snapshot>();
    const reverified = makeScenarioCard(refreshed, 'scenario-source-reverified', card.eventId, '2026-09-26T10:00:00.000Z');
    assert.equal((await client.request('/api/practice-cards', {
      method: 'POST', headers: currentSession.headers, body: reverified,
    })).status, 201);
    const ready = (await client.request('/api/practice-cards')).json<PracticeCardsResponse>().items[0];
    assert.equal(ready.status, 'ready');
    assert.equal(ready.card.eventId, reverified.eventId);
    const changedRefreshedConcept = refreshed.concepts.find((concept) => concept.source.path === changedConcept.source.path);
    assert.ok(changedRefreshedConcept);
    const changedSource = ready.card.sources.find((source) => source.conceptId === changedRefreshedConcept.id);
    assert.ok(changedSource);
    assert.equal(changedSource.sourceRevision, changedRefreshedConcept.source.revision);

    const paused = makeScenarioCard(refreshed, 'scenario-source-paused', reverified.eventId, '2026-09-27T10:00:00.000Z', true);
    assert.equal((await client.request('/api/practice-cards', {
      method: 'POST', headers: currentSession.headers, body: paused,
    })).status, 201);
    const pausedListing = (await client.request('/api/practice-cards')).json<PracticeCardsResponse>().items[0];
    assert.equal(pausedListing.status, 'paused');
    assert.equal((await client.request('/api/practice-attempts', {
      method: 'POST',
      headers: currentSession.headers,
      body: makeScenarioAttempt(paused, 'scenario-paused-answer'),
    })).status, 409);
  } finally {
    await client.stop();
  }
});

test('scenario JSON restore maps all four sources and keeps duplicate restore and POST receipts idempotent', async () => {
  const donor = await running();
  const target = await running();
  try {
    const donorSession = await session(donor);
    const targetSession = await session(target);
    const donorSnapshot = (await donor.request('/api/snapshot?scope=all')).json<Snapshot>();
    const card = makeScenarioCard(donorSnapshot, 'scenario-restore-card');
    const attempt = makeScenarioAttempt(card, 'scenario-restore-attempt');
    assert.equal((await donor.request('/api/practice-cards', {
      method: 'POST', headers: donorSession.headers, body: card,
    })).status, 201);
    assert.equal((await donor.request('/api/practice-attempts', {
      method: 'POST', headers: donorSession.headers, body: attempt,
    })).status, 201);
    const exported = (await donor.request('/api/export')).json<ExportData>();
    const donorSourceIds = new Set(card.sources.map((source) => source.conceptId));

    const previewResponse = await target.request('/api/import/preview', {
      method: 'POST',
      headers: targetSession.headers,
      body: { data: exported, options: DEFAULT_IMPORT_OPTIONS },
    });
    assert.equal(previewResponse.status, 200, previewResponse.body);
    const preview = previewResponse.json<ImportPreview>();
    assert.equal(preview.canImport, true, JSON.stringify(preview.issues));
    assert.equal(preview.counts.practiceCards, 1);
    assert.equal(preview.counts.practiceAttempts, 1);
    assert.equal(preview.matches.filter((match) => match.match === 'path-revision').length, 4);

    const commitBody = {
      data: exported,
      options: DEFAULT_IMPORT_OPTIONS,
      importId: 'scenario-restore-import',
      previewToken: preview.token,
      confirmed: true,
    };
    const committed = await target.request('/api/import/commit', {
      method: 'POST', headers: targetSession.headers, body: commitBody,
    });
    assert.equal(committed.status, 201, committed.body);
    const duplicateCommit = await target.request('/api/import/commit', {
      method: 'POST', headers: targetSession.headers, body: commitBody,
    });
    assert.equal(duplicateCommit.status, 200, duplicateCommit.body);
    const acceptedReceipt = committed.json<Record<string, unknown>>();
    const duplicateReceipt = duplicateCommit.json<Record<string, unknown>>();
    assert.equal(duplicateReceipt.status, 'duplicate');
    assert.equal(duplicateReceipt.importId, acceptedReceipt.importId);
    assert.equal(duplicateReceipt.sourceId, acceptedReceipt.sourceId);
    assert.deepEqual(duplicateReceipt.counts, acceptedReceipt.counts);
    assert.equal(duplicateReceipt.backupId, acceptedReceipt.backupId);

    const restored = (await target.request('/api/export')).json<ExportData>();
    assert.equal(restored.practice?.cards.length, 1);
    assert.equal(restored.practice?.attempts.length, 1);
    const localConceptIds = new Set((await target.request('/api/snapshot?scope=all')).json<Snapshot>().concepts.map((concept) => concept.id));
    const restoredCard = restored.practice!.cards[0];
    assert.equal(restoredCard.sources.length, 4);
    assert.ok(restoredCard.sources.every((source) => localConceptIds.has(source.conceptId)));
    assert.ok(restoredCard.sources.every((source) => !donorSourceIds.has(source.conceptId)));
    assert.deepEqual(restored.practice!.attempts[0].scenario?.stages, attempt.scenario?.stages);

    const { recordedAt: _cardRecordedAt, ...restoredCardRequest } = restoredCard;
    const firstCardPost = await target.request('/api/practice-cards', {
      method: 'POST', headers: targetSession.headers, body: restoredCardRequest,
    });
    const secondCardPost = await target.request('/api/practice-cards', {
      method: 'POST', headers: targetSession.headers, body: restoredCardRequest,
    });
    assert.equal(firstCardPost.status, 200, firstCardPost.body);
    assert.equal(secondCardPost.status, 200, secondCardPost.body);
    assert.deepEqual(secondCardPost.json(), firstCardPost.json());

    const { recordedAt: _attemptRecordedAt, ...restoredAttemptRequest } = restored.practice!.attempts[0];
    const firstAttemptPost = await target.request('/api/practice-attempts', {
      method: 'POST', headers: targetSession.headers, body: restoredAttemptRequest,
    });
    const secondAttemptPost = await target.request('/api/practice-attempts', {
      method: 'POST', headers: targetSession.headers, body: restoredAttemptRequest,
    });
    assert.equal(firstAttemptPost.status, 200, firstAttemptPost.body);
    assert.equal(secondAttemptPost.status, 200, secondAttemptPost.body);
    assert.deepEqual(secondAttemptPost.json(), firstAttemptPost.json());
  } finally {
    await donor.stop();
    await target.stop();
  }
});

test('scenario cards remain private between accounts and private reads return no-store 404s', async () => {
  const client = await running(true);
  try {
    const setup = await client.request('/api/auth/setup', {
      method: 'POST',
      body: { username: 'owner', password: 'owner-password-2026' },
    });
    assert.equal(setup.status, 201, setup.body);
    const ownerCookie = cookieFrom(setup);
    const ownerSession = await session(client, ownerCookie);
    const ownerSnapshot = (await client.request('/api/snapshot?scope=all', { cookie: ownerCookie })).json<Snapshot>();
    const card = makeScenarioCard(ownerSnapshot, 'private-scenario-card');
    assert.equal((await client.request('/api/practice-cards', {
      method: 'POST', cookie: ownerCookie, headers: ownerSession.headers, body: card,
    })).status, 201);

    const memberCreated = await client.request('/api/admin/users', {
      method: 'POST', cookie: ownerCookie, headers: ownerSession.headers,
      body: { username: 'member', password: 'member-password-2026' },
    });
    assert.equal(memberCreated.status, 201, memberCreated.body);
    const memberLogin = await client.request('/api/auth/login', {
      method: 'POST', body: { username: 'member', password: 'member-password-2026' },
    });
    assert.equal(memberLogin.status, 200, memberLogin.body);
    const memberCookie = cookieFrom(memberLogin);
    const memberSession = await session(client, memberCookie);

    const memberListing = await client.request('/api/practice-cards', {
      cookie: memberCookie, headers: memberSession.headers,
    });
    assert.equal(memberListing.status, 200);
    assert.equal(memberListing.headers['cache-control'], 'no-store');
    assert.deepEqual(memberListing.json<PracticeCardsResponse>().items, []);
    assert.doesNotMatch(memberListing.body, /事故响应场景|四份合成来源/);

    const memberHistory = await client.request('/api/practice-cards/private-scenario-card/history', {
      cookie: memberCookie, headers: memberSession.headers,
    });
    assert.equal(memberHistory.status, 404, memberHistory.body);
    assert.equal(memberHistory.headers['cache-control'], 'no-store');
    assert.doesNotMatch(memberHistory.body, /事故响应场景|四份合成来源/);

    const ownerListing = await client.request('/api/practice-cards', {
      cookie: ownerCookie, headers: ownerSession.headers,
    });
    assert.equal(ownerListing.status, 200);
    assert.equal(ownerListing.headers['cache-control'], 'no-store');
    assert.match(ownerListing.body, /事故响应场景/);
  } finally {
    await client.stop();
  }
});
