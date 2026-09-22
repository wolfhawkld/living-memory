import { renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Request, Response } from 'express';
import type { Accounts, AccountSessionIssued } from './accounts.js';

export const SESSION_COOKIE = 'lm_session';

export function requestSessionToken(req: Request): string | null {
  const authorization = req.get('authorization');
  if (authorization !== undefined) return /^Bearer [A-Za-z0-9_-]{32,256}$/.test(authorization) ? authorization.slice(7) : null;
  const cookie = req.get('cookie')?.split(';').map((entry) => entry.trim()).find((entry) => entry.startsWith(`${SESSION_COOKIE}=`));
  if (!cookie) return null;
  try {
    const token = decodeURIComponent(cookie.slice(SESSION_COOKIE.length + 1));
    return /^[A-Za-z0-9_-]{32,256}$/.test(token) ? token : null;
  } catch { return null; }
}

export function setSessionCookie(res: Response, session: AccountSessionIssued): void {
  res.cookie(SESSION_COOKIE, session.token, { httpOnly: true, sameSite: 'strict', secure: false, path: '/',
    expires: new Date(session.expiresAt) });
}

/** Local OS-owner bridge for the existing CLI/hook; never served by an HTTP route. */
export function renewOwnerDevice(accounts: Accounts, dataDir: string, port: number): void {
  const owner = accounts.ownerId();
  if (!owner) return;
  const session = accounts.issueSession(owner, 'device');
  const path = join(dataDir, 'cli-session.json');
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify({ version: 1, baseUrl: `http://127.0.0.1:${port}`, userId: owner,
    sessionToken: session.token, expiresAt: session.expiresAt }), { mode: 0o600, flag: 'wx' });
  renameSync(temporaryPath, path);
}
