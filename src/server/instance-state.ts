import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isValidInstant } from '../core/time-model.js';

export interface InstanceIdentity { format: 'living-memory-instance-identity'; version: 1; instanceId: string }
export interface RestoreQuarantine { format: 'living-memory-restore-quarantine'; version: 1; restoredAt: string; connectorsBlocked: boolean }

function readPrivateJson(path: string): unknown {
  let stat;
  try { stat = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096 || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) throw new Error('INSTANCE_STATE_INVALID: 实例状态文件必须为私有普通文件。');
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error('INSTANCE_STATE_INVALID: 实例状态无法解析。'); }
}
export function readInstanceId(dataDir: string): string {
  const identity = readPrivateJson(join(dataDir, 'instance-identity.json')) as InstanceIdentity | undefined;
  if (identity === undefined) return 'legacy';
  if (!identity || typeof identity !== 'object' || Array.isArray(identity) || identity.format !== 'living-memory-instance-identity' || identity.version !== 1
    || Object.keys(identity).sort().join(',') !== 'format,instanceId,version' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(identity.instanceId)) throw new Error('INSTANCE_STATE_INVALID: 实例身份无效。');
  return identity.instanceId;
}
/** Any unknown quarantine marker fails closed for the connector only. */
export function isRestoreQuarantined(dataDir: string): boolean {
  try {
    const state = readPrivateJson(join(dataDir, 'restore-quarantine.json')) as RestoreQuarantine | undefined;
    if (state === undefined) return false;
    if (!state || typeof state !== 'object' || Array.isArray(state) || Object.keys(state).sort().join(',') !== 'connectorsBlocked,format,restoredAt,version'
      || state.format !== 'living-memory-restore-quarantine' || state.version !== 1 || typeof state.connectorsBlocked !== 'boolean' || !isValidInstant(state.restoredAt)) return true;
    return state.connectorsBlocked;
  } catch { return true; }
}
