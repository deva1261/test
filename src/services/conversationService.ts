import { BOARD_IDENTITY, STATUS_TRANSITIONS, type Conversation, type ConversationStatus, type Message } from '../domain';
import { Errors } from '../errors';
import { ProviderError } from '../provider/types';
import type { BoardCache, ConversationFilter } from '../repositories/types';
import type { InFlightSends } from './inFlightSends';
import type { IntegrationService } from './integrationService';

export interface SyncMeta {
  connected: boolean;
  /** True when a fetch-through was needed but the provider call failed, so cached data was served. */
  stale: boolean;
  syncedAt: Date | null;
}

export interface ConversationServiceDeps {
  cache: BoardCache;
  integrations: IntegrationService;
  sends: InFlightSends;
  cacheTtlMs: number;
  now?: () => Date;
}

export class ConversationService {
  private readonly now: () => Date;
  /** Coalesces concurrent conversation-list refreshes into one provider call. */
  private refreshing: Promise<SyncMeta> | null = null;

  constructor(private readonly deps: ConversationServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** OP-004 */
  async list(filter: ConversationFilter): Promise<{ conversations: Conversation[]; meta: SyncMeta }> {
    this.refreshing ??= this.refreshConversations().finally(() => {
      this.refreshing = null;
    });
    const meta = await this.refreshing;
    return { conversations: await this.deps.cache.listConversations(filter), meta };
  }

  /** OP-005 */
  async messages(conversationId: string): Promise<{ messages: Message[]; meta: SyncMeta }> {
    const conversation = await this.deps.cache.findConversation(conversationId);
    if (!conversation) throw Errors.conversationNotFound();

    const meta: SyncMeta = { connected: false, stale: false, syncedAt: conversation.messagesSyncedAt };
    const active = await this.deps.integrations.active();
    if (active) {
      meta.connected = true;
      if (this.isStale(conversation.messagesSyncedAt)) {
        const now = this.now();
        try {
          const fresh = await active.client.listMessages(conversationId);
          for (const m of fresh) await this.deps.cache.upsertMessage(m, now);
          await this.deps.cache.markMessagesSynced(conversationId, now);
          meta.syncedAt = now;
        } catch (err) {
          if (!(err instanceof ProviderError)) throw err;
          await this.deps.integrations.recordSync(active.integration.id, { error: err.message });
          meta.stale = true;
        }
      }
    }
    return { messages: await this.deps.cache.listMessages(conversationId), meta };
  }

  /** OP-006. The message row is written as `sending` first so the board can show it immediately. */
  async send(conversationId: string, input: { body: string; author?: string }): Promise<Message> {
    const active = await this.deps.integrations.active();
    if (!active) throw Errors.notConnected();
    const conversation = await this.deps.cache.findConversation(conversationId);
    if (!conversation) throw Errors.conversationNotFound();

    const author = input.author ?? BOARD_IDENTITY;
    const pending = await this.deps.cache.createOutgoingMessage(
      { conversationId, author, recipient: conversation.participant, body: input.body },
      this.now(),
    );
    const flight = this.deps.sends.start();
    try {
      const sent = await active.client.sendMessage(
        conversationId,
        { body: input.body, author, clientRef: pending.id },
        flight.signal,
      );
      return await this.deps.cache.completeOutgoingMessage(
        pending.id,
        { status: sent.status, providerMessageId: sent.id },
        this.now(),
      );
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      if (err.kind === 'aborted' || flight.signal.aborted) {
        await this.deps.cache.completeOutgoingMessage(pending.id, { status: 'cancelled' }, this.now());
        throw Errors.sendCancelled();
      }
      await this.deps.cache.completeOutgoingMessage(pending.id, { status: 'failed' }, this.now());
      if (err.kind === 'not_found') throw Errors.conversationNotFound();
      throw Errors.providerUnavailable(err.message);
    } finally {
      flight.done();
    }
  }

  /** OP-007. Board status is local to board-db; it is never pushed to the provider. */
  async updateStatus(conversationId: string, status: ConversationStatus): Promise<Conversation> {
    const conversation = await this.deps.cache.findConversation(conversationId);
    if (!conversation) throw Errors.conversationNotFound();
    if (conversation.status === status) return conversation;
    if (!STATUS_TRANSITIONS[conversation.status].includes(status)) {
      throw Errors.invalidTransition(conversation.status, status);
    }
    const updated = await this.deps.cache.setConversationStatus(conversationId, status, this.now());
    if (!updated) throw Errors.conversationNotFound();
    return updated;
  }

  private async refreshConversations(): Promise<SyncMeta> {
    const active = await this.deps.integrations.active();
    if (!active) return { connected: false, stale: false, syncedAt: null };

    const { integration, client } = active;
    if (!this.isStale(integration.lastSyncAt)) {
      return { connected: true, stale: false, syncedAt: integration.lastSyncAt };
    }

    const now = this.now();
    try {
      const fresh = await client.listConversations({ updatedSince: integration.lastSyncAt });
      for (const c of fresh) await this.deps.cache.upsertConversation(c, now);
      await this.deps.integrations.recordSync(integration.id, { at: now });
      return { connected: true, stale: false, syncedAt: now };
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      await this.deps.integrations.recordSync(integration.id, { error: err.message });
      return { connected: true, stale: true, syncedAt: integration.lastSyncAt };
    }
  }

  private isStale(syncedAt: Date | null): boolean {
    return !syncedAt || this.now().getTime() - syncedAt.getTime() >= this.deps.cacheTtlMs;
  }
}
