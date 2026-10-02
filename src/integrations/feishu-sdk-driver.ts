import type { FeishuConfigResult } from './feishu-config.js';

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
}
export interface FeishuDriver {
  start: () => Promise<void> | void;
  close: () => Promise<void> | void;
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
  EventDispatcher: new (options: { logger: typeof FEISHU_SILENT_LOGGER }) => {
    register: (handlers: Record<string, (event: unknown) => FeishuCardResponse>) => unknown;
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
    return {
      // start() only schedules connection; readiness comes from SDK callbacks.
      start: () => client.start({ eventDispatcher }),
      close: () => client.close({ force: true }),
    };
  };
}
