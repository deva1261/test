import express, { type Express } from 'express';
import type { ChangeHub } from './events/changes';
import { errorHandler, notFound } from './middleware/errorHandler';
import { conversationsRouter } from './routes/conversations';
import { internalEventsRouter, webhooksRouter } from './routes/events';
import { integrationsRouter } from './routes/integrations';
import { streamRouter } from './routes/stream';
import type { ConversationService } from './services/conversationService';
import type { EventService } from './services/eventService';
import type { IntegrationService } from './services/integrationService';

export interface AppDeps {
  integrations: IntegrationService;
  conversations: ConversationService;
  events: EventService;
  webhookSecret: string;
  internalApiToken: string;
  changes: ChangeHub;
  /** Directory holding the board UI (public/). Omit to run API-only. */
  staticDir?: string;
  streamHeartbeatMs?: number;
  /** Optional readiness probe, e.g. a `SELECT 1` against board-db. */
  healthCheck?: () => Promise<void>;
}

/**
 * connect-src 'self' means the browser can only reach this backend: the board UI cannot call
 * Sprintle/Twilio (or anything else) directly, so every request goes through board-api (REQ-009).
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "connect-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use((_req, res, next) => {
    res.set({
      'Content-Security-Policy': CONTENT_SECURITY_POLICY,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    next();
  });

  app.get('/healthz', async (_req, res) => {
    try {
      await deps.healthCheck?.();
      res.json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  });

  // Mounted before express.json(): the webhook route needs the raw body for its signature check.
  app.use('/webhooks', webhooksRouter(deps.events, { webhookSecret: deps.webhookSecret }));

  // Before the no-store middleware below, which would otherwise override its caching headers.
  app.use('/conversations/stream', streamRouter(deps.changes, { heartbeatMs: deps.streamHeartbeatMs }));
  if (deps.staticDir) app.use(express.static(deps.staticDir, { index: 'index.html', maxAge: 0 }));

  app.use(express.json({ limit: '32kb' }));
  app.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.use('/integrations', integrationsRouter(deps.integrations));
  app.use('/conversations', conversationsRouter(deps.conversations));
  app.use('/internal/events', internalEventsRouter(deps.events, { internalApiToken: deps.internalApiToken }));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
