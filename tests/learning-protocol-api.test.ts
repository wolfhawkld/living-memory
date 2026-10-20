import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, request as httpRequest } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Accounts } from '../src/server/accounts.js';
import { createApp, closeApp } from '../src/server/app.js';
import { LEARNING_PROTOCOL_HEADER as HEADER } from '../src/shared/learning-protocol.js';

async function fixture(accountsEnabled = false) {
  const dir = mkdtempSync(join(tmpdir(), 'lm-protocol-'));
  const root = join(dir, 'knowledge'); const dataDir = join(dir, 'data'); mkdirSync(root);
  writeFileSync(join(root, 'A.md'), '---\ntype: concept\ntitle: Alpha\nsummary: synthetic\n---\n# Alpha\nSynthetic content');
  writeFileSync(join(root, 'image.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(join(dir, 'outside.svg'), '<svg>PRIVATE_OUTSIDE_SYNTHETIC</svg>');
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const app = createApp({ root, dataDir, port, accountsEnabled, staticDir: join(dir, 'no-dist'), now: () => new Date('2026-10-18T12:00:00Z') });
  server.on('request', app);
  const request = (path: string, options: { method?: string; headers?: Record<string, string | string[]>; body?: unknown; rawBody?: string; cookie?: string; sse?: boolean } = {}) =>
    new Promise<{ status: number; json: any; text: string; cookie: string; headers: import('node:http').IncomingHttpHeaders }>((resolve, reject) => {
      const body = options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
      const req = httpRequest({ hostname: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(options.cookie ? { Cookie: options.cookie } : {}), ...options.headers,
      } }, res => {
        let text = ''; const result = () => { let json; try { json = JSON.parse(text); } catch { /* binary/SSE */ }
          resolve({ status: res.statusCode!, json, text, headers: res.headers, cookie: res.headers['set-cookie']?.[0].split(';')[0] ?? '' }); };
        res.on('data', data => { text += data; if (options.sse && res.statusCode === 200) { result(); res.destroy(); } });
        res.on('end', result); res.on('error', error => { if (!options.sse) reject(error); });
      }); req.on('error', reject); req.end(body);
    });
  const source = app.livingMemory.getSource();
  const exportRaw = () => { const data = app.livingMemory.store.exportData(source.index.source, source.index.concepts); return { ...data, exportedAt: '' }; };
  return { app, root, dataDir, request, exportRaw, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); closeApp(app); rmSync(dir, { recursive: true, force: true }); } };
}

test('authenticated data requires exactly protocol 2, before writes, with only explicit handshake/auth/health exceptions', async () => {
  const f = await fixture();
  try {
    const session = (await f.request('/api/session')).json;
    assert.equal(session.learningProtocolVersion, 2);
    const before = f.exportRaw();
    for (const value of [undefined, '1', '3', '02', '2, 2', ['2', '2']]) {
      const headers: Record<string, string | string[]> = value === undefined ? {} : { [HEADER]: value };
      assert.equal((await f.request('/api/observations', { method: 'POST', headers, rawBody: '{' })).status, 426);
      for (const [path, method] of [['/api/snapshot', 'GET'], ['/api/export', 'GET'], ['/api/observations', 'POST'], ['/api/import/preview', 'POST']]) {
        const r = await f.request(path, { method, headers, body: method === 'POST' ? {} : undefined });
        assert.equal(r.status, 426, `${method} ${path} ${value}`); assert.equal(r.json.error.code, 'LEARNING_PROTOCOL_REQUIRED');
      }
    }
    assert.equal((await f.request('/api/observations', { method: 'POST', headers: { [HEADER]: '2' }, rawBody: '{' })).status, 400);
    assert.equal((await f.request('/api/snapshot?learningProtocol=2')).status, 426);
    assert.equal((await f.request('/api/snapshot', { headers: { [HEADER]: '2' } })).status, 200);
    assert.equal((await f.request('/api/snapshot', { headers: { [HEADER]: '2', 'X-LM-Source-ID': 'wrong' } })).status, 409);
    assert.equal((await f.request('/api/observations', { method: 'POST', headers: { [HEADER]: '2' }, body: {} })).status, 401);
    assert.equal((await f.request('/api/health')).status, 200);
    const cors = await f.request('/api/snapshot', { method: 'OPTIONS' });
    assert.match(String(cors.headers['access-control-allow-headers']), /X-LM-Learning-Protocol/);
    assert.equal((await f.request('/api/snapshot', { headers: { [HEADER]: '2', Origin: 'https://outside.example' } })).status, 403);
    assert.deepEqual(f.exportRaw(), before);
  } finally { await f.close(); }
});

test('only GET attachment bytes bypass header; SSE requires a single explicit query and retains source checks', async () => {
  const f = await fixture();
  try {
    const session = (await f.request('/api/session')).json;
    const concept = f.app.livingMemory.getSource().index.concepts[0];
    const path = `/api/concepts/${concept.id}/attachment?${new URLSearchParams({ sourceId: session.sourceId, sourceRevision: concept.source.revision, path: 'image.svg' })}`;
    assert.equal((await f.request(path)).status, 200);
    const stale = new URL(path, 'http://synthetic.invalid'); stale.searchParams.set('sourceRevision', 'old');
    assert.equal((await f.request(`${stale.pathname}${stale.search}`)).status, 409);
    const outside = await f.request(path.replace('image.svg', '../outside.svg'));
    assert.equal(outside.status, 404); assert.doesNotMatch(outside.text, /PRIVATE_OUTSIDE_SYNTHETIC/);
    assert.equal((await f.request(path, { method: 'POST' })).status, 426);
    assert.equal((await f.request(`/api/concepts/${concept.id}/attachment-extra`)).status, 426);
    for (const suffix of ['', '?learningProtocol=1', '?learningProtocol=3', '?learningProtocol=2&learningProtocol=2']) {
      assert.equal((await f.request(`/api/changes${suffix}`, { headers: { [HEADER]: '2' } })).status, 426);
    }
    for (const value of ['1', '3', '2, 2', ['2', '2']]) {
      assert.equal((await f.request('/api/changes?learningProtocol=2', { headers: { [HEADER]: value } })).status, 426);
    }
    assert.equal((await f.request('/api/changes?learningProtocol=2', { sse: true })).status, 200);
    assert.equal((await f.request('/api/changes?learningProtocol=2', { headers: { 'X-LM-Source-ID': 'wrong' } })).status, 409);
  } finally { await f.close(); }
});

test('protocol rejection follows authentication and never initializes a lazy member knowledge store', async () => {
  const f = await fixture(true);
  let accounts: Accounts | undefined;
  try {
    assert.equal((await f.request('/api/snapshot')).status, 401);
    for (const path of ['/api/auth/setup', '/api/auth/login']) assert.equal((await f.request(path, { method: 'POST', rawBody: '{' })).status, 400);
    assert.equal((await f.request('/api/auth/setup', { method: 'POST', body: { username: 'protocol-owner', password: 'synthetic-owner-password-2026' } })).status, 201);
    accounts = new Accounts({ dataDir: f.dataDir });
    const member = await accounts.createUser('protocol-member', 'synthetic-member-password-2026');
    const login = await f.request('/api/auth/login', { method: 'POST', body: { username: 'protocol-member', password: 'synthetic-member-password-2026' } });
    assert.equal(login.status, 200);
    const memberRoot = join(f.dataDir, 'users', member.id, 'knowledge');
    assert.equal(existsSync(memberRoot), false);
    const before = readFileSync(f.app.livingMemory.store.dbPath);
    assert.equal((await f.request('/api/snapshot', { cookie: login.cookie })).status, 426);
    assert.equal(existsSync(memberRoot), false);
    assert.deepEqual(readFileSync(f.app.livingMemory.store.dbPath), before);
    assert.equal((await f.request('/api/snapshot', { cookie: login.cookie, headers: { [HEADER]: '2' } })).status, 200);
    assert.equal(existsSync(memberRoot), true);
  } finally { accounts?.close(); await f.close(); }
});

test('revision routes keep archived parents private, validate path/body and preserve receipts, original evidence and anchors', async () => {
  const f = await fixture(true);
  let accounts: Accounts | undefined;
  try {
    const owner = await f.request('/api/auth/setup', { method: 'POST', body: { username: 'revision-owner', password: 'synthetic-owner-password-2026' } });
    const session = (await f.request('/api/session', { cookie: owner.cookie })).json;
    const headers = { [HEADER]: '2', 'X-LM-Token': session.writeToken, 'X-LM-Source-ID': session.sourceId, 'X-LM-Instance-ID': session.instanceId };
    const concept = f.app.livingMemory.getSource().index.concepts[0];
    const observation = { eventId: 'original-observation', conceptId: concept.id, sourceRevision: concept.source.revision, observedAt: '2026-10-17T12:00:00Z', configRevision: 1, anchorEventId: null, answer: 'original answer', rating: 'clear' as const, exposure: 'unexposed' as const, observedExposure: false };
    assert.equal((await f.request('/api/observations', { method: 'POST', cookie: owner.cookie, headers, body: observation })).status, 201);
    const before = f.exportRaw();
    unlinkSync(join(f.root, 'A.md')); f.app.livingMemory.refresh();
    const path = `/api/observations/${observation.eventId}/revisions`;
    const revision = { eventId: 'revision-1', observationEventId: observation.eventId, previousEventId: null, occurredAt: '2026-10-18T11:00:00Z', action: 'revise', reason: 'input-error', assessment: { rating: 'partial', learning: null } };
    assert.equal((await f.request(path, { cookie: owner.cookie })).status, 426);
    assert.equal((await f.request(path, { method: 'POST', cookie: owner.cookie, headers, body: { ...revision, observationEventId: 'another-parent' } })).status, 400);
    assert.equal((await f.request(path, { method: 'POST', cookie: owner.cookie, headers: { ...headers, 'X-LM-Token': 'bad' }, body: revision })).status, 401);
    assert.equal((await f.request(path, { method: 'POST', cookie: owner.cookie, headers: { ...headers, 'X-LM-Instance-ID': 'another' }, body: revision })).status, 409);
    assert.equal((await f.request(path, { method: 'POST', cookie: owner.cookie, headers, body: revision })).status, 201);
    assert.equal((await f.request(path, { method: 'POST', cookie: owner.cookie, headers, body: revision })).json.status, 'duplicate');
    assert.equal((await f.request(path, { method: 'POST', cookie: owner.cookie, headers, body: { ...revision, reason: 'other' } })).status, 409);
    const history = await f.request(`${path}?limit=1`, { cookie: owner.cookie, headers });
    assert.equal(history.status, 200); assert.equal(history.json.observation.answer, 'original answer');
    assert.equal(history.json.state.currentAssessment.rating, 'partial'); assert.equal(history.json.total, 1);
    const after = f.exportRaw(); assert.deepEqual(after.observations, before.observations); assert.deepEqual(after.anchors, before.anchors);
    accounts = new Accounts({ dataDir: f.dataDir }); await accounts.createUser('revision-member', 'synthetic-member-password-2026');
    const member = await f.request('/api/auth/login', { method: 'POST', body: { username: 'revision-member', password: 'synthetic-member-password-2026' } });
    const memberSession = (await f.request('/api/session', { cookie: member.cookie })).json;
    assert.equal((await f.request(path, { cookie: member.cookie, headers: { [HEADER]: '2', 'X-LM-Source-ID': memberSession.sourceId } })).status, 404);
    assert.equal((await f.request(path, { cookie: member.cookie, headers })).status, 409);
  } finally { accounts?.close(); await f.close(); }
});

test('overview and history agree on revised, withdrawn and reinstated evidence while raw exports remain unchanged', async () => {
  const f = await fixture();
  try {
    const session = (await f.request('/api/session')).json;
    const headers = { [HEADER]: '2', 'X-LM-Token': session.writeToken, 'X-LM-Source-ID': session.sourceId, 'X-LM-Instance-ID': session.instanceId };
    const concept = f.app.livingMemory.getSource().index.concepts[0];
    const observation = { eventId: 'overview-original', conceptId: concept.id, sourceRevision: concept.source.revision,
      observedAt: '2026-10-17T12:00:00Z', configRevision: 1, anchorEventId: null, answer: 'SYNTHETIC evidence', rating: 'clear', exposure: 'unexposed', observedExposure: false };
    assert.equal((await f.request('/api/observations', { method: 'POST', headers, body: observation })).status, 201);
    const raw = f.exportRaw();
    const path = `/api/observations/${observation.eventId}/revisions`;
    const revise = { eventId: 'overview-revise', observationEventId: observation.eventId, previousEventId: null, occurredAt: '2026-10-18T11:00:00Z',
      action: 'revise', reason: 'input-error', assessment: { rating: 'blank', learning: null } };
    assert.equal((await f.request(path, { method: 'POST', headers, body: revise })).status, 201);
    const overview = (await f.request('/api/learning-overview', { headers })).json;
    assert.deepEqual(overview.observationAssessments, { raw: 1, effective: 1, withdrawn: 0, unresolved: 0, notYetRecorded: 0, revisionCount: 1 });
    assert.equal(overview.items[0].recall.blank, 1);
    const withdraw = { eventId: 'overview-withdraw', observationEventId: observation.eventId, previousEventId: revise.eventId,
      occurredAt: revise.occurredAt, action: 'withdraw', reason: 'unreliable-evidence' };
    assert.equal((await f.request(path, { method: 'POST', headers, body: withdraw })).status, 201);
    const withdrawn = (await f.request('/api/learning-overview', { headers })).json;
    assert.equal(withdrawn.items[0].recall.total, 0);
    assert.deepEqual(withdrawn.observationAssessments, { raw: 1, effective: 0, withdrawn: 1, unresolved: 0, notYetRecorded: 0, revisionCount: 2 });
    const history = (await f.request(`/api/concepts/${concept.id}/history`, { headers })).json;
    assert.equal(history.total, 1);
    assert.equal(history.observationAssessments[observation.eventId].status, 'withdrawn');
    assert.equal(history.observationRevisionCount, 2);
    assert.equal((await f.request(path, { method: 'POST', headers, body: { ...withdraw, eventId: 'overview-reinstate', previousEventId: withdraw.eventId, action: 'reinstate' } })).status, 201);
    const reinstated = (await f.request('/api/learning-overview', { headers })).json;
    assert.equal(reinstated.items[0].recall.blank, 1);
    assert.equal(reinstated.observationAssessments.revisionCount, 3);
    assert.deepEqual(f.exportRaw().observations, raw.observations);
    assert.deepEqual(f.exportRaw().anchors, raw.anchors);
  } finally { await f.close(); }
});
