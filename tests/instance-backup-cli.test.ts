import assert from 'node:assert/strict';
import test from 'node:test';
import { runInstanceBackupCli, instanceBackupMain, type InstanceBackupCliBackend } from '../scripts/instance-backup';
import type { InstanceManifest, RestoreReport } from '../src/server/instance-backup';

function fixture() {
  const calls: unknown[] = [];
  const manifest = { files: [{ path: 'private', sha256: 'secret-hash' }], sources: [{ userId: 'private-account' }],
    excluded: ['sensitive-private-name'], configuration: ['secret.env'], databases: [{ tables: { privateTable: 4 } }] } as unknown as InstanceManifest;
  const restored = { files: 4, sources: 2, invalidated: { privateAccount: 2 }, instanceId: 'private-instance',
    startup: { dataDir: '/target/data', kgRoot: '/target/kg', cliStateDir: '/target/cli', envArchive: '/target/config/environment.env' } } as unknown as RestoreReport;
  const backend: InstanceBackupCliBackend = {
    backupInstance: async options => { calls.push(['backup', options]); return manifest; },
    verifyInstanceBundle: bundle => { calls.push(['verify', bundle]); return manifest; },
    restoreInstance: async options => { calls.push(['restore', options]); return restored; },
    activateRestoredConnectors: (dataDir, confirmed) => { calls.push(['activate', dataDir, confirmed]); },
  };
  return { calls, backend };
}

test('backup passes only explicit approved paths and prints a whitelist summary without manifest private fields', async () => {
  const f = fixture();
  const result = await runInstanceBackupCli(['backup', '--data-dir', '/private/data', '--kg-root=/private/kg', '--cli-state-dir', '/private/cli',
    '--output', '/target/bundle', '--env-file', '/private/environment.env', '--cli-session-file', '/private/device.json'], f.backend);
  assert.deepEqual(f.calls, [['backup', { dataDir: '/private/data', kgRoot: '/private/kg', cliStateDir: '/private/cli', output: '/target/bundle',
    envFile: '/private/environment.env', cliSessionFile: '/private/device.json' }]]);
  assert.deepEqual(result, { format: 'living-memory-instance', version: 1, status: 'created', files: 1, sources: 1, target: '/target/bundle' });
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
  assert.deepEqual(await runInstanceBackupCli(['verify', '--bundle', '/bundle'], f.backend), { format: 'living-memory-instance', version: 1, status: 'verified', files: 1, sources: 1 });
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
