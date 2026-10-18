import childProcess, { type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertDatabaseFilesOffline, DataDirectoryLockError } from './data-directory-lock.js';

export type OfflineScanMode = 'native' | 'sudo';
export interface OfflineScanner { scan(paths: readonly string[]): Promise<void>; close(): Promise<void> }
export class OfflineScanError extends Error {
  constructor(readonly code: 'OFFLINE_SCAN_AUTH_REQUIRED' | 'OFFLINE_SCAN_UNAVAILABLE') {
    super(code); this.name = 'OfflineScanError';
  }
}
const HELPER = fileURLToPath(new URL('../../scripts/offline-scan-helper.py', import.meta.url));
const LIMIT = 8192;
const SESSION_MS = 30 * 60_000;
const unavailable = () => new OfflineScanError('OFFLINE_SCAN_UNAVAILABLE');
const authRequired = () => new OfflineScanError('OFFLINE_SCAN_AUTH_REQUIRED');

/** One live helper per lease. Caller must await close() before releasing its lease. */
export async function createOfflineScanner(options: { mode?: OfflineScanMode; dataDir: string; procRoot?: string }): Promise<OfflineScanner> {
  const mode = options.mode ?? 'native';
  const uid = process.getuid?.();
  let directory: string;
  try {
    directory = realpathSync(options.dataDir);
    if (uid === undefined || !statSync(directory).isDirectory() || statSync(directory).uid !== uid) throw unavailable();
    if (!['native', 'sudo'].includes(mode) || (mode === 'sudo' && options.procRoot !== undefined)) throw unavailable();
  } catch { throw unavailable(); }
  const fixed = ['living-memory.sqlite', 'accounts.sqlite'].flatMap((name) => ['', '-wal', '-shm', '-journal'].map((suffix) => join(directory, name + suffix)));
  function identities(paths: readonly string[]) {
    if (paths.length !== fixed.length || new Set(paths.map((path) => resolve(path))).size !== fixed.length || paths.some((path) => !fixed.includes(resolve(path)))) throw unavailable();
    const found = new Map<string, { dev: string; ino: string }>();
    for (const path of fixed) {
      try {
        const item = lstatSync(path, { bigint: true });
        if (!item.isFile() || item.isSymbolicLink() || item.uid !== BigInt(uid!)) throw unavailable();
        found.set(`${item.dev}:${item.ino}`, { dev: String(item.dev), ino: String(item.ino) });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || path === fixed[0]) throw unavailable();
      }
    }
    return [...found.values()];
  }
  let closed = false;
  if (mode === 'native') return {
    async scan(paths) { if (closed) throw unavailable(); identities(paths); assertDatabaseFilesOffline(fixed, { procRoot: options.procRoot }); },
    async close() { closed = true; },
  };
  if (process.platform !== 'linux' || uid === 0 || process.geteuid?.() !== uid) throw unavailable();
  let parentStart: string;
  try {
    const stat = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
    parentStart = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/)[19];
    if (!/^\d+$/.test(parentStart)) throw unavailable();
    const helper = lstatSync(HELPER);
    if (!helper.isFile() || helper.isSymbolicLink()) throw unavailable();
  } catch { throw unavailable(); }
  const nonce = randomBytes(32).toString('hex');
  const interactive = Boolean(process.stdin.isTTY && process.stderr.isTTY);
  let child: ChildProcess;
  try {
    child = childProcess.spawn('/usr/bin/sudo', [...(interactive ? [] : ['-n']), '--', '/usr/bin/python3', '-I', '-S', '-B', '-u', HELPER], {
      shell: false, stdio: ['pipe', 'pipe', interactive ? 'inherit' : 'ignore'],
      // Python isolated mode ignores interpreter environment. No app credentials are passed.
      env: { PATH: '/usr/bin:/bin', ...(process.env.TERM ? { TERM: process.env.TERM } : {}) },
    });
  } catch { throw unavailable(); }
  let sequence = 0, buffer = '', failed: Error | null = null, exited = false, operation = false, cleanExit = false, stdoutEnded = false;
  let pending: { sequence: number; resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> } | null = null;
  let closePromise: Promise<void> | undefined;
  let finishExit!: () => void;
  const exit = new Promise<void>((done) => { finishExit = done; });
  function fail(error: Error) {
    failed ??= error;
    if (pending) { clearTimeout(pending.timer); const request = pending; pending = null; request.reject(error); }
  }
  child.on('error', () => { fail(unavailable()); });
  child.on('close', (code, signal) => { exited = true; cleanExit = code === 0 && signal === null; finishExit(); if (!closed) fail(sequence === 0 ? authRequired() : unavailable()); });
  child.stdin!.on('error', () => fail(sequence === 0 ? authRequired() : unavailable()));
  child.stdout!.on('end', () => { stdoutEnded = true; if (!closed || pending) fail(sequence === 0 ? authRequired() : unavailable()); });
  child.stdout!.on('error', () => fail(unavailable()));
  child.stdout!.on('data', (data: Buffer) => {
    if (failed) return;
    buffer += data.toString('utf8');
    if (Buffer.byteLength(buffer) > LIMIT) { fail(unavailable()); return; }
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n'), line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      let response: Record<string, unknown>;
      try { response = JSON.parse(line); } catch { fail(unavailable()); return; }
      if (!pending || !response || Object.keys(response).sort().join(',') !== 'code,nonce,sequence,version' || response.version !== 1 || response.nonce !== nonce || response.sequence !== pending.sequence) { fail(unavailable()); return; }
      const request = pending; pending = null; clearTimeout(request.timer);
      if (response.code === 'OK') request.resolve();
      else {
        const error = response.code === 'DATABASE_OPEN' ? new DataDirectoryLockError('DATABASE_OPEN') : response.code === 'AUTH_REQUIRED' ? authRequired() : unavailable();
        failed = error; request.reject(error);
      }
    }
  });
  const lifetime = setTimeout(() => { fail(unavailable()); void close().catch(() => { /* failure stays latched; caller must still await close */ }); }, SESSION_MS);
  lifetime.unref();
  async function request(type: 'init' | 'scan' | 'close', payload: Record<string, unknown> = {}) {
    if (failed || exited || pending) throw failed ?? unavailable();
    const current = sequence;
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(() => fail(type === 'init' ? authRequired() : unavailable()), type === 'init' ? 15_000 : type === 'close' ? 1_000 : 30_000);
      pending = { sequence: current, resolve: done, reject, timer };
      child.stdin!.write(JSON.stringify({ type, nonce, sequence: current, ...(type === 'init' ? { version: 1 } : {}), ...payload }) + '\n', (error) => { if (error) fail(unavailable()); });
    });
    sequence++;
  }
  function close(): Promise<void> {
    return closePromise ??= shutdown();
  }
  async function shutdown() {
    if (closed) return;
    closed = true;
    clearTimeout(lifetime);
    const previousFailure = failed;
    let closeFailure: unknown;
    if (pending) fail(unavailable());
    try { if (!failed && !exited && !pending) await request('close'); else if (!previousFailure) closeFailure = unavailable(); }
    catch (error) { closeFailure = error; }
    child.stdin?.end();
    if (!exited) {
      const term = setTimeout(() => child.kill('SIGTERM'), 250);
      const kill = setTimeout(() => child.kill('SIGKILL'), 1_000);
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([exit, new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(unavailable()), 3_000); })]); }
      finally { clearTimeout(term); clearTimeout(kill); clearTimeout(deadline); }
    }
    if (!exited || !cleanExit || !stdoutEnded || buffer.length > 0 || closeFailure) throw unavailable();
    if (failed || previousFailure) throw failed ?? previousFailure;
  }
  try { await request('init', { uid: String(uid), parentPid: String(process.pid), parentStart }); }
  catch (error) { try { await close(); } catch { /* retain original initialization failure */ } throw error; }
  return {
    async scan(paths) {
      if (closed || operation) throw unavailable();
      operation = true;
      try { await request('scan', { identities: identities(paths) }); }
      finally { operation = false; }
    },
    close,
  };
}
