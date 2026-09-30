import { randomUUID } from 'node:crypto';
import {
  BOARD_IDENTITY,
  type Conversation,
  type ConversationStatus,
  type Integration,
  type Message,
  type MessageStatus,
  type ProviderEventRecord,
} from '../domain';
import type { ChangeListener } from '../events/changes';
import type { ProviderConversation, ProviderMessage } from '../provider/types';
import type {
  BoardCache,
  CacheWriter,
  ConversationFilter,
  EventRepository,
  IntegrationRepository,
  ProcessOutcome,
} from './types';

/** In-memory implementations used by the test suite. */
export class InMemoryIntegrationRepository implements IntegrationRepository {
  readonly integrations: Integration[] = [];

  constructor(private readonly onChange: ChangeListener = () => undefined) {}

  async findActive(): Promise<Integration | null> {
    const active = this.integrations.find((i) => i.status === 'connected');
    return active ? { ...active } : null;
  }

  async findLatest(): Promise<Integration | null> {
    const latest = this.integrations.at(-1);
    return latest ? { ...latest } : null;
  }

  async activate(input: { accountSid: string; credentialsCiphertext: string }, now: Date): Promise<Integration> {
    for (const i of this.integrations) {
      if (i.status === 'connected') Object.assign(i, { status: 'disconnected', disconnectedAt: now });
    }
    const record: Integration = {
      id: randomUUID(),
      ...input,
      status: 'connected',
      connectedAt: now,
      disconnectedAt: null,
      lastSyncAt: null,
      lastError: null,
    };
    this.integrations.push(record);
    this.onChange({ type: 'integration.changed' });
    return { ...record };
  }

  async deactivate(id: string, now: Date): Promise<void> {
    const i = this.integrations.find((x) => x.id === id);
    if (i && i.status === 'connected') {
      Object.assign(i, { status: 'disconnected', disconnectedAt: now });
      this.onChange({ type: 'integration.changed' });
    }
  }

  async recordSync(id: string, result: { at: Date } | { error: string }): Promise<void> {
    const i = this.integrations.find((x) => x.id === id);
    if (!i) return;
    if ('at' in result) Object.assign(i, { lastSyncAt: result.at, lastError: null });
    else i.lastError = result.error;
    this.onChange({ type: 'integration.changed' });
  }
}

export class InMemoryBoardCache implements BoardCache {
  readonly conversations = new Map<string, Conversation>();
  readonly messages = new Map<string, Message & { providerUpdatedAt: Date | null }>();

  constructor(private readonly onChange: ChangeListener = () => undefined) {}

  async upsertConversation(c: ProviderConversation, now: Date): Promise<void> {
    const providerUpdatedAt = new Date(c.updatedAt);
    const existing = this.conversations.get(c.id);
    if (existing && existing.providerUpdatedAt > providerUpdatedAt) return;
    this.conversations.set(c.id, {
      status: 'open',
      messagesSyncedAt: null,
      ...existing,
      id: c.id,
      title: c.title,
      participant: c.participant,
      lastMessagePreview: c.lastMessagePreview,
      lastMessageAt: c.lastMessageAt ? new Date(c.lastMessageAt) : null,
      providerUpdatedAt,
      updatedAt: now,
    });
    this.onChange({ type: 'conversation.changed', conversationId: c.id });
  }

  async upsertMessage(m: ProviderMessage, now: Date): Promise<boolean> {
    const conversation = this.conversations.get(m.conversationId);
    if (!conversation) return false;

    const existing =
      (m.clientRef ? this.messages.get(m.clientRef) : undefined) ??
      [...this.messages.values()].find((x) => x.providerMessageId === m.id);
    const providerUpdatedAt = new Date(m.updatedAt);
    if (existing?.providerUpdatedAt && existing.providerUpdatedAt > providerUpdatedAt) return true;

    const id = existing?.id ?? randomUUID();
    const createdAt = new Date(m.createdAt);
    this.messages.set(id, {
      id,
      conversationId: m.conversationId,
      providerMessageId: m.id,
      direction: m.direction,
      author: m.author,
      recipient: m.recipient ?? existing?.recipient ?? (m.direction === 'outbound' ? conversation.participant : BOARD_IDENTITY),
      body: m.body,
      status: m.status,
      createdAt: existing?.createdAt ?? createdAt,
      updatedAt: now,
      providerUpdatedAt,
    });
    if (!conversation.lastMessageAt || conversation.lastMessageAt <= createdAt) {
      Object.assign(conversation, { lastMessageAt: createdAt, lastMessagePreview: m.body.slice(0, 200), updatedAt: now });
    }
    this.onChange({ type: 'message.changed', conversationId: m.conversationId, messageId: id });
    this.onChange({ type: 'conversation.changed', conversationId: m.conversationId });
    return true;
  }

  async listConversations(filter: ConversationFilter): Promise<Conversation[]> {
    const q = filter.q?.toLowerCase();
    return [...this.conversations.values()]
      .filter((c) => !filter.status || c.status === filter.status)
      .filter((c) => !filter.since || c.updatedAt > filter.since)
      .filter(
        (c) =>
          !q ||
          [c.title, c.participant, c.lastMessagePreview ?? ''].some((field) => field.toLowerCase().includes(q)),
      )
      .sort((a, b) => (b.lastMessageAt?.getTime() ?? 0) - (a.lastMessageAt?.getTime() ?? 0))
      .slice(0, filter.limit)
      .map((c) => ({ ...c }));
  }

  async findConversation(id: string): Promise<Conversation | null> {
    const c = this.conversations.get(id);
    return c ? { ...c } : null;
  }

  async setConversationStatus(id: string, status: ConversationStatus, now: Date): Promise<Conversation | null> {
    const c = this.conversations.get(id);
    if (!c) return null;
    Object.assign(c, { status, updatedAt: now });
    this.onChange({ type: 'conversation.changed', conversationId: id });
    return { ...c };
  }

  async markMessagesSynced(conversationId: string, now: Date): Promise<void> {
    const c = this.conversations.get(conversationId);
    if (c) c.messagesSyncedAt = now;
  }

  async listMessages(conversationId: string): Promise<Message[]> {
    return [...this.messages.values()]
      .filter((m) => m.conversationId === conversationId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map(({ providerUpdatedAt: _, ...m }) => m);
  }

  async createOutgoingMessage(
    input: { conversationId: string; author: string; recipient: string; body: string },
    now: Date,
  ): Promise<Message> {
    const record = {
      id: randomUUID(),
      ...input,
      providerMessageId: null,
      direction: 'outbound' as const,
      status: 'sending' as const,
      createdAt: now,
      updatedAt: now,
      providerUpdatedAt: null,
    };
    this.messages.set(record.id, record);
    this.onChange({ type: 'message.changed', conversationId: input.conversationId, messageId: record.id });
    const { providerUpdatedAt: _, ...message } = record;
    return { ...message };
  }

  async completeOutgoingMessage(
    id: string,
    result: { status: MessageStatus; providerMessageId?: string },
    now: Date,
  ): Promise<Message> {
    const m = this.messages.get(id);
    if (!m) throw new Error(`Message ${id} not found`);
    // A provider event may have already settled the row (e.g. delivered); don't regress it.
    if (m.status === 'sending') m.status = result.status;
    m.providerMessageId ??= result.providerMessageId ?? null;
    m.updatedAt = now;
    this.onChange({ type: 'message.changed', conversationId: m.conversationId, messageId: id });
    const { providerUpdatedAt: _, ...message } = m;
    return { ...message };
  }
}

export class InMemoryEventRepository implements EventRepository {
  readonly events = new Map<string, ProviderEventRecord>();
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly cache: CacheWriter) {}

  async record(input: { providerEventId: string; type: string; payload: unknown }, now: Date) {
    const existing = [...this.events.values()].find((e) => e.providerEventId === input.providerEventId);
    if (existing) return { event: { ...existing }, duplicate: true };
    const event: ProviderEventRecord = { id: randomUUID(), ...input, receivedAt: now, publishedAt: null, processedAt: null };
    this.events.set(event.id, event);
    return { event: { ...event }, duplicate: false };
  }

  async markPublished(id: string, now: Date): Promise<void> {
    const e = this.events.get(id);
    if (e && !e.publishedAt) e.publishedAt = now;
  }

  async findUnpublished(receivedBefore: Date, limit: number): Promise<ProviderEventRecord[]> {
    return [...this.events.values()]
      .filter((e) => !e.publishedAt && e.receivedAt < receivedBefore)
      .slice(0, limit)
      .map((e) => ({ ...e }));
  }

  async processOnce(
    id: string,
    apply: (event: ProviderEventRecord, cache: CacheWriter) => Promise<void>,
    now: Date,
  ): Promise<ProcessOutcome> {
    // Serialise per event id, standing in for Postgres' SELECT ... FOR UPDATE.
    const previous = this.locks.get(id) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(async (): Promise<ProcessOutcome> => {
      const event = this.events.get(id);
      if (!event) return 'not_found';
      if (event.processedAt) return 'already_processed';
      await apply({ ...event }, this.cache);
      event.processedAt = now;
      return 'processed';
    });
    this.locks.set(id, run);
    return run;
  }
}
