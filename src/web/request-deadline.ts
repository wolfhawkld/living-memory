export const REQUEST_TIMEOUT_MS = 15_000;
export const BULK_REQUEST_TIMEOUT_MS = 60_000;

export class RequestDeadlineError extends Error {
  readonly code = 'REQUEST_TIMEOUT';
  constructor() {
    super('请求等待超时。');
    this.name = 'RequestDeadlineError';
  }
}

/** Bounds fetch AND body consumption. Aborting the transport is best effort:
 * a timed-out write can already have committed on the server. */
export function withRequestDeadline<T>(
  run: (signal: AbortSignal) => Promise<T>,
  { signal, timeoutMs = REQUEST_TIMEOUT_MS }: { signal?: AbortSignal | null; timeoutMs?: number } = {},
): Promise<T> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new RangeError('Invalid request deadline'));
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const abort = (reason: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      controller.abort(reason);
      reject(reason);
    };
    const onAbort = () => abort(signal?.reason);
    const timer = setTimeout(() => abort(new RequestDeadlineError()), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    const complete = (finish: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      finish();
    };
    try {
      // Always attach both handlers, so late results cannot update callers or
      // create unhandled rejections after a timeout/cancellation has won.
      Promise.resolve(run(controller.signal)).then(
        value => complete(() => resolve(value)),
        error => complete(() => reject(error)),
      );
    } catch (error) {
      complete(() => reject(error));
    }
  });
}
