/** Storage changes are short critical sections; network synchronization uses a
 * separate lock so an offline record can still be saved during a slow request. */
export class PendingCoordinationError extends Error {
  readonly code = 'PENDING_COORDINATION_UNAVAILABLE';
  constructor() {
    super('此浏览器暂不支持安全的多页面同步。请更新浏览器并允许本地存储，保留当前内容后重试。');
  }
}

function lockManager(): LockManager {
  try {
    if (typeof window !== 'undefined' && typeof window.navigator?.locks?.request === 'function') {
      return window.navigator.locks;
    }
  } catch { /* Treat denied browser access like an unavailable capability. */ }
  throw new PendingCoordinationError();
}

function lockName(sourceId: string, operation: 'storage' | 'sync'): string {
  return `living-memory.pending.${operation}.v1.${encodeURIComponent(sourceId.trim())}`;
}

export function withPendingStorageLock<T>(sourceId: string, action: () => T): Promise<T> {
  // Every caller completes synchronously while holding this lock. No network
  // request or nested lock acquisition belongs in this critical section.
  return lockManager().request(lockName(sourceId, 'storage'), { mode: 'exclusive' }, () => action());
}

export function withPendingSyncLock<T>(sourceId: string, action: () => Promise<T>, busy: () => T): Promise<T> {
  return lockManager().request(lockName(sourceId, 'sync'), { mode: 'exclusive', ifAvailable: true },
    lock => lock ? action() : busy());
}
