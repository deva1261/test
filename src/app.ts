import express, { type Express } from 'express';
import { errorHandler, notFound } from './middleware/errorHandler';
import { conversationsRouter } from './routes/conversations';
import { internalEventsRouter, webhooksRouter } from './routes/events';
import { integrationsRouter } from './routes/integrations';
import type { ConversationService } from './services/conversationService';
import type { EventService } from './services/eventService';
import type { IntegrationService } from './services/integrationService';

export interface AppDeps {
  integrations: IntegrationService;
  conversations: ConversationService;
  events: EventService;
  webhookSecret: string;
  internalApiToken: string;
  /** Optional readiness probe, e.g. a `SELECT 1` against board-db. */
  healthCheck?: () => Promise<void>;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

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
