/** Drain already-started writes before previewing a bulk restore. */
export function createPendingWriteBarrier() {
  const pending = new Set<Promise<unknown>>();
  return {
    track<T>(write: Promise<T>): Promise<T> {
      pending.add(write);
      void write.then(() => pending.delete(write), () => pending.delete(write));
      return write;
    },
    async settle(): Promise<void> {
      while (pending.size) await Promise.allSettled([...pending]);
    },
  };
}
