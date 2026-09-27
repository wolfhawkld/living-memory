import { strict as assert } from 'node:assert';
import { createServer, request as httpRequest } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeApp, createApp, type LivingMemoryApp } from '../src/server/app.js';
import type { ImportPreview, ImportReceipt, ImportCommitRequest } from '../src/shared/import-data.js';
import { DEFAULT_IMPORT_OPTIONS, MAX_IMPORT_BYTES } from '../src/shared/import-data.js';
import { readFileSync, readdirSync, statSync } from 'node:fs';
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
  const root = mkdtempSync(join(tmpdir(), 'living-memory-import-api-source-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'living-memory-import-api-data-'));
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

async function session(client: RunningApp): Promise<{ writeToken: string; sourceId: string }> {
  const response = await client.request('/api/session');
  assert.equal(response.status, 200);
  return response.json<{ writeToken: string; sourceId: string }>();
}


test('import preview is read-only; moved roots map by path/version, restore atomically and retry exactly once', async () => {
  const donor = await runningApp();
  const target = await runningApp();
  try {
    const donorSession = await session(donor);
    const targetSession = await session(target);
    const original = (await donor.request('/api/snapshot?scope=all')).json<Snapshot>().concepts[0];
    const local = (await target.request('/api/snapshot?scope=all')).json<Snapshot>().concepts.find(c => c.source.path === original.source.path)!;
    assert.notEqual(local.id, original.id);
    const review = { eventId: 'portable-review', conceptId: original.id, sourceRevision: original.source.revision, kind: 'review' };
    assert.equal((await donor.request('/api/reviews', { method: 'POST', headers: headers(donorSession), body: review })).status, 201);
    const exported = (await donor.request('/api/export', { headers: headers(donorSession) })).json<ExportData>();
    const previewResponse = await target.request('/api/import/preview', { method: 'POST', headers: headers(targetSession), body: { data: exported, options: DEFAULT_IMPORT_OPTIONS } });
    assert.equal(previewResponse.status, 200, previewResponse.body);
    const preview = previewResponse.json<ImportPreview>();
    assert.equal(preview.canImport, true, JSON.stringify(preview.issues));
    assert.equal(preview.counts.added.anchors, 1);
    assert.equal(preview.matches.find(c => c.fromId === original.id)?.toId, local.id);
    assert.equal(target.app.livingMemory.store.getAnchors().length, 0);
    assert.equal(readdirSync(target.dataDir).includes('import-backups'), false);
    const request: ImportCommitRequest = { data: exported, options: DEFAULT_IMPORT_OPTIONS, previewToken: preview.token, importId: 'import-portable', confirmed: true };
    const committed = await target.request('/api/import/commit', { method: 'POST', headers: headers(targetSession), body: request });
    assert.equal(committed.status, 201, committed.body);
    const receipt = committed.json<ImportReceipt>();
    const backupPath = join(target.dataDir, 'import-backups', receipt.backupId);
    assert.equal(statSync(backupPath).mode & 0o777, 0o600);
    const backup = JSON.parse(readFileSync(backupPath, 'utf8')) as ExportData;
    assert.equal(backup.anchors.length, 0);
    assert.equal(backup.restoreMetadata?.sourceId, targetSession.sourceId);
    assert.equal(target.app.livingMemory.store.getAnchors()[0].conceptId, local.id);
    const retry = await target.request('/api/import/commit', { method: 'POST', headers: headers(targetSession), body: request });
    assert.equal(retry.status, 200, retry.body);
    assert.deepEqual(retry.json<ImportReceipt>(), { ...receipt, status: 'duplicate' });
    assert.equal(target.app.livingMemory.store.getAnchors().length, 1);
    const anchorRetry = await target.request('/api/reviews', { method: 'POST', headers: headers(targetSession), body: { ...review, conceptId: local.id } });
    assert.equal(anchorRetry.status, 200, anchorRetry.body);
    const anotherPreview = (await target.request('/api/import/preview', { method: 'POST', headers: headers(targetSession), body: { data: exported, options: DEFAULT_IMPORT_OPTIONS } })).json<ImportPreview>();
    assert.equal(anotherPreview.counts.duplicates, 1);
    assert.equal(anotherPreview.counts.added.anchors, 0);
  } finally { await donor.stop(); await target.stop(); donor.cleanup(); target.cleanup(); }
});

test('import requires current account/source/token, validates body, and rejects stale preview without writes', async () => {
  const client = await runningApp();
  try {
    const current = await session(client);
    const exported = (await client.request('/api/export', { headers: headers(current) })).json<ExportData>();
    const body = { data: exported, options: DEFAULT_IMPORT_OPTIONS };
    assert.equal((await client.request('/api/import/preview', { method: 'POST', body })).status, 401);
    assert.equal((await client.request('/api/import/preview', { method: 'POST', headers: { 'x-lm-token': current.writeToken }, body })).status, 400);
    assert.equal((await client.request('/api/import/preview', { method: 'POST', headers: { ...headers(current), 'x-lm-source-id': 'wrong' }, body })).status, 409);
    assert.equal((await client.request('/api/import/preview', { method: 'POST', headers: { ...headers(current), origin: 'https://external.test' }, body })).status, 403);
    assert.equal((await client.request('/api/import/preview', { method: 'POST', headers: headers(current), rawBody: '{' })).status, 400);
    const tooBig = await client.request('/api/import/preview', { method: 'POST', headers: headers(current), rawBody: JSON.stringify({ padding: 'x'.repeat(MAX_IMPORT_BYTES + 8192) }) });
    assert.equal(tooBig.status, 413, tooBig.body);
    const preview = (await client.request('/api/import/preview', { method: 'POST', headers: headers(current), body })).json<ImportPreview>();
    assert.equal((await client.request('/api/config', { method: 'PUT', headers: headers(current), body: { revision: 1, halfLifeDays: 14 } })).status, 200);
    const stale = await client.request('/api/import/commit', { method: 'POST', headers: headers(current), body: { ...body, importId: 'stale-import', previewToken: preview.token, confirmed: true } });
    assert.equal(stale.status, 409, stale.body);
    assert.equal(stale.json<{error:{code:string}}>().error.code, 'IMPORT_STALE');
    assert.equal(client.app.livingMemory.store.getConfig().halfLifeDays, 14);
    assert.equal(readdirSync(client.dataDir).includes('import-backups'), false);
  } finally { await client.stop(); client.cleanup(); }
});

test('import cannot access an unauthenticated account or cross a logged-in source boundary', async () => {
  const client = await runningApp(true);
  try {
    assert.equal((await client.request('/api/import/preview', { method: 'POST', body: {} })).status, 401);
    const setup = await client.request('/api/auth/setup', { method: 'POST', body: { username: 'owner', password: 'a-long-test-password' } });
    assert.equal(setup.status, 201, setup.body);
    const ownerCookie = setup.setCookie!;
    const ownerSession = (await client.request('/api/session', { cookie: ownerCookie })).json<{writeToken:string;sourceId:string}>();
    assert.equal((await client.request('/api/admin/users', { method: 'POST', cookie: ownerCookie, headers: headers(ownerSession), body: { username: 'member', password: 'another-test-password' } })).status, 201);
    const login = await client.request('/api/auth/login', { method: 'POST', body: { username: 'member', password: 'another-test-password' } });
    const memberCookie = login.setCookie!;
    const memberSession = (await client.request('/api/session', { cookie: memberCookie })).json<{writeToken:string;sourceId:string}>();
    const exported = (await client.request('/api/export', { cookie: ownerCookie, headers: headers(ownerSession) })).json<ExportData>();
    const body = { data: exported, options: DEFAULT_IMPORT_OPTIONS };
    const forbidden = await client.request('/api/import/preview', { method: 'POST', cookie: memberCookie, headers: { ...headers(memberSession), 'x-lm-source-id': ownerSession.sourceId }, body });
    assert.equal(forbidden.status, 409);
    const response = await client.request('/api/import/preview', { method: 'POST', cookie: memberCookie, headers: headers(memberSession), body });
    assert.equal(response.status, 200, response.body);
    const preview = response.json<ImportPreview>();
    assert.equal(preview.sourceId, memberSession.sourceId);
    assert.equal(preview.counts.unresolvedConcepts, exported.concepts.length);
  } finally { await client.stop(); client.cleanup(); }
});


test('authorized preview accepts a valid backup larger than the ordinary API body limit', async () => {
  const client = await runningApp();
  try {
    const current = await session(client);
    const data = (await client.request('/api/export', { headers: headers(current) })).json<ExportData>();
    const concept = data.concepts[0];
    data.applications = Array.from({ length: 100 }, (_, index) => ({
      eventId: `large-app-${index}`, conceptId: concept.id, sourceRevision: concept.source.revision,
      occurredAt: NOW, recordedAt: NOW, kind: 'summary', context: '', content: 'x'.repeat(12000),
      outcome: 'unverified', assistance: 'unknown', result: '', limitations: '', insight: '', correction: '', references: '',
    }));
    assert.ok(Buffer.byteLength(JSON.stringify(data)) > 1024 * 1024);
    const preview = await client.request('/api/import/preview', { method: 'POST', headers: headers(current), body: { data, options: DEFAULT_IMPORT_OPTIONS } });
    assert.equal(preview.status, 200, preview.body);
    assert.equal(preview.json<ImportPreview>().counts.added.applications, 100);
    assert.equal(preview.json<ImportPreview>().canImport, true);
    assert.equal(client.app.livingMemory.store.getApplications().length, 0);
  } finally { await client.stop(); client.cleanup(); }
});
