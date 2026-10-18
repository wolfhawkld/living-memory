import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export class DataDirectoryLockError extends Error {
  constructor(readonly code: 'DATA_DIRECTORY_BUSY' | 'DATA_DIRECTORY_LOCK_UNKNOWN' | 'DATABASE_OPEN' | 'OFFLINE_CHECK_UNAVAILABLE') {
    super(`${code}: 请停止使用该数据目录的服务后再执行；不会自动终止进程。`); this.name = 'DataDirectoryLockError';
  }
}
/** Exclusive process lock shared by the server and offline migration tools. */
export function acquireDataDirectoryLock(dataDir: string): { release: () => void } {
  const root = resolve(dataDir); mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(root, 'runtime-lease.sqlite');
  try { const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink()) throw new DataDirectoryLockError('DATA_DIRECTORY_LOCK_UNKNOWN'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path); chmodSync(path, 0o600);
    db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
  } catch (error) {
    try { db?.close(); } catch { /* release failed initialization */ }
    if (/busy|locked/i.test(error instanceof Error ? error.message : '')) throw new DataDirectoryLockError('DATA_DIRECTORY_BUSY');
    throw new DataDirectoryLockError('DATA_DIRECTORY_LOCK_UNKNOWN');
  }
  let released = false;
  return { release() { if (released) return; released = true; try { db!.exec('ROLLBACK'); } finally { db!.close(); } } };
}

/** Linux/WSL legacy preflight: a port check cannot prove SQLite is offline. */
export function assertDatabaseFilesOffline(paths: readonly string[], options: { procRoot?: string; uid?: number } = {}): void {
  const identities = new Set<string>();
  for (const path of paths) {
    try { const stat = statSync(path); identities.add(`${stat.dev}:${stat.ino}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new DataDirectoryLockError('OFFLINE_CHECK_UNAVAILABLE'); }
  }
  if (!identities.size) return;
  const proc = options.procRoot ?? '/proc';
  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined) throw new DataDirectoryLockError('OFFLINE_CHECK_UNAVAILABLE');
  try {
    for (const name of readdirSync(proc).filter((name) => /^\d+$/.test(name))) {
      const directory = join(proc, name);
      let processUids: number[];
      try {
        // A nondumpable process may have a root-owned /proc directory while
        // still running as this user. Directory ownership is not its identity.
        const status = readFileSync(join(directory, 'status'), 'utf8');
        const fields = status.split('\n').filter((line) => line.startsWith('Uid:'));
        const match = fields.length === 1 && /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(fields[0]);
        if (!match) throw new DataDirectoryLockError('OFFLINE_CHECK_UNAVAILABLE');
        processUids = match.slice(1).map(Number);
        if (!processUids.every(Number.isSafeInteger)) throw new DataDirectoryLockError('OFFLINE_CHECK_UNAVAILABLE');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          try { statSync(directory); } catch (gone) { if ((gone as NodeJS.ErrnoException).code === 'ENOENT') continue; }
        }
        throw error;
      }
      if (!processUids.includes(uid)) continue;
      let descriptors: string[];
      try { descriptors = readdirSync(join(directory, 'fd')); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          try { statSync(directory); } catch (gone) { if ((gone as NodeJS.ErrnoException).code === 'ENOENT') continue; }
        }
        throw error;
      }
      for (const descriptor of descriptors) {
        try {
          const file = statSync(join(directory, 'fd', descriptor));
          if (identities.has(`${file.dev}:${file.ino}`)) throw new DataDirectoryLockError('DATABASE_OPEN');
        } catch (error) {
          if (error instanceof DataDirectoryLockError) throw error;
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
    }
  } catch (error) {
    if (error instanceof DataDirectoryLockError) throw error;
    throw new DataDirectoryLockError('OFFLINE_CHECK_UNAVAILABLE');
  }
}
