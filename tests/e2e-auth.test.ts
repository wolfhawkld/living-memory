import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import { createApp, closeApp } from '../src/server/app';
import { authenticateTestOwner } from './e2e/fixtures';

type StorageState = Awaited<ReturnType<APIRequestContext['storageState']>>;
type CreateClient = (storageState?: StorageState) => Promise<APIRequestContext>;

async function withTestServer(accountsEnabled: boolean, run: (createClient: CreateClient) => Promise<void>) {
  const dataDir = mkdtempSync(join(tmpdir(), 'lm-e2e-auth-'));
  const app = createApp({
    root: resolve('fixtures/demo-kg'), dataDir, accountsEnabled,
    port: 4318, limit: 20, staticDir: join(dataDir, 'no-static-files'),
  });
  const server = createServer(app);
  const clients: APIRequestContext[] = [];
  try {
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const port = (server.address() as { port: number }).port;
    await run(async (storageState) => {
      const client = await playwrightRequest.newContext({
        baseURL: `http://127.0.0.1:${port}`,
        extraHTTPHeaders: { host: '127.0.0.1:4318' },
        storageState,
      });
      clients.push(client);
      return client;
    });
  } finally {
    for (const client of clients) await client.dispose();
    app.livingMemory.closeChanges();
    await new Promise<void>((done) => server.close(() => done()));
    closeApp(app);
    rmSync(dataDir, { recursive: true, force: true });
  }
}

test('E2E authentication creates the owner, shares cookies, and logs in again without altering learning data', async () => {
  await withTestServer(true, async (createClient) => {
    const first = await createClient();
    const before = await (await first.get('/api/auth/status')).json();
    assert.equal(before.enabled, true);
    assert.equal(before.needsSetup, true);
    assert.equal((await first.get('/api/snapshot')).status(), 401);

    await authenticateTestOwner(first);
    const initialSession = await (await first.get('/api/session')).json();
    assert.equal(initialSession.user.role, 'admin');
    const snapshot = await (await first.get('/api/snapshot')).json();
    assert.equal(snapshot.concepts.length, 16);
    const learningBefore = await (await first.get('/api/export')).json();

    // Exercise the exact in-memory state used to give the browser its cookie.
    const restored = await createClient(await first.storageState());
    assert.equal((await restored.get('/api/snapshot')).status(), 200);
    const restoredSession = await (await restored.get('/api/session')).json();
    assert.equal(restoredSession.user.id, initialSession.user.id);
    assert.equal(restoredSession.sourceId, initialSession.sourceId);
    const anonymous = await createClient();
    assert.equal((await anonymous.get('/api/snapshot')).status(), 401);

    const logout = await restored.post('/api/auth/logout', {
      headers: { 'X-LM-Token': restoredSession.writeToken, 'X-LM-Source-ID': restoredSession.sourceId },
      data: {},
    });
    assert.equal(logout.status(), 204);
    assert.equal((await restored.get('/api/snapshot')).status(), 401);
    assert.equal((await first.get('/api/snapshot')).status(), 401);

    // The second helper call must use login, since setup is no longer allowed.
    await authenticateTestOwner(restored);
    const laterSession = await (await restored.get('/api/session')).json();
    assert.equal(laterSession.user.id, initialSession.user.id);
    assert.equal(laterSession.sourceId, initialSession.sourceId);
    const learningAfter = await (await restored.get('/api/export')).json();
    for (const field of ['anchors', 'observations', 'retentions', 'applications', 'corrections', 'config', 'configHistory', 'layout']) {
      assert.deepEqual(learningAfter[field], learningBefore[field], field);
    }
  });
});

test('E2E authentication fails when account protection is disabled', async () => {
  await withTestServer(false, async (createClient) => {
    const client = await createClient();
    assert.equal((await (await client.get('/api/auth/status')).json()).enabled, false);
    await assert.rejects(() => authenticateTestOwner(client), /requires account mode/);
  });
});
