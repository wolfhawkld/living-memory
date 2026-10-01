import { lstatSync, readFileSync } from 'node:fs';

/** Only send the OS-owner device credential to its exact configured service. */
export function readDeviceSession(path: string, baseUrl: string, now = Date.now()): string | undefined {
  let stat;
  try { stat = lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error('无法读取本机 CLI 登录凭据。');
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096 || (process.platform !== 'win32'
      && ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())))) {
    throw new Error('CLI 凭据文件必须为当前系统用户私有的普通文件（权限 600）。');
  }
  let value: { version?: unknown; baseUrl?: unknown; sessionToken?: unknown; expiresAt?: unknown };
  try { value = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error('CLI 凭据文件格式无效，请重启本地服务生成新凭据。'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('CLI 凭据文件格式无效，请重启本地服务生成新凭据。');
  if (value.version !== 1 || value.baseUrl !== baseUrl) return undefined;
  if (typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= now) {
    throw new Error('本机 CLI 登录凭据已过期，请重启本地服务更新。');
  }
  if (typeof value.sessionToken !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(value.sessionToken)) throw new Error('CLI 凭据无效，请重启本地服务更新。');
  return value.sessionToken;
}
