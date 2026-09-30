import { Client } from 'pg';
import { CHANGE_CHANNEL, type BoardChange, type ChangeHub } from './changes';

/**
 * LISTENs on board_changes and forwards each notification to the hub. Reconnects with backoff,
 * so a database restart only pauses live updates; the UI's polling fallback covers the gap.
 */
export function listenForChanges(connectionString: string, hub: ChangeHub): { close: () => Promise<void> } {
  let client: Client | null = null;
  let closed = false;
  let retryMs = 1000;
  let timer: NodeJS.Timeout | null = null;

  const scheduleReconnect = () => {
    if (closed || timer) return;
    timer = setTimeout(() => {
      timer = null;
      void connect();
    }, retryMs);
    retryMs = Math.min(retryMs * 2, 30_000);
  };

  const connect = async () => {
    const c = new Client({ connectionString });
    c.on('error', (err) => {
      console.error('Change listener error:', err.message);
      c.end().catch(() => undefined);
      scheduleReconnect();
    });
    c.on('notification', (msg) => {
      if (msg.channel !== CHANGE_CHANNEL || !msg.payload) return;
      try {
        hub.emit(JSON.parse(msg.payload) as BoardChange);
      } catch {
        console.warn('Ignoring malformed change notification');
      }
    });
    try {
      await c.connect();
      await c.query(`LISTEN ${CHANGE_CHANNEL}`);
      client = c;
      retryMs = 1000;
    } catch (err) {
      console.error('Change listener could not connect:', (err as Error).message);
      c.end().catch(() => undefined);
      scheduleReconnect();
    }
  };

  void connect();

  return {
    close: async () => {
      closed = true;
      if (timer) clearTimeout(timer);
      await client?.end().catch(() => undefined);
    },
  };
}
