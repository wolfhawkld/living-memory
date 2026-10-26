import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { createApp } from './app.js';
import { createFeishuConnector, type FeishuConnector } from '../integrations/feishu-connector.js';
import { parseFeishuConfig } from '../integrations/feishu-config.js';
import { createServiceLifecycle } from './service-lifecycle.js';
import { acquireDataDirectoryLock } from './data-directory-lock.js';
import { isRestoreQuarantined } from './instance-state.js';
import { validateStoragePaths } from './storage-paths.js';
import { parseLearningRuntimeVersion } from './learning-runtime-version.js';
import { assertLearningDatabaseV3Ready } from './learning-namespace-v3.js';
import { assertStaticBuildCompatible } from './static-build-compatibility.js';

const learningSchemaVersion = parseLearningRuntimeVersion(process.env.LM_LEARNING_SCHEMA_VERSION);
const port = Number(process.env.LM_PORT ?? 4317);
const dataDir = process.env.LM_DATA_DIR ?? 'data/local';
const staticDir = process.env.LM_STATIC_DIR ?? resolve(process.cwd(), 'dist');
validateStoragePaths({ root: process.env.LM_KG_ROOT ?? resolve(process.cwd(), 'fixtures/demo-kg'), dataDir,
  staticDir, accountsEnabled: process.env.LM_AUTH_MODE !== 'local' });
if (learningSchemaVersion === 3) {
  // Reject incompatible assets and databases before acquiring a lease or
  // preparing sources, accounts, device credentials or a connector.
  assertStaticBuildCompatible(staticDir, learningSchemaVersion);
  assertLearningDatabaseV3Ready(join(dataDir, 'living-memory.sqlite'));
}
const lease = acquireDataDirectoryLock(dataDir);
const connectorEnv = isRestoreQuarantined(dataDir) ? { ...process.env, LM_FEISHU_ENABLED: '0' } : process.env;
const feishuConfiguration = parseFeishuConfig(connectorEnv);
let connector: FeishuConnector | undefined;
const app = (() => { try { return createApp({
  port, staticDir, learningSchemaVersion, accountsEnabled: process.env.LM_AUTH_MODE !== 'local',
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
