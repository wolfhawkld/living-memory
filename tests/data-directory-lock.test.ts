import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireDataDirectoryLock, assertDatabaseFilesOffline } from '../src/server/data-directory-lock.js';

test('one SQLite runtime lease excludes another holder and releases idempotently', () => {
  const data = mkdtempSync(join(tmpdir(), 'lm-lease-'));
  try {
    const first = acquireDataDirectoryLock(data);
    assert.throws(() => acquireDataDirectoryLock(data), { code: 'DATA_DIRECTORY_BUSY' });
    first.release(); first.release();
    const second = acquireDataDirectoryLock(data); second.release();
  } finally { rmSync(data, { recursive: true, force: true }); }
});

test('process exit releases an unclosed runtime lease without PID recovery or removing a live lock', () => {
  const data = mkdtempSync(join(tmpdir(), 'lm-lease-child-'));
  try {
    const module = pathToFileURL(resolve('src/server/data-directory-lock.ts')).href;
    execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval',
      `import { acquireDataDirectoryLock } from ${JSON.stringify(module)}; acquireDataDirectoryLock(${JSON.stringify(data)}); process.exit(0);`], { stdio: 'pipe' });
    const lock = acquireDataDirectoryLock(data); lock.release();
  } finally { rmSync(data, { recursive: true, force: true }); }
});

test('legacy preflight uses actual open file identities instead of a free TCP port', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lm-offline-proc-'));
  try {
    const db = join(dir, 'living-memory.sqlite'), proc = join(dir, 'proc');
    writeFileSync(db, 'synthetic'); mkdirSync(join(proc, '123', 'fd'), { recursive: true });
    const uid = process.getuid!();
    writeFileSync(join(proc, '123', 'status'), `Name:\tsynthetic\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`);
    assertDatabaseFilesOffline([db], { procRoot: proc });
    symlinkSync(db, join(proc, '123', 'fd', '7'));
    assert.throws(() => assertDatabaseFilesOffline([db], { procRoot: proc }), { code: 'DATABASE_OPEN' });
    assert.throws(() => assertDatabaseFilesOffline([db], { procRoot: join(dir, 'missing') }), { code: 'OFFLINE_CHECK_UNAVAILABLE' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('legacy preflight uses all status UIDs rather than /proc directory ownership and refuses unknown identities', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lm-offline-status-'));
  try {
    const db = join(dir, 'living-memory.sqlite'), proc = join(dir, 'proc'), pid = join(proc, '123');
    const owner = process.getuid!(), target = owner + 1;
    writeFileSync(db, 'synthetic'); mkdirSync(join(pid, 'fd'), { recursive: true });
    symlinkSync(db, join(pid, 'fd', '7'));
    // The synthetic directory belongs to owner; the saved UID alone matches
    // target. Checking stat(directory).uid would incorrectly skip this FD.
    writeFileSync(join(pid, 'status'), `Uid:\t${owner}\t${owner}\t${target}\t${owner}\n`);
    assert.throws(() => assertDatabaseFilesOffline([db], { procRoot: proc, uid: target }), { code: 'DATABASE_OPEN' });
    writeFileSync(join(pid, 'status'), `Uid:\t${owner}\t${owner}\t${owner}\t${owner}\n`);
    assertDatabaseFilesOffline([db], { procRoot: proc, uid: target });
    writeFileSync(join(pid, 'status'), 'Uid:\tunknown\n');
    assert.throws(() => assertDatabaseFilesOffline([db], { procRoot: proc, uid: target }), { code: 'OFFLINE_CHECK_UNAVAILABLE' });
    rmSync(join(pid, 'status'));
    assert.throws(() => assertDatabaseFilesOffline([db], { procRoot: proc, uid: target }), { code: 'OFFLINE_CHECK_UNAVAILABLE' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
