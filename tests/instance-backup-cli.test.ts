import assert from 'node:assert/strict';
import test from 'node:test';
import { runInstanceBackupCli, instanceBackupMain, type InstanceBackupCliBackend } from '../scripts/instance-backup';
import type { InstanceManifest, RestoreReport } from '../src/server/instance-backup';

function fixture() {
  const calls: unknown[] = [];
  const manifest = { version: 2, learningSchemaVersion: 2, files: [{ path: 'private', sha256: 'secret-hash' }], sources: [{ userId: 'private-account' }],
    excluded: ['sensitive-private-name'], configuration: ['secret.env'], databases: [{ tables: { privateTable: 4 } }] } as unknown as InstanceManifest;
  const restored = { files: 4, sources: 2, invalidated: { privateAccount: 2 }, instanceId: 'private-instance',
    startup: { dataDir: '/target/data', kgRoot: '/target/kg', cliStateDir: '/target/cli', envArchive: '/target/config/environment.env' } } as unknown as RestoreReport;
  const backend: InstanceBackupCliBackend = {
    backupInstance: async options => { calls.push(['backup', options]); return manifest; },
    verifyInstanceBundle: bundle => { calls.push(['verify', bundle]); return manifest; },
    restoreInstance: async options => { calls.push(['restore', options]); return restored; },
    activateRestoredConnectors: async (dataDir, confirmed, options) => { calls.push(options ? ['activate', dataDir, confirmed, options] : ['activate', dataDir, confirmed]); },
  };
  return { calls, backend };
}

test('backup passes only explicit approved paths and prints a whitelist summary without manifest private fields', async () => {
  const f = fixture();
  const result = await runInstanceBackupCli(['backup', '--data-dir', '/private/data', '--kg-root=/private/kg', '--cli-state-dir', '/private/cli',
    '--output', '/target/bundle', '--env-file', '/private/environment.env', '--cli-session-file', '/private/device.json'], f.backend);
  assert.deepEqual(f.calls, [['backup', { dataDir: '/private/data', kgRoot: '/private/kg', cliStateDir: '/private/cli', output: '/target/bundle',
    envFile: '/private/environment.env', cliSessionFile: '/private/device.json' }]]);
  assert.deepEqual(result, { format: 'living-memory-instance', version: 2, learningSchemaVersion: 2, status: 'created', files: 1, sources: 1, target: '/target/bundle' });
  assert.doesNotMatch(JSON.stringify(result), /private-account|secret-hash|sensitive-private-name|privateTable|secret.env/);
});

test('strict flag parsing rejects duplicates, positional extras, missing values and test-only offline bypasses without backend calls', async () => {
  const f = fixture();
  for (const argv of [
    ['backup', '--proc-root', '/synthetic'], ['backup', '--data-dir', '/x', '--data-dir', '/y'],
    ['verify', '--bundle'], ['verify', '--bundle', ''], ['verify', '--bundle', '/b', 'extra'],
    ['restore', '--bundle', '/b', '--target', '/t', '--output', '/out'], ['activate-connectors', '--data-dir', '/t', '--confirm-bindings=true'],
  ]) await assert.rejects(runInstanceBackupCli(argv, f.backend), { code: 'INVALID_INSTANCE_ARGUMENT' });
  await assert.rejects(runInstanceBackupCli(['unknown'], f.backend), { code: 'INVALID_INSTANCE_COMMAND' });
  await assert.rejects(runInstanceBackupCli(['backup', '--output', '/b'], f.backend), { code: 'INVALID_INSTANCE_ARGUMENT' });
  assert.deepEqual(f.calls, []);
});

test('verify is read-only and restore returns only new startup paths while keeping activation separate', async () => {
  const f = fixture();
  assert.deepEqual(await runInstanceBackupCli(['verify', '--bundle', '/bundle'], f.backend), { format: 'living-memory-instance', version: 2, learningSchemaVersion: 2, status: 'verified', files: 1, sources: 1 });
  const restored = await runInstanceBackupCli(['restore', '--bundle', '/bundle', '--target', '/target'], f.backend) as any;
  assert.equal(restored.status, 'restored-quarantined'); assert.equal(restored.connectorsBlocked, true);
  assert.equal(restored.startup.dataDir, '/target/data'); assert.doesNotMatch(JSON.stringify(restored), /privateAccount|private-instance|invalidated/);
  assert.deepEqual(f.calls, [['verify', '/bundle'], ['restore', { bundle: '/bundle', target: '/target' }]]);
});

test('connector activation requires explicit confirmation and never receives test-only options', async () => {
  const f = fixture();
  await assert.rejects(runInstanceBackupCli(['activate-connectors', '--data-dir', '/target/data'], f.backend), { code: 'CONNECTOR_CONFIRMATION_REQUIRED' });
  assert.deepEqual(f.calls, []);
  await runInstanceBackupCli(['activate-connectors', '--data-dir', '/target/data', '--confirm-bindings'], f.backend);
  assert.deepEqual(f.calls, [['activate', '/target/data', true]]);
});

test('schema selection is restore-only, exact and mutually exclusive with legacy preservation before any backend call', async () => {
  const f = fixture(), restore = ['restore', '--bundle', '/bundle', '--target', '/target'];
  for (const value of ['1', '4', '03', '3.0', ' 3', 'true']) {
    await assert.rejects(runInstanceBackupCli([...restore, '--learning-schema', value], f.backend), { code: 'INVALID_INSTANCE_ARGUMENT' });
  }
  for (const argv of [
    [...restore, '--learning-schema'], [...restore, '--learning-schema', '3', '--learning-schema', '2'],
    [...restore, '--learning-schema', '3', '--preserve-legacy-learning-schema'],
    ['verify', '--bundle', '/bundle', '--learning-schema', '3'], ['backup', '--learning-schema', '3'],
  ]) await assert.rejects(runInstanceBackupCli(argv, f.backend), { code: 'INVALID_INSTANCE_ARGUMENT' });
  assert.deepEqual(f.calls, []);
  await runInstanceBackupCli([...restore, '--learning-schema=2'], f.backend);
  assert.deepEqual(f.calls, [['restore', { bundle: '/bundle', target: '/target', targetLearningSchemaVersion: 2 }]]);
});

test('explicit v3 restore identifies an offline candidate without exposing private report fields or implying runtime support', async () => {
  const f = fixture(), original = f.backend.restoreInstance;
  f.backend.restoreInstance = async options => ({ ...await original(options),
    learningSchemaCandidate: { schemaVersion: 3, runtimeReady: false, secret: 'private-candidate-secret' } } as RestoreReport);
  const result = await runInstanceBackupCli(['restore', '--bundle', '/bundle', '--target', '/candidate', '--learning-schema', '3'], f.backend);
  assert.deepEqual(f.calls, [['restore', { bundle: '/bundle', target: '/candidate', targetLearningSchemaVersion: 3 }]]);
  assert.deepEqual((result as Record<string, unknown>).learningSchemaCandidate, { schemaVersion: 3, runtimeReady: false });
  assert.doesNotMatch(JSON.stringify(result), /private-candidate-secret|privateAccount|private-instance|invalidated/);
  assert.match(String(await runInstanceBackupCli(['restore', '--help'], f.backend)), /当前服务尚不能启动/);
});

test('terminal errors contain only a fixed code and help explains stop/quarantine/browser boundaries without running a backend', async () => {
  const f = fixture(); const stdout: string[] = []; const stderr: string[] = [];
  f.backend.verifyInstanceBundle = () => { throw Object.assign(new Error('/private/user/secret.env contains PASSWORD=private'), { code: 'INSTANCE_HASH_MISMATCH' }); };
  assert.equal(await instanceBackupMain(['verify', '--bundle', '/private/user/bundle'], { stdout: value => stdout.push(value), stderr: value => stderr.push(value) }, f.backend), 1);
  assert.equal(stdout.length, 0); assert.deepEqual(stderr, ['{"error":{"code":"INSTANCE_HASH_MISMATCH"}}\n']);
  f.backend.verifyInstanceBundle = () => { throw Object.assign(new Error('private'), { code: 'PRIVATE_SECRET_TOKEN' }); };
  stderr.length = 0;
  await instanceBackupMain(['verify', '--bundle', '/private/user/bundle'], { stdout: value => stdout.push(value), stderr: value => stderr.push(value) }, f.backend);
  assert.deepEqual(stderr, ['{"error":{"code":"INSTANCE_BACKUP_FAILED"}}\n']);
  const help = await runInstanceBackupCli(['--help'], f.backend);
  assert.equal(typeof help, 'string'); assert.match(String(help), /停止本地服务/); assert.match(String(help), /草稿不在备份/); assert.match(String(help), /不会自动激活飞书/);
  assert.deepEqual(f.calls, []);
});

test('sudo scan is an explicit boolean available only to backup and connector activation', async () => {
  const f = fixture();
  const backup = ['backup', '--data-dir', '/data', '--kg-root', '/kg', '--cli-state-dir', '/cli', '--output', '/bundle'];
  await runInstanceBackupCli([...backup, '--sudo-offline-scan'], f.backend);
  await runInstanceBackupCli(['activate-connectors', '--data-dir', '/data', '--confirm-bindings', '--sudo-offline-scan'], f.backend);
  assert.deepEqual(f.calls, [
    ['backup', { dataDir: '/data', kgRoot: '/kg', cliStateDir: '/cli', output: '/bundle', offlineCheck: 'sudo' }],
    ['activate', '/data', true, { offlineCheck: 'sudo' }],
  ]);
  f.calls.length = 0;
  for (const argv of [
    [...backup, '--sudo-offline-scan=true'], [...backup, '--sudo-offline-scan=false'],
    [...backup, '--sudo-offline-scan', 'true'], [...backup, '--sudo-offline-scan', '--sudo-offline-scan'],
    ['verify', '--bundle', '/bundle', '--sudo-offline-scan'],
    ['restore', '--bundle', '/bundle', '--target', '/target', '--sudo-offline-scan'],
    ['activate-connectors', '--data-dir', '/data', '--confirm-bindings', '--sudo-offline-scan=true'],
  ]) await assert.rejects(runInstanceBackupCli(argv, f.backend), { code: 'INVALID_INSTANCE_ARGUMENT' });
  assert.deepEqual(f.calls, []);
});

test('activation awaits asynchronous rejection and scan failures print only approved fixed codes', async () => {
  const f = fixture();
  const stdout: string[] = [], stderr: string[] = [];
  for (const code of ['OFFLINE_SCAN_AUTH_REQUIRED', 'OFFLINE_SCAN_UNAVAILABLE', 'DATABASE_OPEN', 'INSTANCE_SCHEMA_TARGET_REQUIRED', 'INSTANCE_RUNTIME_UNSUPPORTED']) {
    f.backend.activateRestoredConnectors = async () => {
      await Promise.resolve();
      throw Object.assign(new Error('/private/account PASSWORD=private helper diagnostic'), { code });
    };
    assert.equal(await instanceBackupMain(['activate-connectors', '--data-dir', '/private/data', '--confirm-bindings', '--sudo-offline-scan'],
      { stdout: value => stdout.push(value), stderr: value => stderr.push(value) }, f.backend), 1);
    assert.equal(stdout.length, 0);
    assert.equal(stderr.pop(), JSON.stringify({ error: { code } }) + '\n');
  }
});


test('legacy preservation is a restore-only explicit boolean and v1 verification reports its actual schema', async () => {
  const f=fixture();
  await runInstanceBackupCli(['restore','--bundle','/bundle','--target','/new','--preserve-legacy-learning-schema'],f.backend);
  assert.deepEqual(f.calls,[['restore',{bundle:'/bundle',target:'/new',preserveLegacyLearningSchema:true}]]);
  f.calls.length=0;
  for(const argv of [
    ['restore','--bundle','/bundle','--target','/new','--preserve-legacy-learning-schema=true'],
    ['restore','--bundle','/bundle','--target','/new','--preserve-legacy-learning-schema','false'],
    ['restore','--bundle','/bundle','--target','/new','--preserve-legacy-learning-schema','--preserve-legacy-learning-schema'],
    ['backup','--preserve-legacy-learning-schema'],['verify','--bundle','/bundle','--preserve-legacy-learning-schema'],
    ['activate-connectors','--data-dir','/data','--confirm-bindings','--preserve-legacy-learning-schema'],
  ])await assert.rejects(runInstanceBackupCli(argv,f.backend),{code:'INVALID_INSTANCE_ARGUMENT'});
  assert.deepEqual(f.calls,[]);
  f.backend.verifyInstanceBundle=()=>({version:1,applicationVersion:'0.0.1-preview.1',files:[],sources:[]} as unknown as InstanceManifest);
  assert.deepEqual(await runInstanceBackupCli(['verify','--bundle','/bundle'],f.backend),{format:'living-memory-instance',version:1,learningSchemaVersion:1,status:'verified',files:0,sources:0});
});
