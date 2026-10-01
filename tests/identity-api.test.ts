import { strict as assert } from 'node:assert';
import { createServer, request as httpRequest } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeApp, createApp, type LivingMemoryApp } from '../src/server/app.js';
import type { IdentityStatus, IdentityLinkPreview, IdentityLinkReceipt } from '../src/shared/identity.js';
import type { ImportPreview } from '../src/shared/import-data.js';
import { DEFAULT_IMPORT_OPTIONS, MAX_IMPORT_BYTES } from '../src/shared/import-data.js';
import { readFileSync, readdirSync, statSync, renameSync } from 'node:fs';
import type { Snapshot, ExportData } from '../src/shared/types.js';

interface ResponseData {
  status: number;
  body: string;
  setCookie?: string;
  json: <T>() => T;
}

interface RunningApp {
  app: LivingMemoryApp;
  dataDir: string;
  root: string;
  request: (path: string, options?: {
    method?: string;
    body?: unknown; rawBody?: string;
    headers?: Record<string, string>;
    cookie?: string;
  }) => Promise<ResponseData>;
  stop: () => Promise<void>;
  cleanup: () => void;
}

const NOW = '2026-01-02T01:00:00.000Z';

function conceptFile(title: string, summary: string): string {
  return ['---', 'type: concept', `title: ${title}`, `summary: ${summary}`, '---', '', summary, ''].join('\n');
}

async function runningApp(accountsEnabled = false): Promise<RunningApp> {
  const root = mkdtempSync(join(tmpdir(), 'living-memory-identity-api-source-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'living-memory-identity-api-data-'));
  mkdirSync(join(root, 'Math'), { recursive: true });
  writeFileSync(join(root, 'Math', 'Alpha.md'), conceptFile('Alpha', 'alpha summary'));
  writeFileSync(join(root, 'Math', 'Beta.md'), conceptFile('Beta', 'beta summary'));

  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as { port: number }).port;
  const app = createApp({ root, dataDir, port, accountsEnabled, now: () => new Date(NOW), staticDir: join(dataDir, 'no-dist') });
  server.on('request', app);
  let stopped = false;
  const request = (path: string, options: { method?: string; body?: unknown; rawBody?: string; headers?: Record<string, string>; cookie?: string } = {}) => new Promise<ResponseData>((resolve, reject) => {
    const body = options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
    const req = httpRequest({
      hostname: '127.0.0.1', port, path, method: options.method ?? 'GET',
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
        body: text,
        setCookie: response.headers['set-cookie']?.[0]?.split(';')[0],
        json: <T>() => JSON.parse(text) as T,
      }));
    });
    req.once('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
  return {
    app,
    dataDir,
    root,
    request,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      closeApp(app);
    },
    cleanup: () => { rmSync(root, { recursive: true, force: true }); rmSync(dataDir, { recursive: true, force: true }); },
  };
}

function headers(session: { writeToken: string; sourceId: string }, token = true): Record<string, string> {
  return { 'x-lm-source-id': session.sourceId, ...(token ? { 'x-lm-token': session.writeToken } : {}) };
}

async function session(client: RunningApp, cookie?: string): Promise<{ writeToken: string; sourceId: string }> {
  const response = await client.request('/api/session', cookie ? { cookie } : {});
  assert.equal(response.status, 200);
  return response.json<{ writeToken: string; sourceId: string }>();
}



async function prepareMove(client: RunningApp, cookie?: string) {
  const current = await session(client, cookie);
  const request = (path: string, options: { method?: string; body?: unknown; rawBody?: string; headers?: Record<string, string> } = {}) => client.request(path, {
    ...options,
    cookie,
    headers: { ...headers(current), ...(options.headers ?? {}) },
  });
  const snapshot = (await request('/api/snapshot?scope=all')).json<Snapshot>();
  const old = snapshot.concepts.find(item => item.title === 'Alpha')!;
  const review = { eventId: 'old-review', conceptId: old.id, sourceRevision: old.source.revision, kind: 'review', occurredAt: '2026-01-01T01:00:00Z' };
  assert.equal((await request('/api/reviews', { method: 'POST', body: review })).status, 201);
  await request('/api/layout', { method: 'PUT', body: { [old.id]: { x: 11, y: 12, z: 13 } } });
  await request('/api/review-plan', { method: 'PUT', body: {
    revision: 0, concept: { conceptId: old.id, sourceRevision: old.source.revision, focus: true, deferUntil: null },
  } });
  const before = (await request('/api/export')).json<ExportData>();
  const beforeSnapshot = (await request('/api/snapshot?scope=all')).json<Snapshot>();
  mkdirSync(join(client.root, 'Moved'));
  renameSync(join(client.root, 'Math/Alpha.md'), join(client.root, 'Moved/Renamed.md'));
  await request('/api/refresh', { method: 'POST', body: {} });
  const next = (await request('/api/snapshot?scope=all')).json<Snapshot>().concepts.find(item => item.title === 'Alpha')!;
  assert.notEqual(next.id, old.id);
  const identityRequest = { fromConceptId: old.id, toConceptId: next.id };
  return { current, old, next, review, before, beforeSnapshot, request: identityRequest, cookie };
}

test('confirming a moved concept preserves history, state, preferences and stable identity across restart', async () => {
  const client = await runningApp();
  try {
    const move = await prepareMove(client);
    const status = (await client.request('/api/identities')).json<IdentityStatus>();
    assert.equal(status.orphans.find(item => item.conceptId === move.old.id)?.path, 'Math/Alpha.md');
    assert.equal(status.orphans.find(item => item.conceptId === move.old.id)?.counts.anchors, 1);
    const previewResponse = await client.request('/api/identities/preview', { method: 'POST', headers: headers(move.current), body: move.request });
    assert.equal(previewResponse.status, 200, previewResponse.body);
    const preview = previewResponse.json<IdentityLinkPreview>();
    assert.equal(preview.canLink, true, JSON.stringify(preview.issues));
    assert.equal(preview.revisionMatches, true);
    assert.equal(preview.layoutAction, 'keep-original');
    assert.equal(client.app.livingMemory.store.getIdentityBindings().length, 0);
    const commit = { ...move.request, operationId: 'link-move-1', previewToken: preview.token, confirmed: true };
    const response = await client.request('/api/identities/commit', { method: 'POST', headers: headers(move.current), body: commit });
    assert.equal(response.status, 201, response.body);
    const receipt = response.json<IdentityLinkReceipt>();
    assert.equal(receipt.conceptId, move.old.id);
    const backupPath = join(client.dataDir, 'identity-backups', receipt.backupId);
    assert.equal(statSync(backupPath).mode & 0o777, 0o600);
    assert.deepEqual((JSON.parse(readFileSync(backupPath, 'utf8')) as ExportData).anchors, move.before.anchors);
    const after = (await client.request('/api/snapshot?scope=all')).json<Snapshot>();
    assert.equal(after.concepts.find(item => item.id === move.old.id)?.source.path, 'Moved/Renamed.md');
    assert.equal(after.concepts.some(item => item.id === move.next.id), false);
    assert.deepEqual(after.states[move.old.id], move.beforeSnapshot.states[move.old.id]);
    assert.deepEqual(client.app.livingMemory.store.getLayout()[move.old.id], { x: 11, y: 12, z: 13 });
    assert.equal(client.app.livingMemory.store.getReviewPlan().concepts[move.old.id].focus, true);
    assert.deepEqual(client.app.livingMemory.store.getAnchors(), move.before.anchors);
    const retry = await client.request('/api/identities/commit', { method: 'POST', headers: headers(move.current), body: commit });
    assert.equal(retry.status, 200, retry.body);
    assert.deepEqual(retry.json<IdentityLinkReceipt>(), { ...receipt, status: 'duplicate' });
    assert.equal((await client.request('/api/reviews', { method: 'POST', headers: headers(move.current), body: move.review })).status, 200);
    const exported = (await client.request('/api/export')).json<ExportData>();
    assert.equal(exported.identityBindings?.length, 1);
    assert.equal(exported.concepts.filter(item => item.source.path === 'Moved/Renamed.md').length, 1);
    const importPreview = await client.request('/api/import/preview', { method: 'POST', headers: headers(move.current), body: { data: move.before, options: DEFAULT_IMPORT_OPTIONS } });
    assert.equal(importPreview.status, 200, importPreview.body);
    assert.equal(importPreview.json<ImportPreview>().canImport, true, importPreview.body);
    assert.equal(importPreview.json<ImportPreview>().counts.duplicates, 1);
    await client.stop();
    const restarted = createApp({ root: client.root, dataDir: client.dataDir, accountsEnabled: false, now: () => new Date(NOW) });
    try {
      assert.equal(restarted.livingMemory.getSource().index.concepts.find(item => item.title === 'Alpha')?.id, move.old.id);
      assert.equal(restarted.livingMemory.store.getAnchors().length, 1);
    } finally { closeApp(restarted); }
  } finally { await client.stop(); client.cleanup(); }
});

test('continuous moves keep one stable history and quarantine a restored old path until it is removed', async () => {
  const client = await runningApp();
  try {
    const move = await prepareMove(client);
    const firstPreview = (await client.request('/api/identities/preview', { method: 'POST', headers: headers(move.current), body: move.request })).json<IdentityLinkPreview>();
    assert.equal(firstPreview.canLink, true, JSON.stringify(firstPreview.issues));
    const firstCommit = await client.request('/api/identities/commit', { method: 'POST', headers: headers(move.current), body: {
      ...move.request, operationId: 'link-continuous-1', previewToken: firstPreview.token, confirmed: true,
    } });
    assert.equal(firstCommit.status, 201, firstCommit.body);

    mkdirSync(join(client.root, 'MovedAgain'));
    renameSync(join(client.root, 'Moved/Renamed.md'), join(client.root, 'MovedAgain/Final.md'));
    assert.equal((await client.request('/api/refresh', { method: 'POST', headers: headers(move.current), body: {} })).status, 200);
    const secondSnapshot = (await client.request('/api/snapshot?scope=all')).json<Snapshot>();
    const second = secondSnapshot.concepts.find(item => item.title === 'Alpha')!;
    assert.notEqual(second.id, move.old.id);
    assert.notEqual(second.id, move.next.id);
    const secondRequest = { fromConceptId: move.old.id, toConceptId: second.id };
    const secondPreviewResponse = await client.request('/api/identities/preview', { method: 'POST', headers: headers(move.current), body: secondRequest });
    assert.equal(secondPreviewResponse.status, 200, secondPreviewResponse.body);
    const secondPreview = secondPreviewResponse.json<IdentityLinkPreview>();
    assert.equal(secondPreview.canLink, true, JSON.stringify(secondPreview.issues));
    const secondCommit = await client.request('/api/identities/commit', { method: 'POST', headers: headers(move.current), body: {
      ...secondRequest, operationId: 'link-continuous-2', previewToken: secondPreview.token, confirmed: true,
    } });
    assert.equal(secondCommit.status, 201, secondCommit.body);

    const afterSecond = (await client.request('/api/snapshot?scope=all')).json<Snapshot>();
    assert.equal(afterSecond.concepts.find(item => item.title === 'Alpha')?.id, move.old.id);
    assert.equal(afterSecond.concepts.find(item => item.title === 'Alpha')?.source.path, 'MovedAgain/Final.md');
    assert.deepEqual(client.app.livingMemory.store.getAnchors(), move.before.anchors);
    assert.equal(client.app.livingMemory.store.getIdentityBindings().length, 2);

    writeFileSync(join(client.root, 'Math/Alpha.md'), conceptFile('Alpha', 'alpha summary'));
    assert.equal((await client.request('/api/refresh', { method: 'POST', headers: headers(move.current), body: {} })).status, 200);
    const conflictSnapshot = (await client.request('/api/snapshot?scope=all')).json<Snapshot>();
    assert.equal(conflictSnapshot.concepts.some(item => item.title === 'Alpha'), false);
    assert.match(conflictSnapshot.source.diagnostics.join('\n'), /身份冲突/);
    const conflictStatus = (await client.request('/api/identities', { headers: headers(move.current) })).json<IdentityStatus>();
    assert.equal(conflictStatus.orphans.find(item => item.conceptId === move.old.id)?.counts.anchors, 1);
    const conflictPreview = await client.request('/api/identities/preview', { method: 'POST', headers: headers(move.current), body: secondRequest });
    assert.equal(conflictPreview.status, 200, conflictPreview.body);
    assert.equal(conflictPreview.json<IdentityLinkPreview>().canLink, false);
    assert.deepEqual(client.app.livingMemory.store.getAnchors(), move.before.anchors);

    rmSync(join(client.root, 'Math/Alpha.md'));
    assert.equal((await client.request('/api/refresh', { method: 'POST', headers: headers(move.current), body: {} })).status, 200);
    const restoredSnapshot = (await client.request('/api/snapshot?scope=all')).json<Snapshot>();
    assert.equal(restoredSnapshot.concepts.find(item => item.title === 'Alpha')?.id, move.old.id);
    assert.equal(restoredSnapshot.concepts.find(item => item.title === 'Alpha')?.source.path, 'MovedAgain/Final.md');
    assert.deepEqual(client.app.livingMemory.store.getAnchors(), move.before.anchors);
  } finally { await client.stop(); client.cleanup(); }
});

test('source edits invalidate identity previews; confirming a new version preserves old evidence as pending', async () => {
  const client = await runningApp();
  try {
    const move = await prepareMove(client);
    const getPreview = () => client.request('/api/identities/preview', { method: 'POST', headers: headers(move.current), body: move.request });
    const first = (await getPreview()).json<IdentityLinkPreview>();
    writeFileSync(join(client.root, 'Moved/Renamed.md'), conceptFile('Renamed Alpha', 'changed details'));
    const stale = await client.request('/api/identities/commit', { method: 'POST', headers: headers(move.current), body: {
      ...move.request, operationId: 'stale-link', previewToken: first.token, confirmed: true,
    } });
    assert.equal(stale.status, 409, stale.body);
    assert.equal(stale.json<{error:{code:string}}>().error.code, 'IDENTITY_STALE');
    assert.equal(client.app.livingMemory.store.getIdentityBindings().length, 0);
    assert.equal(readdirSync(client.dataDir).includes('identity-backups'), false);
    const next = (await getPreview()).json<IdentityLinkPreview>();
    assert.equal(next.revisionMatches, false);
    assert.equal(next.canLink, true, JSON.stringify(next.issues));
    const saved = await client.request('/api/identities/commit', { method: 'POST', headers: headers(move.current), body: {
      ...move.request, operationId: 'changed-link', previewToken: next.token, confirmed: true,
    } });
    assert.equal(saved.status, 201, saved.body);
    const snapshot = (await client.request('/api/snapshot?scope=all')).json<Snapshot>();
    assert.equal(snapshot.states[move.old.id].status, 'pending');
    assert.equal(snapshot.states[move.old.id].anchor?.sourceRevision, move.old.source.revision);
    assert.deepEqual(client.app.livingMemory.store.getAnchors(), move.before.anchors);
  } finally { await client.stop(); client.cleanup(); }
});

test('identity writes require token/source and refuse to combine independently learned nodes', async () => {
  const client = await runningApp();
  try {
    const move = await prepareMove(client);
    assert.equal((await client.request('/api/identities/preview', { method: 'POST', body: move.request })).status, 401);
    assert.equal((await client.request('/api/identities/preview', { method: 'POST', body: move.request, headers: { 'x-lm-token': move.current.writeToken } })).status, 400);
    assert.equal((await client.request('/api/identities/preview', { method: 'POST', body: move.request, headers: { ...headers(move.current), 'x-lm-source-id': 'another-source' } })).status, 409);
    assert.equal((await client.request('/api/identities/preview', { method: 'POST', body: move.request, headers: { ...headers(move.current), origin: 'https://external.test' } })).status, 403);
    await client.request('/api/reviews', { method: 'POST', headers: headers(move.current), body: {
      eventId: 'new-node-learned', conceptId: move.next.id, sourceRevision: move.next.source.revision, kind: 'review',
    } });
    const preview = (await client.request('/api/identities/preview', { method: 'POST', body: move.request, headers: headers(move.current) })).json<IdentityLinkPreview>();
    assert.equal(preview.canLink, false);
    assert.ok(preview.issues.some(issue => issue.severity === 'error'));
    assert.equal(client.app.livingMemory.store.getIdentityBindings().length, 0);
  } finally { await client.stop(); client.cleanup(); }
});

test('private account identity catalogs and bindings remain isolated', async () => {
  const client = await runningApp(true);
  try {
    assert.equal((await client.request('/api/identities')).status, 401);
    const setup = await client.request('/api/auth/setup', { method: 'POST', body: { username: 'owner', password: 'a-long-test-password' } });
    const ownerCookie = setup.setCookie!;
    const owner = (await client.request('/api/session', { cookie: ownerCookie })).json<{writeToken:string;sourceId:string}>();
    assert.equal((await client.request('/api/admin/users', { method: 'POST', cookie: ownerCookie, headers: headers(owner), body: { username: 'member', password: 'another-test-password' } })).status, 201);
    const ownerMove = await prepareMove(client, ownerCookie);
    const ownerPreview = (await client.request('/api/identities/preview', { method: 'POST', cookie: ownerCookie, headers: headers(owner), body: ownerMove.request })).json<IdentityLinkPreview>();
    assert.equal(ownerPreview.canLink, true, JSON.stringify(ownerPreview.issues));
    const ownerCommit = await client.request('/api/identities/commit', { method: 'POST', cookie: ownerCookie, headers: headers(owner), body: {
      ...ownerMove.request, operationId: 'owner-link-isolation', previewToken: ownerPreview.token, confirmed: true,
    } });
    assert.equal(ownerCommit.status, 201, ownerCommit.body);
    assert.equal(client.app.livingMemory.store.getIdentityBindings().length, 1);
    const login = await client.request('/api/auth/login', { method: 'POST', body: { username: 'member', password: 'another-test-password' } });
    const cookie = login.setCookie!;
    const member = (await client.request('/api/session', { cookie })).json<{writeToken:string;sourceId:string}>();
    const status = (await client.request('/api/identities', { cookie, headers: headers(member) })).json<IdentityStatus>();
    assert.equal(status.targets.length, 0);
    assert.equal(status.orphans.length, 0);
    assert.equal(status.bindings.length, 0);
    assert.equal(status.sourceId, member.sourceId);
    assert.equal((await client.request('/api/identities', { cookie, headers: { 'x-lm-source-id': owner.sourceId } })).status, 409);
    const memberPreviewResponse = await client.request('/api/identities/preview', { method: 'POST', cookie, headers: headers(member), body: ownerMove.request });
    assert.equal(memberPreviewResponse.status, 200, memberPreviewResponse.body);
    const memberPreview = memberPreviewResponse.json<IdentityLinkPreview>();
    assert.equal(memberPreview.canLink, false);
    assert.equal(memberPreview.from.path, null);
    assert.equal(memberPreview.to.path, null);
    const memberCommit = await client.request('/api/identities/commit', { method: 'POST', cookie, headers: headers(member), body: {
      ...ownerMove.request, operationId: 'member-owner-forged-link', previewToken: memberPreview.token, confirmed: true,
    } });
    assert.equal(memberCommit.status, 409, memberCommit.body);
    assert.equal(memberCommit.json<{error:{code:string}}>().error.code, 'IDENTITY_REJECTED');
    assert.equal(client.app.livingMemory.store.getIdentityBindings().length, 1);
    const forgedSourcePreview = await client.request('/api/identities/preview', { method: 'POST', cookie, headers: { ...headers(member), 'x-lm-source-id': owner.sourceId }, body: ownerMove.request });
    assert.equal(forgedSourcePreview.status, 409, forgedSourcePreview.body);
    const forgedSourceCommit = await client.request('/api/identities/commit', { method: 'POST', cookie, headers: { ...headers(member), 'x-lm-source-id': owner.sourceId }, body: {
      ...ownerMove.request, operationId: 'member-owner-forged-source-link', previewToken: memberPreview.token, confirmed: true,
    } });
    assert.equal(forgedSourceCommit.status, 409, forgedSourceCommit.body);
  } finally { await client.stop(); client.cleanup(); }
});
