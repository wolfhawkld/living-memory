import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Accounts } from '../src/server/accounts.js';
import { StoreError } from '../src/server/store.js';
import type { FeishuDeliveryResult, FeishuReadAuthorization } from '../src/shared/feishu-reading.js';

const actor = { appId: 'app_synthetic', tenantKey: 'tenant_synthetic', openId: 'open_synthetic' };
const operation = '0123456789abcdef0123456789abcdef';
const nextOperation = 'abcdef0123456789abcdef0123456789';
const password = 'synthetic-password-for-read-tests';
async function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'lm-feishu-read-accounts-'));
  const options = { dataDir, now: () => new Date('2026-10-02T00:00:00.000Z') };
  const accounts = new Accounts(options);
  const user = await accounts.setup('owner', password);
  const session = accounts.issueSession(user.id);
  function bind() {
    const issued = accounts.issueFeishuBindingRequest(user.id, session.sessionId, actor);
    assert.equal(accounts.confirmFeishuBinding({ ...actor, code: issued.command.slice('确认绑定 '.length), eventId: 'event', messageId: 'message', chatId: 'chat' }).status, 'confirmed');
    return { userId: user.id, accessRevision: accounts.listUsers()[0]!.accessRevision, bindingId: accounts.getFeishuBindingState(user.id).binding!.id };
  }
  const authorization = bind();
  return { accounts, user, session, authorization, options, bind, cleanup() { try { accounts.close(); } catch { /* reopened fixture */ } rmSync(dataDir, { recursive: true, force: true }); } };
}
function isError(code: string) { return (error: unknown) => error instanceof StoreError && error.code === code; }
function receipts(accounts: Accounts) {
  const database = new DatabaseSync(accounts.dbPath);
  try { return database.prepare('SELECT * FROM feishu_read_receipts ORDER BY operation_id').all(); }
  finally { database.close(); }
}

test('read receipts persist metadata only, finalize once, and leave learning files unchanged', async () => {
  const f = await fixture();
  const learningPath = join(f.options.dataDir, 'synthetic-learning.json');
  const learning = '{"events":[],"memoryAnchor":"unchanged"}';
  writeFileSync(learningPath, learning);
  try {
    assert.equal(f.accounts.claimFeishuRead(operation, actor, f.authorization), true);
    assert.equal(f.accounts.claimFeishuRead(operation, actor, f.authorization), false);
    assert.deepEqual(receipts(f.accounts), [{ operation_id: operation, user_id: f.user.id, created_at: '2026-10-02T00:00:00.000Z', status: 'attempted' }].map(row => Object.assign(Object.create(null), row)));
    f.accounts.finishFeishuRead(operation, f.user.id, 'platform-accepted');
    f.accounts.finishFeishuRead(operation, f.user.id, 'failed-or-unknown');
    assert.equal(receipts(f.accounts)[0]!.status, 'platform-accepted');
    assert.equal(f.accounts.claimFeishuRead(operation, actor, f.authorization), false);
    assert.equal(f.accounts.claimFeishuRead(nextOperation, actor, f.authorization), true);
    f.accounts.finishFeishuRead(nextOperation, f.user.id, 'failed-or-unknown');
    assert.equal(f.accounts.claimFeishuRead(nextOperation, actor, f.authorization), false);
    assert.equal(readFileSync(learningPath, 'utf8'), learning);
    assert.deepEqual(readdirSync(f.options.dataDir).sort(), ['accounts.sqlite', 'synthetic-learning.json']);
    const db = new DatabaseSync(f.accounts.dbPath);
    try {
      assert.deepEqual(db.prepare('PRAGMA table_info(feishu_read_receipts)').all().map(row => row.name), ['operation_id', 'user_id', 'created_at', 'status']);
    } finally { db.close(); }
  } finally { f.cleanup(); }
});

test('receipt migration preserves prior bindings and deduplication survives reopening', async () => {
  const f = await fixture();
  f.accounts.close();
  const db = new DatabaseSync(join(f.options.dataDir, 'accounts.sqlite'));
  db.exec('DROP TABLE feishu_read_receipts');
  db.close();
  let reopened = new Accounts(f.options);
  try {
    assert.equal(reopened.resolveFeishuAccount(actor)?.id, f.user.id);
    assert.equal(reopened.claimFeishuRead(operation, actor, f.authorization), true);
    reopened.close();
    reopened = new Accounts(f.options);
    assert.equal(reopened.claimFeishuRead(operation, actor, f.authorization), false);
    reopened.finishFeishuRead(operation, f.user.id, 'failed-or-unknown');
    reopened.close();
    reopened = new Accounts(f.options);
    assert.equal(reopened.claimFeishuRead(operation, actor, f.authorization), false);
    assert.equal(receipts(reopened)[0]!.status, 'failed-or-unknown');
  } finally { reopened.close(); f.cleanup(); }
});

test('two account stores atomically compete for one operation receipt', async () => {
  const f = await fixture();
  const second = new Accounts(f.options);
  try {
    const results = await Promise.all([
      Promise.resolve().then(() => f.accounts.claimFeishuRead(operation, actor, f.authorization)),
      Promise.resolve().then(() => second.claimFeishuRead(operation, actor, f.authorization)),
    ]);
    assert.deepEqual(results.sort(), [false, true]);
    assert.equal(receipts(second).length, 1);
    second.finishFeishuRead(operation, f.user.id, 'platform-accepted');
    assert.equal(f.accounts.claimFeishuRead(operation, actor, f.authorization), false);
  } finally { second.close(); f.cleanup(); }
});

test('wrong scopes, identities, users and malformed runtime inputs do not claim or finish another operation', async () => {
  const f = await fixture();
  try {
    for (const wrongActor of [{ ...actor, appId: 'other' }, { ...actor, tenantKey: 'other' }, { ...actor, openId: 'other' }]) {
      assert.equal(f.accounts.claimFeishuRead(operation, wrongActor, f.authorization), false);
    }
    for (const auth of [{ ...f.authorization, userId: 'missing' }, { ...f.authorization, bindingId: 'missing' }, { ...f.authorization, accessRevision: 999 }]) {
      assert.equal(f.accounts.claimFeishuRead(operation, actor, auth), false);
    }
    assert.equal(f.accounts.claimFeishuRead(operation, actor, undefined as unknown as FeishuReadAuthorization), false);
    for (const invalid of ['', operation.toUpperCase(), 'x'.repeat(32), undefined, { toString: () => operation }]) {
      assert.throws(() => f.accounts.claimFeishuRead(invalid as string, actor, f.authorization), isError('INVALID_FEISHU_OPERATION'));
      assert.throws(() => f.accounts.finishFeishuRead(invalid as string, f.user.id, 'platform-accepted'), isError('INVALID_FEISHU_OPERATION'));
    }
    assert.equal(f.accounts.claimFeishuRead(operation, actor, f.authorization), true);
    f.accounts.finishFeishuRead(operation, 'other-user', 'platform-accepted');
    f.accounts.finishFeishuRead(nextOperation, f.user.id, 'platform-accepted');
    for (const result of ['attempted', 'success', null, undefined, {}]) {
      assert.throws(() => f.accounts.finishFeishuRead(operation, f.user.id, result as FeishuDeliveryResult), isError('INVALID_FEISHU_DELIVERY_RESULT'));
    }
    assert.equal(receipts(f.accounts)[0]!.status, 'attempted');
  } finally { f.cleanup(); }
});

test('revocation and rebind reject stale authorization generations, including password reset and disabled accounts', async () => {
  const f = await fixture();
  try {
    f.accounts.revokeFeishuBinding(f.user.id, f.session.sessionId, f.authorization.bindingId);
    assert.equal(f.accounts.claimFeishuRead(operation, actor, f.authorization), false);
    const rebound = f.bind();
    assert.notEqual(rebound.bindingId, f.authorization.bindingId);
    assert.equal(f.accounts.claimFeishuRead(operation, actor, f.authorization), false);
    assert.equal(f.accounts.claimFeishuRead(operation, actor, rebound), true);
    await f.accounts.updateUser(f.user.id, { password: 'changed-synthetic-read-password' });
    assert.equal(f.accounts.claimFeishuRead(nextOperation, actor, rebound), false);
    const member = await f.accounts.createUser('member', password);
    const session = f.accounts.issueSession(member.id);
    const memberActor = { ...actor, openId: 'member_open' };
    const request = f.accounts.issueFeishuBindingRequest(member.id, session.sessionId, memberActor);
    f.accounts.confirmFeishuBinding({ ...memberActor, code: request.command.slice('确认绑定 '.length), eventId: 'member_event', messageId: 'member_message', chatId: 'member_chat' });
    const auth = { userId: member.id, accessRevision: member.accessRevision, bindingId: f.accounts.getFeishuBindingState(member.id).binding!.id };
    await f.accounts.updateUser(member.id, { enabled: false });
    assert.equal(f.accounts.claimFeishuRead(nextOperation, memberActor, auth), false);
    await f.accounts.updateUser(member.id, { enabled: true });
    assert.equal(f.accounts.claimFeishuRead(nextOperation, memberActor, auth), false);
  } finally { f.cleanup(); }
});

test('database write errors are fixed and transaction rollback permits a later claim', async () => {
  const f = await fixture();
  const db = new DatabaseSync(f.accounts.dbPath);
  try {
    db.exec(`CREATE TRIGGER synthetic_receipt_failure BEFORE INSERT ON feishu_read_receipts BEGIN SELECT RAISE(ABORT, 'raw-sensitive-synthetic'); END`);
    assert.throws(() => f.accounts.claimFeishuRead(operation, actor, f.authorization), (error: unknown) => isError('WRITE_FAILED')(error) && !String(error).includes('raw-sensitive-synthetic'));
    assert.equal(receipts(f.accounts).length, 0);
    db.exec('DROP TRIGGER synthetic_receipt_failure');
    assert.equal(f.accounts.claimFeishuRead(operation, actor, f.authorization), true);
    db.exec(`CREATE TRIGGER synthetic_finish_failure BEFORE UPDATE ON feishu_read_receipts BEGIN SELECT RAISE(ABORT, 'raw-sensitive-synthetic'); END`);
    assert.throws(() => f.accounts.finishFeishuRead(operation, f.user.id, 'platform-accepted'), (error: unknown) => isError('WRITE_FAILED')(error) && !String(error).includes('raw-sensitive-synthetic'));
    assert.equal(receipts(f.accounts)[0]!.status, 'attempted');
  } finally { db.close(); f.cleanup(); }
});
