import { parseFeishuConfig, type FeishuConfigErrorCode } from './feishu-config.js';
import { normalizeFeishuSdkCardAction } from './feishu-events.js';
import {
  createFeishuSdkDriverFactory,
  type FeishuCardResponse,
  type FeishuDriver,
  type FeishuDriverCallbacks,
  type FeishuDriverFactory,
} from './feishu-sdk-driver.js';

export type FeishuConnectorState = 'disabled' | 'starting' | 'connected' | 'reconnecting' | 'error' | 'stopped';
export type FeishuConnectorErrorCode = FeishuConfigErrorCode
  | 'sdk-init-failed' | 'sdk-start-failed' | 'sdk-connection-error' | 'sdk-stop-failed';
export interface FeishuConnectorStatus {
  state: FeishuConnectorState;
  code?: FeishuConnectorErrorCode;
}
export interface FeishuConnector {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  getStatus: () => FeishuConnectorStatus;
}
export interface FeishuConnectorOptions {
  env: Record<string, string | undefined>;
  driverFactory?: FeishuDriverFactory;
  onStatus?: (status: Readonly<FeishuConnectorStatus>) => void;
}

function denied(): FeishuCardResponse {
  return { toast: { type: 'error', content: '当前无法处理此卡片操作。' } };
}
function bindingNotReady(): FeishuCardResponse {
  return { toast: { type: 'info', content: '账号绑定尚未接入，请等待后续功能。' } };
}

/** No account/knowledge/learning service is available to this foundation connector. */
export function createFeishuConnector(options: FeishuConnectorOptions): FeishuConnector {
  const configuration = parseFeishuConfig(options.env);
  const factory = options.driverFactory ?? createFeishuSdkDriverFactory();
  let status: FeishuConnectorStatus = configuration.ok ? { state: 'disabled' } : { state: 'error', code: configuration.code };
  let driver: FeishuDriver | undefined;
  let driverStarted = false;
  let stopped = false;
  let startPromise: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  let driverClosePromise: Promise<void> | undefined;

  function publish(next: FeishuConnectorStatus, force = false): void {
    if (!force && status.state === next.state && status.code === next.code) return;
    status = next;
    // Observers only receive fixed state/code, never SDK errors, IDs or secrets.
    try { options.onStatus?.(Object.freeze({ ...next })); } catch { /* Logging cannot break the local service. */ }
  }
  function connected(): void {
    if (!stopped && driverStarted) publish({ state: 'connected' });
  }
  const callbacks: FeishuDriverCallbacks = {
    onReady: connected,
    onReconnected: connected,
    onError: () => {
      if (!stopped && driverStarted) publish({ state: 'error', code: 'sdk-connection-error' });
    },
    onReconnecting: () => {
      if (!stopped && driverStarted) publish({ state: 'reconnecting' });
    },
    onCardAction: (event) => {
      if (stopped || !driverStarted || !configuration.ok || !configuration.value.enabled) return denied();
      // Only the authenticated SDK WS callback reaches this adapter. Parsing itself is not authentication.
      const parsed = normalizeFeishuSdkCardAction(event, configuration.value);
      return parsed.ok ? bindingNotReady() : denied();
    },
  };

  function closeDriver(value: FeishuDriver, preserveStartFailure = false): Promise<void> {
    if (driverClosePromise) return driverClosePromise;
    driverClosePromise = Promise.resolve().then(async () => {
      try { await value.close(); }
      catch {
        if (!preserveStartFailure || stopped) publish({ state: 'stopped', code: 'sdk-stop-failed' });
      }
    });
    return driverClosePromise;
  }

  function start(): Promise<void> {
    if (startPromise) return startPromise;
    if (stopped) return Promise.resolve();
    startPromise = Promise.resolve().then(async () => {
      if (stopped) return;
      if (!configuration.ok) {
        publish({ state: 'error', code: configuration.code }, true);
        return;
      }
      if (!configuration.value.enabled) return;
      publish({ state: 'starting' });
      let created: FeishuDriver;
      try { created = await factory(configuration.value, callbacks); }
      catch {
        if (!stopped) publish({ state: 'error', code: 'sdk-init-failed' });
        return;
      }
      if (stopped) { await closeDriver(created); return; }
      driver = created;
      driverStarted = true;
      try { await driver.start(); }
      catch {
        if (!stopped) {
          driverStarted = false;
          driver = undefined;
          const closing = closeDriver(created, true);
          publish({ state: 'error', code: 'sdk-start-failed' });
          await closing;
        }
      }
    });
    return startPromise;
  }

  function stop(): Promise<void> {
    if (stopPromise) return stopPromise;
    stopped = true;
    driverStarted = false;
    // Preserve the completely silent default-disabled startup/shutdown path.
    if (!configuration.ok || configuration.value.enabled) publish({ state: 'stopped' });
    stopPromise = driver ? closeDriver(driver) : driverClosePromise ?? Promise.resolve();
    return stopPromise;
  }

  return { start, stop, getStatus: () => ({ ...status }) };
}
