import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { parseFeishuConfig } from '../integrations/feishu-config.js';
import { isRestoreQuarantined, readInstanceId } from './instance-state.js';
import { resolveSourceIdentity } from './source-identities.js';

export interface InstanceRuntimeProfile {
  format: 'living-memory-instance-runtime';
  version: 1;
  dataDir: string;
  kgRoot: string;
  cliStateDir: string;
  staticDir: string;
  port: number;
  expectedInstanceId: string;
  expectedSourceIdentityHash: string;
  expectedSourceRootFingerprint: string;
  feishuEnvFile?: string;
  kgLimit?: number;
  kgInclude?: string;
}

export type InstanceRuntimeErrorCode =
  | 'INVALID_RUNTIME_ARGUMENT' | 'RUNTIME_PROFILE_INVALID' | 'RUNTIME_PATH_INVALID'
  | 'RUNTIME_STORAGE_CONFLICT' | 'RUNTIME_DATABASE_MISSING' | 'RUNTIME_INSTANCE_MISMATCH'
  | 'RUNTIME_SOURCE_MISMATCH' | 'RUNTIME_BUILD_MISSING' | 'RUNTIME_CONNECTOR_QUARANTINED'
  | 'RUNTIME_CREDENTIALS_INVALID' | 'RUNTIME_START_FAILED';

export class InstanceRuntimeError extends Error {
  constructor(readonly code: InstanceRuntimeErrorCode) { super(code); this.name = 'InstanceRuntimeError'; }
}

export interface InstanceRuntimeCheck {
  format: 'living-memory-runtime-check';
  version: 1;
  status: 'checked';
  url: string;
  instanceMatched: true;
  sourceMatched: true;
  storagePathsChecked: true;
  staticEntryChecked: true;
  restoreQuarantined: boolean;
  credentials: 'not-read';
  databaseContents: 'not-checked';
}

const controlCharacters = /[\u0000-\u001f\u007f]/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const hash = /^[a-f0-9]{64}$/;
const fields = new Set(['format', 'version', 'dataDir', 'kgRoot', 'cliStateDir', 'staticDir', 'port',
  'expectedInstanceId', 'expectedSourceIdentityHash', 'expectedSourceRootFingerprint', 'feishuEnvFile', 'kgLimit', 'kgInclude']);

function absolutePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !controlCharacters.test(value)
    && isAbsolute(value) && resolve(value) === value;
}

function privateText(path: string, limit: number, code: InstanceRuntimeErrorCode): string {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit
      || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) throw new Error();
    const text = readFileSync(path, 'utf8');
    if (Buffer.byteLength(text) > limit) throw new Error();
    return text;
  } catch { throw new InstanceRuntimeError(code); }
}

/** Read a strict private profile. This never initializes storage or reads credentials. */
export function readInstanceRuntimeProfile(path: string): InstanceRuntimeProfile {
  try {
    if (typeof path !== 'string' || !path || controlCharacters.test(path)) throw new Error();
    const value = JSON.parse(privateText(path, 64 * 1024, 'RUNTIME_PROFILE_INVALID')) as InstanceRuntimeProfile;
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.has(key))
      || value.format !== 'living-memory-instance-runtime' || value.version !== 1
      || !['dataDir', 'kgRoot', 'cliStateDir', 'staticDir'].every(key => absolutePath(value[key as keyof InstanceRuntimeProfile]))
      || (value.feishuEnvFile !== undefined && !absolutePath(value.feishuEnvFile))
      || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535
      || typeof value.expectedInstanceId !== 'string' || !(value.expectedInstanceId === 'legacy' || uuid.test(value.expectedInstanceId))
      || typeof value.expectedSourceIdentityHash !== 'string' || !hash.test(value.expectedSourceIdentityHash)
      || typeof value.expectedSourceRootFingerprint !== 'string' || !hash.test(value.expectedSourceRootFingerprint)
      || (value.kgLimit !== undefined && (!Number.isInteger(value.kgLimit) || value.kgLimit < 1 || value.kgLimit > 300))
      || (value.kgInclude !== undefined && (typeof value.kgInclude !== 'string' || value.kgInclude.length > 4096 || controlCharacters.test(value.kgInclude)))) throw new Error();
    return value;
  } catch { throw new InstanceRuntimeError('RUNTIME_PROFILE_INVALID'); }
}

function contains(parent: string, child: string): boolean {
  const suffix = relative(parent, child);
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith('../') && !suffix.startsWith('..\\'));
}
const overlaps = (a: string, b: string): boolean => contains(a, b) || contains(b, a);

function directory(path: string): string {
  try {
    const canonical = realpathSync(path);
    if (!lstatSync(canonical).isDirectory()) throw new Error();
    return canonical;
  } catch { throw new InstanceRuntimeError('RUNTIME_PATH_INVALID'); }
}

/** Resolve parents without inspecting the optional credential file itself. */
function canonicalParent(path: string): string {
  try { return realpathSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new InstanceRuntimeError('RUNTIME_PATH_INVALID');
    const parent = dirname(path);
    if (parent === path) throw new InstanceRuntimeError('RUNTIME_PATH_INVALID');
    return join(canonicalParent(parent), relative(parent, path));
  }
}

function requireFile(path: string, code: InstanceRuntimeErrorCode): void {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error();
  } catch { throw new InstanceRuntimeError(code); }
}

function inspect(profilePath: string): { profile: InstanceRuntimeProfile; check: InstanceRuntimeCheck } {
  const profile = readInstanceRuntimeProfile(profilePath);
  const data = directory(profile.dataDir), root = directory(profile.kgRoot);
  const cli = directory(profile.cliStateDir), assets = directory(profile.staticDir);
  const installationRoot = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
  const privatePaths = [realpathSync(profilePath)];
  if (profile.feishuEnvFile) privatePaths.push(join(canonicalParent(dirname(profile.feishuEnvFile)), relative(dirname(profile.feishuEnvFile), profile.feishuEnvFile)));
  if (contains(assets, installationRoot) || overlaps(data, root) || overlaps(data, assets) || overlaps(root, assets)
    || overlaps(cli, root) || overlaps(cli, assets) || contains(cli, data)
    || privatePaths.some(path => contains(root, path) || contains(assets, path))) {
    throw new InstanceRuntimeError('RUNTIME_STORAGE_CONFLICT');
  }
  requireFile(join(data, 'accounts.sqlite'), 'RUNTIME_DATABASE_MISSING');
  requireFile(join(data, 'living-memory.sqlite'), 'RUNTIME_DATABASE_MISSING');
  requireFile(join(assets, 'index.html'), 'RUNTIME_BUILD_MISSING');
  try {
    if (readInstanceId(data) !== profile.expectedInstanceId) throw new Error();
  } catch { throw new InstanceRuntimeError('RUNTIME_INSTANCE_MISMATCH'); }
  try {
    const source = resolveSourceIdentity(data, root);
    if (source.identityHash !== profile.expectedSourceIdentityHash || source.sourceRootFingerprint !== profile.expectedSourceRootFingerprint) throw new Error();
  } catch { throw new InstanceRuntimeError('RUNTIME_SOURCE_MISMATCH'); }
  return { profile, check: {
    format: 'living-memory-runtime-check', version: 1, status: 'checked', url: `http://127.0.0.1:${profile.port}`,
    instanceMatched: true, sourceMatched: true, storagePathsChecked: true, staticEntryChecked: true,
    restoreQuarantined: isRestoreQuarantined(data), credentials: 'not-read', databaseContents: 'not-checked',
  } };
}

/** Metadata preflight only: no database open, lease, port probe or connector activation. */
export function checkInstanceRuntime(profilePath: string): InstanceRuntimeCheck { return inspect(profilePath).check; }

/** Return an explicit environment; callers must discard all inherited LM_* values before installing it. */
export function prepareInstanceRuntime(profilePath: string, options: { feishu?: boolean } = {}): {
  profile: InstanceRuntimeProfile; environment: Record<string, string>; check: InstanceRuntimeCheck;
} {
  const { profile, check } = inspect(profilePath);
  const environment: Record<string, string> = {
    LM_DATA_DIR: profile.dataDir, LM_KG_ROOT: profile.kgRoot, LM_CLI_STATE_DIR: profile.cliStateDir,
    LM_CLI_SESSION_FILE: join(profile.dataDir, 'cli-session.json'), LM_PORT: String(profile.port),
    LM_AUTH_MODE: 'accounts', LM_STATIC_DIR: profile.staticDir, LM_SERVER_URL: check.url, LM_FEISHU_ENABLED: '0',
    LM_KG_LIMIT: String(profile.kgLimit ?? 20), LM_KG_INCLUDE: profile.kgInclude ?? '',
  };
  if (options.feishu) {
    if (check.restoreQuarantined) throw new InstanceRuntimeError('RUNTIME_CONNECTOR_QUARANTINED');
    if (!profile.feishuEnvFile) throw new InstanceRuntimeError('RUNTIME_CREDENTIALS_INVALID');
    let parsed: Record<string, string | undefined>;
    try { parsed = parseEnv(privateText(profile.feishuEnvFile, 128 * 1024, 'RUNTIME_CREDENTIALS_INVALID')); }
    catch { throw new InstanceRuntimeError('RUNTIME_CREDENTIALS_INVALID'); }
    const selected: Record<string, string | undefined> = { LM_FEISHU_ENABLED: '1' };
    for (const key of ['LM_FEISHU_APP_ID', 'LM_FEISHU_APP_SECRET', 'LM_FEISHU_TENANT_KEY', 'LM_FEISHU_TIME_ZONE']) {
      selected[key] = Object.hasOwn(parsed, key) ? parsed[key] : undefined;
    }
    const config = parseFeishuConfig(selected);
    if (!config.ok || !config.value.enabled) throw new InstanceRuntimeError('RUNTIME_CREDENTIALS_INVALID');
    Object.assign(environment, { LM_FEISHU_ENABLED: '1', LM_FEISHU_APP_ID: config.value.appId,
      LM_FEISHU_APP_SECRET: config.value.appSecret, LM_FEISHU_TENANT_KEY: config.value.tenantKey, LM_FEISHU_TIME_ZONE: config.value.timeZone });
  }
  return { profile, environment, check };
}
