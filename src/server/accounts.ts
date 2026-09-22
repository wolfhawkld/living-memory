import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import type { AccountUser } from '../shared/accounts.js';
import { StoreError } from './store.js';

const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_MAX_LENGTH = 256;
const PASSWORD_HASH_BYTES = 64;
const PASSWORD_SALT_BYTES = 16;
const PASSWORD_HASH_VERSION = 1;
const SCRYPT_N = 131_072;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
const MAX_SCRYPT_OPERATIONS = 2;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_FAILURES = 5;
const MAX_RATE_KEYS = 1_000;
const BROWSER_TTL_MS = 12 * 60 * 60 * 1000;
const DEVICE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9_.-]{2,31}$/;
const PASSWORD_FORMAT = `$lm-scrypt$v=${PASSWORD_HASH_VERSION}$N=${SCRYPT_N},r=${SCRYPT_R},p=${SCRYPT_P}`;

const DUMMY_SALT = Buffer.from('living-memory-account-dummy-salt', 'utf8');
const DUMMY_HASH = Buffer.from(
  'living-memory-account-dummy-hash-living-memory-account-dummy-hash-living-memory-account-dummy-hash',
  'utf8',
).subarray(0, PASSWORD_HASH_BYTES);

export interface AccountsOptions {
  dataDir: string;
  now?: () => Date;
}

export interface AccountSession {
  user: AccountUser;
  csrfToken: string;
  expiresAt: string;
  sessionId: string;
}

export interface AccountSessionIssued extends AccountSession {
  /** The opaque bearer token is returned once and never persisted in raw form. */
  token: string;
}

export interface AccountUpdate {
  enabled?: boolean;
  password?: string;
}

interface AccountRow {
  id: string;
  username: string;
  role: 'admin' | 'member';
  enabled: number;
  access_revision: number;
  password_hash: string;
}

interface SessionRow {
  session_id: string;
  user_id: string;
  csrf_token: string;
  expires_at: string;
}

interface LoginFailure {
  count: number;
  firstFailedAt: number;
  lastFailedAt: number;
}

function accountError(code: string, message: string, status = 400): StoreError {
  return new StoreError(code, message, status);
}

function nowDate(now: () => Date): Date {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw accountError('INVALID_CLOCK', '账户服务时钟无效。');
  }
  return value;
}

function iso(value: Date): string {
  return value.toISOString();
}

function normalizeUsername(value: unknown): string {
  if (typeof value !== 'string') throw accountError('INVALID_USERNAME', '用户名必须是字符串。');
  const normalized = value.normalize('NFKC').trim().toLocaleLowerCase('en-US');
  if (!USERNAME_PATTERN.test(normalized)) {
    throw accountError('INVALID_USERNAME', '用户名必须是 3 到 32 个字符的 ASCII 小写标识符。');
  }
  return normalized;
}

function validatePassword(value: unknown): string {
  if (typeof value !== 'string') throw accountError('INVALID_PASSWORD', '密码必须是字符串。');
  const length = Array.from(value).length;
  if (length < PASSWORD_MIN_LENGTH || length > PASSWORD_MAX_LENGTH) {
    throw accountError('INVALID_PASSWORD', `密码长度必须是 ${PASSWORD_MIN_LENGTH} 到 ${PASSWORD_MAX_LENGTH} 个 Unicode 字符。`);
  }
  return value;
}

function normalizeRateKey(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256) {
    throw accountError('INVALID_RATE_KEY', 'rateKey 必须是长度不超过 256 的非空字符串。');
  }
  return value.trim();
}

function accountUser(row: AccountRow): AccountUser {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    enabled: Boolean(row.enabled),
    accessRevision: row.access_revision,
  };
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function encodePasswordHash(salt: Buffer, digest: Buffer): string {
  return `${PASSWORD_FORMAT}$${salt.toString('base64url')}$${digest.toString('base64url')}`;
}

function decodePasswordHash(value: string): { salt: Buffer; digest: Buffer } | null {
  const prefix = `${PASSWORD_FORMAT}$`;
  if (!value.startsWith(prefix)) return null;
  const pieces = value.slice(prefix.length).split('$');
  if (pieces.length !== 2 || !pieces[0] || !pieces[1]) return null;
  try {
    const salt = Buffer.from(pieces[0], 'base64url');
    const digest = Buffer.from(pieces[1], 'base64url');
    if (salt.length !== PASSWORD_SALT_BYTES || digest.length !== PASSWORD_HASH_BYTES) return null;
    return { salt, digest };
  } catch {
    return null;
  }
}

function safeEqual(left: Buffer, right: Buffer): boolean {
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export class Accounts {
  readonly dbPath: string;
  private readonly now: () => Date;
  private readonly db: DatabaseSync;
  private readonly loginFailures = new Map<string, LoginFailure>();
  private activeScryptOperations = 0;

  constructor(options: AccountsOptions) {
    if (!options || typeof options.dataDir !== 'string' || !options.dataDir.trim()) {
      throw accountError('INVALID_DATA_DIR', '账户 dataDir 必须是非空目录路径。');
    }
    this.now = options.now ?? (() => new Date());
    mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
    chmodSync(options.dataDir, 0o700);
    this.dbPath = join(options.dataDir, 'accounts.sqlite');
    this.db = new DatabaseSync(this.dbPath);
    chmodSync(this.dbPath, 0o600);
    this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL CHECK(role IN ('admin', 'member')),
        enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
        access_revision INTEGER NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        csrf_token TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('browser', 'device')),
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_by_user ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS sessions_by_expiry ON sessions(expires_at);
    `);
    chmodSync(this.dbPath, 0o600);
    this.purgeExpiredSessions(iso(nowDate(this.now)));
  }

  close(): void {
    this.db.close();
  }

  hasAccounts(): boolean {
    const row = this.db.prepare('SELECT 1 AS present FROM accounts LIMIT 1').get() as { present?: number } | undefined;
    return row?.present === 1;
  }

  ownerId(): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'firstOwnerId'").get() as { value?: string } | undefined;
    return row?.value?.trim() || null;
  }

  private purgeExpiredSessions(asOf: string): void {
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(asOf);
  }

  private getAccountById(id: string): AccountRow | undefined {
    return this.db.prepare(`SELECT id, username, role, enabled, access_revision, password_hash
      FROM accounts WHERE id = ?`).get(id) as AccountRow | undefined;
  }

  private getAccountByUsername(username: string): AccountRow | undefined {
    return this.db.prepare(`SELECT id, username, role, enabled, access_revision, password_hash
      FROM accounts WHERE username = ?`).get(username) as AccountRow | undefined;
  }

  private requireAccount(id: unknown): AccountRow {
    if (typeof id !== 'string' || !id.trim()) throw accountError('ACCOUNT_NOT_FOUND', '账户不存在。', 404);
    const row = this.getAccountById(id.trim());
    if (!row) throw accountError('ACCOUNT_NOT_FOUND', '账户不存在。', 404);
    return row;
  }

  private ensureHashCapacity(): void {
    if (this.activeScryptOperations >= MAX_SCRYPT_OPERATIONS) {
      throw accountError('RATE_LIMITED', '认证服务当前繁忙，请稍后重试。', 429);
    }
    this.activeScryptOperations += 1;
  }

  private async derive(password: string, salt: Buffer): Promise<Buffer> {
    this.ensureHashCapacity();
    try {
      return await new Promise<Buffer>((resolve, reject) => {
        scrypt(password, salt, PASSWORD_HASH_BYTES, {
          N: SCRYPT_N,
          r: SCRYPT_R,
          p: SCRYPT_P,
          maxmem: SCRYPT_MAXMEM,
        }, (error, digest) => {
          if (error) reject(error);
          else resolve(digest as Buffer);
        });
      });
    } finally {
      this.activeScryptOperations -= 1;
    }
  }

  private async hashPassword(password: string): Promise<string> {
    const salt = randomBytes(PASSWORD_SALT_BYTES);
    const digest = await this.derive(password, salt);
    return encodePasswordHash(salt, digest);
  }

  private async verifyPassword(password: string, stored: string | undefined): Promise<boolean> {
    const decoded = stored ? decodePasswordHash(stored) : null;
    const digest = await this.derive(password, decoded?.salt ?? DUMMY_SALT);
    return safeEqual(digest, decoded?.digest ?? DUMMY_HASH);
  }

  private pruneLoginFailures(nowMs: number): void {
    for (const [key, entry] of this.loginFailures) {
      if (nowMs - entry.lastFailedAt >= LOGIN_WINDOW_MS) this.loginFailures.delete(key);
    }
  }

  private assertLoginAllowed(rateKey: string, nowMs: number): void {
    this.pruneLoginFailures(nowMs);
    const entry = this.loginFailures.get(rateKey);
    if (entry && nowMs - entry.firstFailedAt < LOGIN_WINDOW_MS && entry.count >= MAX_LOGIN_FAILURES) {
      throw accountError('RATE_LIMITED', '登录失败次数过多，请稍后重试。', 429);
    }
  }

  private recordLoginFailure(rateKey: string, nowMs: number): void {
    this.pruneLoginFailures(nowMs);
    const current = this.loginFailures.get(rateKey);
    const next: LoginFailure = current && nowMs - current.firstFailedAt < LOGIN_WINDOW_MS
      ? { count: current.count + 1, firstFailedAt: current.firstFailedAt, lastFailedAt: nowMs }
      : { count: 1, firstFailedAt: nowMs, lastFailedAt: nowMs };
    if (!this.loginFailures.has(rateKey) && this.loginFailures.size >= MAX_RATE_KEYS) {
      const oldest = this.loginFailures.keys().next().value;
      if (typeof oldest === 'string') this.loginFailures.delete(oldest);
    }
    this.loginFailures.delete(rateKey);
    this.loginFailures.set(rateKey, next);
  }

  private clearLoginFailures(rateKey: string): void {
    this.loginFailures.delete(rateKey);
  }

  async setup(username: unknown, password: unknown): Promise<AccountUser> {
    const normalizedUsername = normalizeUsername(username);
    const validPassword = validatePassword(password);
    // Avoid an expensive password hash for the common repeated-setup path. The
    // same check is repeated inside BEGIN IMMEDIATE below for first-owner races.
    if (this.hasAccounts() || this.ownerId()) {
      throw accountError('SETUP_COMPLETE', '账户初始化已经完成。', 409);
    }
    const passwordHash = await this.hashPassword(validPassword);
    const now = iso(nowDate(this.now));
    const userId = randomUUID();
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const existing = this.db.prepare('SELECT 1 AS present FROM accounts LIMIT 1').get() as { present?: number } | undefined;
      if (existing?.present === 1 || this.ownerId()) {
        throw accountError('SETUP_COMPLETE', '账户初始化已经完成。', 409);
      }
      const duplicate = this.db.prepare('SELECT 1 AS present FROM accounts WHERE username = ?').get(normalizedUsername) as { present?: number } | undefined;
      if (duplicate?.present === 1) throw accountError('ACCOUNT_EXISTS', '用户名已存在。', 409);
      this.db.prepare(`INSERT INTO accounts(
        id, username, role, enabled, access_revision, password_hash, created_at, updated_at
      ) VALUES (?, ?, 'admin', 1, 1, ?, ?, ?)`).run(userId, normalizedUsername, passwordHash, now, now);
      this.db.prepare("INSERT INTO meta(key, value) VALUES ('firstOwnerId', ?)").run(userId);
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* preserve original error */ }
      if (error instanceof StoreError) throw error;
      throw accountError('WRITE_FAILED', '账户暂时无法保存，请稍后重试。', 503);
    }
    return { id: userId, username: normalizedUsername, role: 'admin', enabled: true, accessRevision: 1 };
  }

  async login(username: unknown, password: unknown, rateKey: unknown): Promise<AccountSessionIssued> {
    const normalizedUsername = normalizeUsername(username);
    const validPassword = validatePassword(password);
    const normalizedRateKey = normalizeRateKey(rateKey);
    const now = nowDate(this.now);
    const nowMs = now.getTime();
    this.assertLoginAllowed(normalizedRateKey, nowMs);
    const account = this.getAccountByUsername(normalizedUsername);
    const valid = await this.verifyPassword(validPassword, account?.password_hash);
    if (!account || !valid || !account.enabled) {
      this.recordLoginFailure(normalizedRateKey, nowMs);
      throw accountError('INVALID_CREDENTIALS', '用户名或密码不正确。', 401);
    }
    // Password verification is asynchronous. Re-read the account before
    // issuing a session so a reset/disable committed while scrypt was running
    // cannot authenticate the stale pre-reset password.
    const current = this.getAccountById(account.id);
    if (!current
        || !current.enabled
        || current.access_revision !== account.access_revision
        || current.password_hash !== account.password_hash) {
      this.recordLoginFailure(normalizedRateKey, nowMs);
      throw accountError('INVALID_CREDENTIALS', '用户名或密码不正确。', 401);
    }
    this.clearLoginFailures(normalizedRateKey);
    try {
      return this.issueSessionInternal(current.id, 'browser', current.access_revision);
    } catch (error) {
      // A concurrent disable should not reveal whether the account existed.
      if (error instanceof StoreError && (error.code === 'ACCOUNT_DISABLED' || error.code === 'ACCOUNT_CHANGED')) {
        throw accountError('INVALID_CREDENTIALS', '用户名或密码不正确。', 401);
      }
      throw error;
    }
  }

  issueSession(userId: unknown, kind: 'browser' | 'device' = 'browser'): AccountSessionIssued {
    if (kind !== 'browser' && kind !== 'device') throw accountError('INVALID_SESSION_KIND', 'session kind 必须是 browser 或 device。');
    return this.issueSessionInternal(userId, kind);
  }

  private issueSessionInternal(userId: unknown, kind: 'browser' | 'device', expectedAccessRevision?: number): AccountSessionIssued {
    const account = this.requireAccount(userId);
    if (!account.enabled) throw accountError('ACCOUNT_DISABLED', '账户已停用。', 403);
    const now = nowDate(this.now);
    const createdAt = iso(now);
    const expiresAt = iso(new Date(now.getTime() + (kind === 'device' ? DEVICE_TTL_MS : BROWSER_TTL_MS)));
    const sessionId = randomUUID();
    const token = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    try {
      this.db.exec('BEGIN IMMEDIATE');
      this.purgeExpiredSessions(createdAt);
      const current = this.getAccountById(account.id);
      if (!current) throw accountError('ACCOUNT_NOT_FOUND', '账户不存在。', 404);
      if (!current.enabled) throw accountError('ACCOUNT_DISABLED', '账户已停用。', 403);
      if (expectedAccessRevision !== undefined && current.access_revision !== expectedAccessRevision) {
        throw accountError('ACCOUNT_CHANGED', '账户凭据已变化，请重新登录。', 409);
      }
      if (kind === 'device') this.db.prepare("DELETE FROM sessions WHERE user_id = ? AND kind = 'device'").run(account.id);
      this.db.prepare(`INSERT INTO sessions(
        session_id, user_id, token_hash, csrf_token, kind, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(sessionId, account.id, tokenHash(token), csrfToken, kind, expiresAt, createdAt);
      this.db.exec('COMMIT');
      return { token, user: accountUser(current), csrfToken, expiresAt, sessionId };
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* preserve original error */ }
      if (error instanceof StoreError) throw error;
      throw accountError('WRITE_FAILED', '会话暂时无法创建，请稍后重试。', 503);
    }
  }

  authenticate(rawToken: unknown): AccountSession | null {
    if (typeof rawToken !== 'string' || !rawToken.trim()) return null;
    const now = nowDate(this.now);
    const row = this.db.prepare(`SELECT s.session_id, s.user_id, s.csrf_token, s.expires_at,
      u.id, u.username, u.role, u.enabled, u.access_revision, u.password_hash
      FROM sessions s JOIN accounts u ON u.id = s.user_id
      WHERE s.token_hash = ?`).get(tokenHash(rawToken.trim())) as (SessionRow & AccountRow) | undefined;
    if (!row) return null;
    if (Date.parse(row.expires_at) <= now.getTime() || !row.enabled) {
      this.db.prepare('DELETE FROM sessions WHERE session_id = ?').run(row.session_id);
      return null;
    }
    return {
      sessionId: row.session_id,
      csrfToken: row.csrf_token,
      expiresAt: row.expires_at,
      user: accountUser(row),
    };
  }

  logout(rawToken: unknown): void {
    if (typeof rawToken !== 'string' || !rawToken.trim()) return;
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(rawToken.trim()));
  }

  listUsers(): AccountUser[] {
    const rows = this.db.prepare(`SELECT id, username, role, enabled, access_revision, password_hash
      FROM accounts ORDER BY created_at ASC, id ASC`).all() as unknown as AccountRow[];
    return rows.map(accountUser);
  }

  async createUser(username: unknown, password: unknown): Promise<AccountUser> {
    const normalizedUsername = normalizeUsername(username);
    const validPassword = validatePassword(password);
    if (!this.hasAccounts()) throw accountError('SETUP_REQUIRED', '请先初始化第一个 owner 账户。', 409);
    const passwordHash = await this.hashPassword(validPassword);
    const now = iso(nowDate(this.now));
    const userId = randomUUID();
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const hasOwner = this.db.prepare('SELECT 1 AS present FROM accounts LIMIT 1').get() as { present?: number } | undefined;
      if (hasOwner?.present !== 1) throw accountError('SETUP_REQUIRED', '请先初始化第一个 owner 账户。', 409);
      const duplicate = this.db.prepare('SELECT 1 AS present FROM accounts WHERE username = ?').get(normalizedUsername) as { present?: number } | undefined;
      if (duplicate?.present === 1) throw accountError('ACCOUNT_EXISTS', '用户名已存在。', 409);
      this.db.prepare(`INSERT INTO accounts(
        id, username, role, enabled, access_revision, password_hash, created_at, updated_at
      ) VALUES (?, ?, 'member', 1, 1, ?, ?, ?)`).run(userId, normalizedUsername, passwordHash, now, now);
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* preserve original error */ }
      if (error instanceof StoreError) throw error;
      throw accountError('WRITE_FAILED', '账户暂时无法保存，请稍后重试。', 503);
    }
    return { id: userId, username: normalizedUsername, role: 'member', enabled: true, accessRevision: 1 };
  }

  async updateUser(id: unknown, update: unknown): Promise<AccountUser> {
    if (typeof update !== 'object' || update === null || Array.isArray(update)) {
      throw accountError('INVALID_ACCOUNT_UPDATE', '账户更新内容必须是对象。');
    }
    const value = update as Record<string, unknown>;
    if ('enabled' in value && typeof value.enabled !== 'boolean') throw accountError('INVALID_ACCOUNT_UPDATE', 'enabled 必须是布尔值。');
    if ('password' in value && value.password !== undefined) validatePassword(value.password);
    const password = value.password === undefined ? undefined : value.password as string;
    const requestedEnabled = value.enabled as boolean | undefined;
    const current = this.requireAccount(id);
    if (requestedEnabled === false && current.id === this.ownerId()) {
      throw accountError('OWNER_PROTECTED', '首个 owner 账户不能被停用。', 409);
    }
    const passwordHash = password === undefined ? undefined : await this.hashPassword(password);
    const now = iso(nowDate(this.now));
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const fresh = this.requireAccount(current.id);
      const enabledChanged = requestedEnabled !== undefined && requestedEnabled !== Boolean(fresh.enabled);
      const passwordChanged = passwordHash !== undefined;
      if (requestedEnabled === false && fresh.id === this.ownerId()) {
        throw accountError('OWNER_PROTECTED', '首个 owner 账户不能被停用。', 409);
      }
      if (enabledChanged || passwordChanged) {
        this.db.prepare(`UPDATE accounts SET
          enabled = ?,
          access_revision = access_revision + 1,
          password_hash = COALESCE(?, password_hash),
          updated_at = ?
          WHERE id = ?`).run(
          requestedEnabled === undefined ? fresh.enabled : requestedEnabled ? 1 : 0,
          passwordHash ?? null,
          now,
          fresh.id,
        );
        this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(fresh.id);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* preserve original error */ }
      if (error instanceof StoreError) throw error;
      throw accountError('WRITE_FAILED', '账户暂时无法更新，请稍后重试。', 503);
    }
    const updated = this.getAccountById(current.id);
    if (!updated) throw accountError('ACCOUNT_NOT_FOUND', '账户不存在。', 404);
    return accountUser(updated);
  }
}
