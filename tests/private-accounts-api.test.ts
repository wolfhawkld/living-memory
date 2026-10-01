import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, request } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp, closeApp } from '../src/server/app.js';
import type { AccountUser } from '../src/shared/accounts.js';
import type { Snapshot, ExportData } from '../src/shared/types.js';

test('private account spaces isolate full graph, attachments, history, layouts, exports and device identity', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'lm-private-accounts-'));
  const root = join(temp, 'owner-vault');
  const dataDir = join(temp, 'data');
  const note = (text: string) => `---\ntype: concept\ntitle: Same concept\n---\n${text}\n![image](image.svg)\n`;
  mkdirSync(join(root, 'Math'), { recursive: true });
  writeFileSync(join(root, 'Math', 'Concept.md'), note('OWNER PRIVATE BODY'));
  writeFileSync(join(root, 'Math', 'image.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><text>OWNER PRIVATE IMAGE</text></svg>');
  let app = createApp({ root, dataDir, port: 4317, accountsEnabled: true, staticDir: join(temp, 'none') });
  // Existing personal data is stored before any account exists, exactly as a legacy installation.
  const originalConcept = app.livingMemory.getSource().index.concepts[0];
  app.livingMemory.store.addReview({ eventId: 'old-review', conceptId: originalConcept.id, sourceRevision: originalConcept.source.revision, kind: 'review' });
  const server = createServer((req, res) => app(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  type Reply = { status: number; cookie: string; cookieHeader: string; body: any; text: string };
  const send = (path: string, options: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) => new Promise<Reply>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: {
      host: '127.0.0.1:4317', 'content-type': 'application/json', ...(options.cookie ? { cookie: options.cookie } : {}), ...options.headers,
    } }, (res) => {
      let text = ''; res.setEncoding('utf8'); res.on('data', (part) => text += part);
      res.on('end', () => resolve({ status: res.statusCode!, text, body: text.startsWith('{') ? JSON.parse(text) : null, cookie: res.headers['set-cookie']?.[0]?.split(';')[0] ?? '', cookieHeader: res.headers['set-cookie']?.[0] ?? '' }));
    });
    req.on('error', reject); if (options.body !== undefined) req.write(JSON.stringify(options.body)); req.end();
  });
  try {
    const status = await send('/api/auth/status');
    assert.deepEqual(status.body, { enabled: true, needsSetup: true, user: null });
    for (const path of ['/api/session', '/api/snapshot?scope=all', '/api/export', '/api/layout', '/api/health', '/api/changes', `/api/concepts/${originalConcept.id}/history`, '/api/admin/users']) {
      assert.equal((await send(path)).status, 401, path);
    }
    const setup = await send('/api/auth/setup', { method: 'POST', body: { username: 'owner', password: 'owner-password-2026' } });
    assert.equal(setup.status, 201);
    assert.match(setup.cookieHeader, /HttpOnly/);
    assert.match(setup.cookieHeader, /SameSite=Strict/);
    const ownerCookie = setup.cookie;
    assert.ok(ownerCookie);
    const ownerSession = (await send('/api/session', { cookie: ownerCookie })).body;
    const ownerHeaders = { 'x-lm-token': ownerSession.writeToken, 'x-lm-source-id': ownerSession.sourceId };
    const ownerLayout = { [originalConcept.id]: { x: 10, y: 20, z: 30 } };
    assert.equal((await send('/api/layout', { method: 'PUT', cookie: ownerCookie, headers: ownerHeaders, body: ownerLayout })).status, 200);
    const ownerSnapshot = (await send('/api/snapshot?scope=all', { cookie: ownerCookie })).body as Snapshot;
    assert.equal(ownerSnapshot.states[originalConcept.id].anchor?.eventId, 'old-review');
    assert.equal(ownerSession.sourceId, app.livingMemory.getSource().namespace);
    assert.equal((await send('/api/auth/setup', { method: 'POST', body: { username: 'takeover', password: 'different-password-2026' } })).status, 409);
    assert.equal((await send('/api/admin/users', { method: 'POST', cookie: ownerCookie, body: { username: 'member', password: 'member-password-2026' } })).status, 401, 'cookie alone cannot bypass CSRF');
    const created = await send('/api/admin/users', { method: 'POST', cookie: ownerCookie, headers: ownerHeaders, body: { username: 'member', password: 'member-password-2026' } });
    assert.equal(created.status, 201);
    const member: AccountUser = created.body.user;
    const memberRoot = join(dataDir, 'users', member.id, 'knowledge');
    mkdirSync(join(memberRoot, 'Math'), { recursive: true });
    writeFileSync(join(memberRoot, 'Math', 'Concept.md'), note('MEMBER PRIVATE BODY'));
    const login = await send('/api/auth/login', { method: 'POST', body: { username: 'member', password: 'member-password-2026' } });
    assert.equal(login.status, 200);
    const memberCookie = login.cookie;
    const memberSession = (await send('/api/session', { cookie: memberCookie })).body;
    const memberHeaders = { 'x-lm-token': memberSession.writeToken, 'x-lm-source-id': memberSession.sourceId };
    assert.notEqual(memberSession.sourceId, ownerSession.sourceId);
    assert.equal((await send('/api/snapshot?scope=all', { cookie: memberCookie })).body.concepts.length, 0, 'new account starts empty until refresh');
    assert.deepEqual((await send('/api/layout', { cookie: memberCookie })).body, {}, 'private layout does not expose owner node IDs');
    assert.equal((await send('/api/refresh', { method: 'POST', cookie: memberCookie, headers: memberHeaders, body: {} })).status, 200);
    const memberResponse = await send('/api/snapshot?scope=all', { cookie: memberCookie });
    const memberSnapshot = memberResponse.body as Snapshot;
    assert.equal(memberSnapshot.concepts.length, 1);
    assert.match(memberResponse.text, /MEMBER PRIVATE BODY/);
    assert.doesNotMatch(memberResponse.text, /OWNER PRIVATE BODY/);
    assert.notEqual(memberSnapshot.concepts[0].id, originalConcept.id, 'same domain and title have distinct private identities');
    assert.equal(memberSnapshot.states[memberSnapshot.concepts[0].id].status, 'unknown');
    for (const path of [`/api/concepts/${originalConcept.id}/history`, `/api/concepts/${originalConcept.id}/attachment?sourceId=${ownerSession.sourceId}&sourceRevision=${originalConcept.source.revision}&path=image.svg`]) {
      assert.equal((await send(path, { cookie: memberCookie })).status, 404);
    }
    assert.equal((await send('/api/snapshot', { cookie: memberCookie, headers: ownerHeaders })).status, 409);
    assert.equal((await send('/api/reviews', { method: 'POST', cookie: memberCookie, headers: memberHeaders, body: { eventId: 'steal', conceptId: originalConcept.id, sourceRevision: originalConcept.source.revision, kind: 'review' } })).status, 404);
    assert.equal((await send('/api/layout', { method: 'PUT', cookie: memberCookie, headers: memberHeaders, body: { [originalConcept.id]: { x: 1, y: 2, z: 3 } } })).status, 404);
    assert.equal((await send('/api/admin/users', { cookie: memberCookie })).status, 403);
    assert.equal((await send('/api/export', { cookie: memberCookie })).body.anchors.length, 0);
    const memberConcept = memberSnapshot.concepts[0];
    const memberLayout = { [memberConcept.id]: { x: 1, y: 2, z: 3 } };
    assert.equal((await send('/api/layout', { method: 'PUT', cookie: memberCookie, headers: memberHeaders, body: memberLayout })).status, 200);
    assert.deepEqual((await send('/api/layout', { cookie: ownerCookie })).body, ownerLayout);
    assert.equal((await send('/api/config', { method: 'PUT', cookie: memberCookie, headers: memberHeaders, body: { halfLifeDays: 12, revision: memberSnapshot.config.revision } })).status, 200);
    assert.equal((await send('/api/snapshot', { cookie: ownerCookie })).body.config.halfLifeDays, ownerSnapshot.config.halfLifeDays);
    assert.equal((await send('/api/retentions', { method: 'POST', cookie: memberCookie, headers: memberHeaders, body: {
      eventId: 'own-retention', conceptId: memberConcept.id, sourceRevision: memberConcept.source.revision, active: true, previousEventId: null, occurredAt: new Date().toISOString(),
    } })).status, 201);
    assert.equal(((await send('/api/export', { cookie: ownerCookie })).body as ExportData).retentions!.length, 0);
    const device = JSON.parse(readFileSync(join(dataDir, 'cli-session.json'), 'utf8'));
    const deviceResponse = await send('/api/snapshot', { headers: { authorization: `Bearer ${device.sessionToken}` } });
    assert.match(deviceResponse.text, /OWNER PRIVATE BODY/);
    assert.doesNotMatch(deviceResponse.text, /MEMBER PRIVATE BODY/);
    // Restart preserves private identities/state, while rotating the OS-owner device credential.
    closeApp(app);
    app = createApp({ root, dataDir, port: 4317, accountsEnabled: true, staticDir: join(temp, 'none') });
    assert.equal((await send('/api/snapshot', { headers: { authorization: `Bearer ${device.sessionToken}` } })).status, 401);
    assert.deepEqual((await send('/api/layout', { cookie: memberCookie })).body, memberLayout);
    assert.equal((await send('/api/snapshot', { cookie: memberCookie })).body.states[memberConcept.id].status, 'retained');
    assert.equal((await send('/api/snapshot', { cookie: ownerCookie })).body.states[originalConcept.id].anchor.eventId, 'old-review');
    assert.equal((await send('/api/auth/logout', { method: 'POST', cookie: memberCookie, headers: memberHeaders, body: {} })).status, 204);
    assert.equal((await send('/api/snapshot', { cookie: memberCookie })).status, 401);
    assert.equal((await send('/api/snapshot', { cookie: ownerCookie })).status, 200);
    const adminList = await send('/api/admin/users', { cookie: ownerCookie });
    assert.doesNotMatch(adminList.text, /password|csrfToken|sessionToken|PRIVATE BODY/);
    const loginAgain = await send('/api/auth/login', { method: 'POST', body: { username: 'member', password: 'member-password-2026' } });
    const stream = request({ hostname: '127.0.0.1', port, path: '/api/changes', headers: { host: '127.0.0.1:4317', cookie: loginAgain.cookie } });
    const streamReady = new Promise<string>((resolve, reject) => { stream.once('response', (res) => {
      res.setEncoding('utf8'); res.once('data', (data) => resolve(String(data)));
    }); stream.once('error', reject); });
    const streamEnded = new Promise<void>((resolve, reject) => {
      stream.once('response', (res) => res.once('end', resolve));
      stream.once('error', reject);
      stream.setTimeout(4000, () => stream.destroy(new Error('revoked SSE stayed open')));
    });
    stream.end();
    assert.match(await streamReady, new RegExp(memberSession.sourceId));
    const disable = await send(`/api/admin/users/${member.id}`, { method: 'PUT', cookie: ownerCookie, headers: ownerHeaders, body: { enabled: false } });
    assert.equal(disable.status, 200);
    assert.equal((await send('/api/snapshot', { cookie: loginAgain.cookie })).status, 401);
    await streamEnded;
  } finally {
    app.livingMemory.closeChanges();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeApp(app);
    rmSync(temp, { recursive: true, force: true });
  }
});
