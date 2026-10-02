/** Pure configuration parsing; never reads process.env, logs credentials, or starts transport. */
export const FEISHU_ID_MAX_LENGTH = 256;
export const FEISHU_SECRET_MAX_LENGTH = 4096;

export interface EnabledFeishuConfig {
  enabled: true;
  appId: string;
  /** Credential for the transport only. Do not log or serialize this configuration. */
  appSecret: string;
  tenantKey: string;
}
export type FeishuConfig = { enabled: false } | EnabledFeishuConfig;
export type FeishuConfigErrorCode =
  | 'invalid-enabled' | 'invalid-app-id' | 'invalid-app-secret' | 'invalid-tenant-key';
export type FeishuConfigResult =
  | { ok: true; value: FeishuConfig }
  | { ok: false; code: FeishuConfigErrorCode };

function own(env: Record<string, string | undefined>, key: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(env, key) ? env[key] : undefined;
}
function validString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length <= maxLength && value.trim().length > 0;
}

export function parseFeishuConfig(env: Record<string, string | undefined>): FeishuConfigResult {
  const flag = own(env, 'LM_FEISHU_ENABLED');
  if (flag === undefined || flag === '0') return { ok: true, value: { enabled: false } };
  if (flag !== '1') return { ok: false, code: 'invalid-enabled' };
  const appId = own(env, 'LM_FEISHU_APP_ID');
  if (!validString(appId, FEISHU_ID_MAX_LENGTH) || !/^cli_[0-9a-fA-F]{16}$/.test(appId.trim())) {
    return { ok: false, code: 'invalid-app-id' };
  }
  const appSecret = own(env, 'LM_FEISHU_APP_SECRET');
  if (!validString(appSecret, FEISHU_SECRET_MAX_LENGTH)) return { ok: false, code: 'invalid-app-secret' };
  const tenantKey = own(env, 'LM_FEISHU_TENANT_KEY');
  if (!validString(tenantKey, FEISHU_ID_MAX_LENGTH)) return { ok: false, code: 'invalid-tenant-key' };
  return { ok: true, value: { enabled: true, appId: appId.trim(), appSecret, tenantKey: tenantKey.trim() } };
}
