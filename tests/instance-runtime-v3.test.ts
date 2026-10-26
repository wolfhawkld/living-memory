import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createApp, closeApp } from '../src/server/app.js';
import { Accounts } from '../src/server/accounts.js';
import { acquireDataDirectoryLock } from '../src/server/data-directory-lock.js';
import { initializeAppV3, V3_NOW } from './helpers/app-v3-fixture.js';
import { instanceRuntimeFixture, RUNTIME_TEST_SECRET } from './helpers/instance-runtime-fixture.js';

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const loader = import.meta.resolve('tsx');
const credentials = { username: 'runtime-owner', password: 'synthetic-runtime-owner-password' };
function child(entry: string, args: string[], env: NodeJS.ProcessEnv, cwd: string) {
  const process = spawn(globalThis.process.execPath, ['--import', loader, join(repo, entry), ...args], {
    cwd, env: { PATH: globalThis.process.env.PATH, LANG: 'C.UTF-8', ...env }, stdio: ['ignore', 'pipe', 'pipe'], shell: false,
  });
  let stdout = '', stderr = '';
  process.stdout!.on('data', bytes => { stdout += String(bytes); }); process.stderr!.on('data', bytes => { stderr += String(bytes); });
  const done = new Promise<{ code: number | null }>((yes, no) => {
    process.once('error', no); process.once('close', code => yes({ code }));
  });
  return { process, done, output: () => ({ stdout, stderr }) };
}
async function stop(process: ChildProcess) {
  if (process.exitCode !== null || process.signalCode !== null) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => { process.kill('SIGKILL'); }, 3000);
    process.once('close', () => { clearTimeout(timer); resolve(); }); process.kill('SIGTERM');
  });
}
async function unusedPort() {
  const server = createServer();
  await new Promise<void>((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
  const address = server.address(); assert(address && typeof address !== 'string');
  const port = address.port; await new Promise<void>((yes, no) => server.close(error => error ? no(error) : yes())); return port;
}
async function ready(url: string, running: ReturnType<typeof child>) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    assert.equal(running.process.exitCode, null, 'isolated runtime exited before readiness');
    try { const response = await fetch(url + '/api/auth/status', { signal: AbortSignal.timeout(500) }); if (response.ok) return; } catch { /* bounded startup poll */ }
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  assert.fail('isolated runtime readiness timeout');
}
const baseEnv = (f: ReturnType<typeof instanceRuntimeFixture>, port = f.profile.port) => ({
  LM_DATA_DIR: f.profile.dataDir, LM_KG_ROOT: f.profile.kgRoot, LM_STATIC_DIR: f.profile.staticDir,
  LM_AUTH_MODE: 'accounts', LM_PORT: String(port), LM_FEISHU_ENABLED: '0',
});
async function seed(f: ReturnType<typeof instanceRuntimeFixture>) {
  f.write(join(f.profile.dataDir, 'accounts.sqlite'), ''); f.write(join(f.profile.dataDir, 'living-memory.sqlite'), '');
  initializeAppV3(join(f.profile.dataDir, 'living-memory.sqlite'));
  f.write(join(f.profile.kgRoot, 'Root.md'), '---\ntype: concept\ntitle: Runtime Concept\n---\nSynthetic knowledge.\n');
  const accounts = new Accounts({ dataDir: f.profile.dataDir, now: () => new Date(V3_NOW) });
  try { await accounts.setup(credentials.username, credentials.password); } finally { accounts.close(); }
  const app = createApp({ dataDir: f.profile.dataDir, root: f.profile.kgRoot, staticDir: f.profile.staticDir,
    accountsEnabled: true, learningSchemaVersion: 3, now: () => new Date(V3_NOW) });
  try {
    const concept = app.livingMemory.getSource().index.concepts[0]; assert.ok(concept);
    const store = app.livingMemory.store; store.updateConfig(11, 1);
    store.addObservation({ eventId: 'previous-cleared-answer', conceptId: concept.id, sourceRevision: concept.source.revision,
      observedAt: V3_NOW, configRevision: 2, anchorEventId: null, answer: 'SYNTHETIC_PRIVATE_ORIGINAL',
      evidenceMode: 'written', rating: 'clear', exposure: 'unexposed', observedExposure: false }, null);
    store.clearObservationAnswer({ observationEventId: 'previous-cleared-answer' });
    store.addReview({ eventId: 'previous-review', conceptId: concept.id, sourceRevision: concept.source.revision, kind: 'review', occurredAt: V3_NOW });
    return concept;
  } finally { closeApp(app); }
}

for (const mode of ['raw', 'profile'] as const) {
  test(`${mode} launcher explicitly serves nonempty v3 history and writes while preserving quarantine and releasing its lease`, { timeout: 45000 }, async () => {
    const f = instanceRuntimeFixture(); let running: ReturnType<typeof child> | undefined;
    try {
      const concept = await seed(f); f.markBuild(); f.quarantine();
      const quarantine = readFileSync(join(f.profile.dataDir, 'restore-quarantine.json'));
      const port = await unusedPort(), url = `http://127.0.0.1:${port}`;
      f.writeProfile({ ...f.profile, port, learningSchemaVersion: 3 });
      running = mode === 'raw'
        ? child('src/server/index.ts', [], { ...baseEnv(f, port), LM_LEARNING_SCHEMA_VERSION: '3', LM_FEISHU_ENABLED: '1',
          LM_FEISHU_APP_SECRET: RUNTIME_TEST_SECRET, LM_FEISHU_APP_ID: 'cli_synthetic', LM_FEISHU_TENANT_KEY: 'synthetic' }, f.root)
        : child('scripts/instance-runtime.ts', ['start', '--profile', f.profilePath], { LM_LEARNING_SCHEMA_VERSION: '2',
          LM_DATA_DIR: join(f.root, 'must-not-create'), LM_FEISHU_ENABLED: '1', LM_FEISHU_APP_SECRET: RUNTIME_TEST_SECRET }, f.root);
      await ready(url, running);
      const login = await fetch(url + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(credentials) });
      assert.equal(login.status, 200); const cookie = login.headers.get('set-cookie')!.split(';')[0];
      const session = await (await fetch(url + '/api/session', { headers: { cookie } })).json() as any;
      assert.equal(session.learningProtocolVersion, 3);
      const headers = { cookie, 'X-LM-Learning-Protocol': '3', 'x-lm-token': session.writeToken,
        'x-lm-source-id': session.sourceId, 'x-lm-instance-id': session.instanceId, 'content-type': 'application/json' };
      assert.equal((await fetch(url + '/api/snapshot', { headers: { ...headers, 'X-LM-Learning-Protocol': '2' } })).status, 426);
      const snapshot = await (await fetch(url + '/api/snapshot', { headers })).json() as any;
      assert.equal(snapshot.config.halfLifeDays, 11); assert.equal(snapshot.concepts.length, 1);
      const response = await fetch(url + '/api/export', { headers }); assert.equal(response.status, 200);
      const text = await response.text(), data = JSON.parse(text);
      assert.equal(data.schemaVersion, 3); assert.equal(data.observations[0].answer, null);
      assert.equal(data.observations[0].answerClearing.observationEventId, 'previous-cleared-answer');
      assert.equal(data.anchors[0].eventId, 'previous-review'); assert.doesNotMatch(text, /SYNTHETIC_PRIVATE_ORIGINAL/);
      const posted = await fetch(url + '/api/observations', { method: 'POST', headers, body: JSON.stringify({
        eventId: `new-${mode}`, conceptId: concept.id, sourceRevision: concept.source.revision, observedAt: new Date().toISOString(),
        configRevision: 2, anchorEventId: 'previous-review', answer: '', evidenceMode: 'mental', rating: 'partial',
        exposure: 'unexposed', observedExposure: false,
      }) });
      assert.equal(posted.status, 201, await posted.text());
      const after = await (await fetch(url + '/api/export', { headers })).json() as any;
      assert.equal(after.observations.length, 2); assert.equal(after.config.halfLifeDays, 11);
      assert.equal(after.anchors[0].eventId, 'previous-review');
      assert.deepEqual(readFileSync(join(f.profile.dataDir, 'restore-quarantine.json')), quarantine);
      assert.equal(existsSync(join(f.root, 'must-not-create')), false);
      running.process.kill('SIGTERM'); assert.equal((await running.done).code, 0);
      assert.doesNotMatch(JSON.stringify(running.output()), /SYNTHETIC_RUNTIME_SECRET|Feishu: connected|Feishu: connecting/);
      const lease = acquireDataDirectoryLock(f.profile.dataDir); lease.release();
    } finally { if (running) await stop(running.process); f.cleanup(); }
  });
}

test('raw v3 rejects missing, empty, v2 and damaged databases before leases or credential/source writes', { timeout: 45000 }, async () => {
  for (const kind of ['missing-directory', 'missing', 'empty', 'v2', 'damaged'] as const) {
    const f = instanceRuntimeFixture(); let running: ReturnType<typeof child> | undefined;
    try {
      f.markBuild();
      if (kind === 'missing') unlinkSync(join(f.profile.dataDir, 'living-memory.sqlite'));
      if (kind === 'empty') f.write(join(f.profile.dataDir, 'living-memory.sqlite'), '');
      if (kind === 'v2') {
        f.write(join(f.profile.dataDir, 'living-memory.sqlite'), ''); f.write(join(f.profile.dataDir, 'accounts.sqlite'), '');
        closeApp(createApp({ dataDir: f.profile.dataDir, root: f.profile.kgRoot, staticDir: f.profile.staticDir, accountsEnabled: true }));
      }
      const before = f.inventory();
      running = child('src/server/index.ts', [], { ...baseEnv(f), LM_LEARNING_SCHEMA_VERSION: '3',
        ...(kind === 'missing-directory' ? { LM_DATA_DIR: join(f.root, 'missing-data') } : {}) }, f.root);
      assert.equal((await running.done).code, 1);
      assert.match(running.output().stderr, /LEARNING_SCHEMA_UNSUPPORTED_VERSION/);
      assert.doesNotMatch(JSON.stringify(running.output()), /SYNTHETIC_RUNTIME_SECRET|SYNTHETIC_NOT_A_SQLITE_DATABASE/);
      assert.deepEqual(f.inventory(), before);
    } finally { if (running) await stop(running.process); f.cleanup(); }
  }
});

test('raw invalid version and incompatible assets fail before any startup writes', { timeout: 45000 }, async () => {
  const f = instanceRuntimeFixture();
  try {
    for (const value of ['', '03', ' 3', '4', '2.0']) {
      const before = f.inventory();
      const running = child('src/server/index.ts', [], { ...baseEnv(f), LM_LEARNING_SCHEMA_VERSION: value }, f.root);
      try {
        assert.equal((await running.done).code, 1); assert.match(running.output().stderr, /RUNTIME_SCHEMA_VERSION_INVALID/);
        assert.deepEqual(f.inventory(), before);
      } finally { await stop(running.process); }
    }
    const before = f.inventory();
    const running = child('src/server/index.ts', [], { ...baseEnv(f), LM_LEARNING_SCHEMA_VERSION: '3' }, f.root);
    try {
      assert.equal((await running.done).code, 1); assert.match(running.output().stderr, /RUNTIME_BUILD_INCOMPATIBLE/);
      assert.deepEqual(f.inventory(), before);
    } finally { await stop(running.process); }
  } finally { f.cleanup(); }
});

test('default launcher rejects v3 and profile startup exposes only a fixed schema failure', { timeout: 30000 }, async () => {
  const f = instanceRuntimeFixture();
  try {
    await seed(f); f.markBuild();
    const dbPath = join(f.profile.dataDir, 'living-memory.sqlite'), before = readFileSync(dbPath);
    const defaultRun = child('src/server/index.ts', [], baseEnv(f), f.root);
    try { assert.equal((await defaultRun.done).code, 1); assert.match(defaultRun.output().stderr, /LEARNING_SCHEMA_UNSUPPORTED_VERSION/); }
    finally { await stop(defaultRun.process); }
    assert.deepEqual(readFileSync(dbPath), before);
    // Metadata-only check permits malformed database bytes; actual start must reject them safely.
    f.write(dbPath, 'SYNTHETIC_NOT_A_SQLITE_DATABASE'); f.writeProfile({ ...f.profile, learningSchemaVersion: 3 });
    const badStart = child('scripts/instance-runtime.ts', ['start', '--profile', f.profilePath], {}, f.root);
    try {
      assert.equal((await badStart.done).code, 1);
      const diagnostics = badStart.output().stderr.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
      assert.deepEqual(diagnostics, [{ error: { code: 'LEARNING_SCHEMA_UNSUPPORTED_VERSION' } }]);
      assert.doesNotMatch(JSON.stringify(badStart.output()), /SYNTHETIC_NOT_A_SQLITE_DATABASE|SYNTHETIC_RUNTIME_SECRET|data with spaces/);
    } finally { await stop(badStart.process); }
  } finally { f.cleanup(); }
});
