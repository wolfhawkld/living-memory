import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseFeishuConfig, FEISHU_ID_MAX_LENGTH, FEISHU_SECRET_MAX_LENGTH } from '../src/integrations/feishu-config.js';

function env(): Record<string, string | undefined> {
  return {
    LM_FEISHU_ENABLED: '1', LM_FEISHU_APP_ID: 'cli_0000000000000000',
    LM_FEISHU_APP_SECRET: 'synthetic-secret', LM_FEISHU_TENANT_KEY: 'synthetic-tenant',
  };
}

test('missing or zero flag disables transport and ignores all other configuration', () => {
  for (const flag of [undefined, '0']) {
    const input = { LM_FEISHU_ENABLED: flag, LM_FEISHU_APP_ID: '', LM_FEISHU_APP_SECRET: ' '.repeat(5000), LM_FEISHU_TENANT_KEY: '' };
    assert.deepEqual(parseFeishuConfig(input), { ok: true, value: { enabled: false } });
    Object.defineProperty(input, 'LM_FEISHU_APP_SECRET', { get() { throw new Error('Disabled credentials must not be read'); } });
    assert.deepEqual(parseFeishuConfig(input), { ok: true, value: { enabled: false } });
  }
  assert.deepEqual(parseFeishuConfig({}), { ok: true, value: { enabled: false } });
});

test('enabled configuration trims identifiers and preserves secret bytes', () => {
  const input = { ...env(), LM_FEISHU_APP_ID: ' cli_0000000000000000 \t', LM_FEISHU_APP_SECRET: ' synthetic-secret \n', LM_FEISHU_TENANT_KEY: '\n synthetic-tenant ' };
  assert.deepEqual(parseFeishuConfig(input), { ok: true, value: {
    enabled: true, appId: 'cli_0000000000000000', appSecret: input.LM_FEISHU_APP_SECRET, tenantKey: 'synthetic-tenant', timeZone: 'UTC',
  } });
  assert.equal(input.LM_FEISHU_APP_ID, ' cli_0000000000000000 \t');
});

test('enabled review calendar defaults to UTC and validates an explicit IANA zone without exposing input', () => {
  const result = parseFeishuConfig({ ...env(), LM_FEISHU_TIME_ZONE: ' Asia/Hong_Kong ' });
  assert.equal(result.ok && result.value.enabled && result.value.timeZone, 'Asia/Hong_Kong');
  for (const value of ['', '   ', 'Invalid/Synthetic', 'x'.repeat(129), null, 42, [], {}]) {
    assert.deepEqual(parseFeishuConfig({ ...env(), LM_FEISHU_TIME_ZONE: value } as unknown as Record<string, string | undefined>),
      { ok: false, code: 'invalid-time-zone' });
  }
  const disabled = { LM_FEISHU_ENABLED: '0' };
  Object.defineProperty(disabled, 'LM_FEISHU_TIME_ZONE', { get() { throw new Error('Disabled config must not read zone'); } });
  assert.deepEqual(parseFeishuConfig(disabled), { ok: true, value: { enabled: false } });
});

test('noncanonical and malicious enable flags return one fixed error without values', () => {
  for (const flag of ['', ' ', 'true', 'false', '01', ' 1', '1 ', '2', 'synthetic-secret', '1\nLM_FEISHU_APP_SECRET=synthetic-secret']) {
    assert.deepEqual(parseFeishuConfig({ ...env(), LM_FEISHU_ENABLED: flag }), { ok: false, code: 'invalid-enabled' });
  }
});

test('enabled configuration rejects missing or blank required values with fixed field errors', () => {
  for (const [key, code] of [
    ['LM_FEISHU_APP_ID', 'invalid-app-id'], ['LM_FEISHU_APP_SECRET', 'invalid-app-secret'], ['LM_FEISHU_TENANT_KEY', 'invalid-tenant-key'],
  ]) {
    for (const invalid of [undefined, '', ' \t\n']) {
      assert.deepEqual(parseFeishuConfig({ ...env(), [key]: invalid }), { ok: false, code });
    }
  }
});

test('configuration rejects oversized identifiers and secrets and accepts exact limits', () => {
  for (const [key, max, code] of [
    ['LM_FEISHU_APP_SECRET', FEISHU_SECRET_MAX_LENGTH, 'invalid-app-secret'],
    ['LM_FEISHU_TENANT_KEY', FEISHU_ID_MAX_LENGTH, 'invalid-tenant-key'],
  ] as const) {
    assert.equal(parseFeishuConfig({ ...env(), [key]: 'x'.repeat(max) }).ok, true);
    assert.deepEqual(parseFeishuConfig({ ...env(), [key]: 'x'.repeat(max + 1) }), { ok: false, code });
  }
  for (const invalid of ['x'.repeat(FEISHU_ID_MAX_LENGTH), 'x'.repeat(FEISHU_ID_MAX_LENGTH + 1),
    'synthetic-app', 'cli_000000000000000', 'cli_00000000000000000', 'cli_000000000000000g', 'CLI_0000000000000000']) {
    assert.deepEqual(parseFeishuConfig({ ...env(), LM_FEISHU_APP_ID: invalid }), { ok: false, code: 'invalid-app-id' });
  }
  assert.equal(parseFeishuConfig({ ...env(), LM_FEISHU_APP_ID: 'cli_0123456789abcdef' }).ok, true);
  assert.equal(parseFeishuConfig({ ...env(), LM_FEISHU_APP_ID: 'cli_0123456789ABCDEF' }).ok, true);
});

test('failure results never expose secrets or other environment values', () => {
  const inputs: Record<string, string | undefined>[] = [
    { ...env(), LM_FEISHU_ENABLED: 'secret-in-flag' },
    { ...env(), LM_FEISHU_APP_ID: '' },
    { ...env(), LM_FEISHU_APP_SECRET: 'secret-over-limit-'.repeat(500) },
    { ...env(), LM_FEISHU_TENANT_KEY: '' },
  ];
  for (const input of inputs) {
    const result = parseFeishuConfig(input);
    assert.equal(result.ok, false);
    assert.equal(JSON.stringify(result).includes(input.LM_FEISHU_APP_SECRET!), false);
    assert.equal(JSON.stringify(result).includes('secret-in-flag'), false);
    assert.deepEqual(Object.keys(result).sort(), ['code', 'ok']);
  }
});

test('configuration accepts own environment fields only and rejects nonstring enabled credentials', () => {
  assert.deepEqual(parseFeishuConfig(Object.create(env())), { ok: true, value: { enabled: false } });
  for (const key of ['LM_FEISHU_APP_ID', 'LM_FEISHU_APP_SECRET', 'LM_FEISHU_TENANT_KEY']) {
    for (const invalid of [null, 1, true, {}, []]) {
      assert.equal(parseFeishuConfig({ ...env(), [key]: invalid } as Record<string, string | undefined>).ok, false);
    }
  }
});
