import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { instanceRuntimeMain } from '../scripts/instance-runtime.js';
import { instanceRuntimeFixture, RUNTIME_TEST_SECRET } from './helpers/instance-runtime-fixture.js';

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const cli = join(repo, 'scripts/instance-runtime.ts');
const loader = import.meta.resolve('tsx');
const io = () => { const stdout: string[] = [], stderr: string[] = []; return { stdout, stderr, stream: {
  stdout: (value: string) => { stdout.push(value); }, stderr: (value: string) => { stderr.push(value); },
} }; };
function child(args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) {
  const process = spawn(globalThis.process.execPath, ['--import', loader, cli, ...args], {
    cwd, env: { PATH: globalThis.process.env.PATH, LANG: 'C.UTF-8', ...env }, stdio: ['ignore', 'pipe', 'pipe'], shell: false,
  });
  let stdout = '', stderr = '';
  process.stdout!.on('data', bytes => { stdout += String(bytes); }); process.stderr!.on('data', bytes => { stderr += String(bytes); });
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((yes, no) => {
    process.once('error', no); process.once('close', (code, signal) => yes({ code, signal }));
  });
  return { process, done, output: () => ({ stdout, stderr }) };
}
async function closeSyntheticChild(process: ChildProcess) {
  if (process.exitCode !== null || process.signalCode !== null) return;
  process.kill('SIGTERM');
  await new Promise<void>(resolve => { const timer = setTimeout(() => { process.kill('SIGKILL'); resolve(); }, 3000);
    process.once('close', () => { clearTimeout(timer); resolve(); }); });
}
async function unusedPort() {
  const server = createServer();
  await new Promise<void>((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
  const address = server.address(); assert(address && typeof address !== 'string');
  const port = address.port; await new Promise<void>((yes, no) => server.close(error => error ? no(error) : yes())); return port;
}
async function ready(url: string, process: ChildProcess) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    assert.equal(process.exitCode, null, 'synthetic runtime exited before HTTP readiness');
    try { const response = await fetch(url + '/api/auth/status', { signal: AbortSignal.timeout(500) }); if (response.ok) return response.json() as Promise<{ enabled: boolean; needsSetup: boolean }>; } catch { /* bounded startup poll */ }
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  assert.fail('synthetic runtime HTTP readiness timed out');
}

test('runtime CLI help does not require a profile or import a server', async () => {
  for (const args of [['--help'], ['-h']]) {
    const out = io(); assert.equal(await instanceRuntimeMain(args, out.stream), 0);
    assert.equal(out.stderr.join(''), ''); assert.match(out.stdout.join(''), /check/); assert.match(out.stdout.join(''), /start/);
    assert.match(out.stdout.join(''), /--profile/); assert.match(out.stdout.join(''), /--feishu/);
  }
});

test('runtime CLI check emits only the safe metadata result and keeps the synthetic instance byte-for-byte unchanged', async () => {
  const f = instanceRuntimeFixture();
  try {
    f.writeProfile({ ...f.profile, feishuEnvFile: f.envPath });
    const before = f.inventory(), out = io();
    assert.equal(await instanceRuntimeMain(['check', '--profile', f.profilePath], out.stream), 0);
    const result = JSON.parse(out.stdout.join(''));
    assert.equal(result.status, 'checked'); assert.equal(result.credentials, 'not-read'); assert.equal(result.databaseContents, 'not-checked');
    assert.equal(out.stderr.join(''), ''); assert.deepEqual(f.inventory(), before);
    assert.doesNotMatch(out.stdout.join(''), /SYNTHETIC_RUNTIME_SECRET|data with spaces|knowledge with spaces|expectedInstanceId|expectedSource/);
  } finally { f.cleanup(); }
});

test('runtime CLI rejects invalid flags and malformed profiles with fixed code-only output and no private exception text', async () => {
  const f = instanceRuntimeFixture();
  try {
    for (const args of [[], ['unknown'], ['check'], ['start'], ['check', '--profile'],
      ['check', '--profile', f.profilePath, '--feishu'], ['check', '--profile', f.profilePath, '--profile', f.profilePath],
      ['start', '--profile', f.profilePath, '--feishu=false'], ['check', '--profile', f.profilePath, '--unknown'],
      ['check', '--profile', f.profilePath, 'extra']]) {
      const before = f.inventory(), out = io(); assert.equal(await instanceRuntimeMain(args, out.stream), 1);
      assert.equal(out.stdout.join(''), ''); const result = JSON.parse(out.stderr.join(''));
      assert.deepEqual(Object.keys(result), ['error']); assert.deepEqual(Object.keys(result.error), ['code']); assert.match(result.error.code, /^[A-Z][A-Z0-9_]+$/);
      assert.doesNotMatch(out.stderr.join(''), /SYNTHETIC_RUNTIME_SECRET|data with spaces|knowledge with spaces/); assert.deepEqual(f.inventory(), before);
    }
    f.write(f.profilePath, '{"private":"' + RUNTIME_TEST_SECRET);
    const before = f.inventory(), out = io(); assert.equal(await instanceRuntimeMain(['check', '--profile', f.profilePath], out.stream), 1);
    assert.equal(out.stdout.join(''), ''); assert.deepEqual(Object.keys(JSON.parse(out.stderr.join('')).error), ['code']);
    assert.doesNotMatch(out.stderr.join(''), /SYNTHETIC_RUNTIME_SECRET|runtime profile|SyntaxError/); assert.deepEqual(f.inventory(), before);
  } finally { f.cleanup(); }
});

test('real CLI check and help run from another working directory without starting or initializing a server', { timeout: 15000 }, async () => {
  const f = instanceRuntimeFixture();
  try {
    const before = f.inventory();
    for (const args of [['check', '--profile', f.profilePath], ['--help']]) {
      const running = child(args, f.root, { LM_FEISHU_ENABLED: '1', LM_FEISHU_APP_SECRET: RUNTIME_TEST_SECRET, LM_PORT: '4318' });
      try { assert.equal((await running.done).code, 0); assert.doesNotMatch(JSON.stringify(running.output()), /SYNTHETIC_RUNTIME_SECRET|Feishu: connected|Listening/); }
      finally { await closeSyntheticChild(running.process); }
    }
    assert.deepEqual(f.inventory(), before);
  } finally { f.cleanup(); }
});

test('foreground runtime clears inherited LM settings, serves isolated assets and accounts, rejects duplicate leases, and releases on signals', { timeout: 45000 }, async () => {
  const f = instanceRuntimeFixture();
  try {
    // Start uses valid empty synthetic databases; no existing account or credential is copied.
    f.write(join(f.profile.dataDir, 'accounts.sqlite'), ''); f.write(join(f.profile.dataDir, 'living-memory.sqlite'), '');
    f.quarantine();
    const quarantineBefore = f.inventory().find(item => item.path.endsWith('restore-quarantine.json'));
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      const port = await unusedPort(); f.writeProfile({ ...f.profile, port }); const url = `http://127.0.0.1:${port}`;
      const running = child(['start', '--profile', f.profilePath], f.root, {
        LM_PORT: '4318', LM_AUTH_MODE: 'local', LM_DATA_DIR: join(f.root, 'must-not-create'),
        LM_KG_ROOT: join(f.root, 'wrong-source'), LM_STATIC_DIR: join(f.root, 'wrong-assets'),
        LM_FEISHU_ENABLED: '1', LM_FEISHU_APP_SECRET: RUNTIME_TEST_SECRET, LM_FEISHU_APP_ID: 'cli_synthetic_wrong',
        LM_FEISHU_TENANT_KEY: 'synthetic-wrong', LM_UNRECOGNIZED_RUNTIME_KEY: RUNTIME_TEST_SECRET,
      });
      try {
        const status = await ready(url, running.process); assert.equal(status.enabled, true); assert.equal(status.needsSetup, true);
        const asset = await fetch(url + '/'); assert.equal(asset.status, 200); assert.match(await asset.text(), /Synthetic runtime assets/);
        const duplicate = child(['start', '--profile', f.profilePath], f.root);
        try { assert.equal((await duplicate.done).code, 1); assert.equal(duplicate.output().stdout, '');
          const lines = duplicate.output().stderr.split('\n').filter(Boolean);
          const diagnostics = lines.filter(line => line.startsWith('{')).map(line => JSON.parse(line));
          assert.deepEqual(diagnostics, [{ error: { code: 'DATA_DIRECTORY_BUSY' } }]);
          const remaining = lines.filter(line => !line.startsWith('{'));
          assert.ok(remaining.length === 0 || (remaining.length === 2
            && /^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time$/.test(remaining[0])
            && remaining[1] === '(Use `node --trace-warnings ...` to show where the warning was created)'),
          'stderr may contain only the fixed busy diagnostic and the known SQLite warning'); }
        finally { await closeSyntheticChild(duplicate.process); }
        running.process.kill(signal); assert.equal((await running.done).code, 0);
        assert.doesNotMatch(JSON.stringify(running.output()), /SYNTHETIC_RUNTIME_SECRET|Feishu: connected/);
      } finally { await closeSyntheticChild(running.process); }
      assert.deepEqual(f.inventory().find(item => item.path.endsWith('restore-quarantine.json')), quarantineBefore);
      assert.equal(f.inventory().some(item => item.path.startsWith('must-not-create')), false);
    }
  } finally { f.cleanup(); }
});
