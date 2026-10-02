import { parseFeishuConfig, type FeishuConfigErrorCode } from './feishu-config.js';
import { normalizeFeishuSdkCardAction } from './feishu-events.js';
import { normalizeFeishuBindingMessage, normalizeFeishuReadMessage } from './feishu-messages.js';
import type { FeishuBindingConfirmation, FeishuBindingConfirmationResult, FeishuChannelState } from '../shared/feishu-binding.js';
import type { FeishuDeliveryResult, FeishuReadMessage } from '../shared/feishu-reading.js';
import type { PreparedFeishuReadReply } from '../server/feishu-reading.js';
import {
  createFeishuSdkDriverFactory,
  type FeishuCardResponse,
  type FeishuDriver,
  type FeishuDriverCallbacks,
  type FeishuDriverFactory,
} from './feishu-sdk-driver.js';

export type FeishuConnectorState = FeishuChannelState;
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
  confirmBinding?: (input: FeishuBindingConfirmation) => FeishuBindingConfirmationResult;
  prepareReading?: (input: FeishuReadMessage) => PreparedFeishuReadReply | null;
  /** Monotonic clock for the process-local admission limiter. */
  now?: () => number;
}

function denied(): FeishuCardResponse {
  return { toast: { type: 'error', content: '当前无法处理此卡片操作。' } };
}
function bindingNotReady(): FeishuCardResponse {
  return { toast: { type: 'info', content: '知识卡片操作尚未接入，请等待后续功能。' } };
}

/** Authenticated binding and bounded read capabilities; no learning-write capability. */
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
  const processing = new Set<Promise<void>>();
  const actors = new Map<string, { acceptedAt: number; inFlight: boolean }>();
  const clock = options.now ?? (() => performance.now());

  function admit(input: FeishuReadMessage): { acceptedAt: number; inFlight: boolean } | null {
    if (processing.size >= 4) return null;
    let instant: number;
    try { instant = clock(); } catch { return null; }
    if (!Number.isFinite(instant)) return null;
    const key = JSON.stringify([input.appId, input.tenantKey, input.openId]);
    const previous = actors.get(key);
    if (previous && (previous.inFlight || instant - previous.acceptedAt < 1000)) return null;
    // Only entries past their cooldown and with no in-flight request can be discarded.
    for (const [id, entry] of actors) {
      if (!entry.inFlight && instant - entry.acceptedAt >= 1000) actors.delete(id);
    }
    if (actors.size >= 256) return null;
    const entry = { acceptedAt: instant, inFlight: true };
    actors.set(key, entry);
    return entry;
  }

  async function readMessage(input: FeishuReadMessage): Promise<void> {
    if (stopped || !driverStarted) return;
    let prepared: PreparedFeishuReadReply | null = null;
    let result: FeishuDeliveryResult = 'failed-or-unknown';
    try {
      prepared = options.prepareReading?.(input) ?? null;
      if (!prepared) return;
      // Recheck after preparation; enter send without an asynchronous authorization gap.
      if (stopped || !driverStarted || !driver?.sendText
        || prepared.actor.appId !== input.appId || prepared.actor.tenantKey !== input.tenantKey || prepared.actor.openId !== input.openId
        || !prepared.stillAuthorized()) return;
      const reply = prepared;
      const delivered = await driver.sendText({ openId: reply.actor.openId, text: reply.text, uuid: reply.operationId,
        stillAuthorized: () => !stopped && driverStarted && reply.stillAuthorized() });
      if (delivered === 'platform-accepted') result = delivered;
    } catch { /* Never log original messages, SDK responses or errors. */ }
    finally {
      if (prepared) {
        try { prepared.settle(result); } catch { /* The attempted receipt still blocks automatic redelivery. */ }
      }
    }
  }

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
    onMessage: (event) => {
      if (stopped || !driverStarted || !configuration.ok || !configuration.value.enabled) return;
      const command = normalizeFeishuBindingMessage(event, configuration.value);
      if (command) {
        // Confirmation is an internal capability; never synthesize an HTTP request or owner session.
        try { options.confirmBinding?.(command); } catch { /* No SDK error or message body is logged. */ }
        return;
      }
      const input = normalizeFeishuReadMessage(event, configuration.value);
      if (!input || !options.prepareReading) return;
      const entry = admit(input);
      if (!entry) return;
      // Track work separately so the SDK can acknowledge the incoming event promptly.
      const work = Promise.resolve().then(() => readMessage(input));
      processing.add(work);
      void work.finally(() => { entry.inFlight = false; processing.delete(work); }).catch(() => {});
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
    const closing = driver ? closeDriver(driver) : driverClosePromise ?? Promise.resolve();
    stopPromise = Promise.all([closing, ...processing]).then(() => { actors.clear(); });
    return stopPromise;
  }

  return { start, stop, getStatus: () => ({ ...status }) };
}
