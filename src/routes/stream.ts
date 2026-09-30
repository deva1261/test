import { Router } from 'express';
import type { BoardChange, ChangeHub } from '../events/changes';

/**
 * GET /conversations/stream: Server-Sent Events carrying BoardChange notifications, so a newly
 * connected conversation, message or status change reaches the board without a page refresh.
 */
export function streamRouter(hub: ChangeHub, options: { heartbeatMs?: number } = {}): Router {
  const router = Router();

  router.get('/', (req, res) => {
    res.status(200).set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Stops nginx-style proxies from buffering the stream.
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write('retry: 3000\n\n');
    res.write('event: ready\ndata: {}\n\n');

    const send = (change: BoardChange) => {
      res.write(`event: change\ndata: ${JSON.stringify(change)}\n\n`);
    };
    const unsubscribe = hub.subscribe(send);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), options.heartbeatMs ?? 25_000);

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  return router;
}
