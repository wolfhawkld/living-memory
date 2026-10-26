import assert from 'node:assert/strict';
import test from 'node:test';
import { renameSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import { createApp, closeApp } from '../src/server/app.js';
import { AnswerClearingStoreError } from '../src/server/answer-clearing-store-error.js';
import { AnswerClearingError, parseAnswerClearingState } from '../src/shared/answer-clearing.js';
import { appV3Files, appV3Fixture, V3_NOW } from './helpers/app-v3-fixture.js';
import type { ObservationRequest } from '../src/shared/types.js';

type Fixture = Awaited<ReturnType<typeof appV3Fixture>>;
const headers = (session: any) => ({ 'x-lm-token': session.writeToken, 'x-lm-source-id': session.sourceId, 'x-lm-instance-id': session.instanceId });
const path = (id = 'saved-parent') => `/api/observations/${id}/answer-clearing`;
function observation(f: Fixture, answer = 'SYNTHETIC_PRIVATE_ANSWER', eventId = 'saved-parent'): ObservationRequest {
  const concept = f.app.livingMemory.getSource().index.concepts[0];
  return { eventId, conceptId: concept.id, sourceRevision: concept.source.revision, observedAt: V3_NOW, configRevision: 1,
    anchorEventId: null, answer, evidenceMode: 'written', rating: 'partial', exposure: 'unexposed', observedExposure: false };
}
async function saved(f: Fixture, answer?: string, eventId?: string) {
  const session = (await f.send('/api/session')).body;
  const request = observation(f, answer, eventId);
  assert.equal((await f.send('/api/observations', { method: 'POST', body: request, headers: headers(session) })).status, 201);
  return { session, request, auth: headers(session) };
}

test('answer-clearing state contract rejects extra metadata, accessor fields and invalid union members', () => {
  assert.deepEqual(parseAnswerClearingState({ observationEventId: 'parent', status: 'saved' }), { observationEventId: 'parent', status: 'saved' });
  assert.deepEqual(parseAnswerClearingState({ observationEventId: 'parent', status: 'empty' }), { observationEventId: 'parent', status: 'empty' });
  assert.deepEqual(parseAnswerClearingState({ observationEventId: 'parent', status: 'cleared', clearedAt: V3_NOW }), { observationEventId: 'parent', status: 'cleared', clearedAt: V3_NOW });
  for (const input of [null, {}, { observationEventId: 'parent', status: 'cleared' },
    { observationEventId: 'parent', status: 'saved', answer: 'SYNTHETIC_PRIVATE_ANSWER' },
    { observationEventId: 'parent', status: 'empty', clearedAt: V3_NOW },
    { observationEventId: 'parent', status: 'cleared', clearedAt: 'bad' },
    Object.defineProperty({ observationEventId: 'parent' }, 'status', { enumerable: true, get() { throw new Error('accessed'); } })]) {
    assert.throws(() => parseAnswerClearingState(input), (error: unknown) => error instanceof AnswerClearingError && error.code === 'INVALID_STATE');
  }
});

test('authorized bodyless clearing is idempotent, state-only, durable and recoverable after a lost receipt', async () => {
  const f = await appV3Fixture();
  try {
    const { auth, request } = await saved(f);
    const before = (await f.send('/api/export')).body;
    assert.deepEqual((await f.send(path(), { headers: auth })).body, { observationEventId: request.eventId, status: 'saved' });
    // The caller deliberately discards the successful POST receipt, then recovers using GET.
    assert.equal((await f.send(path(), { method: 'POST', headers: auth })).status, 201);
    const state = await f.send(path(), { headers: { 'x-lm-source-id': auth['x-lm-source-id'], 'x-lm-instance-id': auth['x-lm-instance-id'] } });
    assert.deepEqual(state.body, { observationEventId: request.eventId, status: 'cleared', clearedAt: V3_NOW });
    assert.equal(state.headers['cache-control'], 'no-store');
    assert.doesNotMatch(state.text, /SYNTHETIC_PRIVATE_ANSWER|rating|length|scenario/);
    f.setClock('2026-10-19T00:00:00.000Z');
    const retry = await f.send(path(), { method: 'POST', headers: auth });
    assert.equal(retry.status, 200); assert.deepEqual(retry.body, { ...state.body, status: 'duplicate' });
    const after = (await f.send('/api/export')).body;
    const original = before.observations[0];
    assert.deepEqual(after.observations[0], { ...original, answer: null, answerClearing: { observationEventId: request.eventId, clearedAt: V3_NOW } });
    assert.deepEqual(after.anchors, before.anchors); assert.deepEqual(after.reviewPlan, before.reviewPlan);
    f.restart();
    assert.deepEqual((await f.send(path(), { headers: auth })).body, state.body);
    assert.equal((await f.send('/api/observations', { method: 'POST', headers: headers((await f.send('/api/session')).body), body: request })).body.error.code, 'ANSWER_CLEARED');
  } finally { await f.close(); }
});

test('clearing gates source, exact instance, write token and protocol without mutating the parent', async () => {
  const f = await appV3Fixture();
  try {
    const { auth } = await saved(f);
    const gates: Array<{ headers: Record<string, string>; code: string; status: number }> = [
      { headers: {}, code: 'SOURCE_REQUIRED', status: 400 },
      { headers: { 'x-lm-source-id': auth['x-lm-source-id'] }, code: 'INSTANCE_MISMATCH', status: 409 },
      { headers: { ...auth, 'x-lm-instance-id': 'wrong-instance' }, code: 'INSTANCE_MISMATCH', status: 409 },
      { headers: { ...auth, 'x-lm-source-id': 'wrong-source' }, code: 'SOURCE_MISMATCH', status: 409 },
    ];
    for (const method of ['GET', 'POST']) for (const gate of gates) {
      const response = await f.send(path(), { method, headers: gate.headers });
      assert.equal(response.status, gate.status, `${method} ${gate.code}`); assert.equal(response.body.error.code, gate.code);
    }
    for (const token of ['', 'wrong-token']) {
      const response = await f.send(path(), { method: 'POST', headers: { ...auth, 'x-lm-token': token } });
      assert.equal(response.status, 401); assert.equal(response.body.error.code, 'TOKEN_REQUIRED');
    }
    for (const protocol of [null, '2', '03', ['3', '3']]) {
      const response = await f.send(path(), { method: 'POST', headers: auth, protocol });
      assert.equal(response.status, 426);
    }
    assert.equal((await f.send(path(), { headers: auth })).body.status, 'saved');
  } finally { await f.close(); }
});

test('every nonzero clearing body and query is rejected before any original answer can be cleared', async () => {
  const f = await appV3Fixture();
  try {
    const { auth } = await saved(f);
    for (const rawBody of ['{}', 'null', ' ', '{', 'SYNTHETIC_PRIVATE_ANSWER', JSON.stringify({ answer: 'SYNTHETIC_PRIVATE_ANSWER' })]) {
      const variants: Array<Record<string, string>> = [{}, { 'content-type': 'text/plain' }, { 'content-length': String(Buffer.byteLength(rawBody)) }];
      for (const bodyHeaders of variants) {
        const reply = await f.send(path(), { method: 'POST', headers: { ...auth, ...bodyHeaders }, rawBody });
        assert.equal(reply.status, 400); assert.equal(reply.body.error.code, 'ANSWER_CLEARING_INVALID_REQUEST');
        assert.doesNotMatch(reply.text, /SYNTHETIC_PRIVATE_ANSWER/);
      }
    }
    assert.equal((await f.send(`${path()}?answer=ignored`, { method: 'POST', headers: auth })).status, 400);
    assert.equal((await f.send(path(), { headers: auth })).body.status, 'saved');
    assert.equal((await f.send(path(), { method: 'POST', headers: { ...auth, 'content-length': '0' } })).status, 201);
  } finally { await f.close(); }
});

test('empty and mental answers stay empty while whitespace is saved, invalid and unknown IDs remain safe', async () => {
  const f = await appV3Fixture();
  try {
    const { auth } = await saved(f, '', 'empty-parent');
    const mental = { ...observation(f, '', 'mental-parent'), evidenceMode: 'mental' };
    assert.equal((await f.send('/api/observations', { method: 'POST', headers: auth, body: mental })).status, 201);
    await saved(f, '  ', 'whitespace-parent');
    for (const eventId of ['empty-parent', 'mental-parent']) {
      assert.deepEqual((await f.send(path(eventId), { headers: auth })).body, { observationEventId: eventId, status: 'empty' });
      const rejected = await f.send(path(eventId), { method: 'POST', headers: auth });
      assert.equal(rejected.status, 409); assert.equal(rejected.body.error.code, 'ANSWER_CLEARING_NO_SAVED_ANSWER');
    }
    assert.equal((await f.send(path('whitespace-parent'), { headers: auth })).body.status, 'saved');
    assert.equal((await f.send(path('whitespace-parent'), { method: 'POST', headers: auth })).status, 201);
    for (const method of ['GET', 'POST']) {
      const missing = await f.send(path('unknown-parent'), { method, headers: auth });
      assert.equal(missing.status, 404); assert.equal(missing.body.error.code, 'ANSWER_CLEARING_NOT_FOUND');
      const invalid = await f.send(path('invalid%20id'), { method, headers: auth });
      assert.equal(invalid.status, 400); assert.equal(invalid.body.error.code, 'ANSWER_CLEARING_INVALID_REQUEST');
    }
  } finally { await f.close(); }
});

test('clearing archived parents invalidates revision cursors and rejects an old nonempty export', async () => {
  const f = await appV3Fixture();
  try {
    const { auth, request } = await saved(f);
    const oldExport = (await f.send('/api/export')).body;
    const revisionPath = `/api/observations/${request.eventId}/revisions`;
    for (const [index, previousEventId] of [null, 'revision-one'].entries()) {
      const body = { eventId: index ? 'revision-two' : 'revision-one', observationEventId: request.eventId, previousEventId,
        occurredAt: V3_NOW, action: 'revise', reason: 'rechecked-original', assessment: { rating: index ? 'partial' : 'clear', learning: null } };
      assert.equal((await f.send(revisionPath, { method: 'POST', headers: auth, body })).status, 201);
    }
    const cursor = (await f.send(`${revisionPath}?limit=1`)).body.nextCursor; assert.ok(cursor);
    const concept = f.app.livingMemory.getSource().index.concepts.find(c => c.id === request.conceptId)!;
    renameSync(join(f.root, concept.source.path), join(f.root, 'archived.txt')); f.app.livingMemory.refresh();
    assert.equal((await f.send(path(), { headers: auth })).body.status, 'saved');
    assert.equal((await f.send(path(), { method: 'POST', headers: auth })).status, 201);
    const stale = await f.send(`${revisionPath}?limit=1&cursor=${encodeURIComponent(cursor)}`);
    assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'OBSERVATION_REVISION_HISTORY_CHANGED');
    const fresh = await f.send(revisionPath); assert.equal(fresh.body.observation.answer, null); assert.equal(fresh.body.total, 2);
    const imported = await f.send('/api/import/preview', { method: 'POST', headers: auth, body: { data: oldExport, options: { restoreLayout: false, restoreReviewPlan: false } } });
    assert.equal(imported.status, 409); assert.equal(imported.body.error.code, 'ANSWER_CLEARED');
    assert.doesNotMatch(imported.text, /SYNTHETIC_PRIVATE_ANSWER/);
  } finally { await f.close(); }
});

test('account authentication and namespace prevent clearing or reading another user parent', async () => {
  const f = await appV3Fixture({ accountsEnabled: true });
  try {
    const setup = await f.send('/api/auth/setup', { method: 'POST', protocol: null, body: { username: 'owner', password: 'synthetic-owner-password' } });
    const session = (await f.send('/api/session', { cookie: setup.cookie })).body, auth = headers(session);
    const body = observation(f);
    assert.equal((await f.send('/api/observations', { method: 'POST', cookie: setup.cookie, headers: auth, body })).status, 201);
    const credentials = { username: 'member', password: 'synthetic-member-password' };
    const created = await f.send('/api/admin/users', { method: 'POST', cookie: setup.cookie, headers: auth, body: credentials }); assert.equal(created.status, 201);
    const login = await f.send('/api/auth/login', { method: 'POST', protocol: null, body: credentials });
    const member = (await f.send('/api/session', { cookie: login.cookie })).body;
    for (const method of ['GET', 'POST']) {
      assert.equal((await f.send(path(), { method, headers: auth })).status, 401);
      assert.equal((await f.send(path(), { method, cookie: login.cookie, headers: auth })).status, 409);
      const missing = await f.send(path(), { method, cookie: login.cookie, headers: headers(member) });
      assert.equal(missing.status, 404); assert.equal(missing.body.error.code, 'ANSWER_CLEARING_NOT_FOUND');
    }
    assert.equal((await f.send(path(), { cookie: setup.cookie, headers: auth })).body.status, 'saved');
    assert.equal((await f.send(path(), { method: 'POST', cookie: setup.cookie, headers: auth })).status, 201);
  } finally { await f.close(); }
});

test('default v2 registers neither clearing endpoint', async () => {
  const files = appV3Files(), app = createApp(files), server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as { port: number }).port;
    for (const method of ['GET', 'POST']) await new Promise<void>((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port, path: path(), method, headers: { host: '127.0.0.1:4317', 'x-lm-learning-protocol': '2' } }, res => {
        res.resume(); res.on('end', () => { try { assert.equal(res.statusCode, 404); resolve(); } catch (error) { reject(error); } });
      }); req.on('error', reject); req.end();
    });
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); closeApp(app); files.remove(); }
});


test('concurrent clear requests publish one invalidation and fixed failures reveal no stored text', async () => {
  const f = await appV3Fixture();
  try {
    const { auth } = await saved(f);
    const frame = async () => JSON.parse((await f.send('/api/changes?learningProtocol=3', { protocol: null, firstFrame: true })).text.split('data: ')[1].trim());
    const before = await frame();
    const results = await Promise.all([f.send(path(), { method: 'POST', headers: auth }), f.send(path(), { method: 'POST', headers: auth })]);
    assert.deepEqual(results.map(result => result.status).sort(), [200, 201]);
    assert.equal(results[0].body.clearedAt, results[1].body.clearedAt);
    const after = await frame(); assert.equal(after.revision, before.revision + 1);
    const original = f.app.livingMemory.store.clearObservationAnswer;
    f.app.livingMemory.store.clearObservationAnswer = () => { const error = new AnswerClearingStoreError('ANSWER_CLEARING_WRITE_FAILED', 503); error.message = 'SYNTHETIC_PRIVATE_ANSWER SQL'; throw error; };
    try {
      const failed = await f.send(path(), { method: 'POST', headers: auth });
      assert.equal(failed.status, 503); assert.equal(failed.body.error.code, 'ANSWER_CLEARING_WRITE_FAILED');
      assert.doesNotMatch(failed.text, /SYNTHETIC_PRIVATE_ANSWER|SQL/);
    } finally { f.app.livingMemory.store.clearObservationAnswer = original; }
    assert.equal((await frame()).revision, after.revision);
    assert.equal((await f.send(path(), { headers: auth })).body.status, 'cleared');
  } finally { await f.close(); }
});
