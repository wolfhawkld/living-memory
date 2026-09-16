import { createServer } from 'node:http';
import { createApp } from './app.js';

const port = Number(process.env.LM_PORT ?? 4317);
const app = createApp({ port });
const server = createServer(app);
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`Living Memory local server listening on http://127.0.0.1:${port}\n`);
});

function shutdown(): void {
  server.close(() => {
    app.livingMemory.store.close();
    process.exit(0);
  });
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
