import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyHookInstall, planHookInstall } from '../src/integrations/install-kg-hook.js';

const repository = fileURLToPath(new URL('../', import.meta.url));
// Exact original bytes from 10691a9, independent of the current managed template.
const v1 = readFileSync(new URL('./fixtures/progressive-kg/living_memory_hook.v1.py', import.meta.url));
const v1Sha = '75b588e6f1aedc9fb31527ab0190c81f891b4476723a51c88c2502d9d5eaa16f';
const url = 'http://127.0.0.1:4391';
const secret = 'SYNTHETIC_RUNTIME_SECRET_DO_NOT_PRINT';
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'lm hook runtime '));
  const root = join(base, 'knowledge root'), project = join(base, 'project with spaces');
  for (const path of [join(root, '_system'), join(project, 'src/cli'), join(base, 'bin')]) mkdirSync(path, { recursive: true });
  writeFileSync(join(root, 'AGENTS.md'), '# Synthetic original instructions\n');
  writeFileSync(join(root, 'SCHEMA.md'), '# Synthetic schema\n');
  writeFileSync(join(root, '_system/OPERATIONS.md'), '# Synthetic operations\n');
  writeFileSync(join(root, 'concept.md'), 'Synthetic private concept body\n');
  writeFileSync(join(project, 'src/cli/index.ts'), '// Synthetic CLI presence marker\n');
  const hook = join(root, '_system/living_memory_hook.py');
  const configPath = join(root, '_system/living-memory.local.json');
  const log = join(base, 'npm-call.json');
  writeFileSync(join(base, 'bin/npm'), `#!/usr/bin/env python3
import json, os, sys
with open(os.environ['LM_HOOK_TEST_LOG'], 'w') as output:
    json.dump({'argv': sys.argv[1:], 'cwd': os.getcwd(), 'env': {
        key: os.environ.get(key) for key in ['LM_DATA_DIR', 'LM_CLI_STATE_DIR', 'LM_CLI_SESSION_FILE']
    }}, output)
sys.exit(int(os.environ.get('LM_HOOK_TEST_EXIT', '0')))
`, { mode: 0o755 });
  const runtime = { dataDir: join(base, 'restored instance data'), cliStateDir: join(base, 'restored CLI receipts') };
  const config = (value: unknown) => writeFileSync(configPath, JSON.stringify(value), { mode: 0o600 });
  const run = (extra: Record<string, string> = {}, operationId = 'synthetic-op') => spawnSync('python3',
    [hook, 'query', '--operation-id', operationId], { encoding: 'utf8', timeout: 10_000, env: {
      PATH: `${join(base, 'bin')}:${process.env.PATH ?? '/usr/bin:/bin'}`, LM_HOOK_TEST_LOG: log,
      LM_DATA_DIR: join(base, 'old data'), LM_CLI_STATE_DIR: join(base, 'old receipts'),
      LM_CLI_SESSION_FILE: join(base, 'old credential.json'), ...extra,
    } });
  return { base, root, project, hook, configPath, log, runtime, config, run,
    close: () => rmSync(base, { recursive: true, force: true }) };
}
function inventory(root: string): string[] {
  const result: string[] = [];
  function visit(directory: string, prefix: string) {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name), key = prefix + name, stat = lstatSync(path);
      if (stat.isSymbolicLink()) result.push(`${key}:link:${readlinkSync(path)}`);
      else if (stat.isDirectory()) { result.push(`${key}:dir:${stat.mode}`); visit(path, key + '/'); }
      else result.push(`${key}:file:${stat.mode}:${createHash('sha256').update(readFileSync(path)).digest('hex')}`);
    }
  }
  visit(root, '');
  return result;
}
function readConfig(f: ReturnType<typeof fixture>) { return JSON.parse(readFileSync(f.configPath, 'utf8')); }
function readCall(f: ReturnType<typeof fixture>): { argv: string[]; cwd: string; env: Record<string, string> } {
  return JSON.parse(readFileSync(f.log, 'utf8'));
}
function safeOutput(stdout: string | null, stderr: string | null) {
  for (const value of [stdout ?? '', stderr ?? '']) {
    assert.ok(!value.includes(secret), 'must not dump synthetic secrets');
    assert.ok(!value.includes('Synthetic private concept body'), 'must not dump knowledge text');
  }
}

test('pinned v1 fixture is byte-exact and the installer upgrades it while preserving original instructions and knowledge', () => {
  const f = fixture();
  try {
    assert.equal(v1.length, 1987);
    assert.equal(createHash('sha256').update(v1).digest('hex'), v1Sha);
    // Establish the managed instruction block without deriving the v1 script from the working tree.
    applyHookInstall(planHookInstall(f.root, url, f.project));
    writeFileSync(f.hook, v1);
    const agents = readFileSync(join(f.root, 'AGENTS.md'));
    const concept = readFileSync(join(f.root, 'concept.md'));
    const plan = planHookInstall(f.root, url, f.project, f.runtime);
    assert.ok(plan.files.some(file => file.relativePath === '_system/living_memory_hook.py'));
    assert.ok(!plan.files.some(file => file.relativePath === 'AGENTS.md'));
    applyHookInstall(plan);
    assert.notDeepEqual(readFileSync(f.hook), v1);
    assert.deepEqual(readFileSync(join(f.root, 'AGENTS.md')), agents);
    assert.deepEqual(readFileSync(join(f.root, 'concept.md')), concept);
    assert.deepEqual(readConfig(f), { version: 2, projectRoot: f.project, serverUrl: url, ...f.runtime });
    assert.deepEqual(planHookInstall(f.root, url, f.project, f.runtime).files, []);
  } finally { f.close(); }
});

test('any user byte edit to a v1 or current hook is rejected rather than overwritten', () => {
  for (const variant of ['v1', 'current'] as const) {
    const f = fixture();
    try {
      applyHookInstall(planHookInstall(f.root, url, f.project));
      const original = variant === 'v1' ? v1 : readFileSync(f.hook);
      const edited = Buffer.from(original);
      edited[edited.length - 1] ^= 1;
      writeFileSync(f.hook, edited);
      assert.equal(edited.length, original.length);
      assert.equal(edited.filter((byte, index) => byte !== original[index]).length, 1);
      const initial = inventory(f.base);
      assert.throws(() => planHookInstall(f.root, url, f.project, f.runtime));
      assert.deepEqual(inventory(f.base), initial);
    } finally { f.close(); }
  }
});

test('runtime configuration is preserved when reinstalling without flags and stays private', () => {
  const f = fixture();
  try {
    applyHookInstall(planHookInstall(f.root, url, f.project, f.runtime));
    const initial = inventory(f.base);
    assert.deepEqual(planHookInstall(f.root, url, f.project).files, []);
    applyHookInstall(planHookInstall(f.root, url, f.project));
    assert.deepEqual(readConfig(f), { version: 2, projectRoot: f.project, serverUrl: url, ...f.runtime });
    assert.equal(lstatSync(f.configPath).mode & 0o077, 0);
    assert.deepEqual(inventory(f.base), initial);
  } finally { f.close(); }
});

test('new installs without runtime paths retain the legacy two-field config and inherited environment', () => {
  const f = fixture();
  try {
    applyHookInstall(planHookInstall(f.root, url, f.project));
    assert.deepEqual(readConfig(f), { projectRoot: f.project, serverUrl: url });
    const result = f.run();
    assert.ifError(result.error); assert.equal(result.status, 0);
    const call = readCall(f);
    assert.deepEqual(call.env, { LM_DATA_DIR: join(f.base, 'old data'), LM_CLI_STATE_DIR: join(f.base, 'old receipts'),
      LM_CLI_SESSION_FILE: join(f.base, 'old credential.json') });
    assert.equal(call.argv.includes('--state-dir'), false);
    assert.equal(call.argv[call.argv.indexOf('--source-root') + 1], f.root);
    assert.equal(call.argv[call.argv.indexOf('--url') + 1], url);
    safeOutput(result.stdout, result.stderr);
  } finally { f.close(); }
});

test('v2 runtime replaces old data, session and receipt environment and explicitly forwards state-dir without reading credentials', () => {
  const f = fixture();
  try {
    applyHookInstall(planHookInstall(f.root, url, f.project, f.runtime));
    assert.equal(existsSync(join(f.runtime.dataDir, 'cli-session.json')), false);
    const result = f.run();
    assert.ifError(result.error); assert.equal(result.status, 0);
    const call = readCall(f);
    assert.deepEqual(call.env, { LM_DATA_DIR: f.runtime.dataDir, LM_CLI_STATE_DIR: f.runtime.cliStateDir,
      LM_CLI_SESSION_FILE: join(f.runtime.dataDir, 'cli-session.json') });
    assert.equal(call.argv[call.argv.indexOf('--state-dir') + 1], f.runtime.cliStateDir);
    assert.equal(call.cwd, f.project);
    assert.equal(existsSync(f.runtime.dataDir), false, 'hook must not create the runtime or credential directory');
    assert.equal(existsSync(f.runtime.cliStateDir), false, 'fake CLI must not require/create receipt storage');
    safeOutput(result.stdout, result.stderr);
  } finally { f.close(); }
});

test('runtime paths and operation IDs containing spaces and shell text remain literal arguments and CLI failure propagates', () => {
  const f = fixture();
  try {
    const marker = join(f.base, 'SHOULD_NOT_EXIST');
    const runtime = { dataDir: join(f.base, 'data $(touch SHOULD_NOT_EXIST)'),
      cliStateDir: join(f.base, 'receipts ; touch SHOULD_NOT_EXIST') };
    applyHookInstall(planHookInstall(f.root, url, f.project, runtime));
    const operationId = 'literal-$(touch SHOULD_NOT_EXIST); "quoted"';
    const result = f.run({ LM_HOOK_TEST_EXIT: '7' }, operationId);
    assert.ifError(result.error); assert.equal(result.status, 7);
    const call = readCall(f);
    assert.equal(call.argv[call.argv.indexOf('--operation-id') + 1], operationId);
    assert.equal(call.argv[call.argv.indexOf('--state-dir') + 1], runtime.cliStateDir);
    assert.deepEqual(call.argv.slice(call.argv.indexOf('after'), call.argv.indexOf('after') + 2), ['after', 'query']);
    assert.equal(call.env.LM_DATA_DIR, runtime.dataDir);
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(join(f.project, 'SHOULD_NOT_EXIST')), false);
    assert.equal(call.argv.includes('review'), false);
    safeOutput(result.stdout, result.stderr);
  } finally { f.close(); }
});

test('unknown versions and incomplete, relative or invalid runtime config fail before npm with safe output', () => {
  const f = fixture();
  try {
    applyHookInstall(planHookInstall(f.root, url, f.project, f.runtime));
    const valid = { version: 2, projectRoot: f.project, serverUrl: url, ...f.runtime };
    const invalid: unknown[] = [
      { ...valid, version: 3 }, { ...valid, version: '2' }, { ...valid, version: null }, { ...valid, version: true },
      { version: 2, projectRoot: f.project, serverUrl: url, dataDir: f.runtime.dataDir },
      { version: 2, projectRoot: f.project, serverUrl: url, cliStateDir: f.runtime.cliStateDir },
      { projectRoot: f.project, serverUrl: url, dataDir: f.runtime.dataDir, cliStateDir: f.runtime.cliStateDir },
      { projectRoot: f.project, serverUrl: url, dataDir: f.runtime.dataDir },
      { projectRoot: f.project, serverUrl: url, cliStateDir: f.runtime.cliStateDir },
      { ...valid, unexpected: secret }, { projectRoot: f.project, serverUrl: url, unexpected: secret },
      { ...valid, projectRoot: 42 }, { ...valid, projectRoot: '' }, { ...valid, projectRoot: 'relative/project' },
      { projectRoot: 42, serverUrl: url }, { projectRoot: '', serverUrl: url }, { projectRoot: 'relative/project', serverUrl: url },
      { ...valid, serverUrl: `http://user:${secret}@127.0.0.1:4391` },
      { ...valid, serverUrl: `http://127.0.0.1:4391/?token=${secret}` },
      { projectRoot: f.project, serverUrl: `https://example.com/${secret}` },
      { ...valid, dataDir: '' }, { ...valid, cliStateDir: '   ' }, { ...valid, dataDir: 42 },
      { ...valid, cliStateDir: null }, { ...valid, dataDir: ['unexpected'] },
      { ...valid, dataDir: 'relative/private' }, { ...valid, cliStateDir: 'relative/receipts' },
      { ...valid, dataDir: join(f.base, secret + '\ninvalid') },
    ];
    for (const config of invalid) {
      f.config(config);
      const result = f.run();
      assert.ifError(result.error); assert.notEqual(result.status, 0);
      assert.equal(existsSync(f.log), false, 'malformed config must never invoke npm');
      safeOutput(result.stdout, result.stderr);
    }
    writeFileSync(f.configPath, '{"broken":"' + secret + '"');
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(f.log), false);
    safeOutput(result.stdout, result.stderr);
  } finally { f.close(); }
});

test('installer rejects damaged existing config and incomplete runtime options without replacing files', () => {
  const f = fixture();
  try {
    applyHookInstall(planHookInstall(f.root, url, f.project));
    for (const invalid of [
      { projectRoot: f.project, serverUrl: url, dataDir: f.runtime.dataDir },
      { version: 99, projectRoot: f.project, serverUrl: url, ...f.runtime },
      { version: 2, projectRoot: f.project, serverUrl: url, dataDir: f.runtime.dataDir },
    ]) {
      f.config(invalid); const initial = inventory(f.base);
      assert.throws(() => planHookInstall(f.root, url, f.project));
      assert.throws(() => planHookInstall(f.root, url, f.project, f.runtime));
      assert.deepEqual(inventory(f.base), initial);
    }
    writeFileSync(f.configPath, '{broken ' + secret);
    const initial = inventory(f.base);
    assert.throws(() => planHookInstall(f.root, url, f.project, f.runtime));
    assert.deepEqual(inventory(f.base), initial);
    f.config({ projectRoot: f.project, serverUrl: url });
    assert.throws(() => planHookInstall(f.root, url, f.project, { dataDir: f.runtime.dataDir }));
    assert.throws(() => planHookInstall(f.root, url, f.project, { cliStateDir: f.runtime.cliStateDir }));
  } finally { f.close(); }
});

test('runtime upgrade preserves installer preimage and symlink guards', () => {
  const f = fixture();
  try {
    applyHookInstall(planHookInstall(f.root, url, f.project));
    writeFileSync(f.hook, v1);
    const plan = planHookInstall(f.root, url, f.project, f.runtime);
    writeFileSync(f.configPath, JSON.stringify({ projectRoot: f.project, serverUrl: 'http://127.0.0.1:4392' }));
    const initial = inventory(f.base);
    assert.throws(() => applyHookInstall(plan));
    assert.deepEqual(inventory(f.base), initial);
    const other = join(f.base, 'other hook directory'); mkdirSync(other);
    writeFileSync(join(other, 'OPERATIONS.md'), '# Synthetic operations\n');
    rmSync(join(f.root, '_system'), { recursive: true });
    symlinkSync(other, join(f.root, '_system'), 'dir');
    const linked = inventory(f.base);
    assert.throws(() => planHookInstall(f.root, url, f.project, f.runtime));
    assert.deepEqual(inventory(f.base), linked);
  } finally { f.close(); }
});

test('installer --check resolves relative runtime paths in its plan and does not modify any files', () => {
  const f = fixture();
  try {
    const initial = inventory(f.base);
    const result = spawnSync(process.execPath, ['--import', 'tsx', join(repository, 'src/integrations/install-kg-hook.ts'),
      '--root', f.root, '--url', url, '--data-dir', relative(repository, f.runtime.dataDir),
      '--state-dir', relative(repository, f.runtime.cliStateDir), '--check'],
    { cwd: repository, encoding: 'utf8', timeout: 10_000 });
    assert.ifError(result.error); assert.equal(result.status, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, 'planned');
    assert.ok(output.files.some((file: { path: string }) => file.path === '_system/living-memory.local.json'));
    assert.deepEqual(inventory(f.base), initial);
    safeOutput(result.stdout, result.stderr);
    assert.ok(!result.stdout.includes('projectRoot'), '--check must omit config contents');
  } finally { f.close(); }
});

test('installer CLI converts relative runtime paths to absolute config paths and rejects unpaired flags', () => {
  const f = fixture();
  try {
    const script = join(repository, 'src/integrations/install-kg-hook.ts');
    for (const flag of ['--data-dir', '--state-dir']) {
      const initial = inventory(f.base);
      const result = spawnSync(process.execPath, ['--import', 'tsx', script, '--root', f.root, flag, 'relative runtime', '--check'],
        { cwd: repository, encoding: 'utf8', timeout: 10_000 });
      assert.ifError(result.error); assert.notEqual(result.status, 0);
      assert.deepEqual(inventory(f.base), initial);
      safeOutput(result.stdout, result.stderr);
    }
    const result = spawnSync(process.execPath, ['--import', 'tsx', script, '--root', f.root, '--url', url,
      '--data-dir', relative(repository, f.runtime.dataDir), '--state-dir', relative(repository, f.runtime.cliStateDir)],
    { cwd: repository, encoding: 'utf8', timeout: 10_000 });
    assert.ifError(result.error); assert.equal(result.status, 0);
    assert.deepEqual(readConfig(f), { version: 2, projectRoot: repository.replace(/\/$/, ''), serverUrl: url, ...f.runtime });
    safeOutput(result.stdout, result.stderr);
  } finally { f.close(); }
});

test('installer --check returns a fixed error for malformed private config without echoing its secret', () => {
  const f = fixture();
  try {
    applyHookInstall(planHookInstall(f.root, url, f.project));
    writeFileSync(f.configPath, '{"broken":"' + secret + '"');
    const initial = inventory(f.base);
    const result = spawnSync(process.execPath, ['--import', 'tsx', join(repository, 'src/integrations/install-kg-hook.ts'),
      '--root', f.root, '--url', url, '--check'], { cwd: repository, encoding: 'utf8', timeout: 10_000 });
    assert.ifError(result.error); assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.deepEqual(JSON.parse(result.stderr), { error: { code: 'HOOK_INSTALL_FAILED',
      message: '钩子安装失败，请核对目录、配置版本和受管理文件。' } });
    safeOutput(result.stdout, result.stderr);
    assert.deepEqual(inventory(f.base), initial);
  } finally { f.close(); }
});
