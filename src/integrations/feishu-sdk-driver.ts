import type { FeishuConfigResult } from './feishu-config.js';
import type { FeishuDeliveryResult } from '../shared/feishu-reading.js';

export const FEISHU_HTTP_TIMEOUT_MS = 10_000;
const MAX_SEND_BODY_BYTES = 12 * 1024;

export interface FeishuSendText {
  openId: string;
  text: string;
  uuid: string;
  stillAuthorized: () => boolean;
}

export type EnabledFeishuConfig = Extract<Extract<FeishuConfigResult, { ok: true }>['value'], { enabled: true }>;
export interface FeishuCardResponse {
  toast: { type: 'info' | 'error'; content: string };
}
export interface FeishuDriverCallbacks {
  onReady: () => void;
  onError: () => void;
  onReconnecting: () => void;
  onReconnected: () => void;
  onCardAction: (event: unknown) => FeishuCardResponse;
  onMessage?: (event: unknown) => void;
}
export interface FeishuDriver {
  start: () => Promise<void> | void;
  close: () => Promise<void> | void;
  sendText?: (input: FeishuSendText) => Promise<FeishuDeliveryResult>;
}
export type FeishuDriverFactory = (config: EnabledFeishuConfig, callbacks: FeishuDriverCallbacks) => Promise<FeishuDriver>;

/** SDK logs may contain tickets and event bodies. Suppress all five methods. */
export const FEISHU_SILENT_LOGGER = Object.freeze({
  error: (..._args: unknown[]) => {},
  warn: (..._args: unknown[]) => {},
  info: (..._args: unknown[]) => {},
  debug: (..._args: unknown[]) => {},
  trace: (..._args: unknown[]) => {},
});

interface SdkContract {
  Client?: new (options: {
    appId: string;
    appSecret: string;
    logger: typeof FEISHU_SILENT_LOGGER;
    httpInstance: BoundedHttp;
  }) => { im: { message: { create: (payload: unknown) => Promise<unknown> } } };
  defaultHttpInstance?: BoundedHttp;
  EventDispatcher: new (options: { logger: typeof FEISHU_SILENT_LOGGER }) => {
    register: (handlers: Record<string, (event: unknown) => FeishuCardResponse | void>) => unknown;
  };
  WSClient: new (options: {
    appId: string;
    appSecret: string;
    logger: typeof FEISHU_SILENT_LOGGER;
    autoReconnect: true;
    handshakeTimeoutMs: number;
    onReady: () => void;
    onError: () => void;
    onReconnecting: () => void;
    onReconnected: () => void;
  }) => {
    start: (options: { eventDispatcher: unknown }) => Promise<void> | void;
    close: (options: { force: true }) => Promise<void> | void;
  };
}

interface BoundedHttp {
  request: (options: Record<string, unknown>) => Promise<unknown>;
  get: (url: string, options?: Record<string, unknown>) => Promise<unknown>;
  delete: (url: string, options?: Record<string, unknown>) => Promise<unknown>;
  head: (url: string, options?: Record<string, unknown>) => Promise<unknown>;
  options: (url: string, options?: Record<string, unknown>) => Promise<unknown>;
  post: (url: string, data?: unknown, options?: Record<string, unknown>) => Promise<unknown>;
  put: (url: string, data?: unknown, options?: Record<string, unknown>) => Promise<unknown>;
  patch: (url: string, data?: unknown, options?: Record<string, unknown>) => Promise<unknown>;
}

/** Keep the SDK response interceptor, but never mutate its shared defaults. */
function boundedHttp(base: BoundedHttp, authorizeDispatch: (options: Record<string, unknown>) => boolean): BoundedHttp {
  for (const method of ['request', 'get', 'delete', 'head', 'options', 'post', 'put', 'patch'] as const) {
    if (typeof base?.[method] !== 'function') throw new Error('Feishu SDK HTTP exports unavailable');
  }
  return {
    request: (options) => {
      // SDK token retrieval happens before this actual message dispatch boundary.
      if (!authorizeDispatch(options)) throw new Error('Feishu message dispatch rejected');
      return base.request({ ...options, timeout: FEISHU_HTTP_TIMEOUT_MS });
    },
    get: (url, options) => base.get(url, { ...options, timeout: FEISHU_HTTP_TIMEOUT_MS }),
    delete: (url, options) => base.delete(url, { ...options, timeout: FEISHU_HTTP_TIMEOUT_MS }),
    head: (url, options) => base.head(url, { ...options, timeout: FEISHU_HTTP_TIMEOUT_MS }),
    options: (url, options) => base.options(url, { ...options, timeout: FEISHU_HTTP_TIMEOUT_MS }),
    post: (url, data, options) => base.post(url, data, { ...options, timeout: FEISHU_HTTP_TIMEOUT_MS }),
    put: (url, data, options) => base.put(url, data, { ...options, timeout: FEISHU_HTTP_TIMEOUT_MS }),
    patch: (url, data, options) => base.patch(url, data, { ...options, timeout: FEISHU_HTTP_TIMEOUT_MS }),
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value;
}

/** The dependency is loaded only when an explicitly enabled connector starts. */
export function createFeishuSdkDriverFactory(
  loadSdk: () => Promise<unknown> = () => import('@larksuiteoapi/node-sdk'),
): FeishuDriverFactory {
  return async (config, callbacks) => {
    const loaded = await loadSdk();
    if (!loaded || typeof loaded !== 'object'
      || typeof (loaded as Partial<SdkContract>).WSClient !== 'function'
      || typeof (loaded as Partial<SdkContract>).EventDispatcher !== 'function') {
      throw new Error('Feishu SDK exports unavailable');
    }
    // Narrow adapter for the pinned 1.74.0 public constructor/lifecycle contract.
    const sdk = loaded as SdkContract;
    const eventDispatcher = new sdk.EventDispatcher({ logger: FEISHU_SILENT_LOGGER }).register({
      'card.action.trigger': (event) => callbacks.onCardAction(event),
      'im.message.receive_v1': (event) => callbacks.onMessage?.(event),
    });
    const client = new sdk.WSClient({
      appId: config.appId,
      appSecret: config.appSecret,
      logger: FEISHU_SILENT_LOGGER,
      autoReconnect: true,
      handshakeTimeoutMs: 15_000,
      onReady: callbacks.onReady,
      onError: callbacks.onError,
      onReconnecting: callbacks.onReconnecting,
      onReconnected: callbacks.onReconnected,
    });
    let closed = false;
    let sender: InstanceType<NonNullable<SdkContract['Client']>> | undefined;
    const active = new Map<string, { openId: string; content: string; guard: () => boolean }>();
    function authorizeDispatch(options: Record<string, unknown>): boolean {
      if (closed || options.url !== 'https://open.feishu.cn/open-apis/im/v1/messages' || options.method !== 'POST'
        || !record(options.params) || options.params.receive_id_type !== 'open_id' || !record(options.data)
        || options.data.msg_type !== 'text' || typeof options.data.uuid !== 'string') return false;
      const request = active.get(options.data.uuid);
      return !!request && options.data.receive_id === request.openId && options.data.content === request.content && request.guard();
    }
    return {
      // start() only schedules connection; readiness comes from SDK callbacks.
      start: () => client.start({ eventDispatcher }),
      close: () => { closed = true; return client.close({ force: true }); },
      sendText: async (input) => {
        if (closed || !input || !validId(input.openId)
          || typeof input.uuid !== 'string' || !/^[a-f0-9]{32}$/.test(input.uuid)
          || typeof input.text !== 'string' || !input.text.trim() || typeof input.stillAuthorized !== 'function'
          || active.has(input.uuid) || active.size >= 4) return 'failed-or-unknown';
        const data = { receive_id: input.openId, msg_type: 'text', content: JSON.stringify({ text: input.text }), uuid: input.uuid };
        if (Buffer.byteLength(JSON.stringify(data), 'utf8') > MAX_SEND_BODY_BYTES) return 'failed-or-unknown';
        try {
          if (!input.stillAuthorized()) return 'failed-or-unknown';
          active.set(input.uuid, { openId: input.openId, content: data.content, guard: input.stillAuthorized });
          if (!sender) {
            if (typeof sdk.Client !== 'function' || !sdk.defaultHttpInstance) return 'failed-or-unknown';
            sender = new sdk.Client({ appId: config.appId, appSecret: config.appSecret,
              logger: FEISHU_SILENT_LOGGER, httpInstance: boundedHttp(sdk.defaultHttpInstance, authorizeDispatch) });
          }
          const response = await sender.im.message.create({ params: { receive_id_type: 'open_id' }, data });
          return record(response) && response.code === 0 && record(response.data) && validId(response.data.message_id)
            ? 'platform-accepted' : 'failed-or-unknown';
        } catch { return 'failed-or-unknown'; }
        finally { active.delete(input.uuid); }
      },
    };
  };
}
