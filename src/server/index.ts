import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { createApp } from './app.js';
import { createFeishuConnector, type FeishuConnector } from '../integrations/feishu-connector.js';
import { parseFeishuConfig } from '../integrations/feishu-config.js';
import { createServiceLifecycle } from './service-lifecycle.js';
import { acquireDataDirectoryLock } from './data-directory-lock.js';
import { isRestoreQuarantined } from './instance-state.js';
import { validateStoragePaths } from './storage-paths.js';

const port = Number(process.env.LM_PORT ?? 4317);
const dataDir = process.env.LM_DATA_DIR ?? 'data/local';
validateStoragePaths({ root: process.env.LM_KG_ROOT ?? resolve(process.cwd(), 'fixtures/demo-kg'), dataDir,
  staticDir: resolve(process.cwd(), 'dist'), accountsEnabled: process.env.LM_AUTH_MODE !== 'local' });
const lease = acquireDataDirectoryLock(dataDir);
const connectorEnv = isRestoreQuarantined(dataDir) ? { ...process.env, LM_FEISHU_ENABLED: '0' } : process.env;
const feishuConfiguration = parseFeishuConfig(connectorEnv);
let connector: FeishuConnector | undefined;
const app = (() => { try { return createApp({
  port, accountsEnabled: process.env.LM_AUTH_MODE !== 'local',
  feishuScope: feishuConfiguration.ok && feishuConfiguration.value.enabled
    ? { appId: feishuConfiguration.value.appId, tenantKey: feishuConfiguration.value.tenantKey } : null,
  getFeishuChannelState: () => connector?.getStatus().state ?? 'disabled',
  feishuTimeZone: feishuConfiguration.ok && feishuConfiguration.value.enabled ? feishuConfiguration.value.timeZone : 'UTC',
}); } catch (error) { lease.release(); throw error; } })();
const server = createServer(app);
connector = createFeishuConnector({
  env: connectorEnv,
  confirmBinding: (input) => app.livingMemory.feishuBinding.confirm(input),
  prepareReading: (input) => app.livingMemory.feishuReading.prepare(input),
  prepareCardMessage: (input) => app.livingMemory.feishuCards.prepareMessage(input),
  prepareCardAction: (input) => app.livingMemory.feishuCards.prepareAction(input),
  onStatus: ({ state, code }) => {
    process.stdout.write(`Living Memory Feishu: ${state}${code ? ` (${code})` : ''}\n`);
  },
  onSendDiagnostic: ({ stage, code, httpStatus }) => {
    process.stderr.write(`Living Memory Feishu send: ${stage}${code === undefined ? '' : ` platformCode=${code}`}${httpStatus === undefined ? '' : ` httpStatus=${httpStatus}`}\n`);
  },
});
const lifecycle = createServiceLifecycle({
  connector,
  closeChanges: () => app.livingMemory.closeChanges(),
  closeHttp: () => new Promise<void>((resolve) => server.close(() => resolve())),
  closeStores: () => { try { app.livingMemory.close(); } finally { lease.release(); } },
});
server.once('error', () => {
  void lifecycle.shutdown().finally(() => { process.exitCode = 1; });
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
