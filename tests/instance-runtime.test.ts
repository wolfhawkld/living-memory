import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, renameSync, symlinkSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { checkInstanceRuntime, InstanceRuntimeError, prepareInstanceRuntime, readInstanceRuntimeProfile } from '../src/server/instance-runtime.js';
import { instanceRuntimeFixture, RUNTIME_TEST_SECRET } from './helpers/instance-runtime-fixture.js';

function rejected(operation: () => unknown, code?: string) {
  const codes = ['INVALID_RUNTIME_ARGUMENT', 'RUNTIME_PROFILE_INVALID', 'RUNTIME_PATH_INVALID', 'RUNTIME_STORAGE_CONFLICT',
    'RUNTIME_DATABASE_MISSING', 'RUNTIME_INSTANCE_MISMATCH', 'RUNTIME_SOURCE_MISMATCH', 'RUNTIME_BUILD_MISSING',
    'RUNTIME_CONNECTOR_QUARANTINED', 'RUNTIME_CREDENTIALS_INVALID', 'RUNTIME_START_FAILED'];
  assert.throws(operation, (error: unknown) => error instanceof InstanceRuntimeError && codes.includes(error.code) && (!code || error.code === code));
}

test('runtime check validates existing metadata without opening databases or reading credentials or initializing files', () => {
  const f = instanceRuntimeFixture();
  try {
    f.writeProfile({ ...f.profile, feishuEnvFile: f.envPath }); // Intentionally absent; check must not inspect it.
    const before = f.inventory();
    assert.deepEqual(readInstanceRuntimeProfile(f.profilePath), { ...f.profile, feishuEnvFile: f.envPath });
    assert.deepEqual(checkInstanceRuntime(f.profilePath), { format: 'living-memory-runtime-check', version: 1, status: 'checked',
      url: `http://127.0.0.1:${f.profile.port}`, instanceMatched: true, sourceMatched: true, storagePathsChecked: true,
      staticEntryChecked: true, restoreQuarantined: false, credentials: 'not-read', databaseContents: 'not-checked' });
    assert.deepEqual(f.inventory(), before);
  } finally { f.cleanup(); }
});

test('strict profile rejects unknown keys, malformed values, noncanonical paths and invalid ports without side effects', () => {
  const f = instanceRuntimeFixture();
  try {
    const mutations: unknown[] = [null, [], { ...f.profile, version: 2 }, { ...f.profile, extra: RUNTIME_TEST_SECRET },
      ...[0, -1, 65536, 1.5, '4317', null].map(port => ({ ...f.profile, port })),
      ...[0, -1, 301, 1.5, '20', null].map(kgLimit => ({ ...f.profile, kgLimit })),
      ...['bad\nfilter', 'x'.repeat(4097), 42, null].map(kgInclude => ({ ...f.profile, kgInclude })),
      ...['dataDir', 'kgRoot', 'cliStateDir', 'staticDir', 'feishuEnvFile'].flatMap(key => ['', 'relative/path', '/tmp/../tmp/noncanonical', '/tmp/control\npath', 42]
        .map(value => ({ ...f.profile, [key]: value }))),
      ...['expectedInstanceId', 'expectedSourceIdentityHash', 'expectedSourceRootFingerprint'].flatMap(key => ['', 'malformed', null, RUNTIME_TEST_SECRET]
        .map(value => ({ ...f.profile, [key]: value })))];
    for (const mutation of mutations) {
      f.writeProfile(mutation); const before = f.inventory();
      rejected(() => readInstanceRuntimeProfile(f.profilePath)); assert.deepEqual(f.inventory(), before);
    }
  } finally { f.cleanup(); }
});

test('profile must be a private bounded regular file and symlinks are rejected', () => {
  const f = instanceRuntimeFixture();
  try {
    const target = join(f.root, 'profile original.json'); renameSync(f.profilePath, target); symlinkSync(target, f.profilePath);
    rejected(() => readInstanceRuntimeProfile(f.profilePath)); unlinkSync(f.profilePath); renameSync(target, f.profilePath);
    if (process.platform !== 'win32') { chmodSync(f.profilePath, 0o644); rejected(() => readInstanceRuntimeProfile(f.profilePath)); chmodSync(f.profilePath, 0o600); }
    f.write(f.profilePath, ' '.repeat(65537)); rejected(() => readInstanceRuntimeProfile(f.profilePath));
    f.write(f.profilePath, '{"secret":"' + RUNTIME_TEST_SECRET); rejected(() => readInstanceRuntimeProfile(f.profilePath));
  } finally { f.cleanup(); }
});

test('existing instance identity and source fingerprint are checked, including restored source registry mapping and legacy', () => {
  const f = instanceRuntimeFixture();
  try {
    for (const profile of [{ ...f.profile, expectedInstanceId: '87654321-4321-4321-8321-cba987654321' },
      { ...f.profile, expectedSourceIdentityHash: 'a'.repeat(64) }, { ...f.profile, expectedSourceRootFingerprint: 'b'.repeat(64) }]) {
      f.writeProfile(profile); const before = f.inventory(); rejected(() => checkInstanceRuntime(f.profilePath)); assert.deepEqual(f.inventory(), before);
    }
    f.write(join(f.profile.dataDir, 'source-identities.json'), JSON.stringify({ format: 'living-memory-source-identities', version: 1,
      entries: [{ physicalRoot: f.profile.kgRoot, identityHash: 'a'.repeat(64), displayName: 'Synthetic restored source' }] }));
    f.writeProfile({ ...f.profile, expectedSourceIdentityHash: 'a'.repeat(64) }); assert.equal(checkInstanceRuntime(f.profilePath).sourceMatched, true);
    f.write(join(f.profile.dataDir, 'instance-identity.json'), 'INVALID_JSON_' + RUNTIME_TEST_SECRET); rejected(() => checkInstanceRuntime(f.profilePath));
    unlinkSync(join(f.profile.dataDir, 'instance-identity.json'));
    f.writeProfile({ ...f.profile, expectedInstanceId: 'legacy', expectedSourceIdentityHash: 'a'.repeat(64) });
    assert.equal(checkInstanceRuntime(f.profilePath).instanceMatched, true);
  } finally { f.cleanup(); }
});

test('runtime requires existing directories, database regular files and a regular static entry', () => {
  for (const mode of ['missing-data', 'missing-cli', 'missing-kg', 'missing-static', 'missing-accounts', 'missing-learning', 'db-directory', 'db-symlink', 'missing-index', 'index-symlink']) {
    const f = instanceRuntimeFixture();
    try {
      const keys = { 'missing-data': 'dataDir', 'missing-cli': 'cliStateDir', 'missing-kg': 'kgRoot', 'missing-static': 'staticDir' } as const;
      if (mode in keys) { const key = keys[mode as keyof typeof keys]; f.writeProfile({ ...f.profile, [key]: join(f.root, 'missing') }); }
      else if (mode.startsWith('missing-')) unlinkSync(join(mode === 'missing-index' ? f.profile.staticDir : f.profile.dataDir,
        mode === 'missing-index' ? 'index.html' : mode === 'missing-accounts' ? 'accounts.sqlite' : 'living-memory.sqlite'));
      else if (mode === 'index-symlink') { unlinkSync(join(f.profile.staticDir, 'index.html')); symlinkSync(join(f.profile.kgRoot, 'Root.md'), join(f.profile.staticDir, 'index.html')); }
      else { const path = join(f.profile.dataDir, 'accounts.sqlite'); unlinkSync(path); if (mode === 'db-directory') mkdirSync(path); else symlinkSync(join(f.profile.dataDir, 'living-memory.sqlite'), path); }
      const before = f.inventory(); rejected(() => checkInstanceRuntime(f.profilePath)); assert.deepEqual(f.inventory(), before);
    } finally { f.cleanup(); }
  }
});

test('knowledge and static assets cannot overlap runtime storage or private profile and environment files', () => {
  const f = instanceRuntimeFixture();
  try {
    for (const patch of [{ dataDir: f.profile.kgRoot }, { staticDir: f.profile.dataDir }, { kgRoot: f.root },
      { cliStateDir: f.profile.kgRoot }, { cliStateDir: f.profile.staticDir }, { feishuEnvFile: join(f.profile.kgRoot, 'secrets.env') },
      { feishuEnvFile: join(f.profile.staticDir, 'secrets.env') }]) {
      f.writeProfile({ ...f.profile, ...patch }); const before = f.inventory(); rejected(() => checkInstanceRuntime(f.profilePath)); assert.deepEqual(f.inventory(), before);
    }
    const profileInsideKg = join(f.profile.kgRoot, 'private profile.json'); f.write(profileInsideKg, JSON.stringify(f.profile));
    rejected(() => checkInstanceRuntime(profileInsideKg));
  } finally { f.cleanup(); }
});

test('prepare defaults to accounts and Feishu off without inheriting or mutating process environment', () => {
  const f = instanceRuntimeFixture();
  const keys = ['LM_DATA_DIR', 'LM_FEISHU_ENABLED', 'LM_FEISHU_APP_SECRET'] as const;
  const original = keys.map(key => [key, process.env[key]] as const);
  try {
    process.env.LM_DATA_DIR = '/synthetic/wrong'; process.env.LM_FEISHU_ENABLED = '1'; process.env.LM_FEISHU_APP_SECRET = RUNTIME_TEST_SECRET;
    f.writeProfile({ ...f.profile, feishuEnvFile: f.envPath });
    // Only compare this opaque in-memory snapshot as a boolean: assertion
    // diagnostics must never serialize inherited environment values.
    const environmentSnapshot = () => JSON.stringify(Object.entries(process.env).sort(([a], [b]) => a.localeCompare(b)));
    const before = f.inventory(), environmentBefore = environmentSnapshot();
    const result = prepareInstanceRuntime(f.profilePath);
    assert.ok(environmentBefore === environmentSnapshot(), 'prepare must preserve inherited environment');
    assert.equal(process.env.LM_DATA_DIR === '/synthetic/wrong' && process.env.LM_FEISHU_ENABLED === '1'
      && process.env.LM_FEISHU_APP_SECRET === RUNTIME_TEST_SECRET, true, 'prepare must preserve synthetic inherited values');
    assert.deepEqual(f.inventory(), before);
    assert.equal(result.environment.LM_AUTH_MODE, 'accounts'); assert.equal(result.environment.LM_FEISHU_ENABLED, '0');
    assert.equal(result.environment.LM_DATA_DIR, f.profile.dataDir); assert.equal(result.environment.LM_KG_ROOT, f.profile.kgRoot);
    assert.equal(result.environment.LM_CLI_STATE_DIR, f.profile.cliStateDir); assert.equal(result.environment.LM_CLI_SESSION_FILE, join(f.profile.dataDir, 'cli-session.json'));
    assert.equal(result.environment.LM_PORT, String(f.profile.port)); assert.equal(result.environment.LM_SERVER_URL, `http://127.0.0.1:${f.profile.port}`);
    assert.deepEqual(result.environment, { LM_DATA_DIR: f.profile.dataDir, LM_KG_ROOT: f.profile.kgRoot,
      LM_CLI_STATE_DIR: f.profile.cliStateDir, LM_CLI_SESSION_FILE: join(f.profile.dataDir, 'cli-session.json'),
      LM_PORT: String(f.profile.port), LM_AUTH_MODE: 'accounts', LM_STATIC_DIR: f.profile.staticDir,
      LM_SERVER_URL: `http://127.0.0.1:${f.profile.port}`, LM_FEISHU_ENABLED: '0', LM_KG_LIMIT: '20', LM_KG_INCLUDE: '' });
    assert.doesNotMatch(JSON.stringify(result.environment), /SYNTHETIC_RUNTIME_SECRET|synthetic\/wrong/);
  } finally { for (const [key, value] of original) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } f.cleanup(); }
});

test('explicit Feishu reads only the four allowed credentials, while quarantine blocks before environment access', () => {
  const f = instanceRuntimeFixture();
  try {
    f.writeProfile({ ...f.profile, feishuEnvFile: f.envPath });
    f.quarantine(); const quarantined = f.inventory();
    assert.equal(checkInstanceRuntime(f.profilePath).restoreQuarantined, true);
    assert.equal(prepareInstanceRuntime(f.profilePath).environment.LM_FEISHU_ENABLED, '0');
    rejected(() => prepareInstanceRuntime(f.profilePath, { feishu: true }), 'RUNTIME_CONNECTOR_QUARANTINED'); assert.deepEqual(f.inventory(), quarantined);
    f.quarantine(false);
    f.write(f.envPath, ['LM_FEISHU_APP_ID=cli_0123456789abcdef', `LM_FEISHU_APP_SECRET=${RUNTIME_TEST_SECRET}`,
      'LM_FEISHU_TENANT_KEY=synthetic-runtime-tenant', 'LM_FEISHU_TIME_ZONE=Asia/Shanghai',
      'LM_DATA_DIR=/synthetic/injected', 'PATH=/synthetic/injected', 'UNRELATED_SECRET=IGNORED_SYNTHETIC_SECRET'].join('\n'));
    const before = f.inventory(), prepared = prepareInstanceRuntime(f.profilePath, { feishu: true });
    assert.equal(prepared.environment.LM_FEISHU_ENABLED, '1'); assert.equal(prepared.environment.LM_FEISHU_APP_SECRET, RUNTIME_TEST_SECRET);
    assert.equal(prepared.environment.LM_FEISHU_TIME_ZONE, 'Asia/Shanghai'); assert.equal(prepared.environment.LM_DATA_DIR, f.profile.dataDir);
    assert.equal(prepared.environment.PATH, undefined); assert.equal(prepared.environment.UNRELATED_SECRET, undefined); assert.deepEqual(f.inventory(), before);
  } finally { f.cleanup(); }
});

test('explicit source limits and include filters are reproducible, and CLI storage may be separate but never contain data', () => {
  const f = instanceRuntimeFixture();
  try {
    const separate = join(f.root, 'separate cli'); mkdirSync(separate, { mode: 0o700 });
    f.writeProfile({ ...f.profile, cliStateDir: separate, kgLimit: 300, kgInclude: 'Math/**,Systems/**' });
    const result = prepareInstanceRuntime(f.profilePath);
    assert.equal(result.environment.LM_KG_LIMIT, '300'); assert.equal(result.environment.LM_KG_INCLUDE, 'Math/**,Systems/**');
    assert.equal(result.environment.LM_CLI_STATE_DIR, separate);
    for (const cliStateDir of [f.profile.dataDir, f.root]) {
      f.writeProfile({ ...f.profile, cliStateDir }); rejected(() => checkInstanceRuntime(f.profilePath), 'RUNTIME_STORAGE_CONFLICT');
    }
  } finally { f.cleanup(); }
});

test('Feishu credentials require a private bounded regular file and validated values, without changing quarantine or printing secrets', () => {
  const f = instanceRuntimeFixture();
  try {
    f.writeProfile({ ...f.profile, feishuEnvFile: f.envPath });
    const valid = `LM_FEISHU_APP_ID=cli_0123456789abcdef\nLM_FEISHU_APP_SECRET=${RUNTIME_TEST_SECRET}\nLM_FEISHU_TENANT_KEY=synthetic-runtime-tenant\n`;
    rejected(() => prepareInstanceRuntime(f.profilePath, { feishu: true }), 'RUNTIME_CREDENTIALS_INVALID');
    f.write(f.envPath, valid);
    assert.equal(prepareInstanceRuntime(f.profilePath, { feishu: true }).environment.LM_FEISHU_TIME_ZONE, 'UTC');
    for (const bytes of ['', `LM_FEISHU_APP_SECRET=${RUNTIME_TEST_SECRET}`, valid + 'LM_FEISHU_TIME_ZONE=No/SuchZone\n', 'x'.repeat(131073)]) {
      f.write(f.envPath, bytes); const before = f.inventory();
      rejected(() => prepareInstanceRuntime(f.profilePath, { feishu: true }), 'RUNTIME_CREDENTIALS_INVALID'); assert.deepEqual(f.inventory(), before);
    }
    f.write(f.envPath, valid);
    if (process.platform !== 'win32') { chmodSync(f.envPath, 0o644); rejected(() => prepareInstanceRuntime(f.profilePath, { feishu: true }), 'RUNTIME_CREDENTIALS_INVALID'); chmodSync(f.envPath, 0o600); }
    const target = join(f.root, 'credential target'); renameSync(f.envPath, target); symlinkSync(target, f.envPath);
    rejected(() => prepareInstanceRuntime(f.profilePath, { feishu: true }), 'RUNTIME_CREDENTIALS_INVALID');
  } finally { f.cleanup(); }
});

test('Vite source index must never make the installed repository or its ancestor a public static directory', () => {
  const f = instanceRuntimeFixture();
  try {
    const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
    for (const staticDir of [repo, resolve(fileURLToPath(new URL('../..', import.meta.url)))]) {
      f.writeProfile({ ...f.profile, staticDir }); const before = f.inventory();
      rejected(() => checkInstanceRuntime(f.profilePath), 'RUNTIME_STORAGE_CONFLICT'); assert.deepEqual(f.inventory(), before);
    }
  } finally { f.cleanup(); }
});
