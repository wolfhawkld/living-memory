import { strict as assert } from 'node:assert';
import childProcess, { type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { test, type TestContext } from 'node:test';
import { createOfflineScanner } from '../src/server/offline-scan.js';

function fixture(t: TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), 'lm-offline-scanner-'));
  writeFileSync(join(dataDir, 'living-memory.sqlite'), 'synthetic only');
  const paths = ['living-memory.sqlite', 'accounts.sqlite'].flatMap((name) => ['', '-wal', '-shm', '-journal'].map((suffix) => join(dataDir, name + suffix)));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  return { dataDir, paths };
}
function transport(t: TestContext, respond: (message: Record<string, unknown>, reply: (value: unknown) => void) => void = (message, reply) => reply({ version: 1, nonce: message.nonce, sequence: message.sequence, code: 'OK' })) {
  const child = new EventEmitter() as ChildProcess;
  const stdout = new PassThrough();
  const messages: Record<string, unknown>[] = [];
  let ended = false;
  const exit = () => { if (!ended) { ended = true; if (stdout.readableEnded) child.emit('close', 0, null); else { stdout.once('end', () => child.emit('close', 0, null)); stdout.end(); } } };
  const stdin = new Writable({
    write(chunk, _encoding, done) {
      const message = JSON.parse(String(chunk)); messages.push(message);
      queueMicrotask(() => respond(message, (value) => stdout.write(typeof value === 'string' ? value : JSON.stringify(value) + '\n')));
      done();
    },
    final(done) { queueMicrotask(exit); done(); },
  });
  Object.assign(child, { stdin, stdout, kill: () => { exit(); return true; } });
  const calls: unknown[][] = [];
  t.mock.method(childProcess, 'spawn', (...args: unknown[]) => { calls.push(args); return child; });
  return { child, stdout, messages, calls };
}

test('native default validates the fixed file set and fails closed on missing proc status', async (t) => {
  const { dataDir, paths } = fixture(t);
  const proc = join(dataDir, 'proc'); mkdirSync(proc);
  const scanner = await createOfflineScanner({ dataDir, procRoot: proc });
  await scanner.scan(paths);
  await assert.rejects(scanner.scan([join(dataDir, 'unrelated')]), { code: 'OFFLINE_SCAN_UNAVAILABLE' });
  mkdirSync(join(proc, '123', 'fd'), { recursive: true });
  await assert.rejects(scanner.scan(paths), { code: 'OFFLINE_CHECK_UNAVAILABLE' });
  await scanner.close(); await scanner.close();
  await assert.rejects(scanner.scan(paths), { code: 'OFFLINE_SCAN_UNAVAILABLE' });
});

test('sudo uses fixed executable, isolated interpreter, no shell/password/environment and path-free bigint identities', async (t) => {
  const { dataDir, paths } = fixture(t), fake = transport(t);
  const scanner = await createOfflineScanner({ mode: 'sudo', dataDir });
  await scanner.scan(paths); await scanner.scan(paths); await scanner.close(); await scanner.close();
  assert.equal(fake.calls.length, 1);
  const [command, args, options] = fake.calls[0] as [string, string[], { shell: boolean; env: Record<string, string>; stdio: unknown[] }];
  assert.equal(command, '/usr/bin/sudo');
  assert.deepEqual(args, [...(process.stdin.isTTY && process.stderr.isTTY ? [] : ['-n']), '--', '/usr/bin/python3', '-I', '-S', '-B', '-u', resolve('scripts/offline-scan-helper.py')]);
  assert.equal(options.shell, false);
  assert.deepEqual(Object.keys(options.env).sort(), process.env.TERM ? ['PATH', 'TERM'] : ['PATH']);
  assert.equal(options.stdio[2], process.stdin.isTTY && process.stderr.isTTY ? 'inherit' : 'ignore');
  assert.deepEqual(fake.messages.map((message) => message.type), ['init', 'scan', 'scan', 'close']);
  assert.deepEqual(fake.messages.map((message) => message.sequence), [0, 1, 2, 3]);
  const stat = statSync(paths[0], { bigint: true });
  assert.deepEqual(fake.messages[1].identities, [{ dev: String(stat.dev), ino: String(stat.ino) }]);
  assert.equal(JSON.stringify(fake.messages).includes(dataDir), false);
  assert.match(fake.messages[0].nonce as string, /^[a-f0-9]{64}$/);
});

test('sudo rejects proc overrides and arbitrary or incomplete paths before requesting a scan', async (t) => {
  const { dataDir, paths } = fixture(t), fake = transport(t);
  await assert.rejects(createOfflineScanner({ mode: 'sudo', dataDir, procRoot: '/tmp/synthetic' }), { code: 'OFFLINE_SCAN_UNAVAILABLE' });
  assert.equal(fake.calls.length, 0);
  const scanner = await createOfflineScanner({ mode: 'sudo', dataDir });
  await assert.rejects(scanner.scan(paths.slice(1)), { code: 'OFFLINE_SCAN_UNAVAILABLE' });
  await scanner.close(); assert.equal(fake.messages.some((m) => m.type === 'scan'), false);
});

for (const kind of ['nonce', 'sequence', 'oversized', 'malformed', 'extra'] as const) {
  test(`sudo fails closed on ${kind} output and reaps helper`, async (t) => {
    const { dataDir } = fixture(t);
    const fake = transport(t, (message, reply) => {
      const good = { version: 1, nonce: message.nonce, sequence: message.sequence, code: 'OK' };
      if (kind === 'nonce') reply({ ...good, nonce: 'b'.repeat(64) });
      if (kind === 'sequence') reply({ ...good, sequence: 2 });
      if (kind === 'oversized') reply('x'.repeat(8193));
      if (kind === 'malformed') reply('not-json\n');
      if (kind === 'extra') reply({ ...good, private: '/private/secret' });
    });
    await assert.rejects(createOfflineScanner({ mode: 'sudo', dataDir }), { code: 'OFFLINE_SCAN_UNAVAILABLE' });
    assert.equal(fake.child.stdin!.writableEnded, true);
  });
}

test('sudo reports fixed auth failure on early exit and fixed busy error on matching descriptor', async (t) => {
  const { dataDir, paths } = fixture(t);
  const fake = transport(t, (message, reply) => {
    if (message.type === 'init') reply({ version: 1, nonce: message.nonce, sequence: 0, code: 'OK' });
    else reply({ version: 1, nonce: message.nonce, sequence: message.sequence, code: 'DATABASE_OPEN' });
  });
  const scanner = await createOfflineScanner({ mode: 'sudo', dataDir });
  await assert.rejects(scanner.scan(paths), { code: 'DATABASE_OPEN' });
  await assert.rejects(scanner.close(), { code: 'DATABASE_OPEN' });
  fake.child.emit('close', 1, null);
});

test('sudo timeout and unexpected EOF fail closed without a second privilege attempt', async (t) => {
  const { dataDir } = fixture(t), fake = transport(t, () => {});
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const opening = createOfflineScanner({ mode: 'sudo', dataDir });
  t.mock.timers.tick(15_001);
  await assert.rejects(opening, { code: 'OFFLINE_SCAN_AUTH_REQUIRED' });
  assert.equal(fake.calls.length, 1);
});

test('sudo unexpected exit fails handshake with a redacted authentication error', async (t) => {
  const { dataDir } = fixture(t), fake = transport(t, () => {});
  const opening = createOfflineScanner({ mode: 'sudo', dataDir });
  fake.child.emit('close', 1, null);
  await assert.rejects(opening, { code: 'OFFLINE_SCAN_AUTH_REQUIRED' });
});

for (const failure of ['nonce', 'timeout', 'exit-one', 'signal'] as const) {
  test(`sudo close rejects ${failure} while still reaping the helper`, async (t) => {
    const { dataDir } = fixture(t);
    let fake: ReturnType<typeof transport>;
    fake = transport(t, (message, reply) => {
      if (message.type !== 'close') { reply({ version: 1, nonce: message.nonce, sequence: message.sequence, code: 'OK' }); return; }
      if (failure === 'timeout') return;
      reply({ version: 1, nonce: failure === 'nonce' ? 'b'.repeat(64) : message.nonce, sequence: message.sequence, code: 'OK' });
      if (failure === 'exit-one') fake.child.emit('close', 1, null);
      if (failure === 'signal') fake.child.emit('close', null, 'SIGTERM');
    });
    const scanner = await createOfflineScanner({ mode: 'sudo', dataDir });
    if (failure === 'timeout') t.mock.timers.enable({ apis: ['setTimeout'] });
    const closing = scanner.close();
    const rejection = assert.rejects(closing, { code: 'OFFLINE_SCAN_UNAVAILABLE' });
    if (failure === 'timeout') t.mock.timers.tick(1_001);
    await rejection;
    await assert.rejects(scanner.close(), { code: 'OFFLINE_SCAN_UNAVAILABLE' });
    assert.equal(fake.child.stdin!.writableEnded, true);
  });
}

test('sudo session expiry is latched, reaped and never reconnects', async (t) => {
  const { dataDir, paths } = fixture(t), fake = transport(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const scanner = await createOfflineScanner({ mode: 'sudo', dataDir });
  t.mock.timers.tick(30 * 60_000 + 1);
  await assert.rejects(scanner.scan(paths), { code: 'OFFLINE_SCAN_UNAVAILABLE' });
  await assert.rejects(scanner.close(), { code: 'OFFLINE_SCAN_UNAVAILABLE' });
  assert.equal(fake.calls.length, 1);
});


test('sudo EOF after handshake latches failure and close cannot authorize publish', async (t) => {
  const { dataDir, paths } = fixture(t), fake = transport(t);
  const scanner = await createOfflineScanner({ mode: 'sudo', dataDir });
  fake.stdout.end();
  await new Promise<void>((done) => setImmediate(done));
  await assert.rejects(scanner.scan(paths), { code: 'OFFLINE_SCAN_UNAVAILABLE' });
  await assert.rejects(scanner.close(), { code: 'OFFLINE_SCAN_UNAVAILABLE' });
  assert.equal(fake.calls.length, 1);
});

for (const extra of ['complete-line', 'truncated-tail'] as const) {
  test(`sudo close refuses ${extra} after a valid ACK`, async (t) => {
    const { dataDir } = fixture(t);
    transport(t, (message, reply) => {
      reply({ version: 1, nonce: message.nonce, sequence: message.sequence, code: 'OK' });
      if (message.type === 'close') reply(extra === 'complete-line' ? '{"unexpected":true}\n' : '{"truncated":');
    });
    const scanner = await createOfflineScanner({ mode: 'sudo', dataDir });
    await assert.rejects(scanner.close(), { code: 'OFFLINE_SCAN_UNAVAILABLE' });
  });
}
