interface GraphActivityOptions {
  requestFrame: (cb: (now: number) => void) => number;
  cancelFrame: (id: number) => void;
  onFrame: (now: number) => void;
  onStart: () => void;
  onStop: () => void;
}

export function createGraphActivityController(options: GraphActivityOptions): {
  setActive(active: boolean): void;
  dispose(): void;
} {
  let active: boolean | undefined;
  let disposed = false;
  let generation = 0;
  let pending: { id: number | null; generation: number } | null = null;

  const cancelPending = () => {
    const ticket = pending;
    pending = null;
    if (ticket?.id !== null && ticket?.id !== undefined) options.cancelFrame(ticket.id);
  };

  const schedule = (currentGeneration: number) => {
    if (disposed || !active || generation !== currentGeneration || pending) return;
    const ticket = { id: null as number | null, generation: currentGeneration };
    pending = ticket;
    try {
      ticket.id = options.requestFrame(now => {
        if (disposed || !active || generation !== ticket.generation || pending !== ticket) return;
        pending = null;
        options.onFrame(now);
        schedule(ticket.generation);
      });
    } catch (error) {
      if (pending === ticket) pending = null;
      throw error;
    }
  };

  return {
    setActive(nextActive) {
      if (disposed || active === nextActive) return;
      active = nextActive;
      const currentGeneration = ++generation;
      cancelPending();
      if (nextActive) {
        options.onStart();
        schedule(currentGeneration);
      } else {
        options.onStop();
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      const wasActive = active === true;
      active = false;
      generation++;
      cancelPending();
      if (wasActive) options.onStop();
    },
  };
}
