import { createServer } from 'node:http';
import { createApp } from './app.js';
import { createFeishuConnector } from '../integrations/feishu-connector.js';
import { createServiceLifecycle } from './service-lifecycle.js';

const port = Number(process.env.LM_PORT ?? 4317);
const app = createApp({ port, accountsEnabled: process.env.LM_AUTH_MODE !== 'local' });
const server = createServer(app);
const connector = createFeishuConnector({
  env: process.env,
  onStatus: ({ state, code }) => {
    process.stdout.write(`Living Memory Feishu: ${state}${code ? ` (${code})` : ''}\n`);
  },
});
const lifecycle = createServiceLifecycle({
  connector,
  closeChanges: () => app.livingMemory.closeChanges(),
  closeHttp: () => new Promise<void>((resolve) => server.close(() => resolve())),
  closeStores: () => app.livingMemory.close(),
});
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`Living Memory local server listening on http://127.0.0.1:${port}\n`);
  lifecycle.onListening();
});

function shutdown(): void {
  void lifecycle.shutdown().then(() => process.exit(0), () => {
    process.stderr.write('Living Memory shutdown failed.\n');
    process.exit(1);
  });
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
