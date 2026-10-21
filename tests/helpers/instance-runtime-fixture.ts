import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { InstanceRuntimeProfile } from '../../src/server/instance-runtime.js';

export const RUNTIME_TEST_INSTANCE_ID = '12345678-1234-4234-8234-123456789abc';
export const RUNTIME_TEST_SECRET = 'SYNTHETIC_RUNTIME_SECRET_DO_NOT_PRINT';

/** Invalid SQLite bytes deliberately prove that check only inspects file metadata. */
export function instanceRuntimeFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'lm-runtime-fixture-')));
  const dataDir = join(root, 'data with spaces'), kgRoot = join(root, 'knowledge with spaces');
  const cliStateDir = join(dataDir, 'cli state'), staticDir = join(root, 'static assets');
  for (const path of [dataDir, kgRoot, cliStateDir, staticDir]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const write = (path: string, value: string) => writeFileSync(path, value, { mode: 0o600 });
  write(join(dataDir, 'accounts.sqlite'), 'SYNTHETIC_NOT_A_SQLITE_DATABASE');
  write(join(dataDir, 'living-memory.sqlite'), 'SYNTHETIC_NOT_A_SQLITE_DATABASE');
  write(join(dataDir, 'instance-identity.json'), JSON.stringify({ format: 'living-memory-instance-identity', version: 1, instanceId: RUNTIME_TEST_INSTANCE_ID }));
  write(join(dataDir, 'cli-session.json'), 'INVALID_JSON_' + RUNTIME_TEST_SECRET);
  write(join(staticDir, 'index.html'), '<!doctype html><title>Synthetic runtime assets</title>');
  write(join(kgRoot, 'Root.md'), '# Synthetic runtime knowledge\n');
  const fingerprint = createHash('sha256').update(realpathSync(kgRoot)).digest('hex');
  const profile: InstanceRuntimeProfile = { format: 'living-memory-instance-runtime', version: 1,
    dataDir, kgRoot, cliStateDir, staticDir, port: 43219, expectedInstanceId: RUNTIME_TEST_INSTANCE_ID,
    expectedSourceIdentityHash: fingerprint, expectedSourceRootFingerprint: fingerprint };
  const profilePath = join(root, 'runtime profile.json'), envPath = join(root, 'connector.env');
  const writeProfile = (value: unknown = profile) => write(profilePath, JSON.stringify(value));
  writeProfile();
  return { root, profile, profilePath, envPath, write, writeProfile,
    quarantine(blocked = true) { write(join(dataDir, 'restore-quarantine.json'), JSON.stringify({ format: 'living-memory-restore-quarantine', version: 1,
      restoredAt: '2026-10-21T00:00:00.000Z', connectorsBlocked: blocked })); },
    inventory() {
      const items: Array<{ path: string; mode: number; size: number; bytes?: string }> = [];
      const walk = (dir: string) => { for (const name of readdirSync(dir).sort()) {
        const path = join(dir, name), stat = lstatSync(path);
        items.push({ path: relative(root, path), mode: stat.mode, size: stat.size,
          ...(stat.isFile() ? { bytes: readFileSync(path).toString('base64') } : {}) });
        if (stat.isDirectory()) walk(path);
      } };
      walk(root); return items;
    },
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}
