import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { Layout, ModelConfig, Snapshot } from '../shared/types.js';
import { isValidInstant } from '../core/time-model.js';
import { loadKnowledgeGraph, KnowledgeSourceError, type KnowledgeSource } from './kg.js';
import {
  parseObservationRequest,
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
}

export interface LivingMemoryApp extends Express {
  livingMemory: {
    store: Store;
    getSource: () => KnowledgeSource;
    refresh: () => KnowledgeSource;
    token: string;
    port: number;
  };
}

const DEFAULT_PORT = 4317;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 300;

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

function conceptById(source: KnowledgeSource, id: string) {
  const concept = source.graph.concepts.find((item) => item.id === id);
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
  const initialSource = loadKnowledgeGraph({ root, limit: sourceLimit(options), includePrefix: sourceInclude(options) });
  const dataDir = options.dataDir ?? process.env.LM_DATA_DIR ?? 'data/local';
  const store = new Store({ dataDir, dbPath: options.dbPath, namespace: initialSource.namespace, now: options.now });
  const token = options.token ?? randomBytes(32).toString('hex');
  let source = initialSource;
  const now = options.now ?? (() => new Date());
  const app = express() as LivingMemoryApp;
  app.use(express.json({ limit: '1mb' }));

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
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-LM-Token');
      res.status(204).end();
      return;
    }
    next();
  });

  const requireWrite = (req: Request, res: Response, next: NextFunction): void => {
    if (writeToken(req) !== token) {
      res.status(401).json({ error: { code: 'TOKEN_REQUIRED', message: '写入请求需要有效的本地会话令牌。' } });
      return;
    }
    next();
  };

  app.get('/api/session', (_req, res) => res.json({ writeToken: token, sourceId: source.namespace }));
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', modelVersion: store.getConfig().modelVersion, source: source.graph.source });
  });
  app.get('/api/snapshot', asyncRoute((req, res) => {
    const asOf = parseAsOf(req.query.asOf, now());
    const snapshot: Snapshot = {
      ...source.graph,
      config: store.getConfig(),
      states: store.getStates(source.graph.concepts, asOf),
      asOf,
      observationsCount: store.countObservations(),
    };
    res.json(snapshot);
  }));
  app.post('/api/reviews', requireWrite, asyncRoute((req, res) => {
    const review = parseReviewRequest(req.body);
    if (!store.hasEvent(review.eventId)) {
      const concept = conceptById(source, review.conceptId);
      if (review.sourceRevision !== concept.source.revision) throw new StoreError('SOURCE_REVISION_MISMATCH', '概念内容已变化，请先刷新知识源后重新确认。', 409);
    }
    const receipt = store.addReview(review);
    res.status(receipt.status === 'accepted' ? 201 : 200).json(receipt);
  }));
  app.post('/api/observations', requireWrite, asyncRoute((req, res) => {
    const observation = parseObservationRequest(req.body);
    if (!store.hasEvent(observation.eventId)) {
      const concept = conceptById(source, observation.conceptId);
      if (observation.sourceRevision !== concept.source.revision) throw new StoreError('SOURCE_REVISION_MISMATCH', '概念内容已变化，请先刷新知识源后重新确认。', 409);
    }
    const observedAt = parseAsOf(observation.observedAt, now());
    if (Date.parse(observedAt) > now().getTime()) throw new StoreError('FUTURE_OBSERVATION', '观察时间不能晚于服务当前时间。');
    const expectedAnchor = store.getAnchor(observation.conceptId, observedAt);
    const receipt = store.addObservation({ ...observation, observedAt }, expectedAnchor?.eventId ?? null);
    res.status(receipt.status === 'accepted' ? 201 : 200).json(receipt);
  }));
  app.put('/api/config', requireWrite, asyncRoute((req, res) => {
    const body = req.body as Record<string, unknown>;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new StoreError('INVALID_BODY', '请求体必须是 JSON 对象。');
    const halfLifeDays = body.halfLifeDays;
    const revision = body.revision;
    if (typeof halfLifeDays !== 'number' || !Number.isFinite(halfLifeDays)) throw new StoreError('INVALID_HALF_LIFE', 'halfLifeDays 必须是有限数字。');
    if (typeof revision !== 'number' || !Number.isInteger(revision)) throw new StoreError('INVALID_REVISION', 'revision 必须是正整数。');
    res.json(store.updateConfig(halfLifeDays, revision));
  }));
  app.get('/api/layout', (_req, res) => res.json(store.getLayout()));
  app.put('/api/layout', requireWrite, asyncRoute((req, res) => res.json(store.setLayout(validateLayout(req.body)))));
  app.get('/api/export', (_req, res) => {
    const data = store.exportData(source.graph.source, source.graph.concepts);
    res.setHeader('Content-Disposition', 'attachment; filename="living-memory-export.json"');
    res.type('application/json').send(JSON.stringify(data));
  });
  app.post('/api/refresh', requireWrite, asyncRoute((_req, res) => {
    source = loadKnowledgeGraph({ root, limit: sourceLimit(options), includePrefix: sourceInclude(options) });
    res.json({ status: 'ok', source: source.graph.source });
  }));

  const staticDir = options.staticDir ?? resolve(process.cwd(), 'dist');
  if (existsSync(staticDir)) app.use(express.static(staticDir));
  app.use('/api', (_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: '找不到该 API。' } }));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => apiError(res, error));
  app.livingMemory = {
    store,
    getSource: () => source,
    refresh: () => {
      source = loadKnowledgeGraph({ root, limit: sourceLimit(options), includePrefix: sourceInclude(options) });
      return source;
    },
    token,
    port,
  };
  return app;
}

export function closeApp(app: LivingMemoryApp): void {
  app.livingMemory.store.close();
}

export { apiError };
