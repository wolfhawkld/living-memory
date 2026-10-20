import { strict as assert } from 'node:assert';
import { createServer, request as httpRequest } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApp, closeApp } from '../src/server/app.js';
import type { Snapshot } from '../src/shared/types.js';
import type { KnowledgeReferences } from '../src/shared/knowledge-references.js';

test('reference API is private, version-bound, complete beyond the graph cap and leaves learning exports unchanged', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lm-reference-api-'));
  const root = join(dir, 'knowledge');
  const dataDir = join(dir, 'data');
  mkdirSync(root);
  for (const [title, body] of [['A', '# A\n[[B#定义]]\n[[B#应用]]'], ['B', '# B\n## 定义\n内容\n## 应用\n内容']]) {
    writeFileSync(join(root, `${title}.md`), `---\ntype: concept\ntitle: ${title}\n---\n${body}`);
  }
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as { port: number }).port;
  const app = createApp({ root, dataDir, limit: 1, port, accountsEnabled: true, staticDir: join(dir, 'no-dist') });
  server.on('request', app);
  const request = (path: string, options: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) => new Promise<{ status: number; value: any; cookie: string }>((resolve, reject) => {
    const raw = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: { 'X-LM-Learning-Protocol': '2',
      host: `127.0.0.1:${port}`, ...(raw ? { 'content-type': 'application/json' } : {}),
      ...(options.cookie ? { cookie: options.cookie } : {}), ...options.headers,
    } }, (res) => {
      let text = ''; res.setEncoding('utf8'); res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, value: JSON.parse(text), cookie: res.headers['set-cookie']?.[0]?.split(';')[0] ?? '' }));
    });
    req.on('error', reject); if (raw) req.write(raw); req.end();
  });
  try {
    assert.equal((await request('/api/knowledge/references?conceptId=other&sourceRevision=other')).status, 401);
    const owner = await request('/api/auth/setup', { method: 'POST', body: { username: 'reference-owner', password: 'reference-owner-password-2026' } });
    assert.equal(owner.status, 201);
    const session = (await request('/api/session', { cookie: owner.cookie })).value;
    const headers = { 'x-lm-source-id': session.sourceId, 'x-lm-token': session.writeToken };
    const full = (await request('/api/snapshot?scope=all', { cookie: owner.cookie })).value as Snapshot;
    assert.equal(full.concepts.length, 2);
    const origin = full.concepts.find((item) => item.title === 'A')!;
    const endpoint = `/api/knowledge/references?${new URLSearchParams({ conceptId: origin.id, sourceRevision: origin.source.revision })}`;
    const before = (await request('/api/export', { cookie: owner.cookie })).value;
    const response = await request(endpoint, { cookie: owner.cookie, headers });
    assert.equal(response.status, 200);
    const page = response.value as KnowledgeReferences;
    assert.equal(page.references.length, 2);
    assert.ok(page.references.every((item) => item.status === 'resolved-section'));
    assert.equal((await request(endpoint, { cookie: owner.cookie, headers: { 'x-lm-source-id': 'another-space' } })).status, 409);
    assert.equal((await request(`/api/knowledge/references?conceptId=${origin.id}&sourceRevision=stale`, { cookie: owner.cookie })).status, 409);
    assert.equal((await request('/api/knowledge/references?conceptId=../outside.md&sourceRevision=x', { cookie: owner.cookie })).status, 404);
    assert.equal((await request('/api/knowledge/references?conceptId=x&conceptId=y&sourceRevision=x', { cookie: owner.cookie })).status, 400);
    const created = await request('/api/admin/users', { method: 'POST', cookie: owner.cookie, headers, body: { username: 'reference-member', password: 'reference-member-password-2026' } });
    assert.equal(created.status, 201);
    const member = await request('/api/auth/login', { method: 'POST', body: { username: 'reference-member', password: 'reference-member-password-2026' } });
    assert.equal(member.status, 200);
    assert.equal((await request(endpoint, { cookie: member.cookie })).status, 404);
    const after = (await request('/api/export', { cookie: owner.cookie })).value;
    delete before.exportedAt; delete after.exportedAt;
    assert.deepEqual(after, before);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeApp(app);
    rmSync(dir, { recursive: true, force: true });
  }
});
