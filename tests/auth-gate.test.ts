import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accountStatusKey, parseAccountStatus, validatePassword, validateUsername } from '../src/web/AuthGate.tsx';

test('username validation enforces the bounded ASCII account identifier', () => {
  assert.equal(validateUsername('abc'), null);
  assert.equal(validateUsername('A_user-9.2'), null);
  assert.match(validateUsername('ab') ?? '', /3 到 32/);
  assert.match(validateUsername('中文用户') ?? '', /ASCII|字母/);
  assert.match(validateUsername('-starts-with-dash') ?? '', /开头/);
  assert.match(validateUsername('a'.repeat(33)) ?? '', /3 到 32/);
});

test('password validation requires 12 through 256 characters without inspecting content', () => {
  assert.match(validatePassword('short') ?? '', /12 到 256/);
  assert.equal(validatePassword('correct horse battery'), null);
  assert.equal(validatePassword('😀'.repeat(12)), null);
  assert.match(validatePassword('😀'.repeat(11)) ?? '', /12 到 256/);
  assert.equal(validatePassword('😀'.repeat(256)), null);
  assert.equal(validatePassword('p'.repeat(256)), null);
  assert.match(validatePassword('p'.repeat(257)) ?? '', /12 到 256/);
});

test('account status parsing rejects incomplete or malformed server responses', () => {
  const status = parseAccountStatus({
    enabled: true,
    needsSetup: false,
    user: { id: 'u-1', username: 'alice', role: 'admin', enabled: true, accessRevision: 3 },
  });
  assert.equal(status.user?.username, 'alice');
  assert.throws(() => parseAccountStatus({ enabled: true, needsSetup: false }), /不完整|用户信息无效/);
  assert.throws(() => parseAccountStatus({ enabled: true, needsSetup: false, user: { id: 'u-1' } }), /用户信息无效/);
  assert.equal(parseAccountStatus({ enabled: true, needsSetup: false, user: null }).user, null);
});

test('account status key changes only when account identity or access revision changes', () => {
  const base = { enabled: true, needsSetup: false, user: { id: 'u-1', username: 'alice', role: 'member' as const, enabled: true, accessRevision: 1 } };
  assert.equal(accountStatusKey(base), accountStatusKey({ ...base, user: { ...base.user, username: 'alice-renamed' } }));
  assert.notEqual(accountStatusKey(base), accountStatusKey({ ...base, user: { ...base.user, accessRevision: 2 } }));
  assert.notEqual(accountStatusKey(base), accountStatusKey({ ...base, user: { ...base.user, id: 'u-2' } }));
  assert.notEqual(accountStatusKey(base), accountStatusKey({ enabled: true, needsSetup: true, user: null }));
});
