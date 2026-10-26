import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initializeAnswerClearingSchemaV3 } from '../../src/server/answer-clearing-schema';
import { createApp, closeApp } from '../../src/server/app';

// Dedicated synthetic instance; never select a profile or read personal env files.
const temp = mkdtempSync(join(tmpdir(), 'lm-browser-v3-'));
const root = join(temp, 'knowledge'), dataDir = join(temp, 'data');
mkdirSync(root); mkdirSync(dataDir);
for (const name of ['Alpha', 'Beta', 'Gamma']) writeFileSync(join(root, `${name}.md`), `---\ntype: concept\ntitle: ${name}\n---\nSynthetic ${name} concept.\n`);
const db = new DatabaseSync(join(dataDir, 'living-memory.sqlite'));
db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
initializeAnswerClearingSchemaV3(db, { recordedAt: new Date().toISOString() });
db.exec('COMMIT'); db.close();
const app = createApp({ root, dataDir, staticDir: resolve('dist'), port: 4319, accountsEnabled: true, learningSchemaVersion: 3 });
const server = createServer(app);
server.listen(4319, '127.0.0.1', () => process.stdout.write('Living Memory synthetic v3 ready\n'));
const shutdown = () => { app.livingMemory.closeChanges(); server.close(() => { closeApp(app); rmSync(temp, { recursive: true, force: true }); process.exit(0); }); };
process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
