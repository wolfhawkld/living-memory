import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Accounts } from '../src/server/accounts.js';
import { StoreError } from '../src/server/store.js';

const OWNER_PASSWORD = 'correct-horse-battery-staple';
const MEMBER_PASSWORD = 'member-password-123';
const NEW_MEMBER_PASSWORD = 'new-member-password-456';

interface Fixture {
  dataDir: string;
  now: () => Date;
  setNow(value: string): void;
  cleanup(): void;
}

function fixture(prefix = 'living-memory-accounts-'): Fixture {
  const dataDir = mkdtempSync(join(tmpdir(), prefix));
  let current = '2026-09-22T09:00:00.000Z';
  return {
    dataDir,
    now: () => new Date(current),
    setNow(value: string) { current = value; },
    cleanup() { rmSync(dataDir, { recursive: true, force: true }); },
  };
}

function isStoreError(code: string, status?: number) {
  return (error: unknown): boolean => error instanceof StoreError
    && error.code === code
    && (status === undefined || error.status === status);
}

test('setup persists a redacted owner and keeps password material private across restart', async () => {
  const context = fixture();
  const accounts = new Accounts({ dataDir: context.dataDir, now: context.now });
  try {
    const owner = await accounts.setup('  Owner.Name  ', OWNER_PASSWORD);
    assert.equal(owner.username, 'owner.name');
    assert.equal(owner.role, 'admin');
    assert.equal(owner.enabled, true);
    assert.equal(owner.accessRevision, 1);
    assert.equal(accounts.hasAccounts(), true);
    assert.equal(accounts.ownerId(), owner.id);
    assert.deepEqual(accounts.listUsers(), [owner]);
    assert.equal(Object.hasOwn(owner, 'password'), false);
    assert.equal(Object.hasOwn(owner, 'passwordHash'), false);

    const database = new DatabaseSync(accounts.dbPath);
    const row = database.prepare('SELECT password_hash FROM accounts WHERE id = ?').get(owner.id) as { password_hash: string };
    database.close();
    assert.notEqual(row.password_hash, OWNER_PASSWORD);
    assert.match(row.password_hash, /^\$lm-scrypt\$v=1\$N=131072,r=8,p=1\$/);
    assert.equal(readFileSync(accounts.dbPath).includes(Buffer.from(OWNER_PASSWORD)), false);
    assert.equal(statSync(context.dataDir).mode & 0o777, 0o700);
    assert.equal(statSync(accounts.dbPath).mode & 0o777, 0o600);

    accounts.close();
    chmodSync(context.dataDir, 0o755);
    const reopened = new Accounts({ dataDir: context.dataDir, now: context.now });
    try {
      assert.equal(reopened.ownerId(), owner.id);
      assert.deepEqual(reopened.listUsers(), [owner]);
      assert.equal(statSync(context.dataDir).mode & 0o777, 0o700);
      assert.equal(statSync(reopened.dbPath).mode & 0o777, 0o600);
    } finally {
      reopened.close();
    }
  } finally {
    try { accounts.close(); } catch { /* already closed after restart check */ }
    context.cleanup();
  }
});

test('login issues browser and device sessions, rotates devices, logs out, and expires absolute sessions', async () => {
  const context = fixture();
  const accounts = new Accounts({ dataDir: context.dataDir, now: context.now });
  try {
    const owner = await accounts.setup('owner', OWNER_PASSWORD);
    const browser = await accounts.login('OWNER', OWNER_PASSWORD, '127.0.0.1');
    assert.equal(browser.user.id, owner.id);
    assert.equal(browser.user.username, 'owner');
    assert.equal(accounts.authenticate(browser.token)?.sessionId, browser.sessionId);
    assert.equal(accounts.authenticate(browser.token)?.csrfToken, browser.csrfToken);
    assert.equal(Date.parse(browser.expiresAt), Date.parse('2026-09-22T21:00:00.000Z'));

    const deviceOne = accounts.issueSession(owner.id, 'device');
    const deviceTwo = accounts.issueSession(owner.id, 'device');
    assert.equal(accounts.authenticate(deviceOne.token), null);
    assert.equal(accounts.authenticate(deviceTwo.token)?.sessionId, deviceTwo.sessionId);
    assert.equal(accounts.authenticate(browser.token)?.sessionId, browser.sessionId);

    accounts.logout(browser.token);
    assert.equal(accounts.authenticate(browser.token), null);

    const shortLived = await accounts.login('owner', OWNER_PASSWORD, '127.0.0.2');
    context.setNow('2026-09-22T21:00:00.001Z');
    assert.equal(accounts.authenticate(shortLived.token), null);
    assert.equal(accounts.authenticate(deviceTwo.token)?.sessionId, deviceTwo.sessionId);
    context.setNow('2026-10-22T09:00:00.001Z');
    assert.equal(accounts.authenticate(deviceTwo.token), null);
  } finally {
    accounts.close();
    context.cleanup();
  }
});

test('unknown, wrong, and disabled credentials share one invalid-credentials result; failures throttle by rate key', async () => {
  const context = fixture();
  const accounts = new Accounts({ dataDir: context.dataDir, now: context.now });
  try {
    const owner = await accounts.setup('owner', OWNER_PASSWORD);
    await assert.rejects(() => accounts.login('missing', OWNER_PASSWORD, 'rate-a'), isStoreError('INVALID_CREDENTIALS', 401));
    await assert.rejects(() => accounts.login(owner.username, 'wrong-password-123', 'rate-b'), isStoreError('INVALID_CREDENTIALS', 401));

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await assert.rejects(() => accounts.login('owner', 'wrong-password-123', 'rate-throttle'), isStoreError('INVALID_CREDENTIALS', 401));
    }
    await assert.rejects(() => accounts.login('owner', 'wrong-password-123', 'rate-throttle'), isStoreError('INVALID_CREDENTIALS', 401));
    await assert.rejects(() => accounts.login('owner', OWNER_PASSWORD, 'rate-throttle'), isStoreError('RATE_LIMITED', 429));
    assert.equal((await accounts.login('owner', OWNER_PASSWORD, 'rate-other')).user.id, owner.id);

    const member = await accounts.createUser('member', MEMBER_PASSWORD);
    await accounts.updateUser(member.id, { enabled: false });
    await assert.rejects(() => accounts.login('member', MEMBER_PASSWORD, 'rate-disabled'), isStoreError('INVALID_CREDENTIALS', 401));
    assert.throws(() => accounts.issueSession(member.id), isStoreError('ACCOUNT_DISABLED', 403));
  } finally {
    accounts.close();
    context.cleanup();
  }
});

test('password and enabled changes advance accessRevision and revoke sessions; first owner cannot be disabled', async () => {
  const context = fixture();
  const accounts = new Accounts({ dataDir: context.dataDir, now: context.now });
  try {
    const owner = await accounts.setup('owner', OWNER_PASSWORD);
    const member = await accounts.createUser('member', MEMBER_PASSWORD);
    const memberSession = accounts.issueSession(member.id);
    const changedPassword = await accounts.updateUser(member.id, { password: NEW_MEMBER_PASSWORD });
    assert.equal(changedPassword.accessRevision, 2);
    assert.equal(accounts.authenticate(memberSession.token), null);
    assert.equal((await accounts.login('member', NEW_MEMBER_PASSWORD, 'password-change')).user.id, member.id);

    const disabled = await accounts.updateUser(member.id, { enabled: false });
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.accessRevision, 3);
    await assert.rejects(() => accounts.updateUser(owner.id, { enabled: false }), isStoreError('OWNER_PROTECTED', 409));
    assert.equal(accounts.listUsers().find((user) => user.id === owner.id)?.enabled, true);

    const reenabled = await accounts.updateUser(member.id, { enabled: true });
    assert.equal(reenabled.enabled, true);
    assert.equal(reenabled.accessRevision, 4);
  } finally {
    accounts.close();
    context.cleanup();
  }
});

test('login rejects a member disabled while asynchronous password verification is in flight', async () => {
  const context = fixture('living-memory-accounts-login-race-');
  const accounts = new Accounts({ dataDir: context.dataDir, now: context.now });
  try {
    await accounts.setup('owner', OWNER_PASSWORD);
    const member = await accounts.createUser('member', MEMBER_PASSWORD);
    const login = accounts.login('member', MEMBER_PASSWORD, 'race-disable');
    // login has already scheduled scrypt before returning its promise. Commit
    // the disable synchronously through the no-password update path before
    // the worker callback can resume login.
    await accounts.updateUser(member.id, { enabled: false });
    await assert.rejects(() => login, isStoreError('INVALID_CREDENTIALS', 401));
    assert.equal(accounts.listUsers().find((user) => user.id === member.id)?.enabled, false);
  } finally {
    accounts.close();
    context.cleanup();
  }
});

test('setup is first-owner only even when two account stores race', async () => {
  const context = fixture('living-memory-accounts-race-');
  const first = new Accounts({ dataDir: context.dataDir, now: context.now });
  const second = new Accounts({ dataDir: context.dataDir, now: context.now });
  try {
    const results = await Promise.allSettled([
      first.setup('first-owner', OWNER_PASSWORD),
      second.setup('second-owner', OWNER_PASSWORD),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    assert.ok(rejected);
    assert.equal((rejected.reason as StoreError).code, 'SETUP_COMPLETE');
    assert.equal(first.listUsers().length, 1);
    assert.equal(second.listUsers().length, 1);
  } finally {
    first.close();
    second.close();
    context.cleanup();
  }
});
