import type { Response } from 'express';
import type { ChangeNotification } from '../shared/types.js';

/** Local SSE invalidations. Reconnection sends an initial frame to recover any gap. */
export function createChangeFeed(sourceId: string) {
  const clients = new Set<Response>();
  let revision = 0;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const remove = (client: Response) => {
    clients.delete(client);
    if (!clients.size && heartbeat) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
  };
  const write = (client: Response, frame: string) => {
    if (client.destroyed || client.writableEnded) { remove(client); return; }
    // Do not let an unread local connection accumulate an unbounded buffer.
    if (!client.write(frame)) { remove(client); client.end(); }
  };
  const send = (client: Response, reason: ChangeNotification['reason']) => {
    const message: ChangeNotification = { sourceId, revision, reason };
    write(client, `data: ${JSON.stringify(message)}\n\n`);
  };
  const close = () => {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = undefined;
    for (const client of clients) client.end();
    clients.clear();
  };
  return {
    subscribe(client: Response) {
      client.status(200).set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      client.flushHeaders();
      clients.add(client);
      client.on('close', () => remove(client));
      client.on('error', () => { remove(client); client.destroy(); });
      send(client, 'connected');
      if (!heartbeat && clients.size > 0) {
        heartbeat = setInterval(() => {
          for (const current of clients) write(current, ': keepalive\n\n');
        }, 15_000);
        heartbeat.unref();
      }
    },
    publish(reason: Exclude<ChangeNotification['reason'], 'connected'>) {
      revision += 1;
      for (const client of clients) send(client, reason);
    },
    close,
  };
}
