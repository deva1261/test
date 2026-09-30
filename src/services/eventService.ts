import { z } from 'zod';
import type { ProviderEventRecord } from '../domain';
import { Errors } from '../errors';
import type { EventPublisher } from '../events/publisher';
import { providerConversationSchema, providerMessageSchema } from '../provider/types';
import type { CacheWriter, EventRepository, ProcessOutcome } from '../repositories/types';

export const webhookEventSchema = z.object({
  id: z.string().min(1).max(200),
  type: z.string().min(1).max(100),
  occurredAt: z.string().datetime({ offset: true }),
  data: z.record(z.unknown()),
});

export type WebhookEvent = z.infer<typeof webhookEventSchema>;

export interface EventServiceDeps {
  events: EventRepository;
  publisher: EventPublisher;
  now?: () => Date;
}

function partitionKey(event: WebhookEvent): string {
  const data = event.data as { conversationId?: unknown; id?: unknown };
  const key = event.type.startsWith('message.') ? data.conversationId : data.id;
  return typeof key === 'string' ? key : event.id;
}

export class EventService {
  private readonly now: () => Date;

  constructor(private readonly deps: EventServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * OP-008. Records the event before publishing so nothing is lost if Kafka is down: the provider
   * gets a 503 and retries, and the relay republishes anything still unpublished.
   */
  async ingest(event: WebhookEvent): Promise<{ eventId: string; duplicate: boolean }> {
    const { event: record, duplicate } = await this.deps.events.record(
      { providerEventId: event.id, type: event.type, payload: event },
      this.now(),
    );
    if (!record.publishedAt) {
      try {
        await this.deps.publisher.publish({ eventId: record.id, key: partitionKey(event) });
      } catch (err) {
        console.error(`Failed to publish event ${record.id}:`, (err as Error).message);
        throw Errors.eventPublishFailed();
      }
      await this.deps.events.markPublished(record.id, this.now());
    }
    return { eventId: record.id, duplicate };
  }

  /** OP-009. Safe to call any number of times for the same event. */
  async process(eventId: string): Promise<Exclude<ProcessOutcome, 'not_found'>> {
    const outcome = await this.deps.events.processOnce(eventId, (e, cache) => this.apply(e, cache), this.now());
    if (outcome === 'not_found') throw Errors.eventNotFound();
    return outcome;
  }

  /** Republishes events whose publish failed or was interrupted. Returns how many were sent. */
  async relayUnpublished(olderThanMs = 30_000, batchSize = 100): Promise<number> {
    const pending = await this.deps.events.findUnpublished(new Date(this.now().getTime() - olderThanMs), batchSize);
    let sent = 0;
    for (const record of pending) {
      const parsed = webhookEventSchema.safeParse(record.payload);
      const key = parsed.success ? partitionKey(parsed.data) : record.providerEventId;
      await this.deps.publisher.publish({ eventId: record.id, key });
      await this.deps.events.markPublished(record.id, this.now());
      sent++;
    }
    return sent;
  }

  private async apply(record: ProviderEventRecord, cache: CacheWriter): Promise<void> {
    const event = webhookEventSchema.parse(record.payload);
    const now = this.now();
    switch (event.type) {
      case 'conversation.created':
      case 'conversation.updated':
        await cache.upsertConversation(providerConversationSchema.parse(event.data), now);
        return;
      case 'message.created':
      case 'message.updated': {
        const applied = await cache.upsertMessage(providerMessageSchema.parse(event.data), now);
        // The next fetch-through of this conversation's messages will pick it up.
        if (!applied) console.warn(`Event ${record.id}: conversation not cached yet, message skipped`);
        return;
      }
      default:
        // Unknown types are acknowledged so the provider doesn't retry them forever.
        console.info(`Event ${record.id}: ignoring unsupported type ${event.type}`);
    }
  }
}
