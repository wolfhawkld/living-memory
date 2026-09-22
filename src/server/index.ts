import { createServer } from 'node:http';
import { createApp } from './app.js';

const port = Number(process.env.LM_PORT ?? 4317);
const app = createApp({ port, accountsEnabled: process.env.LM_AUTH_MODE !== 'local' });
const server = createServer(app);
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`Living Memory local server listening on http://127.0.0.1:${port}\n`);
});

function shutdown(): void {
  app.livingMemory.closeChanges();
  server.close(() => {
    app.livingMemory.close();
    process.exit(0);
  });
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
