import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isValidInstant } from '../core/time-model.js';
import { readDeviceSession } from './device-session.js';
import type { Concept, MemoryState, ReviewRequest, Snapshot } from '../shared/types.js';

const DEFAULT_TIMEOUT_MS = 8_000;
const EVENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

type FetchImplementation = typeof fetch;

export interface CliRunnerOptions {
  /** Base URL override. Otherwise --url, LM_SERVER_URL, then the local default apply. */
  url?: string;
  /** Source-root override. Otherwise --source-root, LM_KG_ROOT, then no check applies. */
  sourceRoot?: string;
  /** Receipt directory override. Otherwise --state-dir, LM_CLI_STATE_DIR, then the repo-local default applies. */
  stateDir?: string;
  /** Environment used for defaults. It is useful for isolated tests. */
  env?: NodeJS.ProcessEnv;
  /** Clock used when a review does not provide --at. */
  now?: () => Date;
  /** HTTP timeout in milliseconds. */
  timeoutMs?: number;
  /** Injectable fetch implementation for tests. */
  fetchImpl?: FetchImplementation;
}

export interface CliErrorDetails {
  [key: string]: unknown;
}

export class CliError extends Error {
  readonly code: string;
  readonly details: CliErrorDetails;

  constructor(code: string, message: string, details: CliErrorDetails = {}) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.details = details;
  }
}

interface ParsedOptions {
  url?: string;
  sourceRoot?: string;
  stateDir?: string;
  confirm: boolean;
  eventId?: string;
  at?: string;
  revision?: string;
  operationId?: string;
  help: boolean;
}

interface ParsedCommand {
  name: string | null;
  args: string[];
  options: ParsedOptions;
}

interface SessionResponse {
  writeToken: string;
  sourceId: string;
}

interface RefreshResponse {
  status: string;
  source?: Snapshot['source'];
}

interface ReviewReceipt {
  version: 1;
  sourceId: string;
  eventId: string;
  request: ReviewRequest & { occurredAt: string };
  status: 'pending' | 'succeeded';
  createdAt: string;
  updatedAt: string;
  response?: unknown;
}

interface SelectedConcept {
  concept: Concept;
  state: MemoryState;
}

const HELP_TEXT = `Living Memory 本地 CLI

用法：node --import tsx src/cli/index.ts <命令> [参数] [选项]

命令：
  query <文本>                         刷新后搜索整个知识源的标题、别名和摘要
  show <ID|相对路径|标题|别名>           显示概念、当前状态和关联关系
  status [选择器]                       显示配置、来源、时间和状态计数
  refresh                              刷新当前知识源
  after <query|ingest|consolidate> --operation-id <ID>
                                      报告成功工作流并刷新知识源
  review <选择器> --confirm             创建一次已冻结时间的重温确认
    [--event-id <ID>] [--at <ISO>] [--revision <REV>]
  retry <event-id>                      重试本地收据中的重温请求

通用选项：
  --url <URL>                          默认 http://127.0.0.1:4317
  --source-root <目录>                 校验知识源目录命名空间
  --state-dir <目录>                   收据目录（默认仓库 data/local/cli）
  --confirm                             review 必须明确提供此选项
  --help                               显示帮助

所有成功结果写入 stdout 的 JSON；错误写入 stderr 的结构化 JSON，并以非零状态退出。
只接受本机回环 HTTP URL；不会执行 shell 命令。`;

export function helpText(): string {
  return HELP_TEXT;
}

function asNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new CliError('INVALID_ARGUMENT', `${label} 不能为空。`);
  }
  return value.trim();
}

function parseOptionValue(argv: string[], index: number, option: string): { value: string; next: number } {
  const value = argv[index + 1];
  if (value === undefined || value === '--' || value.startsWith('--')) {
    throw new CliError('INVALID_ARGUMENT', `${option} 需要一个值。`);
  }
  return { value, next: index + 1 };
}

function parseCommand(argv: string[]): ParsedCommand {
  const options: ParsedOptions = { confirm: false, help: false };
  const args: string[] = [];
  let command: string | null = null;
  let parsingOptions = true;
  const seen = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (parsingOptions && token === '--') {
      parsingOptions = false;
      continue;
    }
    if (parsingOptions && (token === '--help' || token === '-h')) {
      options.help = true;
      continue;
    }
    if (parsingOptions && token.startsWith('--')) {
      const equals = token.indexOf('=');
      const name = equals >= 0 ? token.slice(0, equals) : token;
      const inline = equals >= 0 ? token.slice(equals + 1) : undefined;
      if (seen.has(name)) throw new CliError('INVALID_ARGUMENT', `选项 ${name} 不能重复。`);
      seen.add(name);
      if (name === '--confirm') {
        if (inline !== undefined && inline !== '') throw new CliError('INVALID_ARGUMENT', '--confirm 不接受值。');
        options.confirm = true;
        continue;
      }
      const knownValueOption = name === '--url'
        || name === '--source-root'
        || name === '--state-dir'
        || name === '--event-id'
        || name === '--at'
        || name === '--revision'
        || name === '--operation-id';
      if (!knownValueOption) throw new CliError('INVALID_ARGUMENT', `未知选项：${name}。`);
      const value = inline === undefined
        ? parseOptionValue(argv, index, name)
        : { value: inline, next: index };
      index = value.next;
      if (!value.value.trim()) throw new CliError('INVALID_ARGUMENT', `${name} 的值不能为空。`);
      if (name === '--url') options.url = value.value;
      if (name === '--source-root') options.sourceRoot = value.value;
      if (name === '--state-dir') options.stateDir = value.value;
      if (name === '--event-id') options.eventId = value.value;
      if (name === '--at') options.at = value.value;
      if (name === '--revision') options.revision = value.value;
      if (name === '--operation-id') options.operationId = value.value;
      continue;
    }
    if (command === null) command = token;
    else args.push(token);
  }

  return { name: command, args, options };
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function validateBaseUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new CliError('INVALID_URL', '服务器 URL 无效，只接受本机回环 HTTP URL。');
  }
  if (parsed.protocol !== 'http:' || !isLoopbackHost(parsed.hostname)) {
    throw new CliError('INVALID_URL', '服务器 URL 必须是本机回环 HTTP URL。');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname !== '' && parsed.pathname !== '/')) {
    throw new CliError('INVALID_URL', '服务器 URL 不得包含用户信息、查询参数、片段或 API 路径。');
  }
  if (parsed.port) {
    const port = Number(parsed.port);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new CliError('INVALID_URL', '服务器 URL 的端口无效。');
    }
  }
  return parsed.origin;
}

function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../..');
}

function configuredValue(cliValue: string | undefined, optionValue: string | undefined, env: NodeJS.ProcessEnv, envName: string): string | undefined {
  const value = cliValue ?? optionValue ?? env[envName];
  return value?.trim() || undefined;
}

function configuredStateDir(cliValue: string | undefined, optionValue: string | undefined, env: NodeJS.ProcessEnv): string {
  const configured = configuredValue(cliValue, optionValue, env, 'LM_CLI_STATE_DIR');
  return configured ? resolve(configured) : resolve(repoRoot(), 'data/local/cli');
}

function configuredSourceRoot(cliValue: string | undefined, optionValue: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  const configured = configuredValue(cliValue, optionValue, env, 'LM_KG_ROOT');
  return configured ? resolve(configured) : undefined;
}

function sourceIdForRoot(root: string): string {
  let canonical: string;
  try {
    canonical = realpathSync(resolve(root));
    if (!statSync(canonical).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new CliError('SOURCE_ROOT_INVALID', '知识源目录不存在或不是目录，无法校验 sourceId。');
  }
  return `kg_${createHash('sha256').update(canonical).digest('hex').slice(0, 48)}`;
}

function validateSourceRoot(root: string | undefined, sourceId: string): void {
  if (!root) return;
  const expected = sourceIdForRoot(root);
  if (expected !== sourceId) {
    throw new CliError('SOURCE_MISMATCH', '知识源目录与当前会话 sourceId 不匹配，已拒绝刷新或写入。', {
      expectedSourceId: expected,
      sessionSourceId: sourceId,
    });
  }
}

function normalizeInstant(value: string, option = '--at'): string {
  if (!isValidInstant(value)) {
    throw new CliError('INVALID_INSTANT', `${option} 必须是带时区的 ISO 8601 时间（例如 2026-01-01T00:00:00Z）。`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new CliError('INVALID_INSTANT', `${option} 时间无效。`);
  return new Date(parsed).toISOString();
}

function ensureEventId(value: string): string {
  if (!EVENT_ID_PATTERN.test(value)) {
    throw new CliError('INVALID_EVENT_ID', 'eventId 只能包含字母、数字、点、下划线、冒号或短横线，长度不超过 128。');
  }
  return value;
}

function nowIso(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new CliError('INVALID_CLOCK', '本地时钟返回了无效时间。');
  }
  return value.toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRedirectError(error: unknown): boolean {
  const message = `${errorMessage(error)} ${error && typeof error === 'object' && 'cause' in error ? errorMessage((error as { cause?: unknown }).cause) : ''}`;
  return /redirect|unexpected redirect/i.test(message);
}

class ApiClient {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly fetchImpl: FetchImplementation;
  private token: string | undefined;
  private sourceId: string | undefined;
  private readonly deviceSession: string | undefined;

  constructor(options: { baseUrl: string; timeoutMs: number; fetchImpl: FetchImplementation; deviceSession?: string }) {
    this.baseUrl = options.baseUrl;
    this.timeoutMs = options.timeoutMs;
    this.fetchImpl = options.fetchImpl;
    this.deviceSession = options.deviceSession;
  }

  private endpoint(path: string): string {
    return `${this.baseUrl}/api${path}`;
  }

  async json<T>(path: string, init: { method?: string; body?: unknown; write?: boolean } = {}): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.deviceSession) headers.Authorization = `Bearer ${this.deviceSession}`;
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    if (init.write) {
      if (!this.token) throw new CliError('SESSION_REQUIRED', '写入请求缺少本地会话令牌。');
      headers['X-LM-Token'] = this.token;
    }
    if (this.sourceId) headers['X-LM-Source-ID'] = this.sourceId;
    const controller = new AbortController();
    let response: Response;
    let text: string;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const operation = (async () => {
        const result = await this.fetchImpl(this.endpoint(path), {
          method: init.method ?? 'GET',
          headers,
          ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
          redirect: 'error',
          signal: controller.signal,
        });
        return { response: result, text: await result.text() };
      })();
      const deadline = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new CliError('TIMEOUT', '本地服务请求超时，请检查服务是否正在运行。'));
        }, this.timeoutMs);
      });
      const result = await Promise.race([operation, deadline]);
      response = result.response;
      text = result.text;
    } catch (error) {
      if (error instanceof CliError && error.code === 'TIMEOUT') throw error;
      if (controller.signal.aborted) throw new CliError('TIMEOUT', '本地服务请求超时，请检查服务是否正在运行。');
      if (isRedirectError(error)) throw new CliError('REDIRECT_REJECTED', '服务器返回了重定向，CLI 已拒绝继续请求。');
      throw new CliError('NETWORK_ERROR', '本地服务暂时不可达，请检查服务是否正在运行。');
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }

    let data: unknown;
    if (text.trim()) {
      try {
        data = JSON.parse(text);
      } catch {
        if (!response.ok) throw new CliError('HTTP_ERROR', `请求失败（HTTP ${response.status}）。`, { status: response.status });
        throw new CliError('INVALID_RESPONSE', '本地服务返回的不是有效 JSON。', { status: response.status });
      }
    }
    if (!response.ok) {
      const record = data && typeof data === 'object' ? data as Record<string, unknown> : {};
      const error = record.error && typeof record.error === 'object' ? record.error as Record<string, unknown> : {};
      const message = typeof error.message === 'string' ? error.message : `请求失败（HTTP ${response.status}）。`;
      const code = typeof error.code === 'string' ? error.code : 'HTTP_ERROR';
      throw new CliError(code, message, { status: response.status, serverCode: code });
    }
    return data as T;
  }

  async session(): Promise<SessionResponse> {
    const result = await this.json<Partial<SessionResponse>>('/session');
    if (typeof result.writeToken !== 'string' || !result.writeToken.trim() || typeof result.sourceId !== 'string' || !result.sourceId.trim()) {
      throw new CliError('SESSION_INVALID', '本地服务会话不完整，缺少 writeToken 或 sourceId。');
    }
    this.token = result.writeToken;
    this.sourceId = result.sourceId;
    return { writeToken: result.writeToken, sourceId: result.sourceId };
  }
}

function sourcePathKey(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\/+/, '');
  return normalized.toLocaleLowerCase();
}

function selectorCandidates(snapshot: Snapshot, selector: string): Concept[] {
  const value = selector.trim();
  const lower = value.toLocaleLowerCase();
  const path = sourcePathKey(value);
  const withoutMd = path.replace(/\.md$/i, '');
  const exactId = snapshot.concepts.find((concept) => concept.id === value);
  if (exactId) return [exactId];
  const exactPaths = snapshot.concepts.filter((concept) => {
    const conceptPath = sourcePathKey(concept.source.path);
    return conceptPath === path || conceptPath.replace(/\.md$/i, '') === withoutMd;
  });
  if (exactPaths.length > 0) return exactPaths;
  const matches = new Map<string, Concept>();
  for (const concept of snapshot.concepts) {
    if (concept.title.trim().toLocaleLowerCase() === lower) matches.set(concept.id, concept);
    if (concept.aliases.some((alias) => alias.trim().toLocaleLowerCase() === lower)) matches.set(concept.id, concept);
  }
  return [...matches.values()];
}

function resolveSelector(snapshot: Snapshot, selector: string): SelectedConcept {
  const value = asNonEmptyString(selector, '选择器');
  const candidates = selectorCandidates(snapshot, value);
  if (candidates.length === 0) {
    throw new CliError('CONCEPT_NOT_FOUND', `找不到概念：${value}。`);
  }
  if (candidates.length > 1) {
    throw new CliError('AMBIGUOUS_SELECTOR', `选择器有歧义：${value}。`, {
      candidateIds: candidates.map((concept) => concept.id),
      candidates: candidates.map((concept) => ({ id: concept.id, title: concept.title, path: concept.source.path })),
    });
  }
  const concept = candidates[0];
  const state = snapshot.states[concept.id];
  if (!state) throw new CliError('SNAPSHOT_INVALID', `快照缺少概念状态：${concept.id}。`);
  return { concept, state };
}

function stateCounts(snapshot: Snapshot): Record<MemoryState['status'], number> {
  const counts: Record<MemoryState['status'], number> = { unknown: 0, recent: 0, revisit: 0, stale: 0, pending: 0, retained: 0 };
  for (const state of Object.values(snapshot.states)) counts[state.status] += 1;
  return counts;
}

function receiptPath(stateDir: string, sourceId: string, eventId: string): string {
  const digest = createHash('sha256').update(sourceId + eventId).digest('hex');
  return join(stateDir, `${digest}.json`);
}

function ensureStateDir(stateDir: string): void {
  try {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    chmodSync(stateDir, 0o700);
  } catch {
    throw new CliError('RECEIPT_STORAGE_FAILED', '无法创建 CLI 私有收据目录。');
  }
}

function parseReceipt(value: unknown, path: string): ReviewReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CliError('RECEIPT_INVALID', `收据无效：${path}。`);
  const candidate = value as Partial<ReviewReceipt>;
  const request = candidate.request;
  if (candidate.version !== 1 || typeof candidate.sourceId !== 'string' || typeof candidate.eventId !== 'string' || (candidate.status !== 'pending' && candidate.status !== 'succeeded') || typeof candidate.createdAt !== 'string' || typeof candidate.updatedAt !== 'string' || !request || typeof request !== 'object' || Array.isArray(request)) {
    throw new CliError('RECEIPT_INVALID', `收据无效：${path}。`);
  }
  const review = request as Partial<ReviewRequest>;
  if (review.eventId !== candidate.eventId || review.kind !== 'review' || typeof review.conceptId !== 'string' || typeof review.sourceRevision !== 'string' || typeof review.occurredAt !== 'string' || !isValidInstant(review.occurredAt)) {
    throw new CliError('RECEIPT_INVALID', `收据中的冻结请求无效：${path}。`);
  }
  return candidate as ReviewReceipt;
}

function readReceipt(stateDir: string, sourceId: string, eventId: string): { receipt: ReviewReceipt | null; path: string } {
  const path = receiptPath(stateDir, sourceId, eventId);
  if (!existsSync(path)) return { receipt: null, path };
  try {
    return { receipt: parseReceipt(JSON.parse(readFileSync(path, 'utf8')) as unknown, path), path };
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError('RECEIPT_INVALID', `无法读取 CLI 收据：${path}。`);
  }
}

function findReceiptInOtherSource(stateDir: string, sourceId: string, eventId: string): ReviewReceipt | null {
  if (!existsSync(stateDir)) return null;
  let names: string[];
  try {
    names = readdirSync(stateDir);
  } catch {
    return null;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const path = join(stateDir, name);
    try {
      const receipt = parseReceipt(JSON.parse(readFileSync(path, 'utf8')) as unknown, path);
      if (receipt.eventId === eventId && receipt.sourceId !== sourceId) return receipt;
    } catch {
      // Ignore unrelated or incomplete files while looking for a source-owned receipt.
    }
  }
  return null;
}

function atomicWrite(path: string, value: unknown, allowReplace: boolean): void {
  const directory = dirname(path);
  ensureStateDir(directory);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8' });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporary, 0o600);
    if (allowReplace) {
      renameSync(temporary, path);
    } else {
      // linkSync fails with EEXIST without replacing a receipt another process
      // created after our initial lookup. The temporary file remains private
      // until the link is committed, then is removed.
      try {
        linkSync(temporary, path);
        unlinkSync(temporary);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new CliError('RECEIPT_EXISTS', '相同 sourceId 和 eventId 的本地收据已经存在。');
        }
        throw error;
      }
    }
    chmodSync(path, 0o600);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try { unlinkSync(temporary); } catch { /* no-op */ }
    if (error instanceof CliError) throw error;
    throw new CliError('RECEIPT_STORAGE_FAILED', '无法原子写入 CLI 私有收据。');
  }
}

function createReceipt(stateDir: string, receipt: ReviewReceipt): ReviewReceipt {
  ensureStateDir(stateDir);
  const { receipt: existing, path } = readReceipt(stateDir, receipt.sourceId, receipt.eventId);
  if (existing) return existing;
  try {
    atomicWrite(path, receipt, false);
  } catch (error) {
    if (error instanceof CliError && error.code === 'RECEIPT_EXISTS') {
      const raced = readReceipt(stateDir, receipt.sourceId, receipt.eventId).receipt;
      if (raced) return raced;
    }
    throw error;
  }
  const created = readReceipt(stateDir, receipt.sourceId, receipt.eventId).receipt;
  if (!created) throw new CliError('RECEIPT_STORAGE_FAILED', 'CLI 收据写入后无法读取。');
  return created;
}

function updateReceipt(stateDir: string, receipt: ReviewReceipt, patch: Partial<ReviewReceipt>): ReviewReceipt {
  const next: ReviewReceipt = { ...receipt, ...patch, updatedAt: new Date().toISOString() };
  const path = receiptPath(stateDir, receipt.sourceId, receipt.eventId);
  atomicWrite(path, next, true);
  const updated = readReceipt(stateDir, receipt.sourceId, receipt.eventId).receipt;
  if (!updated) throw new CliError('RECEIPT_STORAGE_FAILED', 'CLI 收据更新后无法读取。');
  return updated;
}

function eventRetryDetails(error: unknown, eventId: string): CliErrorDetails {
  const details: CliErrorDetails = error instanceof CliError ? { ...error.details } : {};
  details.eventId = eventId;
  details.retryCommand = `node --import tsx src/cli/index.ts retry ${eventId}`;
  return details;
}

function rethrowReviewError(error: unknown, eventId: string): never {
  if (error instanceof CliError) throw new CliError(error.code, error.message, eventRetryDetails(error, eventId));
  throw new CliError('REVIEW_FAILED', errorMessage(error), eventRetryDetails(error, eventId));
}

function assertReceiptMatches(
  receipt: ReviewReceipt,
  sourceId: string,
  selected: SelectedConcept,
  requestedRevision: string,
  requestedAt: string | undefined,
): void {
  if (receipt.sourceId !== sourceId) throw new CliError('SOURCE_MISMATCH', '收据属于其他 sourceId，已拒绝重用。');
  if (receipt.request.conceptId !== selected.concept.id) {
    throw new CliError('EVENT_CONFLICT', 'eventId 已绑定其他概念，不能改写原请求。', { eventId: receipt.eventId });
  }
  if (receipt.request.sourceRevision !== requestedRevision || receipt.request.sourceRevision !== selected.concept.source.revision) {
    throw new CliError('EVENT_CONFLICT', 'eventId 的 source revision 与当前概念不一致，不能改写原请求。', { eventId: receipt.eventId });
  }
  if (requestedAt !== undefined && receipt.request.occurredAt !== requestedAt) {
    throw new CliError('EVENT_CONFLICT', 'eventId 已冻结其他 occurredAt，不能改写原请求。', { eventId: receipt.eventId });
  }
}

async function postReview(client: ApiClient, stateDir: string, receipt: ReviewReceipt): Promise<{ receipt: ReviewReceipt; response: unknown }> {
  try {
    const response = await client.json<unknown>('/reviews', { method: 'POST', body: receipt.request, write: true });
    return { receipt: updateReceipt(stateDir, receipt, { status: 'succeeded', response }), response };
  } catch (error) {
    rethrowReviewError(error, receipt.eventId);
  }
}

function requestOptions(options: ParsedOptions, runner: CliRunnerOptions, env: NodeJS.ProcessEnv): { baseUrl: string; sourceRoot?: string; stateDir: string } {
  const rawUrl = configuredValue(options.url, runner.url, env, 'LM_SERVER_URL') ?? 'http://127.0.0.1:4317';
  return {
    baseUrl: validateBaseUrl(rawUrl),
    sourceRoot: configuredSourceRoot(options.sourceRoot, runner.sourceRoot, env),
    stateDir: configuredStateDir(options.stateDir, runner.stateDir, env),
  };
}

async function runQuery(client: ApiClient, root: string | undefined, args: string[]): Promise<Record<string, unknown>> {
  const query = asNonEmptyString(args.join(' '), '查询文本');
  const session = await client.session();
  validateSourceRoot(root, session.sourceId);
  const refreshed = await client.json<RefreshResponse>('/refresh', { method: 'POST', body: {}, write: true });
  const snapshot = await client.json<Snapshot>('/snapshot?scope=all');
  const needle = query.toLocaleLowerCase();
  const hits = snapshot.concepts
    .filter((concept) => [concept.title, concept.summary, ...concept.aliases].some((field) => field.toLocaleLowerCase().includes(needle)))
    .map((concept) => ({
      id: concept.id,
      title: concept.title,
      aliases: concept.aliases,
      domain: concept.domain,
      summary: concept.summary,
      source: concept.source,
      sourceRevision: concept.source.revision,
      state: snapshot.states[concept.id],
    }));
  return {
    command: 'query',
    query,
    sourceId: session.sourceId,
    scope: {
      kind: 'all',
      source: snapshot.source.name,
      mode: snapshot.source.mode,
      loadedConcepts: snapshot.concepts.length,
      sourceConcepts: snapshot.source.conceptCount,
      viewLimit: snapshot.source.limit,
    },
    refreshed,
    asOf: snapshot.asOf,
    hits,
  };
}

async function runShow(client: ApiClient, root: string | undefined, args: string[]): Promise<Record<string, unknown>> {
  const selector = asNonEmptyString(args.join(' '), '选择器');
  const session = await client.session();
  validateSourceRoot(root, session.sourceId);
  const snapshot = await client.json<Snapshot>('/snapshot?scope=all');
  const selected = resolveSelector(snapshot, selector);
  const incidentLinks = snapshot.links.filter((link) => link.source === selected.concept.id || link.target === selected.concept.id);
  return {
    command: 'show',
    selector,
    sourceId: session.sourceId,
    concept: selected.concept,
    sourceRevision: selected.concept.source.revision,
    state: selected.state,
    incidentLinks,
  };
}

async function runStatus(client: ApiClient, root: string | undefined, args: string[]): Promise<Record<string, unknown>> {
  const selector = args.length > 0 ? args.join(' ') : undefined;
  const session = await client.session();
  validateSourceRoot(root, session.sourceId);
  const snapshot = await client.json<Snapshot>('/snapshot?scope=all');
  const result: Record<string, unknown> = {
    command: 'status',
    sourceId: session.sourceId,
    config: snapshot.config,
    source: snapshot.source,
    asOf: snapshot.asOf,
    counts: {
      concepts: snapshot.concepts.length,
      sourceConcepts: snapshot.source.conceptCount,
      links: snapshot.links.length,
      observations: snapshot.observationsCount,
    },
    stateCounts: stateCounts(snapshot),
  };
  if (selector !== undefined) {
    const selected = resolveSelector(snapshot, selector);
    result.selector = selector;
    result.concept = selected.concept;
    result.state = selected.state;
  }
  return result;
}

async function runRefresh(client: ApiClient, root: string | undefined): Promise<Record<string, unknown>> {
  const session = await client.session();
  validateSourceRoot(root, session.sourceId);
  const refreshed = await client.json<RefreshResponse>('/refresh', { method: 'POST', body: {}, write: true });
  return { command: 'refresh', sourceId: session.sourceId, refreshed };
}

async function runAfter(client: ApiClient, root: string | undefined, args: string[], operationId: string | undefined): Promise<Record<string, unknown>> {
  const workflow = asNonEmptyString(args[0] ?? '', '工作流类型');
  if (!['query', 'ingest', 'consolidate'].includes(workflow)) throw new CliError('INVALID_ARGUMENT', 'after 的工作流类型必须是 query、ingest 或 consolidate。');
  const id = asNonEmptyString(operationId ?? '', '--operation-id');
  const session = await client.session();
  validateSourceRoot(root, session.sourceId);
  const refreshed = await client.json<RefreshResponse>('/refresh', { method: 'POST', body: {}, write: true });
  return {
    command: 'after',
    sourceId: session.sourceId,
    operationId: id,
    operationType: workflow,
    status: 'refreshed',
    reportedWorkflowStatus: 'succeeded',
    refreshed,
  };
}

async function runReview(
  client: ApiClient,
  root: string | undefined,
  stateDir: string,
  args: string[],
  options: ParsedOptions,
  now: () => Date,
): Promise<Record<string, unknown>> {
  if (!options.confirm) throw new CliError('CONFIRM_REQUIRED', 'review 必须明确提供 --confirm。');
  const selector = asNonEmptyString(args.join(' '), '选择器');
  const session = await client.session();
  validateSourceRoot(root, session.sourceId);
  const snapshot = await client.json<Snapshot>('/snapshot?scope=all');
  const selected = resolveSelector(snapshot, selector);
  const requestedRevision = options.revision ?? selected.concept.source.revision;
  if (requestedRevision !== selected.concept.source.revision) {
    throw new CliError('SOURCE_REVISION_MISMATCH', '指定的 --revision 与当前概念版本不一致。', {
      expectedRevision: selected.concept.source.revision,
      requestedRevision,
    });
  }
  const requestedAt = options.at === undefined ? undefined : normalizeInstant(options.at);
  const eventId = ensureEventId(options.eventId ?? randomUUID());
  const state = readReceipt(stateDir, session.sourceId, eventId);
  let receipt = state.receipt;
  if (receipt) {
    assertReceiptMatches(receipt, session.sourceId, selected, requestedRevision, requestedAt);
  } else {
    const occurredAt = requestedAt ?? nowIso(now);
    const request: ReviewRequest & { occurredAt: string } = {
      eventId,
      conceptId: selected.concept.id,
      sourceRevision: selected.concept.source.revision,
      kind: 'review',
      occurredAt,
    };
    receipt = createReceipt(stateDir, {
      version: 1,
      sourceId: session.sourceId,
      eventId,
      request,
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    assertReceiptMatches(receipt, session.sourceId, selected, requestedRevision, requestedAt);
  }
  const posted = await postReview(client, stateDir, receipt);
  return {
    command: 'review',
    selector,
    sourceId: session.sourceId,
    eventId,
    request: posted.receipt.request,
    response: posted.response,
    receipt: { status: posted.receipt.status, path: receiptPath(stateDir, session.sourceId, eventId) },
  };
}

async function runRetry(client: ApiClient, root: string | undefined, stateDir: string, args: string[]): Promise<Record<string, unknown>> {
  const eventId = ensureEventId(asNonEmptyString(args[0] ?? '', 'event-id'));
  const session = await client.session();
  validateSourceRoot(root, session.sourceId);
  const stored = readReceipt(stateDir, session.sourceId, eventId).receipt;
  if (!stored) {
    if (findReceiptInOtherSource(stateDir, session.sourceId, eventId)) {
      throw new CliError('SOURCE_MISMATCH', 'eventId 的收据属于其他 sourceId，已拒绝重用。', { eventId });
    }
    throw new CliError('RECEIPT_NOT_FOUND', `找不到 eventId 的 CLI 收据：${eventId}。`, {
      eventId,
      retryCommand: `node --import tsx src/cli/index.ts review <选择器> --confirm --event-id ${eventId}`,
    });
  }
  if (stored.sourceId !== session.sourceId || stored.eventId !== eventId) {
    throw new CliError('SOURCE_MISMATCH', '收据属于其他 sourceId，已拒绝重用。');
  }
  const posted = await postReview(client, stateDir, stored);
  return {
    command: 'retry',
    sourceId: session.sourceId,
    eventId,
    request: posted.receipt.request,
    response: posted.response,
    receipt: { status: posted.receipt.status, path: receiptPath(stateDir, session.sourceId, eventId) },
  };
}

/**
 * Execute one CLI command and return its JSON-serializable result.
 * The function does not write stdout/stderr, which keeps it useful for tests and bridges.
 */
export async function runCli(argv: string[], runner: CliRunnerOptions = {}): Promise<Record<string, unknown> | string> {
  const parsed = parseCommand(argv);
  if (parsed.options.help || parsed.name === null || parsed.name === 'help') return HELP_TEXT;
  const options = requestOptions(parsed.options, runner, runner.env ?? process.env);
  const timeoutMs = runner.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new CliError('INVALID_ARGUMENT', 'timeoutMs 必须是正数。');
  const env = runner.env ?? process.env;
  const credentialPath = env.LM_CLI_SESSION_FILE ?? join(env.LM_DATA_DIR ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../data/local'), 'cli-session.json');
  let deviceSession: string | undefined;
  try { deviceSession = runner.fetchImpl && !env.LM_CLI_SESSION_FILE ? undefined : readDeviceSession(credentialPath, options.baseUrl); }
  catch (error) { throw new CliError('CLI_AUTH_INVALID', errorMessage(error)); }
  const client = new ApiClient({ baseUrl: options.baseUrl, timeoutMs, fetchImpl: runner.fetchImpl ?? fetch, deviceSession });
  const root = options.sourceRoot;
  const stateDir = options.stateDir;
  const now = runner.now ?? (() => new Date());

  switch (parsed.name) {
    case 'query':
      return runQuery(client, root, parsed.args);
    case 'show':
      if (parsed.args.length === 0) throw new CliError('INVALID_ARGUMENT', 'show 需要一个选择器。');
      return runShow(client, root, parsed.args);
    case 'status':
      if (parsed.args.length > 1) throw new CliError('INVALID_ARGUMENT', 'status 最多接受一个选择器。');
      return runStatus(client, root, parsed.args);
    case 'refresh':
      if (parsed.args.length > 0) throw new CliError('INVALID_ARGUMENT', 'refresh 不接受位置参数。');
      return runRefresh(client, root);
    case 'after':
      if (parsed.args.length !== 1) throw new CliError('INVALID_ARGUMENT', 'after 需要 query、ingest 或 consolidate 之一。');
      return runAfter(client, root, parsed.args, parsed.options.operationId);
    case 'review':
      if (parsed.args.length === 0) throw new CliError('INVALID_ARGUMENT', 'review 需要一个选择器。');
      return runReview(client, root, stateDir, parsed.args, parsed.options, now);
    case 'retry':
      if (parsed.args.length !== 1) throw new CliError('INVALID_ARGUMENT', 'retry 需要一个 event-id。');
      if (parsed.options.eventId || parsed.options.at || parsed.options.revision || parsed.options.confirm) throw new CliError('INVALID_ARGUMENT', 'retry 只接受 event-id 和通用连接选项。');
      return runRetry(client, root, stateDir, parsed.args);
    default:
      throw new CliError('UNKNOWN_COMMAND', `未知命令：${parsed.name}。`, { help: '使用 --help 查看命令帮助。' });
  }
}

function errorPayload(error: unknown): Record<string, unknown> {
  if (error instanceof CliError) return { error: { code: error.code, message: error.message, ...error.details } };
  return { error: { code: 'CLI_ERROR', message: errorMessage(error) } };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  try {
    const result = await runCli(argv);
    process.stdout.write(typeof result === 'string' ? `${result}\n` : `${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${JSON.stringify(errorPayload(error))}\n`);
    return 1;
  }
}

const executedPath = process.argv[1] ? resolve(process.argv[1]) : '';
const modulePath = resolve(fileURLToPath(import.meta.url));
if (executedPath === modulePath) {
  void main().then((code) => {
    if (code !== 0) process.exitCode = code;
  });
}
