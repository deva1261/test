import { Router } from 'express';
import type { ConversationService } from '../services/conversationService';
import { listConversationsSchema, sendMessageSchema, updateStatusSchema } from '../validation/schemas';
import { wrap } from './wrap';

export function conversationsRouter(conversations: ConversationService): Router {
  const router = Router();

  // OP-004
  router.get(
    '/',
    wrap(async (req, res) => {
      const filter = listConversationsSchema.parse(req.query);
      res.status(200).json(await conversations.list(filter));
    }),
  );

  // OP-005
  router.get(
    '/:id/messages',
    wrap(async (req, res) => {
      res.status(200).json(await conversations.messages(req.params.id));
    }),
  );

  // OP-006
  router.post(
    '/:id/messages',
    wrap(async (req, res) => {
      const input = sendMessageSchema.parse(req.body ?? {});
      res.status(201).json({ message: await conversations.send(req.params.id, input) });
    }),
  );

  // OP-007
  router.patch(
    '/:id/status',
    wrap(async (req, res) => {
      const { status } = updateStatusSchema.parse(req.body ?? {});
      res.status(200).json({ conversation: await conversations.updateStatus(req.params.id, status) });
    }),
  );

  return router;
}
