/**
 * Small in-memory Web Locks implementation for tests that exercise multiple
 * pages sharing a pending-write namespace.
 *
 * Requests for one name are granted in FIFO order. Consecutive shared
 * requests may run together, while an exclusive request waits for every
 * currently held shared lock. An ifAvailable request never joins the queue:
 * it receives null when the name is held or has a waiter already queued.
 */

type LockMode = 'shared' | 'exclusive';

interface MemoryLock {
  readonly name: string;
  readonly mode: LockMode;
}

interface MemoryLockOptions {
  readonly mode?: LockMode;
  readonly ifAvailable?: boolean;
}

type LockCallback<T> = (lock: MemoryLock | null) => T | PromiseLike<T>;

interface QueuedRequest<T = unknown> {
  readonly mode: LockMode;
  readonly callback: LockCallback<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
}

interface LockState {
  readonly queue: QueuedRequest<unknown>[];
  heldExclusive: boolean;
  heldShared: number;
}

export class MemoryLockManager {
  private readonly states = new Map<string, LockState>();

  request<T>(name: string, callback: LockCallback<T>): Promise<T>;
  request<T>(name: string, options: MemoryLockOptions, callback: LockCallback<T>): Promise<T>;
  request<T>(
    name: string,
    optionsOrCallback: MemoryLockOptions | LockCallback<T>,
    maybeCallback?: LockCallback<T>,
  ): Promise<T> {
    const options = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback;
    const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
    if (!callback) return Promise.reject(new TypeError('A lock callback is required'));
    const mode = options.mode ?? 'exclusive';
    const state = this.states.get(name) ?? { queue: [], heldExclusive: false, heldShared: 0 };
    this.states.set(name, state);

    if (options.ifAvailable && (state.heldExclusive || state.heldShared > 0 || state.queue.length > 0)) {
      // Native Web Locks invokes the callback through the returned promise,
      // so callback exceptions become rejections rather than synchronous throws.
      return Promise.resolve().then(() => callback(null));
    }

    if (options.ifAvailable) {
      return this.runImmediately(name, state, mode, callback);
    }

    return new Promise<T>((resolve, reject) => {
      state.queue.push({
        mode,
        callback,
        resolve: resolve as (value: unknown | PromiseLike<unknown>) => void,
        reject,
      });
      this.drain(name, state);
    });
  }

  private runImmediately<T>(name: string, state: LockState, mode: LockMode, callback: LockCallback<T>): Promise<T> {
    this.hold(state, mode);
    const lock: MemoryLock = { name, mode };
    let result: T | PromiseLike<T>;
    try {
      result = callback(lock);
    } catch (error) {
      this.release(name, state, mode);
      return Promise.reject(error);
    }
    return Promise.resolve(result).then(
      value => {
        this.release(name, state, mode);
        return value;
      },
      error => {
        this.release(name, state, mode);
        throw error;
      },
    );
  }

  private drain(name: string, state: LockState): void {
    if (state.heldExclusive) return;
    if (state.heldShared > 0) {
      // An exclusive waiter at the head preserves FIFO ordering. New shared
      // waiters behind it must wait until that exclusive request completes.
      while (state.queue[0]?.mode === 'shared') {
        this.startQueued(name, state, state.queue.shift()!);
      }
      return;
    }

    if (state.queue[0]?.mode === 'exclusive') {
      this.startQueued(name, state, state.queue.shift()!);
      return;
    }
    while (state.queue[0]?.mode === 'shared') {
      this.startQueued(name, state, state.queue.shift()!);
    }
  }

  private startQueued<T>(name: string, state: LockState, request: QueuedRequest<T>): void {
    this.hold(state, request.mode);
    const lock: MemoryLock = { name, mode: request.mode };
    let result: T | PromiseLike<T>;
    try {
      result = request.callback(lock);
    } catch (error) {
      this.release(name, state, request.mode);
      request.reject(error);
      return;
    }
    Promise.resolve(result).then(
      value => { this.release(name, state, request.mode); request.resolve(value); },
      error => { this.release(name, state, request.mode); request.reject(error); },
    );
  }

  private hold(state: LockState, mode: LockMode): void {
    if (mode === 'exclusive') state.heldExclusive = true;
    else state.heldShared += 1;
  }

  private release(name: string, state: LockState, mode: LockMode): void {
    if (mode === 'exclusive') state.heldExclusive = false;
    else state.heldShared -= 1;
    this.drain(name, state);
    if (!state.heldExclusive && state.heldShared === 0 && state.queue.length === 0) {
      this.states.delete(name);
    }
  }
}

export function createMemoryLockManager(): MemoryLockManager {
  return new MemoryLockManager();
}
