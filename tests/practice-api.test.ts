import { strict as assert } from 'node:assert';
import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeApp, createApp } from '../src/server/app.js';
import type { ExportData, Snapshot } from '../src/shared/types.js';
import type { PracticeAttemptRequest, PracticeCardRequest, PracticeCardsResponse, PracticeHistoryResponse } from '../src/shared/practice.js';
import type { ImportPreview } from '../src/shared/import-data.js';
import { DEFAULT_IMPORT_OPTIONS } from '../src/shared/import-data.js';

const NOW = '2026-01-10T00:00:00.000Z';
const note = (title: string, body: string) => `---\ntype: concept\ntitle: ${title}\nsummary: ${body}\n---\n\n${body}\n`;
interface Response { status: number; headers: IncomingHttpHeaders; body: string; json: <T>() => T }
interface Options { method?: string; body?: unknown; headers?: Record<string, string>; cookie?: string }

async function running(accountsEnabled = false) {
  const root = mkdtempSync(join(tmpdir(), 'lm-practice-source-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'lm-practice-data-'));
  writeFileSync(join(root, 'Alpha.md'), note('Alpha', 'Alpha reference'));
  writeFileSync(join(root, 'Beta.md'), note('Beta', 'Beta reference'));
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as { port: number }).port;
  let app = createApp({ root, dataDir, port, accountsEnabled, limit: 1, now: () => new Date(NOW), staticDir: join(dataDir, 'no-dist') });
  server.on('request', app);
  const request = (path: string, options: Options = {}) => new Promise<Response>((resolve, reject) => {
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method: options.method ?? 'GET',
      headers: { host: `127.0.0.1:${port}`, ...(body ? { 'content-type': 'application/json' } : {}),
        ...(options.cookie ? { cookie: options.cookie } : {}), ...options.headers } }, (response) => {
      let text = ''; response.setEncoding('utf8'); response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: text, json: <T>() => JSON.parse(text) as T }));
    });
    req.once('error', reject); if (body) req.write(body); req.end();
  });
  return { root, dataDir, request,
    restart: () => {
      server.removeListener('request', app); closeApp(app);
      app = createApp({ root, dataDir, port, accountsEnabled, limit: 1, now: () => new Date(NOW), staticDir: join(dataDir, 'no-dist') });
      server.on('request', app);
    },
    stop: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); closeApp(app);
      rmSync(root, { recursive: true, force: true }); rmSync(dataDir, { recursive: true, force: true });
    } };
}

async function session(client: Awaited<ReturnType<typeof running>>, cookie?: string) {
  const value = (await client.request('/api/session', { cookie })).json<{ writeToken: string; sourceId: string }>();
  return { value, headers: { 'x-lm-token': value.writeToken, 'x-lm-source-id': value.sourceId } };
}

function makeCard(snapshot: Snapshot): PracticeCardRequest {
  return { eventId: 'card-v1', cardId: 'question', previousEventId: null, occurredAt: '2026-01-02T00:00:00.000Z',
    kind: 'comparison', title: 'Conditions', prompt: 'Under which conditions should each method be used?',
    referenceAnswer: 'PRIVATE REFERENCE ANSWER', referenceNotes: 'Compare the assumptions in both notes.',
    sources: snapshot.concepts.map((concept) => ({ conceptId: concept.id, sourceRevision: concept.source.revision })),
    sourceChecked: true, paused: false };
}
function makeAttempt(card: PracticeCardRequest, eventId = 'attempt-v1'): PracticeAttemptRequest {
  return { eventId, cardId: card.cardId, cardEventId: card.eventId, answeredAt: '2026-01-03T00:00:00.000Z',
    answer: 'PRIVATE OWN ANSWER', confidence: 75, confidenceAt: '2026-01-02T23:59:00.000Z', exposure: 'unexposed',
    observedExposure: false, cue: 'independent', outcome: 'partial', checkNotes: 'One condition was missing.' };
}

test('practice API uses the full index, preserves anchors/retention and aggregates, checks versions, and survives restart', async () => {
  const client = await running();
  try {
    const s = await session(client);
    const full = (await client.request('/api/snapshot?scope=all')).json<Snapshot>();
    assert.equal(full.concepts.length, 2);
    assert.equal((await client.request('/api/snapshot')).json<Snapshot>().concepts.length, 1);
    const first = full.concepts[0];
    const review = { eventId: 'anchor', conceptId: first.id, sourceRevision: first.source.revision, kind: 'review', occurredAt: '2026-01-01T00:00:00.000Z' };
    assert.equal((await client.request('/api/reviews', { method: 'POST', headers: s.headers, body: review })).status, 201);
    const retain = { eventId: 'retained', conceptId: first.id, sourceRevision: first.source.revision, occurredAt: '2026-01-01T01:00:00.000Z', active: true, previousEventId: null };
    assert.equal((await client.request('/api/retentions', { method: 'POST', headers: s.headers, body: retain })).status, 201);
    const baseline = (await client.request('/api/export')).json<ExportData>();
    const beforeOverview = (await client.request('/api/learning-overview')).body;
    const beforePlan = (await client.request('/api/review-plan?timeZone=UTC')).body;
    const card = makeCard(full);
    assert.equal((await client.request('/api/practice-cards', { method: 'POST', body: card })).status, 401);
    assert.equal((await client.request('/api/practice-cards', { method: 'POST', headers: { ...s.headers, 'x-lm-source-id': 'wrong' }, body: card })).status, 409);
    const created = await client.request('/api/practice-cards', { method: 'POST', headers: s.headers, body: card });
    assert.equal(created.status, 201, created.body);
    assert.equal((await client.request('/api/practice-cards', { method: 'POST', headers: s.headers, body: card })).status, 200);
    const attempt = makeAttempt(card);
    assert.equal((await client.request('/api/practice-attempts', { method: 'POST', headers: s.headers, body: attempt })).status, 201);
    assert.equal((await client.request('/api/practice-attempts', { method: 'POST', headers: s.headers, body: attempt })).status, 200);
    assert.equal((await client.request('/api/learning-overview')).body, beforeOverview);
    assert.equal((await client.request('/api/review-plan?timeZone=UTC')).body, beforePlan);
    const exported = (await client.request('/api/export')).json<ExportData>();
    assert.deepEqual(exported.anchors, baseline.anchors);
    assert.deepEqual(exported.retentions, baseline.retentions);
    assert.deepEqual(exported.configHistory, baseline.configHistory);
    assert.deepEqual(exported.observations, []);
    const listing = await client.request('/api/practice-cards', { headers: s.headers });
    assert.equal(listing.headers['cache-control'], 'no-store');
    const ready = listing.json<PracticeCardsResponse>().items[0];
    assert.equal(ready.status, 'ready'); assert.equal(ready.currentAttempts, 1);
    assert.equal(ready.latest?.answer, attempt.answer);

    const paused = { ...card, eventId: 'card-paused', previousEventId: card.eventId, occurredAt: '2026-01-04T00:00:00.000Z', paused: true };
    assert.equal((await client.request('/api/practice-cards', { method: 'POST', headers: s.headers, body: paused })).status, 201);
    assert.equal((await client.request('/api/practice-attempts', { method: 'POST', headers: s.headers, body: { ...attempt, eventId: 'stale-new-attempt' } })).status, 409);
    assert.equal((await client.request('/api/practice-attempts', { method: 'POST', headers: s.headers, body: attempt })).status, 200);
    const active = { ...paused, eventId: 'card-active', previousEventId: paused.eventId, occurredAt: '2026-01-05T00:00:00.000Z', paused: false };
    assert.equal((await client.request('/api/practice-cards', { method: 'POST', headers: s.headers, body: active })).status, 201);
    writeFileSync(join(client.root, first.source.path), note(first.title, 'A revised condition'));
    assert.equal((await client.request('/api/refresh', { method: 'POST', headers: s.headers, body: {} })).status, 200);
    const changed = (await client.request('/api/practice-cards')).json<PracticeCardsResponse>().items[0];
    assert.equal(changed.status, 'source-changed'); assert.equal(changed.currentAttempts, 0); assert.equal(changed.totalAttempts, 1);
    assert.equal((await client.request('/api/practice-attempts', { method: 'POST', headers: s.headers,
      body: { ...attempt, eventId: 'changed-source-attempt', cardEventId: active.eventId, answeredAt: '2026-01-06T00:00:00.000Z' } })).status, 409);
    assert.equal((await client.request('/api/practice-cards', { method: 'POST', headers: s.headers, body: card })).status, 200);
    const fresh = (await client.request('/api/snapshot?scope=all')).json<Snapshot>();
    assert.equal(fresh.states[first.id].status, 'retained');
    const revised = { ...active, eventId: 'card-current', previousEventId: active.eventId, occurredAt: '2026-01-07T00:00:00.000Z',
      referenceAnswer: 'Rechecked current assumptions', sources: fresh.concepts.map((concept) => ({ conceptId: concept.id, sourceRevision: concept.source.revision })) };
    assert.equal((await client.request('/api/practice-cards', { method: 'POST', headers: s.headers, body: revised })).status, 201);
    client.restart();
    const restarted = (await client.request('/api/practice-cards')).json<PracticeCardsResponse>().items[0];
    assert.equal(restarted.card.eventId, revised.eventId); assert.equal(restarted.status, 'ready');
    assert.equal(restarted.totalAttempts, 1); assert.equal(restarted.currentAttempts, 0);
    const history = (await client.request('/api/practice-cards/question/history')).json<PracticeHistoryResponse>();
    assert.equal(history.cards.length, 4); assert.equal(history.attempts.length, 1);
    assert.equal(history.attempts[0].answer, attempt.answer);
    const original = history.cards.find((item) => item.eventId === attempt.cardEventId)!;
    assert.equal(original.referenceAnswer, card.referenceAnswer);
  } finally { await client.stop(); }
});

test('practice export restores both comparison references across roots and retains idempotent request receipts', async () => {
  const donor = await running(); const target = await running();
  try {
    const d = await session(donor); const t = await session(target);
    const snapshot = (await donor.request('/api/snapshot?scope=all')).json<Snapshot>();
    const card = makeCard(snapshot); const attempt = makeAttempt(card);
    assert.equal((await donor.request('/api/practice-cards', { method: 'POST', headers: d.headers, body: card })).status, 201);
    assert.equal((await donor.request('/api/practice-attempts', { method: 'POST', headers: d.headers, body: attempt })).status, 201);
    const exported = (await donor.request('/api/export')).json<ExportData>();
    assert.equal(exported.practice?.cards.length, 1); assert.equal(exported.practice?.attempts.length, 1);
    const options = DEFAULT_IMPORT_OPTIONS;
    const previewResponse = await target.request('/api/import/preview', { method: 'POST', headers: t.headers, body: { data: exported, options } });
    assert.equal(previewResponse.status, 200, previewResponse.body);
    const preview = previewResponse.json<ImportPreview>();
    assert.equal(preview.canImport, true, JSON.stringify(preview.issues));
    const committed = await target.request('/api/import/commit', { method: 'POST', headers: t.headers,
      body: { data: exported, options, importId: 'practice-restore', previewToken: preview.token, confirmed: true } });
    assert.equal(committed.status, 201, committed.body);
    const restored = (await target.request('/api/export')).json<ExportData>();
    const localConcepts = (await target.request('/api/snapshot?scope=all')).json<Snapshot>().concepts;
    const localIds = new Set(localConcepts.map((concept) => concept.id));
    assert.ok(restored.practice?.cards[0].sources.every((source) => localIds.has(source.conceptId)));
    assert.equal(restored.practice?.attempts[0].answer, attempt.answer);
    const localCard = restored.practice!.cards[0]; const { recordedAt: _cardTime, ...cardRequest } = localCard;
    const { recordedAt: _attemptTime, ...attemptRequest } = restored.practice!.attempts[0];
    assert.equal((await target.request('/api/practice-cards', { method: 'POST', headers: t.headers, body: cardRequest })).status, 200);
    assert.equal((await target.request('/api/practice-attempts', { method: 'POST', headers: t.headers, body: attemptRequest })).status, 200);
    target.restart();
    assert.equal((await target.request('/api/practice-cards')).json<PracticeCardsResponse>().items[0].currentAttempts, 1);
    assert.deepEqual(restored.observations, []);
  } finally { await donor.stop(); await target.stop(); }
});

test('practice cards and answer history remain private to each authenticated knowledge space', async () => {
  const client = await running(true);
  try {
    assert.equal((await client.request('/api/practice-cards')).status, 401);
    const setup = await client.request('/api/auth/setup', { method: 'POST', body: { username: 'owner', password: 'owner-password-2026' } });
    const ownerCookie = setup.headers['set-cookie']![0].split(';')[0]; const owner = await session(client, ownerCookie);
    const snapshot = (await client.request('/api/snapshot?scope=all', { cookie: ownerCookie })).json<Snapshot>();
    const card = makeCard(snapshot);
    assert.equal((await client.request('/api/practice-cards', { method: 'POST', cookie: ownerCookie, headers: owner.headers, body: card })).status, 201);
    assert.equal((await client.request('/api/practice-attempts', { method: 'POST', cookie: ownerCookie, headers: owner.headers, body: makeAttempt(card) })).status, 201);
    assert.equal((await client.request('/api/admin/users', { method: 'POST', cookie: ownerCookie, headers: owner.headers,
      body: { username: 'member', password: 'member-password-2026' } })).status, 201);
    const login = await client.request('/api/auth/login', { method: 'POST', body: { username: 'member', password: 'member-password-2026' } });
    const memberCookie = login.headers['set-cookie']![0].split(';')[0]; const member = await session(client, memberCookie);
    const list = await client.request('/api/practice-cards', { cookie: memberCookie, headers: member.headers });
    assert.deepEqual(list.json<PracticeCardsResponse>().items, []); assert.doesNotMatch(list.body, /PRIVATE/);
    const history = await client.request('/api/practice-cards/question/history', { cookie: memberCookie, headers: member.headers });
    assert.equal(history.status, 404); assert.doesNotMatch(history.body, /PRIVATE/);
    assert.equal((await client.request('/api/practice-cards', { cookie: memberCookie, headers: owner.headers })).status, 409);
  } finally { await client.stop(); }
});
