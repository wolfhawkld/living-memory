import { createServer, request as httpRequest } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, closeApp } from '../../src/server/app.js';

export interface ActivityApiResponse { status: number; value: any; cookie: string }
export interface ActivityApiOptions { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> }

/** All paths, accounts and HTTP listeners belong to this isolated synthetic test. */
export async function activityApiClient(options: { instanceId?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lm-activity-api-'));
  const root = join(dir, 'knowledge');
  const dataDir = join(dir, 'data');
  mkdirSync(root);
  if (options.instanceId) {
    mkdirSync(dataDir);
    writeFileSync(join(dataDir, 'instance-identity.json'), JSON.stringify({ format: 'living-memory-instance-identity', version: 1, instanceId: options.instanceId }), { mode: 0o600 });
  }
  writeFileSync(join(root, 'Alpha.md'), '---\ntype: concept\ntitle: Alpha\n---\n# Alpha\n## 定义\n合成定义。\n');
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as { port: number }).port;
  const app = createApp({ root, dataDir, port, accountsEnabled: true, staticDir: join(dir, 'no-dist') });
  server.on('request', app);
  const request = (path: string, options: ActivityApiOptions = {}) => new Promise<ActivityApiResponse>((resolve, reject) => {
    const raw = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: { 'X-LM-Learning-Protocol': '2',
      host: `127.0.0.1:${port}`, ...(raw === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.cookie ? { cookie: options.cookie } : {}), ...options.headers,
    } }, (res) => {
      let text = ''; res.setEncoding('utf8'); res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode!, value: JSON.parse(text), cookie: res.headers['set-cookie']?.[0]?.split(';')[0] ?? '' }); }
        catch (error) { reject(error); }
      });
    });
    req.on('error', reject); if (raw !== undefined) req.write(raw); req.end();
  });
  const setup = await request('/api/auth/setup', { method: 'POST', body: { username: 'activity-owner', password: 'activity-owner-password-2026' } });
  if (setup.status !== 201) throw new Error('Synthetic owner setup failed.');
  const ownerCookie = setup.cookie;
  const session = (await request('/api/session', { cookie: ownerCookie })).value as { writeToken: string; sourceId: string; instanceId: string };
  const instanceHeaders: Record<string, string> = session.instanceId === 'legacy' ? {} : { 'x-lm-instance-id': session.instanceId };
  const ownerHeaders: Record<string, string> = { 'x-lm-token': session.writeToken, 'x-lm-source-id': session.sourceId, ...instanceHeaders };
  const device = JSON.parse(readFileSync(join(dataDir, 'cli-session.json'), 'utf8')) as { sessionToken: string };
  const deviceAuthorization = { authorization: `Bearer ${device.sessionToken}` };
  const deviceSession = (await request('/api/session', { headers: deviceAuthorization })).value as { writeToken: string; sourceId: string };
  const deviceHeaders = { ...deviceAuthorization, 'x-lm-token': deviceSession.writeToken, 'x-lm-source-id': deviceSession.sourceId, ...instanceHeaders };
  return {
    app, root, dataDir, request, ownerCookie, ownerHeaders, sourceId: session.sourceId,
    owner: (path: string, options: Omit<ActivityApiOptions, 'cookie'> = {}) => request(path, { cookie: ownerCookie, ...options, headers: { ...ownerHeaders, ...options.headers } }),
    device: (path: string, options: Omit<ActivityApiOptions, 'cookie'> = {}) => request(path, { ...options, headers: { ...deviceHeaders, ...options.headers } }),
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      closeApp(app);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
