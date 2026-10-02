import type { FeishuConnector } from '../integrations/feishu-connector.js';

interface ServiceLifecycleOptions {
  connector: Pick<FeishuConnector, 'start' | 'stop'>;
  closeChanges: () => void;
  closeHttp: () => Promise<void>;
  closeStores: () => void;
}

/** Start only after HTTP is listening; stop the connector before closing local resources. */
export function createServiceLifecycle(options: ServiceLifecycleOptions) {
  let stopping = false;
  let started = false;
  let shutdownPromise: Promise<void> | undefined;
  return {
    onListening(): void {
      if (stopping || started) return;
      started = true;
      // Connector start absorbs/redacts its SDK failures; they do not take down HTTP.
      void options.connector.start();
    },
    shutdown(): Promise<void> {
      if (shutdownPromise) return shutdownPromise;
      stopping = true;
      shutdownPromise = Promise.resolve().then(async () => {
        try { await options.connector.stop(); }
        finally {
          try { options.closeChanges(); }
          finally {
            try { await options.closeHttp(); }
            finally { options.closeStores(); }
          }
        }
      });
      return shutdownPromise;
    },
  };
}
