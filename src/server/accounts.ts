import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import type { AccountUser } from '../shared/accounts.js';
import type { FeishuActor, FeishuScope, FeishuBindingView, FeishuBindingRequestView, FeishuBindingIssued, FeishuBindingConfirmation, FeishuBindingConfirmationResult } from '../shared/feishu-binding.js';
import { StoreError } from './store.js';
import type { FeishuCardDraftInput, FeishuCardStored, FeishuCardNavAction, FeishuCardView } from '../shared/feishu-cards.js';
import type { FeishuDeliveryResult, FeishuReadAuthorization } from '../shared/feishu-reading.js';
import { feishuReviewItemId, feishuReviewEventId, feishuReviewCurrentOperations } from '../shared/feishu-review.js';
import type { FeishuReviewState, FeishuReviewSession, FeishuReviewOperation, FeishuReviewWriteIntent, FeishuReviewTrigger, FeishuReviewMutation, FeishuReviewTransitionContext, FeishuReviewTransitionResult, FeishuReviewTarget, FeishuReviewResolvedTarget } from '../shared/feishu-review.js';

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
  kind: 'browser' | 'device';
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
  kind: 'browser' | 'device';
  session_id: string;
  user_id: string;
  csrf_token: string;
  expires_at: string;
}

export type { FeishuBindingConfirmation } from '../shared/feishu-binding.js';

interface BindingRequestRow {
  id: string; user_id: string; session_id: string; account_access_revision: number;
  status: FeishuBindingRequestView['status']; expires_at: string; open_id: string | null;
}

function validFeishuText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value;
}

function validCardId(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{32}$/.test(value); }
function validFingerprint(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function strictKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function cardPage(value: unknown): boolean { return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 100_000; }
function cardDomain(value: unknown): boolean { return value === null || (typeof value === 'string' && value.length > 0 && value.length <= 512); }
function validCardView(value: unknown, allowRead = true): value is FeishuCardView {
  if (!value || typeof value !== 'object') return false;
  const view = value as Record<string, unknown>;
  if (validReviewTarget(view)) return true;
  if (view.kind === 'help') return strictKeys(view,['kind']);
  if (view.kind === 'domains') return strictKeys(view,['kind','page']) && cardPage(view.page);
  if (view.kind === 'list') return strictKeys(view,['kind','domainId','query','sort','page']) && cardDomain(view.domainId)
    && typeof view.query === 'string' && view.query.length <= 120 && ['elapsed','title'].includes(view.sort as string) && cardPage(view.page);
  if (view.kind === 'due') return strictKeys(view,['kind','domainId','limit']) && cardDomain(view.domainId) && [3,5].includes(view.limit as number);
  if (view.kind === 'read' && allowRead) return strictKeys(view,['kind','reference','page','revision','back'])
    && typeof view.reference === 'string' && /^[a-f0-9]{12,64}$/.test(view.reference) && cardPage(view.page)
    && typeof view.revision === 'string' && /^[a-f0-9]{12}$/.test(view.revision)
    && !!view.back && ['list','due'].includes((view.back as Record<string,unknown>).kind as string) && validCardView(view.back,false);
  return false;
}
function validReviewTarget(value: unknown): value is FeishuReviewTarget {
  if (!value || typeof value !== 'object') return false;
  const target = value as Record<string, unknown>;
  if (target.kind === 'review-batch-start') return strictKeys(value,['kind']);
  if (target.kind === 'review-start') return strictKeys(value, ['kind','reference','revision','domainId'])
    && typeof target.reference === 'string' && /^[a-f0-9]{12,64}$/.test(target.reference)
    && typeof target.revision === 'string' && /^[a-f0-9]{12}$/.test(target.revision) && cardDomain(target.domainId);
  return target.kind === 'review' && strictKeys(value, ['kind','sessionId','version','verb','page'])
    && validCardId(target.sessionId) && positiveInteger(target.version) && cardPage(target.page)
    && ['show','reveal','rate-clear','rate-partial','rate-blank','confirm-review','pause','resume','finish','retry','next','skip'].includes(target.verb as string);
}
function positiveInteger(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }
function reviewInstant(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function metadataBudget(value: unknown): boolean {
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8') <= 16 * 1024; } catch { return false; }
}
function validReviewFrozen(value: unknown): boolean {
  return value === null || (strictKeys(value,['observedAt','configRevision','halfLifeDays','anchorEventId'])
    && reviewInstant(value.observedAt) && positiveInteger(value.configRevision) && typeof value.halfLifeDays === 'number'
    && Number.isFinite(value.halfLifeDays) && value.halfLifeDays > 0
    && (value.anchorEventId === null || validFeishuText(value.anchorEventId)));
}
function validReviewState(value: unknown): value is FeishuReviewState {
  const fields = ['domainId','conceptId','sourceRevision','phase','paused','page','frozen'];
  if (value && typeof value === 'object' && Object.hasOwn(value,'batch')) fields.push('batch');
  if (!strictKeys(value,fields) || !cardDomain(value.domainId) || !validFeishuText(value.conceptId) || !validFeishuText(value.sourceRevision)
      || !['front','revealed','saved','finished'].includes(value.phase as string) || typeof value.paused !== 'boolean'
      || !cardPage(value.page) || !metadataBudget(value) || !validReviewFrozen(value.frozen)) return false;
  if (!Object.hasOwn(value,'batch')) return true;
  const batch = value.batch;
  if (!strictKeys(batch,['requestedSize','cursor','items']) || ![3,5].includes(batch.requestedSize as number)
      || !Array.isArray(batch.items) || batch.items.length < 1 || batch.items.length > (batch.requestedSize as number)
      || !Number.isSafeInteger(batch.cursor) || (batch.cursor as number) < 0 || (batch.cursor as number) >= batch.items.length) return false;
  const ids = new Set<string>(); const concepts = new Set<string>();
  for (const [index,item] of batch.items.entries()) {
    if (!strictKeys(item,['id','conceptId','sourceRevision','frozen','disposition']) || !validCardId(item.id)
        || !validFeishuText(item.conceptId) || !validFeishuText(item.sourceRevision) || ids.has(item.id) || concepts.has(item.conceptId)
        || !validReviewFrozen(item.frozen) || !['open','completed','skipped','ineligible','conflict','ended'].includes(item.disposition as string)) return false;
    ids.add(item.id); concepts.add(item.conceptId);
    if (index < (batch.cursor as number) && item.disposition === 'open') return false;
    if (index > (batch.cursor as number) && (item.disposition !== 'open' || item.frozen !== null)) return false;
    if (index === batch.cursor) {
      if (item.conceptId !== value.conceptId || item.sourceRevision !== value.sourceRevision
          || stableReviewJson(item.frozen) !== stableReviewJson(value.frozen)) return false;
      if ((value.phase === 'finished') === (item.disposition === 'open')) return false;
      if (value.phase === 'front' && item.frozen !== null) return false;
      if (['revealed','saved'].includes(value.phase as string) && item.frozen === null) return false;
    }
  }
  return true;
}
function stableReviewJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableReviewJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableReviewJson(record[key])}`).join(',')}}`;
}
function validReviewIntent(value: unknown, session: FeishuReviewSession): value is FeishuReviewWriteIntent {
  if (!strictKeys(value,['kind','request']) || !metadataBudget(value)) return false;
  const r = value.request;
  const state = session.state;
  if (value.kind === 'observation') {
    if (!strictKeys(r,['eventId','conceptId','sourceRevision','observedAt','configRevision','anchorEventId','answer','evidenceMode','rating','exposure','observedExposure','learning'])
        || state.phase !== 'revealed' || state.paused || !state.frozen
        || r.eventId !== feishuReviewEventId(session,'observation') || r.conceptId !== state.conceptId || r.sourceRevision !== state.sourceRevision
        || r.observedAt !== state.frozen.observedAt || r.configRevision !== state.frozen.configRevision || r.anchorEventId !== state.frozen.anchorEventId
        || r.answer !== '' || r.evidenceMode !== 'mental' || !['clear','partial','blank'].includes(r.rating as string)
        || r.exposure !== 'unknown' || r.observedExposure !== false) return false;
    return strictKeys(r.learning,['task','cue','outcome','basis','confidence','confidenceAt'])
      && r.learning.task === 'concept' && r.learning.cue === 'unknown' && r.learning.outcome === 'unverified'
      && r.learning.basis === 'self-check' && r.learning.confidence === null && r.learning.confidenceAt === null;
  }
  return value.kind === 'review' && strictKeys(r,['eventId','conceptId','sourceRevision','kind','occurredAt'])
    && state.phase === 'saved' && !state.paused && r.eventId === feishuReviewEventId(session,'review')
    && r.conceptId === state.conceptId && r.sourceRevision === state.sourceRevision && r.kind === 'review' && reviewInstant(r.occurredAt);
}

function validCardDraft(value: unknown): value is FeishuCardDraftInput {
  if (!strictKeys(value,['namespace','sourceFingerprint','originChatId','view','actions'])
      || !validFeishuText(value.namespace) || !validFingerprint(value.sourceFingerprint) || !validFeishuText(value.originChatId)
      || !validCardView(value.view) || !Array.isArray(value.actions) || value.actions.length > 16) return false;
  const ids = new Set<string>();
  for (const action of value.actions) {
    if (!strictKeys(action,['id','target']) || typeof action.id !== 'string' || !/^a(?:[0-9]|1[0-5])$/.test(action.id)
        || ids.has(action.id) || !validCardView(action.target)) return false;
    ids.add(action.id);
  }
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8') <= 16 * 1024; }
  catch { return false; }
}
function validCardAction(action: FeishuCardNavAction): boolean {
  return !!action && validCardId(action.cardId) && typeof action.actionId === 'string' && /^a(?:[0-9]|1[0-5])$/.test(action.actionId)
    && [action.appId,action.tenantKey,action.openId,action.eventId,action.messageId,action.chatId].every(validFeishuText);
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
      CREATE TABLE IF NOT EXISTS feishu_bindings (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES accounts(id),
        account_access_revision INTEGER NOT NULL, app_id TEXT NOT NULL,
        tenant_key TEXT NOT NULL, open_id TEXT NOT NULL, bound_at TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS feishu_binding_user_active ON feishu_bindings(user_id) WHERE revoked_at IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS feishu_binding_actor_active ON feishu_bindings(app_id, tenant_key, open_id) WHERE revoked_at IS NULL;
      CREATE TABLE IF NOT EXISTS feishu_binding_requests (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE REFERENCES accounts(id),
        session_id TEXT NOT NULL, account_access_revision INTEGER NOT NULL,
        app_id TEXT NOT NULL, tenant_key TEXT NOT NULL, code_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','confirmed','cancelled','expired','invalidated')),
        confirmed_at TEXT, open_id TEXT, event_id TEXT, message_id TEXT, chat_id TEXT
      );
      CREATE TABLE IF NOT EXISTS feishu_read_receipts (
        operation_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES accounts(id),
        created_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('attempted', 'platform-accepted', 'failed-or-unknown'))
      );
      CREATE TABLE IF NOT EXISTS feishu_card_views (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES accounts(id),
        account_access_revision INTEGER NOT NULL, binding_id TEXT NOT NULL,
        app_id TEXT NOT NULL, tenant_key TEXT NOT NULL, open_id TEXT NOT NULL,
        namespace TEXT NOT NULL, source_fingerprint TEXT NOT NULL, origin_chat_id TEXT NOT NULL,
        view_json TEXT NOT NULL, actions_json TEXT NOT NULL,
        created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
        message_id TEXT, chat_id TEXT,
        status TEXT NOT NULL CHECK(status IN ('draft','active','consumed'))
      );
      CREATE TABLE IF NOT EXISTS feishu_review_sessions (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES accounts(id),
        account_access_revision INTEGER NOT NULL, binding_id TEXT NOT NULL,
        app_id TEXT NOT NULL, tenant_key TEXT NOT NULL, open_id TEXT NOT NULL,
        namespace TEXT NOT NULL, source_fingerprint TEXT NOT NULL, origin_chat_id TEXT NOT NULL,
        created_at TEXT NOT NULL, expires_at TEXT NOT NULL, version INTEGER NOT NULL,
        phase TEXT NOT NULL CHECK(phase IN ('front','revealed','saved','finished')), state_json TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS feishu_review_current ON feishu_review_sessions(binding_id, namespace) WHERE phase != 'finished';
      CREATE TABLE IF NOT EXISTS feishu_review_operations (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES feishu_review_sessions(id), item_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('observation','review')), intent_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','applied','conflict')),
        error_code TEXT, created_at TEXT NOT NULL, settled_at TEXT,
        UNIQUE(session_id, item_id, kind)
      );
      CREATE INDEX IF NOT EXISTS feishu_cards_by_user ON feishu_card_views(user_id);
      CREATE INDEX IF NOT EXISTS sessions_by_user ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS sessions_by_expiry ON sessions(expires_at);
    `);
    this.migrateFeishuReviewItems();
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
      return { token, user: accountUser(current), csrfToken, expiresAt, sessionId, kind };
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* preserve original error */ }
      if (error instanceof StoreError) throw error;
      throw accountError('WRITE_FAILED', '会话暂时无法创建，请稍后重试。', 503);
    }
  }

  authenticate(rawToken: unknown): AccountSession | null {
    if (typeof rawToken !== 'string' || !rawToken.trim()) return null;
    const now = nowDate(this.now);
    const row = this.db.prepare(`SELECT s.session_id, s.user_id, s.csrf_token, s.expires_at, s.kind,
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
      kind: row.kind,
      csrfToken: row.csrf_token,
      expiresAt: row.expires_at,
      user: accountUser(row),
    };
  }

  logout(rawToken: unknown): void {
    if (typeof rawToken !== 'string' || !rawToken.trim()) return;
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(rawToken.trim()));
  }

  private bindingTransaction<T>(action: () => T): T {
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* preserve original error */ }
      if (error instanceof StoreError) throw error;
      throw accountError('WRITE_FAILED', '飞书绑定暂时无法保存，请稍后重试。', 503);
    }
  }

  private requireBindingBrowser(userId: string, sessionId: string, now: string): AccountRow {
    const account = this.getAccountById(userId);
    const session = this.db.prepare('SELECT user_id, kind, expires_at FROM sessions WHERE session_id = ?').get(sessionId) as { user_id: string; kind: string; expires_at: string } | undefined;
    if (!account?.enabled || !session || session.user_id !== userId || session.kind !== 'browser' || session.expires_at <= now) {
      throw accountError('BROWSER_SESSION_REQUIRED', '请使用有效的浏览器会话管理飞书绑定。', 403);
    }
    return account;
  }

  private invalidateFeishuUser(userId: string, now: string): void {
    this.db.prepare('UPDATE feishu_bindings SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(now, userId);
    this.db.prepare("UPDATE feishu_binding_requests SET status = 'invalidated' WHERE user_id = ? AND status IN ('pending','confirmed')").run(userId);
  }

  private refreshFeishuRequest(userId: string, now: string): void {
    this.db.prepare(`UPDATE feishu_binding_requests SET status = CASE WHEN expires_at <= ? THEN 'expired' ELSE 'invalidated' END
      WHERE user_id = ? AND status = 'pending' AND (expires_at <= ? OR NOT EXISTS (
        SELECT 1 FROM sessions s JOIN accounts a ON a.id = s.user_id
        WHERE s.session_id = feishu_binding_requests.session_id AND s.user_id = feishu_binding_requests.user_id
          AND s.kind = 'browser' AND s.expires_at > ? AND a.enabled = 1
          AND a.access_revision = feishu_binding_requests.account_access_revision
      ))`).run(now, userId, now, now);
  }

  getFeishuBindingState(userId: string): { binding: FeishuBindingView | null; request: FeishuBindingRequestView | null } {
    const now = iso(nowDate(this.now));
    this.refreshFeishuRequest(userId, now);
    const binding = this.db.prepare(`SELECT b.id, b.app_id AS appId, b.tenant_key AS tenantKey, b.open_id AS openId, b.bound_at AS boundAt
      FROM feishu_bindings b JOIN accounts a ON a.id = b.user_id
      WHERE b.user_id = ? AND b.revoked_at IS NULL AND a.enabled = 1 AND a.access_revision = b.account_access_revision`).get(userId) as unknown as FeishuBindingView | undefined;
    const request = this.db.prepare(`SELECT id, status, expires_at AS expiresAt, confirmed_at AS confirmedAt FROM feishu_binding_requests WHERE user_id = ?`).get(userId) as unknown as FeishuBindingRequestView | undefined;
    return { binding: binding ?? null, request: request ?? null };
  }

  issueFeishuBindingRequest(userId: string, sessionId: string, scope: FeishuScope): FeishuBindingIssued {
    if (!validFeishuText(scope?.appId) || !validFeishuText(scope?.tenantKey)) throw accountError('INVALID_FEISHU_SCOPE', '飞书应用范围无效。');
    const now = nowDate(this.now);
    const createdAt = iso(now);
    const code = `LM-${randomBytes(16).toString('base64url')}`;
    return this.bindingTransaction(() => {
      const account = this.requireBindingBrowser(userId, sessionId, createdAt);
      if (this.db.prepare('SELECT 1 FROM feishu_bindings WHERE user_id = ? AND revoked_at IS NULL').get(userId)) {
        throw accountError('FEISHU_ALREADY_BOUND', '请先解除已有飞书绑定。', 409);
      }
      const session = this.db.prepare('SELECT expires_at FROM sessions WHERE session_id = ?').get(sessionId) as { expires_at: string };
      const expiresAt = iso(new Date(Math.min(now.getTime() + 10 * 60 * 1000, Date.parse(session.expires_at))));
      const id = randomUUID();
      this.db.prepare('DELETE FROM feishu_binding_requests WHERE user_id = ?').run(userId);
      this.db.prepare(`INSERT INTO feishu_binding_requests(id,user_id,session_id,account_access_revision,app_id,tenant_key,code_hash,created_at,expires_at,status)
        VALUES(?,?,?,?,?,?,?,?,?,'pending')`).run(id,userId,sessionId,account.access_revision,scope.appId,scope.tenantKey,tokenHash(code),createdAt,expiresAt);
      return { request: { id, status: 'pending', expiresAt, confirmedAt: null }, command: `确认绑定 ${code}` };
    });
  }

  cancelFeishuBindingRequest(userId: string, sessionId: string, requestId: unknown): void {
    if (!validFeishuText(requestId)) throw accountError('INVALID_FEISHU_REQUEST', '绑定请求标识无效。');
    this.bindingTransaction(() => {
      this.requireBindingBrowser(userId, sessionId, iso(nowDate(this.now)));
      this.db.prepare("UPDATE feishu_binding_requests SET status = 'cancelled' WHERE id = ? AND user_id = ? AND status = 'pending'").run(requestId, userId);
    });
  }

  revokeFeishuBinding(userId: string, sessionId: string, bindingId: unknown): void {
    if (!validFeishuText(bindingId)) throw accountError('INVALID_FEISHU_BINDING', '飞书绑定标识无效。');
    const now = iso(nowDate(this.now));
    this.bindingTransaction(() => {
      this.requireBindingBrowser(userId, sessionId, now);
      const existing = this.db.prepare('SELECT revoked_at FROM feishu_bindings WHERE id = ? AND user_id = ?').get(bindingId, userId) as { revoked_at: string | null } | undefined;
      if (!existing) throw accountError('FEISHU_BINDING_NOT_FOUND', '飞书绑定不存在。', 404);
      if (existing.revoked_at !== null) return;
      this.db.prepare('UPDATE feishu_bindings SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL').run(now, bindingId, userId);
      this.db.prepare("UPDATE feishu_binding_requests SET status = 'invalidated' WHERE user_id = ? AND status IN ('pending','confirmed')").run(userId);
    });
  }

  confirmFeishuBinding(input: FeishuBindingConfirmation): FeishuBindingConfirmationResult {
    if (!input || typeof input.code !== 'string' || !/^LM-[A-Za-z0-9_-]{22}$/.test(input.code) || ![input.appId,input.tenantKey,input.openId,input.eventId,input.messageId,input.chatId].every(validFeishuText)) return { status: 'rejected' };
    const now = iso(nowDate(this.now));
    return this.bindingTransaction(() => {
      const row = this.db.prepare('SELECT * FROM feishu_binding_requests WHERE code_hash = ? AND app_id = ? AND tenant_key = ?').get(tokenHash(input.code), input.appId, input.tenantKey) as unknown as BindingRequestRow | undefined;
      if (!row) return { status: 'rejected' };
      this.refreshFeishuRequest(row.user_id, now);
      const account = this.getAccountById(row.user_id);
      if (!account?.enabled || account.access_revision !== row.account_access_revision) return { status: 'rejected' };
      if (row.status === 'confirmed') {
        const binding = this.resolveFeishuAccount(input);
        const activeRequest = this.db.prepare('SELECT status FROM feishu_binding_requests WHERE id = ?').get(row.id) as {status: string};
        return { status: activeRequest.status === 'confirmed' && row.open_id === input.openId && binding?.id === row.user_id ? 'duplicate' : 'rejected' };
      }
      if (row.status !== 'pending' || row.expires_at <= now) return { status: 'rejected' };
      try { this.requireBindingBrowser(row.user_id, row.session_id, now); } catch (error) { if (error instanceof StoreError) return { status: 'rejected' }; throw error; }
      if (this.db.prepare(`SELECT 1 FROM feishu_bindings WHERE revoked_at IS NULL AND (user_id = ? OR (app_id = ? AND tenant_key = ? AND open_id = ?))`).get(row.user_id,input.appId,input.tenantKey,input.openId)) return { status: 'rejected' };
      this.db.prepare(`INSERT INTO feishu_bindings(id,user_id,account_access_revision,app_id,tenant_key,open_id,bound_at) VALUES(?,?,?,?,?,?,?)`).run(randomUUID(),row.user_id,account.access_revision,input.appId,input.tenantKey,input.openId,now);
      this.db.prepare(`UPDATE feishu_binding_requests SET status = 'confirmed', confirmed_at = ?, open_id = ?, event_id = ?, message_id = ?, chat_id = ? WHERE id = ?`).run(now,input.openId,input.eventId,input.messageId,input.chatId,row.id);
      return { status: 'confirmed' };
    });
  }

  resolveFeishuAccount(actor: FeishuActor): AccountUser | null {
    if (!actor || ![actor.appId,actor.tenantKey,actor.openId].every(validFeishuText)) return null;
    const row = this.db.prepare(`SELECT a.id,a.username,a.role,a.enabled,a.access_revision,a.password_hash FROM feishu_bindings b JOIN accounts a ON a.id = b.user_id
      WHERE b.app_id = ? AND b.tenant_key = ? AND b.open_id = ? AND b.revoked_at IS NULL AND a.enabled = 1 AND a.access_revision = b.account_access_revision`).get(actor.appId,actor.tenantKey,actor.openId) as unknown as AccountRow | undefined;
    return row ? accountUser(row) : null;
  }

  /** Persist a metadata-only receipt before any external delivery attempt. */
  claimFeishuRead(operationId: string, actor: FeishuActor, authorization: FeishuReadAuthorization): boolean {
    this.validateFeishuReadOperation(operationId);
    if (!actor || ![actor.appId, actor.tenantKey, actor.openId].every(validFeishuText)
        || !authorization || !validFeishuText(authorization.userId) || !validFeishuText(authorization.bindingId)
        || !Number.isSafeInteger(authorization.accessRevision) || authorization.accessRevision < 1) return false;
    const now = iso(nowDate(this.now));
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const result = this.db.prepare(`INSERT OR IGNORE INTO feishu_read_receipts(operation_id, user_id, created_at, status)
        SELECT ?, a.id, ?, 'attempted' FROM accounts a JOIN feishu_bindings b ON b.user_id = a.id
        WHERE a.id = ? AND a.enabled = 1 AND a.access_revision = ?
          AND b.id = ? AND b.revoked_at IS NULL AND b.account_access_revision = a.access_revision
          AND b.app_id = ? AND b.tenant_key = ? AND b.open_id = ?`).run(
          operationId, now, authorization.userId, authorization.accessRevision, authorization.bindingId,
          actor.appId, actor.tenantKey, actor.openId,
        );
      this.db.exec('COMMIT');
      return result.changes === 1;
    } catch {
      try { this.db.exec('ROLLBACK'); } catch { /* preserve fixed receipt error */ }
      throw accountError('WRITE_FAILED', '飞书读取回执暂时无法保存，请稍后重试。', 503);
    }
  }

  /** Delivery outcome is final: unknown outcomes are never retried implicitly. */
  finishFeishuRead(operationId: string, userId: string, result: FeishuDeliveryResult): void {
    this.validateFeishuReadOperation(operationId);
    if (result !== 'platform-accepted' && result !== 'failed-or-unknown') {
      throw accountError('INVALID_FEISHU_DELIVERY_RESULT', '飞书发送结果无效。');
    }
    if (typeof userId !== 'string' || !userId) return;
    try {
      this.db.prepare(`UPDATE feishu_read_receipts SET status = ?
        WHERE operation_id = ? AND user_id = ? AND status = 'attempted'`).run(result, operationId, userId);
    } catch {
      throw accountError('WRITE_FAILED', '飞书读取回执暂时无法保存，请稍后重试。', 503);
    }
  }

  private validateFeishuReadOperation(operationId: unknown): void {
    if (typeof operationId !== 'string' || !/^[a-f0-9]{32}$/.test(operationId)) {
      throw accountError('INVALID_FEISHU_OPERATION', '飞书读取操作标识无效。');
    }
  }

  private cardTransaction<T>(action: () => T): T {
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch {
      try { this.db.exec('ROLLBACK'); } catch { /* fixed card error only */ }
      throw accountError('WRITE_FAILED', '飞书卡片状态暂时无法保存，请稍后重试。', 503);
    }
  }

  private cardAuthorization(actor: FeishuActor, auth: FeishuReadAuthorization): boolean {
    if (!actor || !auth || ![actor.appId, actor.tenantKey, actor.openId, auth.userId, auth.bindingId].every(validFeishuText)
        || !Number.isSafeInteger(auth.accessRevision)) return false;
    return !!this.db.prepare(`SELECT 1 FROM feishu_bindings b JOIN accounts a ON a.id = b.user_id
      WHERE b.id = ? AND a.id = ? AND a.enabled = 1 AND a.access_revision = ?
        AND b.account_access_revision = a.access_revision AND b.revoked_at IS NULL
        AND b.app_id = ? AND b.tenant_key = ? AND b.open_id = ?`).get(
          auth.bindingId, auth.userId, auth.accessRevision, actor.appId, actor.tenantKey, actor.openId);
  }

  private cardById(id: string): FeishuCardStored | null {
    const row = this.db.prepare('SELECT * FROM feishu_card_views WHERE id = ?').get(id);
    if (!row) return null;
    return {
      id: row.id as string, actor: { appId: row.app_id as string, tenantKey: row.tenant_key as string, openId: row.open_id as string },
      authorization: { userId: row.user_id as string, bindingId: row.binding_id as string, accessRevision: row.account_access_revision as number },
      namespace: row.namespace as string, sourceFingerprint: row.source_fingerprint as string, originChatId: row.origin_chat_id as string,
      view: JSON.parse(row.view_json as string) as FeishuCardView, actions: JSON.parse(row.actions_json as string) as FeishuCardStored['actions'],
      createdAt: row.created_at as string, expiresAt: row.expires_at as string, messageId: row.message_id as string | null,
      chatId: row.chat_id as string | null, status: row.status as FeishuCardStored['status'],
    };
  }

  private sameCardOwner(card: FeishuCardStored, actor: FeishuActor, auth: FeishuReadAuthorization): boolean {
    return !!actor && !!auth && card.actor.appId === actor.appId && card.actor.tenantKey === actor.tenantKey
      && card.actor.openId === actor.openId && card.authorization.userId === auth.userId
      && card.authorization.bindingId === auth.bindingId && card.authorization.accessRevision === auth.accessRevision;
  }

  createFeishuCardDraft(actor: FeishuActor, auth: FeishuReadAuthorization, input: FeishuCardDraftInput): FeishuCardStored | null {
    if (!validCardDraft(input)) return null;
    const now = nowDate(this.now);
    const createdAt = iso(now);
    return this.cardTransaction(() => {
      if (!this.cardAuthorization(actor, auth)) return null;
      this.db.prepare("DELETE FROM feishu_card_views WHERE expires_at <= ? OR (user_id = ? AND status = 'consumed')").run(createdAt, auth.userId);
      const count = this.db.prepare('SELECT COUNT(*) AS count FROM feishu_card_views WHERE user_id = ?').get(auth.userId) as { count: number };
      if (count.count >= 32) return null;
      const id = randomUUID().replaceAll('-', '');
      const expiresAt = iso(new Date(now.getTime() + 30 * 60 * 1000));
      this.db.prepare(`INSERT INTO feishu_card_views(id,user_id,account_access_revision,binding_id,app_id,tenant_key,open_id,
        namespace,source_fingerprint,origin_chat_id,view_json,actions_json,created_at,expires_at,status)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft')`).run(id,auth.userId,auth.accessRevision,auth.bindingId,
          actor.appId,actor.tenantKey,actor.openId,input.namespace,input.sourceFingerprint,input.originChatId,
          JSON.stringify(input.view),JSON.stringify(input.actions),createdAt,expiresAt);
      return this.cardById(id);
    });
  }

  isFeishuCardDraftAuthorized(cardId: string, actor: FeishuActor, auth: FeishuReadAuthorization): boolean {
    if (!validCardId(cardId)) return false;
    try {
      const card = this.cardById(cardId);
      return !!card && card.status === 'draft' && card.expiresAt > iso(nowDate(this.now))
        && this.sameCardOwner(card,actor,auth) && this.cardAuthorization(actor,auth);
    } catch { throw accountError('WRITE_FAILED', '飞书卡片状态暂时无法读取，请稍后重试。', 503); }
  }

  discardFeishuCard(cardId: string, actor: FeishuActor, auth: FeishuReadAuthorization): void {
    if (!validCardId(cardId)) return;
    this.cardTransaction(() => {
      const card = this.cardById(cardId);
      if (card?.status === 'draft' && this.sameCardOwner(card,actor,auth)) {
        this.db.prepare("DELETE FROM feishu_card_views WHERE id = ? AND status = 'draft'").run(cardId);
      }
    });
  }

  activateFeishuCard(cardId: string, actor: FeishuActor, auth: FeishuReadAuthorization, delivery: { messageId: string; chatId: string }): boolean {
    if (!validCardId(cardId) || !delivery || ![delivery.messageId,delivery.chatId].every(validFeishuText)) return false;
    return this.cardTransaction(() => {
      const card = this.cardById(cardId);
      if (!card || card.status !== 'draft' || card.expiresAt <= iso(nowDate(this.now)) || delivery.chatId !== card.originChatId
          || !this.sameCardOwner(card,actor,auth) || !this.cardAuthorization(actor,auth)) return false;
      this.db.prepare("UPDATE feishu_card_views SET status = 'consumed' WHERE binding_id = ? AND status = 'active'").run(auth.bindingId);
      this.db.prepare("UPDATE feishu_card_views SET status = 'active', message_id = ?, chat_id = ? WHERE id = ?").run(delivery.messageId,delivery.chatId,cardId);
      return true;
    });
  }

  getFeishuCardForAction(action: FeishuCardNavAction): FeishuCardStored | null {
    if (!validCardAction(action)) return null;
    try {
      const card = this.cardById(action.cardId);
      return card && card.status === 'active' && card.expiresAt > iso(nowDate(this.now))
        && this.sameCardOwner(card,action,card.authorization) && this.cardAuthorization(action,card.authorization)
        && card.messageId === action.messageId && card.chatId === action.chatId && card.originChatId === action.chatId
        && card.actions.some(entry => entry.id === action.actionId) ? card : null;
    } catch { throw accountError('WRITE_FAILED', '飞书卡片状态暂时无法读取，请稍后重试。', 503); }
  }

  claimFeishuCardAction(action: FeishuCardNavAction, auth: FeishuReadAuthorization,
    expected: { cardId: string; namespace: string; sourceFingerprint: string }): { card: FeishuCardStored; target: FeishuCardView; operationId: string } | null {
    if (!validCardAction(action) || !expected || expected.cardId !== action.cardId
        || !validFeishuText(expected.namespace) || !validFingerprint(expected.sourceFingerprint)) return null;
    return this.cardTransaction(() => {
      const card = this.getFeishuCardForAction(action);
      if (!card || !this.sameCardOwner(card,action,auth) || card.namespace !== expected.namespace
          || card.sourceFingerprint !== expected.sourceFingerprint) return null;
      const target = card.actions.find(entry => entry.id === action.actionId)!.target;
      const operationId = tokenHash(JSON.stringify(['feishu-card-click-v1',card.id,action.actionId])).slice(0,32);
      const receipt = this.db.prepare("INSERT OR IGNORE INTO feishu_read_receipts(operation_id,user_id,created_at,status) VALUES(?,?,?,'attempted')")
        .run(operationId,auth.userId,iso(nowDate(this.now)));
      if (!receipt.changes) return null;
      this.db.prepare("UPDATE feishu_card_views SET status = 'consumed' WHERE id = ?").run(card.id);
      return { card, target, operationId };
    });
  }

  /** Add per-item journals without rewriting legacy session state or immutable intents. */
  private migrateFeishuReviewItems(): void {
    const columns = this.db.prepare('PRAGMA table_info(feishu_review_operations)').all();
    if (columns.some(column => column.name === 'item_id')) return;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      if (this.db.prepare('PRAGMA table_info(feishu_review_operations)').all().some(column=>column.name === 'item_id')) {
        this.db.exec('COMMIT');
        return;
      }
      this.db.exec(`ALTER TABLE feishu_review_operations RENAME TO feishu_review_operations_legacy_03b;
        CREATE TABLE feishu_review_operations (
          id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES feishu_review_sessions(id), item_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('observation','review')), intent_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('pending','applied','conflict')),
          error_code TEXT, created_at TEXT NOT NULL, settled_at TEXT,
          UNIQUE(session_id,item_id,kind)
        );
        INSERT INTO feishu_review_operations(id,session_id,item_id,kind,intent_json,status,error_code,created_at,settled_at)
          SELECT id,session_id,session_id,kind,intent_json,status,error_code,created_at,settled_at FROM feishu_review_operations_legacy_03b;
        DROP TABLE feishu_review_operations_legacy_03b;
        COMMIT;`);
    } catch {
      try { this.db.exec('ROLLBACK'); } catch { /* preserve fixed migration error */ }
      throw accountError('WRITE_FAILED','飞书复习记录迁移暂时无法完成。',503);
    }
  }

  private reviewSessionById(id: string): FeishuReviewSession | null {
    const row = this.db.prepare('SELECT * FROM feishu_review_sessions WHERE id = ?').get(id);
    if (!row) return null;
    const state: unknown = JSON.parse(row.state_json as string);
    if (!validReviewState(state) || state.phase !== row.phase || !positiveInteger(row.version)) throw new Error('Invalid review state');
    return { id: row.id as string,
      actor: { appId: row.app_id as string, tenantKey: row.tenant_key as string, openId: row.open_id as string },
      authorization: { userId: row.user_id as string, bindingId: row.binding_id as string, accessRevision: row.account_access_revision as number },
      namespace: row.namespace as string, sourceFingerprint: row.source_fingerprint as string,
      originChatId: row.origin_chat_id as string, createdAt: row.created_at as string, expiresAt: row.expires_at as string,
      version: row.version as number, state };
  }

  private sameReviewOwner(session: FeishuReviewSession, actor: FeishuActor, auth: FeishuReadAuthorization): boolean {
    return !!actor && !!auth && session.actor.appId === actor.appId && session.actor.tenantKey === actor.tenantKey
      && session.actor.openId === actor.openId && session.authorization.userId === auth.userId
      && session.authorization.bindingId === auth.bindingId && session.authorization.accessRevision === auth.accessRevision;
  }

  private reviewOperations(sessionId: string): FeishuReviewOperation[] {
    return this.db.prepare('SELECT * FROM feishu_review_operations WHERE session_id = ? ORDER BY created_at, id').all(sessionId).map(row => ({
      id: row.id as string, sessionId: row.session_id as string, itemId: (row.item_id ?? row.session_id) as string, intent: JSON.parse(row.intent_json as string) as FeishuReviewWriteIntent,
      status: row.status as FeishuReviewOperation['status'], errorCode: row.error_code as string | null,
      createdAt: row.created_at as string, settledAt: row.settled_at as string | null,
    }));
  }

  getFeishuReviewSession(actor: FeishuActor, auth: FeishuReadAuthorization, namespace: string): FeishuReviewSession | null {
    if (!validFeishuText(namespace)) return null;
    try {
      if (!this.cardAuthorization(actor, auth)) return null;
      const row = this.db.prepare("SELECT id FROM feishu_review_sessions WHERE binding_id = ? AND namespace = ? AND phase != 'finished'")
        .get(auth.bindingId, namespace);
      const session = row ? this.reviewSessionById(row.id as string) : null;
      return session && this.sameReviewOwner(session, actor, auth) ? session : null;
    } catch { throw accountError('WRITE_FAILED', '飞书复习状态暂时无法读取，请稍后重试。', 503); }
  }

  getFeishuReviewOperations(sessionId: string, actor: FeishuActor, auth: FeishuReadAuthorization): FeishuReviewOperation[] {
    if (!validCardId(sessionId)) return [];
    try {
      const session = this.reviewSessionById(sessionId);
      return session && this.sameReviewOwner(session, actor, auth) && this.cardAuthorization(actor, auth)
        ? this.reviewOperations(sessionId) : [];
    } catch { throw accountError('WRITE_FAILED', '飞书复习状态暂时无法读取，请稍后重试。', 503); }
  }

  isFeishuReviewVersionAuthorized(sessionId: string, version: number, actor: FeishuActor, auth: FeishuReadAuthorization): boolean {
    if (!validCardId(sessionId) || !positiveInteger(version)) return false;
    try {
      const session = this.reviewSessionById(sessionId);
      return !!session && session.version === version && this.sameReviewOwner(session, actor, auth) && this.cardAuthorization(actor, auth);
    } catch { throw accountError('WRITE_FAILED', '飞书复习状态暂时无法读取，请稍后重试。', 503); }
  }

  claimFeishuReviewTransition(actor: FeishuActor, auth: FeishuReadAuthorization, trigger: FeishuReviewTrigger,
    scope: { namespace: string; sourceFingerprint: string; originChatId: string },
    reduce: (input: FeishuReviewTransitionContext) => FeishuReviewMutation | null): FeishuReviewTransitionResult | null {
    if (!scope || !validFeishuText(scope.namespace) || !validFingerprint(scope.sourceFingerprint)
        || !validFeishuText(scope.originChatId) || typeof reduce !== 'function' || !trigger
        || !['message','card'].includes(trigger.kind)) return null;
    const incoming = trigger.kind === 'message' ? trigger.message : trigger.action;
    if (!incoming || !actor || incoming.appId !== actor.appId || incoming.tenantKey !== actor.tenantKey || incoming.openId !== actor.openId
        || ![incoming.eventId,incoming.messageId,incoming.chatId].every(validFeishuText) || incoming.chatId !== scope.originChatId
        || (trigger.kind === 'message' && (typeof trigger.message.text !== 'string' || trigger.message.text.length > 4096))
        || (trigger.kind === 'card' && !validCardAction(trigger.action))) return null;
    return this.cardTransaction(() => {
      if (!this.cardAuthorization(actor, auth)) return null;
      const session = this.getFeishuReviewSession(actor, auth, scope.namespace);
      if (session && session.originChatId !== scope.originChatId) return null;
      const operations = session ? this.reviewOperations(session.id) : [];
      let target: FeishuReviewResolvedTarget | null = null;
      let card: FeishuCardStored | null = null;
      if (trigger.kind === 'card') {
        card = this.getFeishuCardForAction(trigger.action);
        if (!card || !this.sameCardOwner(card, actor, auth) || card.namespace !== scope.namespace
            || card.sourceFingerprint !== scope.sourceFingerprint || card.originChatId !== scope.originChatId) return null;
        const candidate = card.actions.find(action => action.id === trigger.action.actionId)?.target;
        if (!validReviewTarget(candidate)) return null;
        if (candidate.kind === 'review-batch-start') {
          if (card.view.kind !== 'due') return null;
          target = { ...candidate,domainId:card.view.domainId,limit:card.view.limit };
        } else target = candidate;
        if (target.kind === 'review' && (!session || target.sessionId !== session.id || target.version !== session.version)) return null;
      }
      const operationId = trigger.kind === 'message'
        ? tokenHash(JSON.stringify(['feishu-read-v1',actor.appId,actor.tenantKey,actor.openId,incoming.messageId])).slice(0,32)
        : tokenHash(JSON.stringify(['feishu-card-click-v1',trigger.action.cardId,trigger.action.actionId])).slice(0,32);
      if (this.db.prepare('SELECT 1 FROM feishu_read_receipts WHERE operation_id = ?').get(operationId)) return null;
      const mutation = reduce(structuredClone({ session, operations, target }));
      if (mutation && typeof (mutation as unknown as { then?: unknown }).then === 'function') {
        // Reject asynchronous reducers; suppress a rejected promise without awaiting it.
        Promise.resolve(mutation).catch(() => {});
        return null;
      }
      if (!mutation || typeof mutation !== 'object') return null;
      const now = iso(nowDate(this.now));
      let next = session;
      let newIntent: FeishuReviewWriteIntent | null = null;
      if (mutation.kind === 'create') {
        if (!strictKeys(mutation,['kind','id','state']) || session || !validCardId(mutation.id) || !validReviewState(mutation.state)
            || mutation.state.phase !== 'front' || mutation.state.paused || mutation.state.page !== 1 || mutation.state.frozen !== null
            || (mutation.state.batch && mutation.state.batch.cursor !== 0)
            || this.db.prepare('SELECT 1 FROM feishu_review_sessions WHERE id = ?').get(mutation.id)) return null;
        next = { id: mutation.id, actor: { ...actor }, authorization: { ...auth }, ...scope, createdAt: now,
          expiresAt: iso(new Date(Date.parse(now) + 24 * 60 * 60_000)), version: 1, state: mutation.state };
      } else if (mutation.kind === 'update') {
        const keys = Object.hasOwn(mutation,'intent') ? ['kind','state','intent'] : ['kind','state'];
        if (!strictKeys(mutation,keys) || !session || !validReviewState(mutation.state) || session.version >= Number.MAX_SAFE_INTEGER) return null;
        const before = session.state; const after = mutation.state;
        if (after.domainId !== before.domainId || after.conceptId !== before.conceptId || after.sourceRevision !== before.sourceRevision) return null;
        if (before.frozen !== null && stableReviewJson(after.frozen) !== stableReviewJson(before.frozen)) return null;
        if (!!before.batch !== !!after.batch) return null;
        if (before.batch && after.batch) {
          if (before.batch.cursor !== after.batch.cursor || before.batch.requestedSize !== after.batch.requestedSize
              || after.phase === 'finished') return null;
          const unchanged = { ...after.batch,items:after.batch.items.map((item,index)=>index === before.batch!.cursor
            ? { ...item,frozen:before.batch!.items[index]!.frozen } : item) };
          if (stableReviewJson(unchanged) !== stableReviewJson(before.batch)) return null;
        }
        const reveal = before.phase === 'front' && after.phase === 'revealed';
        if (before.frozen === null && after.frozen !== null && !reveal) return null;
        if (reveal && (before.paused || after.paused || !after.frozen || after.frozen.observedAt > now
            || session.expiresAt <= now || session.sourceFingerprint !== scope.sourceFingerprint)) return null;
        if (after.phase !== before.phase && !reveal && after.phase !== 'finished') return null;
        if (after.phase === 'finished' && operations.some(operation => operation.status === 'pending')) return null;
        next = { ...session, version: session.version + 1, state: after };
        if (mutation.intent !== undefined) {
          if (!validReviewIntent(mutation.intent,next)) return null;
          if (mutation.intent.kind === 'observation' && before.phase !== 'revealed') return null;
          if (mutation.intent.kind === 'review' && (before.phase !== 'saved'
              || !feishuReviewCurrentOperations(session,operations).some(operation => operation.intent.kind === 'observation' && operation.status === 'applied'))) return null;
          const existing = feishuReviewCurrentOperations(session,operations).find(operation => operation.intent.kind === mutation.intent!.kind);
          if (existing && stableReviewJson(existing.intent) !== stableReviewJson(mutation.intent)) return null;
          if (!existing && (session.expiresAt <= now || session.sourceFingerprint !== scope.sourceFingerprint
              || operations.some(operation=>operation.status === 'pending'))) return null;
          if (!existing) newIntent = mutation.intent;
        }
      } else if (mutation.kind === 'advance' || mutation.kind === 'finish') {
        const advance = mutation.kind === 'advance';
        if (!strictKeys(mutation,advance ? ['kind','disposition'] : ['kind']) || !session
            || session.version >= Number.MAX_SAFE_INTEGER || operations.some(operation=>operation.status === 'pending')) return null;
        const state = session.state; const current = feishuReviewCurrentOperations(session,operations);
        const conflict = current.some(operation=>operation.status === 'conflict');
        const completed = current.some(operation=>operation.intent.kind === 'observation' && operation.status === 'applied');
        if (advance) {
          if (!state.batch || state.paused || session.expiresAt <= now || session.sourceFingerprint !== scope.sourceFingerprint
              || !['completed','skipped','ineligible','conflict'].includes(mutation.disposition)) return null;
          if (mutation.disposition === 'completed' && (state.phase !== 'saved' || !completed || conflict)) return null;
          if (mutation.disposition === 'skipped' && (!['front','revealed'].includes(state.phase) || current.length !== 0)) return null;
          if (mutation.disposition === 'ineligible' && (state.phase !== 'front' || state.frozen !== null || current.length !== 0)) return null;
          if (mutation.disposition === 'conflict' && !conflict) return null;
          const last = state.batch.cursor === state.batch.items.length - 1;
          const items = state.batch.items.map((item,index)=>index === state.batch!.cursor ? { ...item,disposition:mutation.disposition } : item);
          const cursor = last ? state.batch.cursor : state.batch.cursor + 1;
          const item = items[cursor]!;
          next = { ...session,version:session.version+1,state:{ ...state,conceptId:item.conceptId,sourceRevision:item.sourceRevision,
            frozen:item.frozen,phase:last ? 'finished' : 'front',page:1,batch:{ ...state.batch,cursor,items } } };
        } else {
          const disposition = conflict ? 'conflict' : completed ? 'completed' : 'ended';
          next = { ...session,version:session.version+1,state:{ ...state,phase:'finished',...(state.batch ? { batch:{ ...state.batch,
            items:state.batch.items.map((item,index)=>index === state.batch!.cursor ? { ...item,disposition } : item) } } : {}) } };
        }
        if (!validReviewState(next.state)) return null;
      } else if (mutation.kind !== 'none' || !strictKeys(mutation,['kind'])) return null;
      const receipt = this.db.prepare("INSERT OR IGNORE INTO feishu_read_receipts(operation_id,user_id,created_at,status) VALUES(?,?,?,'attempted')")
        .run(operationId,auth.userId,now);
      if (receipt.changes !== 1) return null;
      if (card) this.db.prepare("UPDATE feishu_card_views SET status = 'consumed' WHERE id = ? AND status = 'active'").run(card.id);
      if (mutation.kind === 'create' && next) {
        this.db.prepare(`INSERT INTO feishu_review_sessions(id,user_id,account_access_revision,binding_id,app_id,tenant_key,open_id,
          namespace,source_fingerprint,origin_chat_id,created_at,expires_at,version,phase,state_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(next.id,auth.userId,auth.accessRevision,auth.bindingId,actor.appId,actor.tenantKey,actor.openId,
            next.namespace,next.sourceFingerprint,next.originChatId,next.createdAt,next.expiresAt,next.version,next.state.phase,JSON.stringify(next.state));
      } else if (['update','advance','finish'].includes(mutation.kind) && next && session) {
        const changed = this.db.prepare('UPDATE feishu_review_sessions SET version = ?, phase = ?, state_json = ? WHERE id = ? AND version = ?')
          .run(next.version,next.state.phase,JSON.stringify(next.state),next.id,session.version);
        if (changed.changes !== 1) throw new Error('Review version changed');
      }
      if (newIntent && next) this.db.prepare(`INSERT INTO feishu_review_operations(id,session_id,item_id,kind,intent_json,status,created_at)
        VALUES(?,?,?,?,?,'pending',?)`).run(newIntent.request.eventId,next.id,feishuReviewItemId(next),newIntent.kind,stableReviewJson(newIntent),now);
      return { operationId, session: next ? this.reviewSessionById(next.id) : null, operations: next ? this.reviewOperations(next.id) : [] };
    });
  }

  settleFeishuReviewOperation(operationId: string, actor: FeishuActor, auth: FeishuReadAuthorization,
    result: { status: 'applied' | 'conflict'; errorCode?: string }): FeishuReviewSession | null {
    const safeCodes = ['EVENT_CONFLICT','ANCHOR_CONFLICT','CONFIG_REVISION_UNKNOWN','SOURCE_CHANGED','WRITE_FAILED','SESSION_EXPIRED',
      'STATE_CONFLICT','CONFIG_CONFLICT','SOURCE_MISMATCH','FUTURE_OBSERVATION','FUTURE_EVENT'];
    if (typeof operationId !== 'string' || !/^feishu-(?:observation|review):[a-f0-9]{32}(?::[a-f0-9]{32})?$/.test(operationId) || !result
        || !strictKeys(result,Object.hasOwn(result,'errorCode') ? ['status','errorCode'] : ['status'])
        || !['applied','conflict'].includes(result.status)) return null;
    if (result.status === 'applied' && result.errorCode != null) return null;
    const errorCode = result.status === 'applied' ? null : result.errorCode ?? 'STATE_CONFLICT';
    if (errorCode !== null && !safeCodes.includes(errorCode)) return null;
    return this.cardTransaction(() => {
      if (!this.cardAuthorization(actor,auth)) return null;
      const row = this.db.prepare('SELECT session_id FROM feishu_review_operations WHERE id = ?').get(operationId);
      const session = row ? this.reviewSessionById(row.session_id as string) : null;
      if (!session || !this.sameReviewOwner(session,actor,auth)) return null;
      const operation = this.reviewOperations(session.id).find(item => item.id === operationId)!;
      if (operation.status !== 'pending') return operation.status === result.status && operation.errorCode === errorCode ? session : null;
      if (session.version >= Number.MAX_SAFE_INTEGER || session.state.phase === 'finished' || operation.itemId !== feishuReviewItemId(session)) return null;
      if (operation.intent.kind === 'observation' && session.state.phase !== 'revealed') return null;
      if (operation.intent.kind === 'review' && session.state.phase !== 'saved') return null;
      const state = { ...session.state, ...(result.status === 'applied' && operation.intent.kind === 'observation' ? { phase: 'saved' as const } : {}) };
      const now = iso(nowDate(this.now));
      const changed = this.db.prepare("UPDATE feishu_review_operations SET status = ?, error_code = ?, settled_at = ? WHERE id = ? AND status = 'pending'")
        .run(result.status,errorCode,now,operationId);
      if (changed.changes !== 1) return null;
      const advanced = this.db.prepare('UPDATE feishu_review_sessions SET version = ?, phase = ?, state_json = ? WHERE id = ? AND version = ?')
        .run(session.version + 1,state.phase,JSON.stringify(state),session.id,session.version);
      if (advanced.changes !== 1) throw new Error('Review settlement version changed');
      return this.reviewSessionById(session.id);
    });
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
        this.invalidateFeishuUser(fresh.id, now);
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
