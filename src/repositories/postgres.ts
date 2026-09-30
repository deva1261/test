import type { Pool, PoolClient } from 'pg';
import {
  BOARD_IDENTITY,
  type Conversation,
  type ConversationStatus,
  type Integration,
  type Message,
  type MessageStatus,
  type ProviderEventRecord,
} from '../domain';
import { CHANGE_CHANNEL, type BoardChange } from '../events/changes';
import type { ProviderConversation, ProviderMessage } from '../provider/types';
import type {
  BoardCache,
  CacheWriter,
  ConversationFilter,
  EventRepository,
  IntegrationRepository,
  ProcessOutcome,
} from './types';

type Queryable = Pool | PoolClient;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Inside a transaction, Postgres delivers the notification only if the transaction commits. */
async function notify(db: Queryable, change: BoardChange): Promise<void> {
  await db.query('SELECT pg_notify($1, $2)', [CHANGE_CHANNEL, JSON.stringify(change)]);
}

interface IntegrationRow {
  id: string;
  account_sid: string;
  credentials_ciphertext: string;
  status: 'connected' | 'disconnected';
  connected_at: Date;
  disconnected_at: Date | null;
  last_sync_at: Date | null;
  last_error: string | null;
}

interface ConversationRow {
  id: string;
  title: string;
  participant: string;
  status: ConversationStatus;
  last_message_preview: string | null;
  last_message_at: Date | null;
  provider_updated_at: Date;
  messages_synced_at: Date | null;
  updated_at: Date;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  provider_message_id: string | null;
  direction: 'inbound' | 'outbound';
  author: string;
  recipient: string;
  body: string;
  status: MessageStatus;
  created_at: Date;
  updated_at: Date;
}

interface EventRow {
  id: string;
  provider_event_id: string;
  type: string;
  payload: unknown;
  received_at: Date;
  published_at: Date | null;
  processed_at: Date | null;
}

const toIntegration = (r: IntegrationRow): Integration => ({
  id: r.id,
  accountSid: r.account_sid,
  credentialsCiphertext: r.credentials_ciphertext,
  status: r.status,
  connectedAt: r.connected_at,
  disconnectedAt: r.disconnected_at,
  lastSyncAt: r.last_sync_at,
  lastError: r.last_error,
});

const toConversation = (r: ConversationRow): Conversation => ({
  id: r.id,
  title: r.title,
  participant: r.participant,
  status: r.status,
  lastMessagePreview: r.last_message_preview,
  lastMessageAt: r.last_message_at,
  providerUpdatedAt: r.provider_updated_at,
  messagesSyncedAt: r.messages_synced_at,
  updatedAt: r.updated_at,
});

const toMessage = (r: MessageRow): Message => ({
  id: r.id,
  conversationId: r.conversation_id,
  providerMessageId: r.provider_message_id,
  direction: r.direction,
  author: r.author,
  recipient: r.recipient,
  body: r.body,
  status: r.status,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toEvent = (r: EventRow): ProviderEventRecord => ({
  id: r.id,
  providerEventId: r.provider_event_id,
  type: r.type,
  payload: r.payload,
  receivedAt: r.received_at,
  publishedAt: r.published_at,
  processedAt: r.processed_at,
});

async function inTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export class PostgresIntegrationRepository implements IntegrationRepository {
  constructor(private readonly pool: Pool) {}

  async findActive(): Promise<Integration | null> {
    const { rows } = await this.pool.query<IntegrationRow>(`SELECT * FROM integrations WHERE status = 'connected'`);
    return rows[0] ? toIntegration(rows[0]) : null;
  }

  async findLatest(): Promise<Integration | null> {
    const { rows } = await this.pool.query<IntegrationRow>(
      'SELECT * FROM integrations ORDER BY created_at DESC LIMIT 1',
    );
    return rows[0] ? toIntegration(rows[0]) : null;
  }

  activate(input: { accountSid: string; credentialsCiphertext: string }, now: Date): Promise<Integration> {
    return inTransaction(this.pool, async (client) => {
      await client.query(
        `UPDATE integrations SET status = 'disconnected', disconnected_at = $1 WHERE status = 'connected'`,
        [now],
      );
      const { rows } = await client.query<IntegrationRow>(
        `INSERT INTO integrations (account_sid, credentials_ciphertext, status, connected_at, created_at)
         VALUES ($1, $2, 'connected', $3, $3) RETURNING *`,
        [input.accountSid, input.credentialsCiphertext, now],
      );
      await notify(client, { type: 'integration.changed' });
      return toIntegration(rows[0]);
    });
  }

  async deactivate(id: string, now: Date): Promise<void> {
    const { rowCount } = await this.pool.query(
      `UPDATE integrations SET status = 'disconnected', disconnected_at = $2 WHERE id = $1 AND status = 'connected'`,
      [id, now],
    );
    if (rowCount) await notify(this.pool, { type: 'integration.changed' });
  }

  async recordSync(id: string, result: { at: Date } | { error: string }): Promise<void> {
    if ('at' in result) {
      await this.pool.query('UPDATE integrations SET last_sync_at = $2, last_error = NULL WHERE id = $1', [id, result.at]);
    } else {
      await this.pool.query('UPDATE integrations SET last_error = $2 WHERE id = $1', [id, result.error]);
    }
    await notify(this.pool, { type: 'integration.changed' });
  }
}

/** CacheWriter over any connection, so the event consumer can reuse it inside its transaction. */
class PostgresCacheWriter implements CacheWriter {
  constructor(protected readonly db: Queryable) {}

  async upsertConversation(c: ProviderConversation, now: Date): Promise<void> {
    const { rowCount } = await this.db.query(
      `INSERT INTO conversations
         (id, title, participant, last_message_preview, last_message_at, provider_updated_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET
         title = EXCLUDED.title,
         participant = EXCLUDED.participant,
         last_message_preview = EXCLUDED.last_message_preview,
         last_message_at = EXCLUDED.last_message_at,
         provider_updated_at = EXCLUDED.provider_updated_at,
         updated_at = EXCLUDED.updated_at
       WHERE conversations.provider_updated_at <= EXCLUDED.provider_updated_at
       RETURNING id`,
      [c.id, c.title, c.participant, c.lastMessagePreview, c.lastMessageAt, c.updatedAt, now],
    );
    if (rowCount) await notify(this.db, { type: 'conversation.changed', conversationId: c.id });
  }

  async upsertMessage(m: ProviderMessage, now: Date): Promise<boolean> {
    const conv = await this.db.query<{ participant: string }>('SELECT participant FROM conversations WHERE id = $1', [
      m.conversationId,
    ]);
    if (!conv.rows[0]) return false;
    const recipient = m.recipient ?? (m.direction === 'outbound' ? conv.rows[0].participant : BOARD_IDENTITY);

    // Our own outgoing row, matched by the clientRef we sent with it.
    let messageId: string | null = null;
    if (m.clientRef && UUID_RE.test(m.clientRef)) {
      const res = await this.db.query<{ id: string }>(
        `UPDATE messages SET provider_message_id = $2, status = $3, provider_updated_at = $4, updated_at = $5
         WHERE id = $1 AND (provider_updated_at IS NULL OR provider_updated_at <= $4)
         RETURNING id`,
        [m.clientRef, m.id, m.status, m.updatedAt, now],
      );
      messageId = res.rows[0]?.id ?? null;
      if (!messageId) {
        const exists = await this.db.query('SELECT 1 FROM messages WHERE id = $1', [m.clientRef]);
        if (exists.rowCount) return true; // cached copy is newer
      }
    }
    if (!messageId) {
      const res = await this.db.query<{ id: string }>(
        `INSERT INTO messages
           (conversation_id, provider_message_id, direction, author, recipient, body, status,
            provider_updated_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (provider_message_id) DO UPDATE SET
           body = EXCLUDED.body,
           status = EXCLUDED.status,
           provider_updated_at = EXCLUDED.provider_updated_at,
           updated_at = EXCLUDED.updated_at
         WHERE messages.provider_updated_at IS NULL OR messages.provider_updated_at <= EXCLUDED.provider_updated_at
         RETURNING id`,
        [m.conversationId, m.id, m.direction, m.author, recipient, m.body, m.status, m.updatedAt, m.createdAt, now],
      );
      messageId = res.rows[0]?.id ?? null;
      if (!messageId) return true; // cached copy is newer
    }

    await this.db.query(
      `UPDATE conversations SET last_message_at = $2, last_message_preview = left($3, 200), updated_at = $4
       WHERE id = $1 AND (last_message_at IS NULL OR last_message_at <= $2)`,
      [m.conversationId, m.createdAt, m.body, now],
    );
    await notify(this.db, { type: 'message.changed', conversationId: m.conversationId, messageId });
    await notify(this.db, { type: 'conversation.changed', conversationId: m.conversationId });
    return true;
  }
}

export class PostgresBoardCache extends PostgresCacheWriter implements BoardCache {
  constructor(private readonly pool: Pool) {
    super(pool);
  }

  async listConversations(filter: ConversationFilter): Promise<Conversation[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.status) {
      params.push(filter.status);
      where.push(`status = $${params.length}`);
    }
    if (filter.since) {
      params.push(filter.since);
      where.push(`updated_at > $${params.length}`);
    }
    if (filter.q) {
      params.push(`%${filter.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
      const p = `$${params.length}`;
      where.push(`(title ILIKE ${p} OR participant ILIKE ${p} OR last_message_preview ILIKE ${p})`);
    }
    params.push(filter.limit);
    const { rows } = await this.pool.query<ConversationRow>(
      `SELECT * FROM conversations
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY last_message_at DESC NULLS LAST, id
       LIMIT $${params.length}`,
      params,
    );
    return rows.map(toConversation);
  }

  async findConversation(id: string): Promise<Conversation | null> {
    const { rows } = await this.pool.query<ConversationRow>('SELECT * FROM conversations WHERE id = $1', [id]);
    return rows[0] ? toConversation(rows[0]) : null;
  }

  async setConversationStatus(id: string, status: ConversationStatus, now: Date): Promise<Conversation | null> {
    const { rows } = await this.pool.query<ConversationRow>(
      'UPDATE conversations SET status = $2, updated_at = $3 WHERE id = $1 RETURNING *',
      [id, status, now],
    );
    if (!rows[0]) return null;
    await notify(this.pool, { type: 'conversation.changed', conversationId: id });
    return toConversation(rows[0]);
  }

  async markMessagesSynced(conversationId: string, now: Date): Promise<void> {
    await this.pool.query('UPDATE conversations SET messages_synced_at = $2 WHERE id = $1', [conversationId, now]);
  }

  async listMessages(conversationId: string): Promise<Message[]> {
    const { rows } = await this.pool.query<MessageRow>(
      'SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at, id',
      [conversationId],
    );
    return rows.map(toMessage);
  }

  async createOutgoingMessage(
    input: { conversationId: string; author: string; recipient: string; body: string },
    now: Date,
  ): Promise<Message> {
    const { rows } = await this.pool.query<MessageRow>(
      `INSERT INTO messages (conversation_id, direction, author, recipient, body, status, created_at, updated_at)
       VALUES ($1, 'outbound', $2, $3, $4, 'sending', $5, $5) RETURNING *`,
      [input.conversationId, input.author, input.recipient, input.body, now],
    );
    await notify(this.pool, { type: 'message.changed', conversationId: input.conversationId, messageId: rows[0].id });
    return toMessage(rows[0]);
  }

  async completeOutgoingMessage(
    id: string,
    result: { status: MessageStatus; providerMessageId?: string },
    now: Date,
  ): Promise<Message> {
    const { rows } = await this.pool.query<MessageRow>(
      `UPDATE messages SET
         status = CASE WHEN status = 'sending' THEN $2 ELSE status END,
         provider_message_id = COALESCE(provider_message_id, $3),
         updated_at = $4
       WHERE id = $1 RETURNING *`,
      [id, result.status, result.providerMessageId ?? null, now],
    );
    if (!rows[0]) throw new Error(`Message ${id} not found`);
    await notify(this.pool, { type: 'message.changed', conversationId: rows[0].conversation_id, messageId: id });
    return toMessage(rows[0]);
  }
}

export class PostgresEventRepository implements EventRepository {
  constructor(private readonly pool: Pool) {}

  async record(input: { providerEventId: string; type: string; payload: unknown }, now: Date) {
    const inserted = await this.pool.query<EventRow>(
      `INSERT INTO provider_events (provider_event_id, type, payload, received_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (provider_event_id) DO NOTHING RETURNING *`,
      [input.providerEventId, input.type, JSON.stringify(input.payload), now],
    );
    if (inserted.rows[0]) return { event: toEvent(inserted.rows[0]), duplicate: false };
    const { rows } = await this.pool.query<EventRow>('SELECT * FROM provider_events WHERE provider_event_id = $1', [
      input.providerEventId,
    ]);
    return { event: toEvent(rows[0]), duplicate: true };
  }

  async markPublished(id: string, now: Date): Promise<void> {
    await this.pool.query('UPDATE provider_events SET published_at = $2 WHERE id = $1 AND published_at IS NULL', [
      id,
      now,
    ]);
  }

  async findUnpublished(receivedBefore: Date, limit: number): Promise<ProviderEventRecord[]> {
    const { rows } = await this.pool.query<EventRow>(
      `SELECT * FROM provider_events WHERE published_at IS NULL AND received_at < $1
       ORDER BY received_at LIMIT $2`,
      [receivedBefore, limit],
    );
    return rows.map(toEvent);
  }

  async processOnce(
    id: string,
    apply: (event: ProviderEventRecord, cache: CacheWriter) => Promise<void>,
    now: Date,
  ): Promise<ProcessOutcome> {
    if (!UUID_RE.test(id)) return 'not_found';
    try {
      return await inTransaction(this.pool, async (client) => {
        const { rows } = await client.query<EventRow>('SELECT * FROM provider_events WHERE id = $1 FOR UPDATE', [id]);
        if (!rows[0]) return 'not_found';
        if (rows[0].processed_at) return 'already_processed';
        await apply(toEvent(rows[0]), new PostgresCacheWriter(client));
        await client.query('UPDATE provider_events SET processed_at = $2, attempts = attempts + 1, last_error = NULL WHERE id = $1', [
          id,
          now,
        ]);
        return 'processed';
      });
    } catch (err) {
      await this.pool
        .query('UPDATE provider_events SET attempts = attempts + 1, last_error = $2 WHERE id = $1', [
          id,
          (err as Error).message.slice(0, 1000),
        ])
        .catch(() => undefined);
      throw err;
    }
  }
}
