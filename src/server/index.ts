import { createServer } from 'node:http';
import { createApp } from './app.js';
import { createFeishuConnector, type FeishuConnector } from '../integrations/feishu-connector.js';
import { parseFeishuConfig } from '../integrations/feishu-config.js';
import { createServiceLifecycle } from './service-lifecycle.js';

const port = Number(process.env.LM_PORT ?? 4317);
const feishuConfiguration = parseFeishuConfig(process.env);
let connector: FeishuConnector | undefined;
const app = createApp({
  port, accountsEnabled: process.env.LM_AUTH_MODE !== 'local',
  feishuScope: feishuConfiguration.ok && feishuConfiguration.value.enabled
    ? { appId: feishuConfiguration.value.appId, tenantKey: feishuConfiguration.value.tenantKey } : null,
  getFeishuChannelState: () => connector?.getStatus().state ?? 'disabled',
});
const server = createServer(app);
connector = createFeishuConnector({
  env: process.env,
  confirmBinding: (input) => app.livingMemory.feishuBinding.confirm(input),
  prepareReading: (input) => app.livingMemory.feishuReading.prepare(input),
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
