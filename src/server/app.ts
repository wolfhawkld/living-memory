import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { Layout, ModelConfig, Snapshot } from '../shared/types.js';
import { MAX_IMPORT_BYTES, type ImportCommitRequest } from '../shared/import-data.js';
import { saveImportBackup } from './import-backup.js';
import type { IdentityLinkCommit, IdentityLinkRequest } from '../shared/identity.js';
import { applyIdentityBindings } from './identity-source.js';
import { reviewDayKey, type ReviewPlanResponse, type ReviewPlanUpdate } from '../shared/review-plan.js';
import { isValidInstant } from '../core/time-model.js';
import { buildLearningOverview } from '../core/learning-overview.js';
import { buildPracticeCards } from '../core/practice.js';
import { parsePracticeCardRequest, parsePracticeAttemptRequest } from './practice-validation.js';
import { sendConceptAttachment } from './attachments.js';
import { loadKnowledgeGraph, KnowledgeSourceError, type KnowledgeSource } from './kg.js';
import { createChangeFeed } from './changes.js';
import { Accounts, type AccountSession } from './accounts.js';
import type { FeishuBindingConfirmation, FeishuBindingConfirmationResult, FeishuBindingStatus, FeishuChannelState, FeishuScope } from '../shared/feishu-binding.js';
import { requestSessionToken, renewOwnerDevice, setSessionCookie, SESSION_COOKIE } from './account-session.js';
import { validateStoragePaths } from './storage-paths.js';
import {
  parseApplicationRequest,
  parseCorrectionRequest,
  parseObservationRequest,
  parseRetentionRequest,
  parseReviewRequest,
  Store,
  StoreError,
} from './store.js';

export interface AppOptions {
  /** The source root. Defaults to LM_KG_ROOT or fixtures/demo-kg. */
  kgRoot?: string;
  /** Alias accepted for callers which use the shorter name. */
  root?: string;
  dataDir?: string;
  dbPath?: string;
  limit?: number;
  includePrefix?: string;
  port?: number;
  now?: () => Date;
  token?: string;
  staticDir?: string;
  accountsEnabled?: boolean;
  feishuScope?: FeishuScope | null;
  getFeishuChannelState?: () => FeishuChannelState;
}

export interface LivingMemoryApp extends Express {
  livingMemory: {
    store: Store;
    getSource: () => KnowledgeSource;
    refresh: () => KnowledgeSource;
    closeChanges: () => void;
    token: string;
    port: number;
    close: () => void;
    /** Internal authenticated transport capability; no raw-event HTTP receiver exists. */
    feishuBinding: { confirm: (input: FeishuBindingConfirmation) => FeishuBindingConfirmationResult };
  };
}

const DEFAULT_PORT = 4317;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 300;
const BYTES_PER_MIB = 1024 * 1024;
const JSON_BODY_LIMIT = BYTES_PER_MIB;
const IMPORT_BODY_LIMIT = MAX_IMPORT_BYTES + 4096;

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function sourceRoot(options: AppOptions): string {
  const configured = options.kgRoot ?? options.root ?? process.env.LM_KG_ROOT;
  if (configured?.trim()) return configured;
  return resolve(process.cwd(), 'fixtures/demo-kg');
}

function sourceLimit(options: AppOptions): number {
  const value = options.limit ?? envNumber('LM_KG_LIMIT', DEFAULT_LIMIT);
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(value)));
}

function sourceInclude(options: AppOptions): string | undefined {
  return options.includePrefix ?? process.env.LM_KG_INCLUDE;
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function hostParts(value: string | undefined): { hostname: string; port: number | null } | null {
  if (!value) return null;
  const raw = value.split(',')[0].trim();
  if (!raw || raw.includes('@')) return null;
  if (raw.startsWith('[')) {
    const close = raw.indexOf(']');
    if (close < 0) return null;
    const hostname = raw.slice(1, close);
    const suffix = raw.slice(close + 1);
    if (!suffix) return { hostname, port: null };
    if (!/^:\d+$/.test(suffix)) return null;
    return { hostname, port: Number(suffix.slice(1)) };
  }
  const colonCount = (raw.match(/:/g) ?? []).length;
  if (colonCount > 1) return { hostname: raw, port: null };
  const separator = raw.lastIndexOf(':');
  if (separator < 0) return { hostname: raw, port: null };
  const port = Number(raw.slice(separator + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { hostname: raw.slice(0, separator), port };
}

function localPortAllowed(value: string | undefined, servicePort: number): boolean {
  const parsed = hostParts(value);
  if (!parsed || !isLoopbackHost(parsed.hostname)) return false;
  return parsed.port === servicePort || parsed.port === 5173 || (parsed.port === null && servicePort === 80);
}

function originAllowed(value: string | undefined, servicePort: number): boolean {
  if (!value) return true;
  if (value === 'null') return false;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:') return false;
    const port = url.port === '' ? 80 : Number(url.port);
    return isLoopbackHost(url.hostname) && (port === servicePort || port === 5173);
  } catch {
    return false;
  }
}

function apiError(res: Response, error: unknown): void {
  if (error && typeof error === 'object' && 'type' in error && error.type === 'entity.too.large') {
    // body-parser reports the active parser's limit, including the import envelope.
    const isImportBody = 'limit' in error && error.limit === IMPORT_BODY_LIMIT;
    const message = isImportBody
      ? `请求数据过大，请使用不超过 ${MAX_IMPORT_BYTES / BYTES_PER_MIB} MiB 的学习数据备份。`
      : `请求数据过大，请使用不超过 ${JSON_BODY_LIMIT / BYTES_PER_MIB} MiB 的请求数据。`;
    res.status(413).json({ error: { code: 'BODY_TOO_LARGE', message } });
    return;
  }
  if (error instanceof StoreError) {
    res.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }
  if (error instanceof KnowledgeSourceError) {
    res.status(503).json({ error: { code: error.code, message: error.message } });
    return;
  }
  if (error instanceof SyntaxError) {
    res.status(400).json({ error: { code: 'INVALID_JSON', message: '请求体不是有效的 JSON。' } });
    return;
  }
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: '服务发生未预期错误，请稍后重试。' } });
}

function asyncRoute(handler: (req: Request, res: Response) => unknown) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      const result = handler(req, res);
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        void (result as Promise<unknown>).catch(next);
      }
    } catch (error) {
      next(error);
    }
  };
}

function parseAsOf(value: unknown, now: Date): string {
  if (value === undefined || value === null || value === '') return now.toISOString();
  if (typeof value !== 'string') throw new StoreError('INVALID_AS_OF', 'asOf 必须是带时区的 ISO 8601 时间。');
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || !isValidInstant(value)) {
    throw new StoreError('INVALID_AS_OF', 'asOf 必须是带时区的 ISO 8601 时间。');
  }
  return new Date(parsed).toISOString();
}

function parseSnapshotScope(value: unknown): 'default' | 'all' {
  if (value === undefined) return 'default';
  if (value === 'all') return 'all';
  throw new StoreError('INVALID_SCOPE', 'scope 只能是 all。');
}

function parseHistoryLimit(value: unknown): number {
  if (value === undefined) return 20;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new StoreError('INVALID_HISTORY_LIMIT', 'limit 必须是 1 到 100 的整数。');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new StoreError('INVALID_HISTORY_LIMIT', 'limit 必须是 1 到 100 的整数。');
  }
  return parsed;
}

function parseHistoryCursor(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value) {
    throw new StoreError('INVALID_HISTORY_CURSOR', '历史分页游标无效，请重新读取历史。');
  }
  return value;
}

function parseScenarioPromptLimit(value: unknown): number {
  if (value === undefined) return 20;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new StoreError('INVALID_SCENARIO_PROMPTS_LIMIT', 'limit 必须是 1 到 50 的整数。');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 50) {
    throw new StoreError('INVALID_SCENARIO_PROMPTS_LIMIT', 'limit 必须是 1 到 50 的整数。');
  }
  return parsed;
}

function parseScenarioPromptCursor(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value) {
    throw new StoreError('INVALID_SCENARIO_PROMPTS_CURSOR', '场景回访分页游标无效，请重新读取场景。');
  }
  return value;
}

function parseHistoryApplicationEventId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new StoreError('INVALID_EVENT_ID', 'applicationEventId 格式无效。');
  }
  return value;
}

function parseReviewPlanTimeZone(value: unknown): string {
  if (value === undefined) return 'UTC';
  if (typeof value !== 'string' || value.length === 0 || value.length > 64 || value.trim() !== value) {
    throw new StoreError('INVALID_TIME_ZONE', 'timeZone 必须是合法的 IANA 时区名称。');
  }
  try {
    // Constructing the formatter validates the IANA name, while the length
    // guard above prevents an unbounded query value from reaching Intl.
    new Intl.DateTimeFormat('en-CA', { timeZone: value }).format(new Date(0));
  } catch {
    throw new StoreError('INVALID_TIME_ZONE', 'timeZone 必须是合法的 IANA 时区名称。');
  }
  return value;
}

function reviewPlanResponse(
  source: KnowledgeSource,
  store: Store,
  timeZone: string,
  asOf: string,
): ReviewPlanResponse {
  return {
    sourceId: source.namespace,
    asOf,
    timeZone,
    dayKey: reviewDayKey(asOf, timeZone),
    plan: store.getReviewPlan(),
    completedConceptIds: store.getCompletedConceptIds(asOf, timeZone),
  };
}

function conceptById(source: KnowledgeSource, id: string) {
  const concept = source.index.concepts.find((item) => item.id === id);
  if (!concept) throw new StoreError('CONCEPT_NOT_FOUND', '找不到对应概念，请先刷新知识源。', 404);
  return concept;
}

function validateLayout(value: unknown): Layout {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new StoreError('INVALID_LAYOUT', '布局必须是以概念 ID 为键的对象。');
  const result: Layout = {};
  for (const [id, position] of Object.entries(value as Record<string, unknown>)) {
    if (!position || typeof position !== 'object' || Array.isArray(position)) throw new StoreError('INVALID_LAYOUT', '布局坐标必须包含 x、y、z。');
    const { x, y, z } = position as Record<string, unknown>;
    if (![x, y, z].every((coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate))) {
      throw new StoreError('INVALID_LAYOUT', '布局坐标必须是有限数字。');
    }
    result[id] = { x: x as number, y: y as number, z: z as number };
  }
  if (Object.keys(result).length > 10_000) throw new StoreError('INVALID_LAYOUT', '布局条目过多。');
  return result;
}

function writeToken(req: Request): string | undefined {
  const value = req.header('x-lm-token');
  return value?.trim() || undefined;
}

/** Create the P0 local API. The app does not listen until index.ts calls listen(). */
export function createApp(options: AppOptions = {}): LivingMemoryApp {
  const port = options.port ?? envNumber('LM_PORT', DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new StoreError('INVALID_PORT', 'LM_PORT 必须是有效端口。');
  const root = sourceRoot(options);
  const dataDir = options.dataDir ?? process.env.LM_DATA_DIR ?? 'data/local';
  const staticDir = options.staticDir ?? resolve(process.cwd(), 'dist');
  validateStoragePaths({ root, dataDir, staticDir, accountsEnabled: Boolean(options.accountsEnabled), dbPath: options.dbPath });
  const initialRawSource = loadKnowledgeGraph({ root, limit: sourceLimit(options), includePrefix: sourceInclude(options) });
  const store = new Store({ dataDir, dbPath: options.dbPath, namespace: initialRawSource.namespace, now: options.now });
  const initialSource = applyIdentityBindings(initialRawSource, store.getIdentityBindings());
  store.rememberConcepts(initialSource.index.concepts);
  const token = options.token ?? randomBytes(32).toString('hex');
  const accounts = options.accountsEnabled ? new Accounts({ dataDir, now: options.now }) : null;
  const feishuScope = options.feishuScope ? { ...options.feishuScope } : null;
  const feishuChannelState = options.getFeishuChannelState ?? (() => 'disabled' as const);
  if (accounts) renewOwnerDevice(accounts, dataDir, port);
  type KnowledgeContext = { rawSource: KnowledgeSource; source: KnowledgeSource; store: Store; changes: ReturnType<typeof createChangeFeed>; root: string; includePrefix?: string };
  const initialContext: KnowledgeContext = { rawSource: initialRawSource, source: initialSource, store, changes: createChangeFeed(initialSource.namespace), root, includePrefix: sourceInclude(options) };
  const userContexts = new Map<string, KnowledgeContext>();
  const contextForUser = (userId: string): KnowledgeContext => {
    if (!accounts || userId === accounts.ownerId()) return initialContext;
    const existing = userContexts.get(userId);
    if (existing) return existing;
    const privateRoot = join(dataDir, 'users', userId, 'knowledge');
    mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
    const rawSource = loadKnowledgeGraph({ root: privateRoot, limit: sourceLimit(options) });
    const privateStore = new Store({ dataDir, dbPath: options.dbPath, namespace: rawSource.namespace, now: options.now });
    const privateSource = applyIdentityBindings(rawSource, privateStore.getIdentityBindings());
    privateStore.rememberConcepts(privateSource.index.concepts);
    const context = { rawSource, source: privateSource, root: privateRoot, store: privateStore, changes: createChangeFeed(privateSource.namespace) };
    userContexts.set(userId, context);
    return context;
  };
  const refreshContext = (context: KnowledgeContext) => {
    const rawSource = loadKnowledgeGraph({ root: context.root, limit: sourceLimit(options), includePrefix: context.includePrefix });
    const next = applyIdentityBindings(rawSource, context.store.getIdentityBindings());
    if (next.namespace !== context.store.namespace) throw new StoreError('SOURCE_MISMATCH', '知识根目录已变化，请重启服务后重新连接。', 409);
    context.store.rememberConcepts(next.index.concepts);
    context.rawSource = rawSource;
    context.source = next;
    context.changes.publish('source');
    return next;
  };
  const refreshSource = () => refreshContext(initialContext);
  type AccountRequest = Request & { accountSession?: AccountSession; knowledgeContext?: KnowledgeContext };
  const contextOf = (req: Request) => (req as AccountRequest).knowledgeContext ?? initialContext;
  const sessionOf = (req: Request) => (req as AccountRequest).accountSession;
  const now = options.now ?? (() => new Date());
  const app = express() as LivingMemoryApp;
  const jsonBody = express.json({ limit: JSON_BODY_LIMIT });
  // Bulk restore is parsed only after account/source/token checks.
  app.use((req, res, next) => /^\/api\/import\/(preview|commit)\/?$/i.test(req.path)
    ? next() : jsonBody(req, res, next));

  app.use((req, res, next) => {
    if (!localPortAllowed(req.headers.host, port)) {
      res.status(403).json({ error: { code: 'HOST_FORBIDDEN', message: '仅允许从本机回环地址访问。' } });
      return;
    }
    const origin = req.headers.origin;
    if (!originAllowed(origin, port)) {
      res.status(403).json({ error: { code: 'ORIGIN_FORBIDDEN', message: '请求来源不在允许的本机来源内。' } });
      return;
    }
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-LM-Token, X-LM-Source-ID');
      res.status(204).end();
      return;
    }
    next();
  });

  const resolveAccount = (req: Request) => {
    const raw = requestSessionToken(req);
    return raw && accounts ? accounts.authenticate(raw) : null;
  };
  const authStatus = (user: AccountSession['user'] | null = null) => ({ enabled: Boolean(accounts), needsSetup: Boolean(accounts && !accounts.hasAccounts()), user });
  app.get('/api/auth/status', (req, res) => res.set('Cache-Control', 'no-store').json(authStatus(resolveAccount(req)?.user ?? null)));
  app.post('/api/auth/setup', asyncRoute(async (req, res) => {
    if (!accounts) throw new StoreError('ACCOUNTS_DISABLED', '当前为本机单用户模式。', 404);
    if (!req.is('application/json')) throw new StoreError('INVALID_BODY', '请提交 JSON。');
    const user = await accounts.setup(req.body?.username, req.body?.password);
    // A fresh private account claims the existing knowledge source and learning
    // namespace exactly once; no copying of legacy events is required.
    const session = accounts.issueSession(user.id);
    renewOwnerDevice(accounts, dataDir, port);
    setSessionCookie(res, session);
    res.set('Cache-Control', 'no-store').status(201).json(authStatus(user));
  }));
  app.post('/api/auth/login', asyncRoute(async (req, res) => {
    if (!accounts) throw new StoreError('ACCOUNTS_DISABLED', '当前为本机单用户模式。', 404);
    if (!req.is('application/json')) throw new StoreError('INVALID_BODY', '请提交 JSON。');
    const session = await accounts.login(req.body?.username, req.body?.password, req.socket.remoteAddress ?? 'local');
    setSessionCookie(res, session);
    res.set('Cache-Control', 'no-store').json(authStatus(session.user));
  }));

  app.use('/api', (req, res, next) => {
    if (accounts) {
      const session = resolveAccount(req);
      if (!session) { next(new StoreError('AUTH_REQUIRED', '请登录后访问你的私人知识空间。', 401)); return; }
      (req as AccountRequest).accountSession = session;
      (req as AccountRequest).knowledgeContext = contextForUser(session.user.id);
    }
    const expectedSource = req.header('x-lm-source-id');
    if (expectedSource && expectedSource !== contextOf(req).source.namespace) {
      next(new StoreError('SOURCE_MISMATCH', '会话或知识空间已变化，请重新登录后确认操作。', 409)); return;
    }
    res.set('Cache-Control', 'no-store');
    next();
  });

  const requireWrite = (req: Request, res: Response, next: NextFunction): void => {
    if (writeToken(req) !== (sessionOf(req)?.csrfToken ?? token)) {
      res.status(401).json({ error: { code: 'TOKEN_REQUIRED', message: '写入请求需要有效的本地会话令牌。' } });
      return;
    }
    next();
  };

  const requireBrowser = (req: Request, _res: Response, next: NextFunction): void => {
    if (!accounts) { next(new StoreError('ACCOUNTS_DISABLED', '请启用账号登录后使用飞书绑定。', 404)); return; }
    if (sessionOf(req)?.kind !== 'browser') { next(new StoreError('BROWSER_SESSION_REQUIRED', '请在已登录的网页中管理飞书绑定。', 403)); return; }
    next();
  };
  const bindingStatus = (req: Request): FeishuBindingStatus => ({
    scope: feishuScope ? { ...feishuScope } : null, channelState: feishuChannelState(),
    ...accounts!.getFeishuBindingState(sessionOf(req)!.user.id),
  });
  function bindingBody(req: Request, keys: readonly string[]): Record<string, unknown> {
    const body = req.body as unknown;
    if (!req.is('application/json') || typeof body !== 'object' || body === null || Array.isArray(body)
      || Object.keys(body).some((key) => !keys.includes(key))) {
      throw new StoreError('INVALID_BINDING_REQUEST', '请提交有效的绑定操作。');
    }
    return body as Record<string, unknown>;
  }
  function bindingOperationId(value: unknown): string {
    if (typeof value !== 'string' || !value.trim() || value.length > 256) {
      throw new StoreError('INVALID_BINDING_REQUEST', '请选择有效的绑定操作。');
    }
    return value;
  }
  app.get('/api/feishu/binding', requireBrowser, asyncRoute((req, res) => res.json(bindingStatus(req))));
  app.post('/api/feishu/binding/request', requireBrowser, requireWrite, asyncRoute((req, res) => {
    bindingBody(req, []);
    if (!feishuScope || feishuChannelState() !== 'connected') {
      throw new StoreError('FEISHU_UNAVAILABLE', '飞书通道尚未连接，暂时无法生成绑定指令。', 409);
    }
    const session = sessionOf(req)!;
    res.status(201).json(accounts!.issueFeishuBindingRequest(session.user.id, session.sessionId, feishuScope));
  }));
  app.post('/api/feishu/binding/cancel', requireBrowser, requireWrite, asyncRoute((req, res) => {
    const body = bindingBody(req, ['requestId']);
    const session = sessionOf(req)!;
    accounts!.cancelFeishuBindingRequest(session.user.id, session.sessionId, bindingOperationId(body.requestId));
    res.json(bindingStatus(req));
  }));
  app.post('/api/feishu/binding/revoke', requireBrowser, requireWrite, asyncRoute((req, res) => {
    const body = bindingBody(req, ['bindingId']);
    const session = sessionOf(req)!;
    accounts!.revokeFeishuBinding(session.user.id, session.sessionId, bindingOperationId(body.bindingId));
    res.json(bindingStatus(req));
  }));

  const importBody = express.json({ limit: IMPORT_BODY_LIMIT });
  const requireSourceHeader = (req: Request, _res: Response, next: NextFunction) => {
    if (!req.header('x-lm-source-id')) { next(new StoreError('SOURCE_REQUIRED', '请确认当前知识空间后操作。')); return; }
    next();
  };
  app.post('/api/import/preview', requireWrite, requireSourceHeader, importBody, asyncRoute((req, res) => {
    const { source, store } = contextOf(req);
    res.json(store.previewImport(req.body?.data, req.body?.options, source.index.source, source.index.concepts));
  }));
  app.post('/api/import/commit', requireWrite, requireSourceHeader, importBody, asyncRoute((req, res) => {
    const { source, store, changes } = contextOf(req);
    const receipt = store.commitImport(req.body as ImportCommitRequest, source.index.source, source.index.concepts,
      (backup) => saveImportBackup(store.dbPath, store.namespace, backup));
    if (receipt.status === 'accepted') changes.publish('import');
    res.status(receipt.status === 'accepted' ? 201 : 200).json(receipt);
  }));

  app.get('/api/identities', asyncRoute((req, res) => {
    const { store, source } = contextOf(req);
    res.json(store.getIdentityStatus(source.index.concepts));
  }));
  app.post('/api/identities/preview', requireWrite, requireSourceHeader, asyncRoute((req, res) => {
    const context = contextOf(req);
    const source = refreshContext(context);
    res.json(context.store.previewIdentityLink(req.body as IdentityLinkRequest, source.index.source, source.index.concepts));
  }));
  app.post('/api/identities/commit', requireWrite, requireSourceHeader, asyncRoute((req, res) => {
    const context = contextOf(req);
    const source = refreshContext(context);
    const receipt = context.store.commitIdentityLink(req.body as IdentityLinkCommit, source.index.source, source.index.concepts,
      backup => saveImportBackup(context.store.dbPath, context.store.namespace, backup, 'identity'));
    context.source = applyIdentityBindings(context.rawSource, context.store.getIdentityBindings());
    if (receipt.status === 'accepted') context.changes.publish('identity');
    res.status(receipt.status === 'accepted' ? 201 : 200).json(receipt);
  }));

  app.post('/api/auth/logout', requireWrite, (req, res) => {
    const raw = requestSessionToken(req);
    if (accounts && raw) accounts.logout(raw);
    res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'strict', path: '/' });
    res.status(204).end();
  });
  const requireAdmin = (req: Request, _res: Response, next: NextFunction) => {
    if (!accounts || sessionOf(req)?.user.role !== 'admin') { next(new StoreError('FORBIDDEN', '只有管理员可以管理账号。', 403)); return; }
    next();
  };
  app.get('/api/admin/users', requireAdmin, (_req, res) => res.json({ users: accounts!.listUsers() }));
  app.post('/api/admin/users', requireAdmin, requireWrite, asyncRoute(async (req, res) => {
    const user = await accounts!.createUser(req.body?.username, req.body?.password);
    contextForUser(user.id);
    res.status(201).json({ user });
  }));
  app.put('/api/admin/users/:id', requireAdmin, requireWrite, asyncRoute(async (req, res) => {
    const user = await accounts!.updateUser(String(req.params.id), req.body);
    if (user.id === accounts!.ownerId()) renewOwnerDevice(accounts!, dataDir, port);
    res.json({ user });
  }));
  app.get('/api/session', (req, res) => res.set('Cache-Control', 'no-store').json({
    writeToken: sessionOf(req)?.csrfToken ?? token, sourceId: contextOf(req).source.namespace,
    ...(sessionOf(req) ? { user: sessionOf(req)!.user } : {}),
  }));
  app.get('/api/changes', (req, res) => {
    contextOf(req).changes.subscribe(res);
    if (accounts) {
      const raw = requestSessionToken(req)!;
      const timer = setInterval(() => { if (!accounts.authenticate(raw)) res.end(); }, 1000);
      timer.unref();
      res.on('close', () => clearInterval(timer));
    }
  });
  app.get('/api/health', (req, res) => {
    const { source, store, changes } = contextOf(req);
    res.json({ status: 'ok', modelVersion: store.getConfig().modelVersion, source: source.index.source });
  });
  app.get('/api/snapshot', asyncRoute((req, res) => {
    const { source, store, changes } = contextOf(req);
    const asOf = parseAsOf(req.query.asOf, now());
    const scope = parseSnapshotScope(req.query.scope);
    const graph = scope === 'all' ? source.index : source.graph;
    const snapshot: Snapshot = {
      ...graph,
      config: store.getConfig(),
      states: store.getStates(graph.concepts, asOf),
      asOf,
      observationsCount: store.countObservations(),
    };
    res.json(snapshot);
  }));
  app.get('/api/concepts/:conceptId/history', asyncRoute((req, res) => {
    const { source, store, changes } = contextOf(req);
    const conceptId = req.params.conceptId;
    if (typeof conceptId !== 'string') throw new StoreError('CONCEPT_NOT_FOUND', '找不到对应概念，请先刷新知识源。', 404);
    const concept = conceptById(source, conceptId);
    const limit = parseHistoryLimit(req.query.limit);
    const cursor = parseHistoryCursor(req.query.cursor);
    const applicationEventId = parseHistoryApplicationEventId(req.query.applicationEventId);
    if (cursor !== undefined && applicationEventId !== undefined) {
      throw new StoreError('INVALID_HISTORY_CURSOR', '聚焦单条应用历史时不能同时使用分页游标。');
    }
    const history = store.getConceptHistory(concept, now().toISOString(), limit, cursor, applicationEventId);
    res.set('Cache-Control', 'no-store').json(history);
  }));
  app.get('/api/learning-overview', asyncRoute((req, res) => {
    const { source, store } = contextOf(req);
    const asOf = now().toISOString();
    const concepts = source.index.concepts;
    res.set('Cache-Control', 'no-store').json(buildLearningOverview({
      sourceId: source.namespace, asOf, concepts,
      states: store.getStates(concepts, asOf),
      observations: store.getObservations(), applications: store.getApplications(),
      corrections: store.getCorrections(),
      anchors: store.getAnchors(),
    }));
  }));
  app.get('/api/scenario-prompts', asyncRoute((req, res) => {
    const { source, store } = contextOf(req);
    const limit = parseScenarioPromptLimit(req.query.limit);
    const cursor = parseScenarioPromptCursor(req.query.cursor);
    const conceptIds = new Set(source.index.concepts.map((concept) => concept.id));
    const page = store.getScenarioPrompts(conceptIds, limit, cursor);
    res.set('Cache-Control', 'no-store').json({
      sourceId: source.namespace,
      asOf: now().toISOString(),
      ...page,
    });
  }));
  app.get('/api/practice-cards', asyncRoute((req, res) => {
    const { source, store } = contextOf(req);
    res.set('Cache-Control', 'no-store').json({ sourceId: source.namespace, asOf: now().toISOString(),
      items: buildPracticeCards(store.getPracticeData(), source.index.concepts) });
  }));
  app.get('/api/practice-cards/:cardId/history', asyncRoute((req, res) => {
    const { source, store } = contextOf(req);
    const cardId = req.params.cardId;
    if (typeof cardId !== 'string' || !store.getPracticeCard(cardId)) {
      throw new StoreError('PRACTICE_CARD_NOT_FOUND', '找不到当前知识空间的练习卡。', 404);
    }
    const data = store.getPracticeData();
    res.set('Cache-Control', 'no-store').json({ sourceId: source.namespace, cardId,
      cards: data.cards.filter((card) => card.cardId === cardId),
      attempts: data.attempts.filter((attempt) => attempt.cardId === cardId) });
  }));
  app.post('/api/practice-cards', requireWrite, asyncRoute((req, res) => {
    const { source, store, changes } = contextOf(req);
    const receipt = store.addPracticeCard(parsePracticeCardRequest(req.body), source.index.concepts);
    if (receipt.status === 'accepted') changes.publish('practice');
    res.status(receipt.status === 'accepted' ? 201 : 200).json(receipt);
  }));
  app.post('/api/practice-attempts', requireWrite, asyncRoute((req, res) => {
    const { source, store, changes } = contextOf(req);
    const receipt = store.addPracticeAttempt(parsePracticeAttemptRequest(req.body), source.index.concepts);
    if (receipt.status === 'accepted') changes.publish('practice');
    res.status(receipt.status === 'accepted' ? 201 : 200).json(receipt);
  }));
  app.get('/api/review-plan', asyncRoute((req, res) => {
    const { source, store } = contextOf(req);
    const timeZone = parseReviewPlanTimeZone(req.query.timeZone);
    const asOf = now().toISOString();
    res.json(reviewPlanResponse(source, store, timeZone, asOf));
  }));
  app.put('/api/review-plan', requireWrite, asyncRoute((req, res) => {
    const { source, store, changes } = contextOf(req);
    const timeZone = parseReviewPlanTimeZone(req.query.timeZone);
    const body = req.body as Record<string, unknown>;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new StoreError('INVALID_BODY', '请求体必须是 JSON 对象。');
    }
    const hasBudget = Object.prototype.hasOwnProperty.call(body, 'dailyBudget');
    const hasConcept = Object.prototype.hasOwnProperty.call(body, 'concept');
    if (hasBudget === hasConcept) {
      throw new StoreError('INVALID_BODY', '请求必须且只能更新 dailyBudget 或 concept。');
    }
    if (hasConcept) {
      const concept = body.concept;
      if (!concept || typeof concept !== 'object' || Array.isArray(concept)) {
        throw new StoreError('INVALID_BODY', 'concept 必须是对象。');
      }
      const conceptRecord = concept as Record<string, unknown>;
      if (typeof conceptRecord.conceptId !== 'string' || typeof conceptRecord.sourceRevision !== 'string') {
        throw new StoreError('INVALID_BODY', 'conceptId 和 sourceRevision 必须是有效字符串。');
      }
      const currentConcept = conceptById(source, conceptRecord.conceptId);
      if (conceptRecord.sourceRevision !== currentConcept.source.revision) {
        throw new StoreError('SOURCE_REVISION_MISMATCH', '概念内容已变化，请先刷新知识源后重新确认。', 409);
      }
    }
    const before = store.getReviewPlan();
    const updated = store.updateReviewPlan(body as ReviewPlanUpdate);
    // Only the request that supplied the current revision can have caused a
    // revision advance. A stale identical replay returns the current plan and
    // must not emit a second invalidation event.
    if (updated.revision > before.revision
        && body.revision === before.revision) changes.publish('review-plan');
    const asOf = now().toISOString();
    res.json({ ...reviewPlanResponse(source, store, timeZone, asOf), plan: updated });
  }));
  app.get('/api/concepts/:conceptId/attachment', asyncRoute((req, res) => {
    const { source, store, changes } = contextOf(req);
    const conceptId = req.params.conceptId;
    if (typeof conceptId !== 'string') throw new StoreError('CONCEPT_NOT_FOUND', '找不到对应概念，请先刷新知识源。', 404);
    const concept = conceptById(source, conceptId);
    sendConceptAttachment(res, source, concept, req.query);
  }));
  app.post('/api/reviews', requireWrite, asyncRoute((req, res) => {
    const { source, store, changes } = contextOf(req);
    const review = parseReviewRequest(req.body);
    if (!store.hasEvent(review.eventId)) {
      const concept = conceptById(source, review.conceptId);
      if (review.sourceRevision !== concept.source.revision) throw new StoreError('SOURCE_REVISION_MISMATCH', '概念内容已变化，请先刷新知识源后重新确认。', 409);
    }
    const receipt = store.addReview(review);
    if (receipt.status === 'accepted') changes.publish('review');
    res.status(receipt.status === 'accepted' ? 201 : 200).json(receipt);
  }));
  app.post('/api/observations', requireWrite, asyncRoute((req, res) => {
    const { source, store, changes } = contextOf(req);
    const observation = parseObservationRequest(req.body);
    if (!store.hasEvent(observation.eventId)) {
      const concept = conceptById(source, observation.conceptId);
      if (observation.sourceRevision !== concept.source.revision) throw new StoreError('SOURCE_REVISION_MISMATCH', '概念内容已变化，请先刷新知识源后重新确认。', 409);
    }
    const observedAt = parseAsOf(observation.observedAt, now());
    if (Date.parse(observedAt) > now().getTime()) throw new StoreError('FUTURE_OBSERVATION', '观察时间不能晚于服务当前时间。');
    const anchor = store.getAnchor(observation.conceptId, observedAt);
    // A source refresh invalidates an old anchor for the new observation
    // version. Allow an explicit current-version observation with no anchor so
    // it remains honest (decay is null); a stale non-null anchor still fails in
    // Store.addObservation with ANCHOR_CONFLICT.
    const expectedAnchor = anchor && anchor.sourceRevision === observation.sourceRevision ? anchor : null;
    const receipt = store.addObservation({ ...observation, observedAt }, expectedAnchor?.eventId ?? null);
    if (receipt.status === 'accepted') changes.publish('observation');
    res.status(receipt.status === 'accepted' ? 201 : 200).json(receipt);
  }));
  app.post('/api/retentions', requireWrite, asyncRoute((req, res) => {
    const { source, store, changes } = contextOf(req);
    const retention = parseRetentionRequest(req.body);
    if (!store.hasEvent(retention.eventId)) {
      const concept = conceptById(source, retention.conceptId);
      if (retention.sourceRevision !== concept.source.revision) throw new StoreError('SOURCE_REVISION_MISMATCH', '概念内容已变化，请先刷新知识源后重新确认。', 409);
    }
    const expectedPreviousEventId = store.getRetention(retention.conceptId)?.eventId ?? null;
    const receipt = store.addRetention(retention, expectedPreviousEventId);
    if (receipt.status === 'accepted') changes.publish('retention');
    res.status(receipt.status === 'accepted' ? 201 : 200).json(receipt);
  }));
  app.post('/api/applications', requireWrite, asyncRoute((req, res) => {
    const { source, store, changes } = contextOf(req);
    const record = parseApplicationRequest(req.body);
    if (!store.hasEvent(record.eventId)) {
      const concept = conceptById(source, record.conceptId);
      if (record.sourceRevision !== concept.source.revision) throw new StoreError('SOURCE_REVISION_MISMATCH', '概念内容已变化，请保留当前记录，刷新知识源后重新确认。', 409);
    }
    const receipt = store.addApplication(record);
    if (receipt.status === 'accepted') changes.publish('application');
    res.status(receipt.status === 'accepted' ? 201 : 200).json(receipt);
  }));
  app.post('/api/corrections', requireWrite, asyncRoute((req, res) => {
    const { source, store, changes } = contextOf(req);
    const decision = parseCorrectionRequest(req.body);
    if (!store.hasEvent(decision.eventId)) {
      const concept = conceptById(source, decision.conceptId);
      if (decision.sourceRevision !== concept.source.revision) throw new StoreError('SOURCE_REVISION_MISMATCH', '资料版本已变化，请重新核对当前资料后记录处理结果。', 409);
    }
    const receipt = store.addCorrection(decision);
    if (receipt.status === 'accepted') changes.publish('correction');
    res.status(receipt.status === 'accepted' ? 201 : 200).json(receipt);
  }));
  app.put('/api/config', requireWrite, asyncRoute((req, res) => {
    const { source, store, changes } = contextOf(req);
    const body = req.body as Record<string, unknown>;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new StoreError('INVALID_BODY', '请求体必须是 JSON 对象。');
    const halfLifeDays = body.halfLifeDays;
    const revision = body.revision;
    if (typeof halfLifeDays !== 'number' || !Number.isFinite(halfLifeDays)) throw new StoreError('INVALID_HALF_LIFE', 'halfLifeDays 必须是有限数字。');
    if (typeof revision !== 'number' || !Number.isInteger(revision)) throw new StoreError('INVALID_REVISION', 'revision 必须是正整数。');
    const config = store.updateConfig(halfLifeDays, revision);
    if (config.status === 'accepted') changes.publish('config');
    res.json(config);
  }));
  app.get('/api/layout', (req, res) => res.json(contextOf(req).store.getLayout()));
  app.put('/api/layout', requireWrite, asyncRoute((req, res) => {
    const { source, store, changes } = contextOf(req);
    const partial = validateLayout(req.body);
    if (accounts && Object.keys(partial).some((id) => !source.index.concepts.some((concept) => concept.id === id))) throw new StoreError('CONCEPT_NOT_FOUND', '布局包含不属于当前私人空间的节点。', 404);
    const merged = { ...store.getLayout(), ...partial };
    res.json(store.setLayout(merged));
  }));
  app.get('/api/export', (req, res) => {
    const { source, store, changes } = contextOf(req);
    const data = store.exportData(source.index.source, source.index.concepts);
    res.setHeader('Content-Disposition', 'attachment; filename="living-memory-export.json"');
    res.type('application/json').send(JSON.stringify(data));
  });
  app.post('/api/refresh', requireWrite, asyncRoute((req, res) => {
    const next = refreshContext(contextOf(req));
    res.json({ status: 'ok', source: next.index.source });
  }));

  if (existsSync(staticDir)) app.use(express.static(staticDir));
  app.use('/api', (_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: '找不到该 API。' } }));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => apiError(res, error));
  app.livingMemory = {
    store,
    getSource: () => initialContext.source,
    refresh: refreshSource,
    closeChanges: () => { initialContext.changes.close(); for (const context of userContexts.values()) context.changes.close(); },
    token,
    port,
    feishuBinding: {
      confirm: (input) => {
        if (!accounts || !feishuScope || !input || input.appId !== feishuScope.appId || input.tenantKey !== feishuScope.tenantKey) {
          return { status: 'rejected' };
        }
        try { return accounts.confirmFeishuBinding(input); } catch { return { status: 'rejected' }; }
      },
    },
    close: () => {
      initialContext.changes.close();
      store.close();
      for (const context of userContexts.values()) { context.changes.close(); context.store.close(); }
      accounts?.close();
    },
  };
  return app;
}

export function closeApp(app: LivingMemoryApp): void {
  app.livingMemory.close();
}

export { apiError };
