import { z } from 'zod';
import { CONVERSATION_STATUSES } from '../domain';

export const connectSchema = z
  .object({
    accountSid: z.string().trim().min(1, 'accountSid is required').max(64),
    authToken: z.string().min(1, 'authToken is required').max(256),
  })
  .strict();

export const listConversationsSchema = z.object({
  status: z.enum(CONVERSATION_STATUSES).optional(),
  q: z.string().trim().max(200).optional().transform((v) => v || undefined),
  since: z
    .string()
    .datetime({ offset: true, message: 'since must be an ISO 8601 timestamp' })
    .transform((v) => new Date(v))
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const sendMessageSchema = z
  .object({
    body: z.string().trim().min(1, 'body is required').max(1600, 'body must be at most 1600 characters'),
    author: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

export const updateStatusSchema = z.object({ status: z.enum(CONVERSATION_STATUSES) }).strict();
