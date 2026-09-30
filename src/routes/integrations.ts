import { Router } from 'express';
import type { IntegrationService } from '../services/integrationService';
import { connectSchema } from '../validation/schemas';
import { wrap } from './wrap';

export function integrationsRouter(integrations: IntegrationService): Router {
  const router = Router();

  // OP-001
  router.post(
    '/connect',
    wrap(async (req, res) => {
      const credentials = connectSchema.parse(req.body ?? {});
      res.status(201).json({ integration: await integrations.connect(credentials) });
    }),
  );

  // OP-002
  router.post(
    '/disconnect',
    wrap(async (_req, res) => {
      res.status(200).json(await integrations.disconnect());
    }),
  );

  // OP-003
  router.get(
    '/status',
    wrap(async (_req, res) => {
      res.status(200).json({ integration: await integrations.status() });
    }),
  );

  return router;
}
