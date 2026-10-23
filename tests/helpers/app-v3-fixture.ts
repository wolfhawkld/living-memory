import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, request } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createApp, closeApp, type AppOptions } from '../../src/server/app.js';
import { initializeAnswerClearingSchemaV3 } from '../../src/server/answer-clearing-schema.js';

export const V3_NOW = '2026-10-20T12:00:00.000Z';
export function appV3Files() {
  const temp = mkdtempSync(join(tmpdir(), 'lm-app-v3-'));
  const root = join(temp, 'knowledge'), dataDir = join(temp, 'data'), staticDir = join(temp, 'static');
  mkdirSync(root); mkdirSync(dataDir);
  writeFileSync(join(root, 'Alpha.md'), '---\ntype: concept\ntitle: Alpha\n---\nSynthetic alpha body.\n');
  writeFileSync(join(root, 'Beta.md'), '---\ntype: concept\ntitle: Beta\n---\nSynthetic beta body.\n');
  const dbPath = join(dataDir, 'living-memory.sqlite');
  return { temp, root, dataDir, staticDir, dbPath, remove: () => rmSync(temp, { recursive: true, force: true }) };
}
export function initializeAppV3(dbPath: string) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE');
    initializeAnswerClearingSchemaV3(db, { recordedAt: '2026-10-01T00:00:00.000Z' });
    db.exec('COMMIT');
  } finally { db.close(); }
}
export type ApiReply = { status: number; body: any; text: string; cookie: string; headers: Record<string, unknown> };
export type ApiOptions = { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string | string[]>; protocol?: string | string[] | null; firstFrame?: boolean };
export async function appV3Fixture(options: Omit<AppOptions, 'learningSchemaVersion'> = {}) {
  const files = appV3Files(); initializeAppV3(files.dbPath);
  let clock = new Date(V3_NOW);
  const base = { root: files.root, dataDir: files.dataDir, staticDir: files.staticDir, port: 4317, now: () => clock, ...options };
  let app = createApp({ ...base, learningSchemaVersion: 3 });
  const server = createServer((req, res) => app(req, res));
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as { port: number }).port;
  const send = (path: string, options: ApiOptions = {}) => new Promise<ApiReply>((resolve, reject) => {
    const protocol = options.protocol === undefined ? '3' : options.protocol;
    const req = request({ hostname: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: {
      host: '127.0.0.1:4317', 'content-type': 'application/json', ...(protocol === null ? {} : { 'X-LM-Learning-Protocol': protocol }),
      ...(options.cookie ? { cookie: options.cookie } : {}), ...options.headers,
    } }, res => {
      let text = ''; res.setEncoding('utf8');
      const finish = () => resolve({ status: res.statusCode!, body: text.startsWith('{') ? JSON.parse(text) : null, text,
        cookie: res.headers['set-cookie']?.[0]?.split(';')[0] ?? '', headers: res.headers });
      res.on('data', part => { text += part; if (options.firstFrame) { finish(); req.destroy(); } });
      res.on('end', finish);
    });
    req.on('error', reject); req.setTimeout(5000, () => req.destroy(new Error('synthetic HTTP timeout')));
    if (options.body !== undefined) req.write(JSON.stringify(options.body)); req.end();
  });
  return { ...files, send, get app() { return app; }, setClock(value: string) { clock = new Date(value); },
    restart() { closeApp(app); app = createApp({ ...base, learningSchemaVersion: 3 }); },
    async close() { app.livingMemory.closeChanges(); await new Promise<void>(resolve => server.close(() => resolve())); closeApp(app); files.remove(); },
  };
}
