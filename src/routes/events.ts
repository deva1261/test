import express, { Router } from 'express';
import { Errors } from '../errors';
import { requireInternalToken } from '../middleware/requireInternalToken';
import { SIGNATURE_HEADER, isValidSignature } from '../provider/webhookSignature';
import { webhookEventSchema, type EventService } from '../services/eventService';
import { wrap } from './wrap';

export function webhooksRouter(events: EventService, options: { webhookSecret: string }): Router {
  const router = Router();

  // OP-008. Raw body so the HMAC is checked over exactly the bytes the provider signed.
  router.post(
    '/sprintle-twilio/events',
    express.raw({ type: '*/*', limit: '256kb' }),
    wrap(async (req, res) => {
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!isValidSignature(raw, req.get(SIGNATURE_HEADER), options.webhookSecret)) throw Errors.invalidSignature();

      let json: unknown;
      try {
        json = JSON.parse(raw.toString('utf8'));
      } catch {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Malformed request body' } });
        return;
      }
      const { eventId, duplicate } = await events.ingest(webhookEventSchema.parse(json));
      res.status(duplicate ? 200 : 202).json({ eventId, duplicate });
    }),
  );

  return router;
}

export function internalEventsRouter(events: EventService, options: { internalApiToken: string }): Router {
  const router = Router();
  router.use(requireInternalToken(options.internalApiToken));

  // OP-009
  router.post(
    '/:eventId/process',
    wrap(async (req, res) => {
      const outcome = await events.process(req.params.eventId);
      res.status(200).json({ eventId: req.params.eventId, outcome });
    }),
  );

  return router;
}
