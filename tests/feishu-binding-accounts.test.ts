import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Accounts, type FeishuBindingConfirmation } from '../src/server/accounts.js';
import { StoreError } from '../src/server/store.js';

const scope = { appId: 'app_synthetic', tenantKey: 'tenant_synthetic' };
const actor = { ...scope, openId: 'open_synthetic' };
const password = 'synthetic-account-password';
async function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'lm-feishu-binding-'));
  let time = Date.parse('2026-10-02T00:00:00.000Z');
  const options = { dataDir, now: () => new Date(time) };
  const accounts = new Accounts(options);
  const user = await accounts.setup('owner', password);
  const session = accounts.issueSession(user.id);
  return { accounts, user, session, options, advance(ms: number) { time += ms; }, cleanup() { accounts.close(); rmSync(dataDir, { recursive: true, force: true }); } };
}
function confirmation(command: string, overrides: Partial<FeishuBindingConfirmation> = {}): FeishuBindingConfirmation {
  return { ...actor, eventId: 'event_synthetic', messageId: 'message_synthetic', chatId: 'chat_synthetic', code: command.slice('确认绑定 '.length), ...overrides };
}
function errorCode(code: string) { return (error: unknown) => error instanceof StoreError && error.code === code; }

test('binding requests disclose the random command once, persist hashes only, and authenticate trustworthy session kinds', async () => {
  const f = await fixture();
  try {
    assert.equal(f.session.kind, 'browser');
    assert.equal(f.accounts.authenticate(f.session.token)?.kind, 'browser');
    const device = f.accounts.issueSession(f.user.id, 'device');
    assert.equal(f.accounts.authenticate(device.token)?.kind, 'device');
    assert.throws(() => f.accounts.issueFeishuBindingRequest(f.user.id, device.sessionId, scope), errorCode('BROWSER_SESSION_REQUIRED'));
    const issued = f.accounts.issueFeishuBindingRequest(f.user.id, f.session.sessionId, scope);
    assert.match(issued.command, /^确认绑定 LM-[A-Za-z0-9_-]{22}$/);
    assert.equal(Date.parse(issued.request.expiresAt) - Date.parse('2026-10-02T00:00:00Z'), 600_000);
    assert.deepEqual(Object.keys(f.accounts.getFeishuBindingState(f.user.id).request!).sort(), ['confirmedAt', 'expiresAt', 'id', 'status']);
    assert.equal(readFileSync(f.accounts.dbPath).includes(Buffer.from(confirmation(issued.command).code)), false);
  } finally { f.cleanup(); }
});

test('reissue, cancel, expiry, logout, and browser TTL make unconsumed codes unusable', async () => {
  const f = await fixture();
  try {
    const first = f.accounts.issueFeishuBindingRequest(f.user.id, f.session.sessionId, scope);
    const second = f.accounts.issueFeishuBindingRequest(f.user.id, f.session.sessionId, scope);
    assert.equal(f.accounts.confirmFeishuBinding(confirmation(first.command)).status, 'rejected');
    f.accounts.cancelFeishuBindingRequest(f.user.id, f.session.sessionId, second.request.id);
    assert.equal(f.accounts.confirmFeishuBinding(confirmation(second.command)).status, 'rejected');
    const third = f.accounts.issueFeishuBindingRequest(f.user.id, f.session.sessionId, scope);
    f.advance(600_000);
    assert.equal(f.accounts.confirmFeishuBinding(confirmation(third.command)).status, 'rejected');
    assert.equal(f.accounts.getFeishuBindingState(f.user.id).request?.status, 'expired');
    f.advance(12 * 3600_000 - 600_000 - 30_000);
    const nearExpiry = f.accounts.issueFeishuBindingRequest(f.user.id, f.session.sessionId, scope);
    assert.equal(nearExpiry.request.expiresAt, f.session.expiresAt);
    f.accounts.logout(f.session.token);
    assert.equal(f.accounts.confirmFeishuBinding(confirmation(nearExpiry.command)).status, 'rejected');
    assert.equal(f.accounts.getFeishuBindingState(f.user.id).request?.status, 'invalidated');
  } finally { f.cleanup(); }
});

test('confirmation is atomic, scope-bound, idempotent only for the claimed actor, and revocation prevents resurrection', async () => {
  const f = await fixture();
  try {
    const issued = f.accounts.issueFeishuBindingRequest(f.user.id, f.session.sessionId, scope);
    assert.equal(f.accounts.confirmFeishuBinding(confirmation(issued.command, { tenantKey: 'different' })).status, 'rejected');
    assert.equal(f.accounts.confirmFeishuBinding(confirmation(issued.command, { appId: 'different' })).status, 'rejected');
    assert.equal(f.accounts.getFeishuBindingState(f.user.id).request?.status, 'pending');
    assert.equal(f.accounts.confirmFeishuBinding(confirmation(issued.command)).status, 'confirmed');
    assert.equal(f.accounts.resolveFeishuAccount(actor)?.id, f.user.id);
    assert.equal(f.accounts.confirmFeishuBinding(confirmation(issued.command)).status, 'duplicate');
    assert.equal(f.accounts.confirmFeishuBinding(confirmation(issued.command, { openId: 'other' })).status, 'rejected');
    assert.throws(() => f.accounts.issueFeishuBindingRequest(f.user.id, f.session.sessionId, scope), errorCode('FEISHU_ALREADY_BOUND'));
    f.accounts.logout(f.session.token);
    assert.equal(f.accounts.resolveFeishuAccount(actor)?.id, f.user.id);
    const session = f.accounts.issueSession(f.user.id);
    const binding = f.accounts.getFeishuBindingState(f.user.id).binding!;
    f.accounts.revokeFeishuBinding(f.user.id, session.sessionId, binding.id);
    assert.equal(f.accounts.resolveFeishuAccount(actor), null);
    assert.equal(f.accounts.confirmFeishuBinding(confirmation(issued.command)).status, 'rejected');
    const next = f.accounts.issueFeishuBindingRequest(f.user.id, session.sessionId, scope);
    assert.equal(f.accounts.confirmFeishuBinding(confirmation(next.command)).status, 'confirmed');
    assert.notEqual(f.accounts.getFeishuBindingState(f.user.id).binding?.id, binding.id);
    assert.equal(f.accounts.confirmFeishuBinding(confirmation(issued.command)).status, 'rejected');
  } finally { f.cleanup(); }
});

test('two stores preserve unique actors, failed confirmation leaves pending, and cross-user management is rejected', async () => {
  const f = await fixture();
  const second = new Accounts(f.options);
  try {
    const member = await f.accounts.createUser('member', password);
    const session = f.accounts.issueSession(member.id);
    const firstRequest = f.accounts.issueFeishuBindingRequest(f.user.id, f.session.sessionId, scope);
    const secondRequest = second.issueFeishuBindingRequest(member.id, session.sessionId, scope);
    second.cancelFeishuBindingRequest(member.id, session.sessionId, firstRequest.request.id);
    assert.equal(f.accounts.getFeishuBindingState(f.user.id).request?.status, 'pending');
    assert.equal(second.getFeishuBindingState(member.id).request?.status, 'pending');
    assert.throws(() => second.issueFeishuBindingRequest(member.id, f.session.sessionId, scope), errorCode('BROWSER_SESSION_REQUIRED'));
    const results = await Promise.all([
      Promise.resolve().then(() => f.accounts.confirmFeishuBinding(confirmation(firstRequest.command))),
      Promise.resolve().then(() => second.confirmFeishuBinding(confirmation(secondRequest.command))),
    ]);
    assert.deepEqual(results.map(r => r.status).sort(), ['confirmed', 'rejected']);
    assert.equal(second.getFeishuBindingState(member.id).request?.status, 'pending');
    assert.throws(() => second.revokeFeishuBinding(member.id, session.sessionId, f.accounts.getFeishuBindingState(f.user.id).binding!.id), errorCode('FEISHU_BINDING_NOT_FOUND'));
    assert.equal(second.confirmFeishuBinding(confirmation(secondRequest.command, { openId: 'other_actor' })).status, 'confirmed');
    const third = await f.accounts.createUser('third', password);
    const database = new DatabaseSync(f.accounts.dbPath);
    try {
      assert.throws(() => database.prepare(`INSERT INTO feishu_bindings(id,user_id,account_access_revision,app_id,tenant_key,open_id,bound_at) VALUES('illegal',?,1,'different','different','different','2026-10-02')`).run(f.user.id));
      assert.throws(() => database.prepare(`INSERT INTO feishu_bindings(id,user_id,account_access_revision,app_id,tenant_key,open_id,bound_at) VALUES('illegal',?,1,?,?,?,'2026-10-02')`).run(third.id, scope.appId,scope.tenantKey,actor.openId));
    } finally { database.close(); }
  } finally { second.close(); f.cleanup(); }
});

test('password reset and disable/re-enable invalidate requests and bindings without restoring external authority', async () => {
  const f = await fixture();
  try {
    const issued = f.accounts.issueFeishuBindingRequest(f.user.id, f.session.sessionId, scope);
    f.accounts.confirmFeishuBinding(confirmation(issued.command));
    await f.accounts.updateUser(f.user.id, { password: 'changed-synthetic-password' });
    assert.equal(f.accounts.resolveFeishuAccount(actor), null);
    assert.equal(f.accounts.confirmFeishuBinding(confirmation(issued.command)).status, 'rejected');
    const member = await f.accounts.createUser('member', password);
    const session = f.accounts.issueSession(member.id);
    const pending = f.accounts.issueFeishuBindingRequest(member.id, session.sessionId, scope);
    await f.accounts.updateUser(member.id, { enabled: false });
    await f.accounts.updateUser(member.id, { enabled: true });
    assert.equal(f.accounts.confirmFeishuBinding(confirmation(pending.command)).status, 'rejected');
    assert.equal(f.accounts.getFeishuBindingState(member.id).request?.status, 'invalidated');
    const freshSession = f.accounts.issueSession(member.id);
    const fresh = f.accounts.issueFeishuBindingRequest(member.id, freshSession.sessionId, scope);
    assert.equal(f.accounts.confirmFeishuBinding(confirmation(fresh.command)).status, 'confirmed');
    await f.accounts.updateUser(member.id, { enabled: false });
    await f.accounts.updateUser(member.id, { enabled: true });
    assert.equal(f.accounts.resolveFeishuAccount(actor), null);
    assert.equal(f.accounts.confirmFeishuBinding(confirmation(fresh.command)).status, 'rejected');
  } finally { f.cleanup(); }
});

test('additive migration preserves legacy account and sessions across reopen and uses no raw commands', async () => {
  const f = await fixture();
  f.accounts.close();
  const db = new DatabaseSync(join(f.options.dataDir, 'accounts.sqlite'));
  db.exec('DROP TABLE feishu_binding_requests; DROP TABLE feishu_bindings;');
  db.close();
  const upgraded = new Accounts(f.options);
  try {
    assert.equal(upgraded.authenticate(f.session.token)?.user.id, f.user.id);
    assert.equal(upgraded.authenticate(f.session.token)?.kind, 'browser');
    const issued = upgraded.issueFeishuBindingRequest(f.user.id, f.session.sessionId, scope);
    upgraded.confirmFeishuBinding(confirmation(issued.command));
    upgraded.close();
    const reopened = new Accounts(f.options);
    try {
      assert.equal(reopened.resolveFeishuAccount(actor)?.id, f.user.id);
      assert.equal(reopened.confirmFeishuBinding(confirmation(issued.command)).status, 'duplicate');
    } finally { reopened.close(); }
  } finally { try { upgraded.close(); } catch { /* already closed */ } rmSync(f.options.dataDir, { recursive: true, force: true }); }
});

test('database failure rolls back both binding insert and request consumption', async () => {
  const f = await fixture();
  const db = new DatabaseSync(f.accounts.dbPath);
  try {
    const issued = f.accounts.issueFeishuBindingRequest(f.user.id, f.session.sessionId, scope);
    db.exec(`CREATE TRIGGER synthetic_fail_confirmation BEFORE UPDATE OF status ON feishu_binding_requests
      WHEN NEW.status = 'confirmed' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;`);
    assert.throws(() => f.accounts.confirmFeishuBinding(confirmation(issued.command)), errorCode('WRITE_FAILED'));
    assert.equal(f.accounts.getFeishuBindingState(f.user.id).request?.status, 'pending');
    assert.equal(f.accounts.resolveFeishuAccount(actor), null);
    db.exec('DROP TRIGGER synthetic_fail_confirmation');
    assert.equal(f.accounts.confirmFeishuBinding(confirmation(issued.command)).status, 'confirmed');
    assert.equal(f.accounts.confirmFeishuBinding(confirmation('确认绑定 wrong')).status, 'rejected');
  } finally { db.close(); f.cleanup(); }
});

test('repeated cancellation and historical revocation never alter a replacement generation', async () => {
  const f = await fixture();
  try {
    const first = f.accounts.issueFeishuBindingRequest(f.user.id, f.session.sessionId, scope);
    f.accounts.cancelFeishuBindingRequest(f.user.id, f.session.sessionId, first.request.id);
    f.accounts.cancelFeishuBindingRequest(f.user.id, f.session.sessionId, first.request.id);
    const next = f.accounts.issueFeishuBindingRequest(f.user.id, f.session.sessionId, scope);
    f.accounts.cancelFeishuBindingRequest(f.user.id, f.session.sessionId, first.request.id);
    assert.equal(f.accounts.getFeishuBindingState(f.user.id).request?.status, 'pending');
    f.accounts.confirmFeishuBinding(confirmation(next.command));
    f.accounts.cancelFeishuBindingRequest(f.user.id, f.session.sessionId, next.request.id);
    assert.equal(f.accounts.getFeishuBindingState(f.user.id).request?.status, 'confirmed');
    const binding = f.accounts.getFeishuBindingState(f.user.id).binding!;
    f.accounts.revokeFeishuBinding(f.user.id, f.session.sessionId, binding.id);
    const last = f.accounts.issueFeishuBindingRequest(f.user.id, f.session.sessionId, scope);
    f.accounts.revokeFeishuBinding(f.user.id, f.session.sessionId, binding.id);
    assert.equal(f.accounts.getFeishuBindingState(f.user.id).request?.status, 'pending');
    f.accounts.confirmFeishuBinding(confirmation(last.command));
    const before = f.accounts.getFeishuBindingState(f.user.id);
    f.accounts.revokeFeishuBinding(f.user.id, f.session.sessionId, binding.id);
    assert.deepEqual(f.accounts.getFeishuBindingState(f.user.id), before);
    assert.throws(() => f.accounts.cancelFeishuBindingRequest(f.user.id, f.session.sessionId, undefined), errorCode('INVALID_FEISHU_REQUEST'));
    assert.throws(() => f.accounts.revokeFeishuBinding(f.user.id, f.session.sessionId, undefined), errorCode('INVALID_FEISHU_BINDING'));
    assert.equal(f.accounts.confirmFeishuBinding({ ...confirmation(last.command), code: 5 } as unknown as FeishuBindingConfirmation).status, 'rejected');
  } finally { f.cleanup(); }
});
