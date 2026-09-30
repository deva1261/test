import { z } from 'zod';
import { MESSAGE_STATUSES } from '../domain';

// Shapes Sprintle/Twilio returns from its REST API and embeds in webhook `data`.
export const providerConversationSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  participant: z.string(),
  lastMessagePreview: z.string().nullable().default(null),
  lastMessageAt: z.string().datetime({ offset: true }).nullable().default(null),
  updatedAt: z.string().datetime({ offset: true }),
});

export const providerMessageSchema = z.object({
  id: z.string().min(1),
  conversationId: z.string().min(1),
  direction: z.enum(['inbound', 'outbound']),
  author: z.string(),
  /** Receiver identity; when absent the cache derives it from direction and participant. */
  recipient: z.string().nullable().optional(),
  body: z.string(),
  status: z.enum(MESSAGE_STATUSES),
  /** Echo of the `clientRef` we sent, so our local outgoing row can be matched. */
  clientRef: z.string().nullable().optional(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});

export type ProviderConversation = z.infer<typeof providerConversationSchema>;
export type ProviderMessage = z.infer<typeof providerMessageSchema>;

export interface ProviderCredentials {
  accountSid: string;
  authToken: string;
}

export interface ProviderClient {
  /** Resolves if the credentials are accepted; throws ProviderError('unauthorized') if not. */
  verify(): Promise<void>;
  listConversations(options: { updatedSince?: Date | null }): Promise<ProviderConversation[]>;
  listMessages(conversationId: string): Promise<ProviderMessage[]>;
  sendMessage(
    conversationId: string,
    input: { body: string; author: string; clientRef: string },
    signal: AbortSignal,
  ): Promise<ProviderMessage>;
}

export type ProviderClientFactory = (credentials: ProviderCredentials) => ProviderClient;

export type ProviderErrorKind = 'unauthorized' | 'not_found' | 'unavailable' | 'bad_response' | 'aborted';

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
