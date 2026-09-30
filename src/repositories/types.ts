import type {
  Conversation,
  ConversationStatus,
  Integration,
  Message,
  MessageStatus,
  ProviderEventRecord,
} from '../domain';
import type { ProviderConversation, ProviderMessage } from '../provider/types';

export interface IntegrationRepository {
  findActive(): Promise<Integration | null>;
  /** The most recently created integration, connected or not. */
  findLatest(): Promise<Integration | null>;
  /** Disconnects any active integration and records a new connected one, atomically. */
  activate(input: { accountSid: string; credentialsCiphertext: string }, now: Date): Promise<Integration>;
  deactivate(id: string, now: Date): Promise<void>;
  recordSync(id: string, result: { at: Date } | { error: string }): Promise<void>;
}

/** Writes provider data into the cache. Shared by fetch-through and the Kafka consumer. */
export interface CacheWriter {
  /** Inserts or updates; ignored if `updatedAt` is older than what is cached. Never touches board status. */
  upsertConversation(conversation: ProviderConversation, now: Date): Promise<void>;
  /**
   * Inserts or updates, matching our outgoing row via `clientRef` first, then `id`.
   * Ignored if older than what is cached. Returns false if the conversation is not cached.
   */
  upsertMessage(message: ProviderMessage, now: Date): Promise<boolean>;
}

export interface ConversationFilter {
  status?: ConversationStatus;
  /** Case-insensitive match on title, participant or last message preview. */
  q?: string;
  /** Only conversations whose cached row changed after this instant. */
  since?: Date;
  limit: number;
}

export interface BoardCache extends CacheWriter {
  listConversations(filter: ConversationFilter): Promise<Conversation[]>;
  findConversation(id: string): Promise<Conversation | null>;
  setConversationStatus(id: string, status: ConversationStatus, now: Date): Promise<Conversation | null>;
  markMessagesSynced(conversationId: string, now: Date): Promise<void>;
  listMessages(conversationId: string): Promise<Message[]>;
  createOutgoingMessage(
    input: { conversationId: string; author: string; recipient: string; body: string },
    now: Date,
  ): Promise<Message>;
  /** Sets the send outcome only while the row is still `sending`; a provider event may have settled it first. */
  completeOutgoingMessage(
    id: string,
    result: { status: MessageStatus; providerMessageId?: string },
    now: Date,
  ): Promise<Message>;
}

export type ProcessOutcome = 'processed' | 'already_processed' | 'not_found';

export interface EventRepository {
  /** Deduplicates on `providerEventId`. */
  record(
    input: { providerEventId: string; type: string; payload: unknown },
    now: Date,
  ): Promise<{ event: ProviderEventRecord; duplicate: boolean }>;
  markPublished(id: string, now: Date): Promise<void>;
  findUnpublished(receivedBefore: Date, limit: number): Promise<ProviderEventRecord[]>;
  /**
   * Runs `apply` and marks the event processed in one transaction, holding a row lock so
   * concurrent deliveries of the same event cannot both apply it.
   */
  processOnce(
    id: string,
    apply: (event: ProviderEventRecord, cache: CacheWriter) => Promise<void>,
    now: Date,
  ): Promise<ProcessOutcome>;
}
