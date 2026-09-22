import type { ChangeNotification } from '../shared/types';

/** The small part of EventSource that the browser subscription needs. */
export interface ChangeEventSource {
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onerror: ((event: Event) => void) | null;
  close(): void;
}

export interface ChangeSubscriptionOptions {
  url?: string;
  createEventSource?: (url: string) => ChangeEventSource;
  onChange: (notification: ChangeNotification) => void;
  onConnected?: (notification: ChangeNotification, reconnected: boolean) => void;
  onError?: (event: Event) => void;
}

const CHANGE_REASONS: ReadonlySet<ChangeNotification['reason']> = new Set([
  'connected',
  'source',
  'review',
  'observation',
  'config',
  'retention',
]);

function isChangeReason(value: unknown): value is ChangeNotification['reason'] {
  return typeof value === 'string' && CHANGE_REASONS.has(value as ChangeNotification['reason']);
}

/** Parse one default (unnamed) SSE data frame. Invalid frames are ignored. */
export function parseChangeNotification(value: unknown): ChangeNotification | null {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const candidate = parsed as Record<string, unknown>;
  if (
    typeof candidate.sourceId !== 'string' ||
    candidate.sourceId.length === 0 ||
    typeof candidate.revision !== 'number' ||
    !Number.isInteger(candidate.revision) ||
    candidate.revision < 0 ||
    !isChangeReason(candidate.reason)
  ) return null;
  return {
    sourceId: candidate.sourceId,
    revision: candidate.revision,
    reason: candidate.reason,
  };
}

/**
 * Subscribe to the local invalidation stream. EventSource reconnects itself;
 * the first `connected` frame after the first one is reported as a reconnect
 * so the caller can re-read its session and projection.
 */
export function subscribeToChanges(options: ChangeSubscriptionOptions): () => void {
  const createEventSource = options.createEventSource ?? ((url: string) => {
    if (typeof EventSource === 'undefined') throw new Error('EventSource is unavailable.');
    return new EventSource(url) as unknown as ChangeEventSource;
  });
  let eventSource: ChangeEventSource;
  try {
    eventSource = createEventSource(options.url ?? '/api/changes');
  } catch (error) {
    options.onError?.(error instanceof Event ? error : new Event('error'));
    return () => undefined;
  }

  let hasConnected = false;
  eventSource.onmessage = (event) => {
    const notification = parseChangeNotification(event.data);
    if (!notification) return;
    if (notification.reason === 'connected') {
      const reconnected = hasConnected;
      hasConnected = true;
      options.onConnected?.(notification, reconnected);
      return;
    }
    options.onChange(notification);
  };
  eventSource.onerror = (event) => options.onError?.(event);

  return () => {
    eventSource.onmessage = null;
    eventSource.onerror = null;
    eventSource.close();
  };
}

/**
 * A deferred latest-value operation. A failed operation keeps its value for a
 * later explicit trigger; it never schedules its own retry loop.
 */
export interface DeferredChangeController<T> {
  readonly hasPending: boolean;
  readonly inFlight: boolean;
  defer(value: T): void;
  peek(): T | null;
  consume(): T | null;
  clear(): void;
  begin(): { value: T; settle(success: boolean): boolean } | null;
}

export function createDeferredChangeController<T>(): DeferredChangeController<T> {
  let pending: T | null = null;
  let inFlight = false;
  return {
    get hasPending() { return pending !== null; },
    get inFlight() { return inFlight; },
    defer(value) { pending = value; },
    peek() { return pending; },
    consume() {
      const next = pending;
      pending = null;
      return next;
    },
    clear() { pending = null; },
    begin() {
      if (inFlight || pending === null) return null;
      const value = pending;
      inFlight = true;
      let settled = false;
      return {
        value,
        settle(success: boolean) {
          if (settled) return false;
          settled = true;
          inFlight = false;
          if (success && pending === value) pending = null;
          return success && pending !== null;
        },
      };
    },
  };
}
