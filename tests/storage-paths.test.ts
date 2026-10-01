import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateStoragePaths } from '../src/server/storage-paths.js';

test('storage boundaries reject overlapping roots, symlink aliases, public private-data paths and auth downgrade', () => {
  const temp = mkdtempSync(join(tmpdir(), 'lm-paths-'));
  const options = { root: join(temp, 'vault'), dataDir: join(temp, 'data'), staticDir: join(temp, 'dist'), accountsEnabled: true };
  try {
    mkdirSync(options.root); mkdirSync(options.dataDir); mkdirSync(options.staticDir);
    assert.doesNotThrow(() => validateStoragePaths(options));
    assert.throws(() => validateStoragePaths({ ...options, root: temp }), /不能包含彼此/);
    assert.throws(() => validateStoragePaths({ ...options, root: join(options.dataDir, 'users', 'member', 'knowledge') }), /不能包含彼此/);
    assert.throws(() => validateStoragePaths({ ...options, staticDir: options.dataDir }), /静态目录/);
    assert.throws(() => validateStoragePaths({ ...options, staticDir: options.root }), /静态目录/);
    assert.throws(() => validateStoragePaths({ ...options, dbPath: join(options.staticDir, 'private.sqlite') }), /静态目录/);
    symlinkSync(options.dataDir, join(temp, 'alias'), 'dir');
    assert.throws(() => validateStoragePaths({ ...options, root: join(temp, 'alias', 'future-knowledge') }), /不能包含彼此/);
    assert.throws(() => validateStoragePaths({ ...options, staticDir: join(temp, 'alias') }), /静态目录/);
    writeFileSync(join(options.dataDir, 'accounts.sqlite'), 'fixture');
    assert.throws(() => validateStoragePaths({ ...options, accountsEnabled: false }), /已有账号库/);
    assert.doesNotThrow(() => validateStoragePaths(options));
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
