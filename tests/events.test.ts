import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildTestApp, conversation, INTERNAL_TOKEN, providerMessage, signedWebhook } from './helpers';

const conversationCreated = {
  id: 'EV1',
  type: 'conversation.created',
  occurredAt: '2026-01-01T09:00:00.000Z',
  data: conversation(),
};

const messageCreated = {
  id: 'EV2',
  type: 'message.created',
  occurredAt: '2026-01-01T09:01:00.000Z',
  data: providerMessage({ createdAt: '2026-01-01T09:01:00.000Z', updatedAt: '2026-01-01T09:01:00.000Z' }),
};

const processEvent = (app: Parameters<typeof request>[0], eventId: string) =>
  request(app).post(`/internal/events/${eventId}/process`).set('authorization', `Bearer ${INTERNAL_TOKEN}`);

describe('POST /webhooks/sprintle-twilio/events', () => {
  it('records the event and publishes it to Kafka keyed by conversation', async () => {
    const { app, publisher, eventRepo } = buildTestApp();
    const res = await signedWebhook(app, messageCreated);

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ eventId: expect.any(String), duplicate: false });
    expect(publisher.published).toEqual([{ eventId: res.body.eventId, key: 'CH1' }]);
    expect(eventRepo.events.get(res.body.eventId)?.publishedAt).not.toBeNull();
  });

  it('deduplicates provider retries and does not publish twice', async () => {
    const { app, publisher } = buildTestApp();
    const first = await signedWebhook(app, conversationCreated);
    const second = await signedWebhook(app, conversationCreated);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ eventId: first.body.eventId, duplicate: true });
    expect(publisher.published).toHaveLength(1);
  });

  it('rejects a missing or wrong signature', async () => {
    const { app, publisher } = buildTestApp();
    expect((await signedWebhook(app, conversationCreated, 'wrong-secret')).status).toBe(401);
    const unsigned = await request(app)
      .post('/webhooks/sprintle-twilio/events')
      .set('content-type', 'application/json')
      .send(conversationCreated);
    expect(unsigned.status).toBe(401);
    expect(unsigned.body.error.code).toBe('INVALID_SIGNATURE');
    expect(publisher.published).toHaveLength(0);
  });

  it('rejects a signed but malformed payload', async () => {
    const { app } = buildTestApp();
    const res = await signedWebhook(app, { id: 'EV9', type: 'message.created' });
    expect(res.status).toBe(400);
  });

  it('returns 503 when Kafka is down, then publishes on the provider retry', async () => {
    const { app, publisher } = buildTestApp();
    publisher.failing = true;
    const failed = await signedWebhook(app, conversationCreated);
    expect(failed.status).toBe(503);
    expect(failed.body.error.code).toBe('EVENT_PUBLISH_FAILED');

    publisher.failing = false;
    const retried = await signedWebhook(app, conversationCreated);
    expect(retried.status).toBe(200);
    expect(publisher.published).toHaveLength(1);
  });

  it('relays events whose publish failed', async () => {
    const { app, publisher, events, advance } = buildTestApp();
    publisher.failing = true;
    await signedWebhook(app, conversationCreated);
    publisher.failing = false;

    expect(await events.relayUnpublished()).toBe(0); // too recent; the provider may still retry
    advance(31_000);
    expect(await events.relayUnpublished()).toBe(1);
    expect(await events.relayUnpublished()).toBe(0);
    expect(publisher.published).toHaveLength(1);
  });
});

describe('POST /internal/events/:eventId/process', () => {
  it('applies conversation and message events to the cache', async () => {
    const { app, cache } = buildTestApp();
    const conv = await signedWebhook(app, conversationCreated);
    const msg = await signedWebhook(app, messageCreated);

    expect((await processEvent(app, conv.body.eventId)).body.outcome).toBe('processed');
    expect((await processEvent(app, msg.body.eventId)).body.outcome).toBe('processed');

    const [c] = await cache.listConversations({ limit: 10 });
    expect(c).toMatchObject({ id: 'CH1', status: 'open', lastMessageAt: new Date('2026-01-01T09:01:00.000Z') });
    expect((await cache.listMessages('CH1')).map((m) => m.providerMessageId)).toEqual(['IM100']);
  });

  it('applies each event exactly once, even when delivered concurrently', async () => {
    const { app, cache } = buildTestApp();
    const conv = await signedWebhook(app, conversationCreated);
    await processEvent(app, conv.body.eventId);
    const msg = await signedWebhook(app, messageCreated);

    const outcomes = await Promise.all([1, 2, 3].map(() => processEvent(app, msg.body.eventId)));
    expect(outcomes.map((r) => r.body.outcome).sort()).toEqual(['already_processed', 'already_processed', 'processed']);
    expect(await cache.listMessages('CH1')).toHaveLength(1);
  });

  it('ignores out-of-order updates older than the cached copy', async () => {
    const { app, cache } = buildTestApp();
    const newer = await signedWebhook(app, {
      ...conversationCreated,
      id: 'EV-new',
      type: 'conversation.updated',
      data: conversation({ title: 'Newer', updatedAt: '2026-01-01T09:10:00.000Z' }),
    });
    const older = await signedWebhook(app, conversationCreated);
    await processEvent(app, newer.body.eventId);
    await processEvent(app, older.body.eventId);
    expect((await cache.findConversation('CH1'))?.title).toBe('Newer');
  });

  it('updates our own outgoing message via clientRef instead of duplicating it', async () => {
    const { app, cache, provider, connect } = buildTestApp();
    await connect();
    provider.conversations = [conversation()];
    await request(app).get('/conversations');
    const sent = await request(app).post('/conversations/CH1/messages').send({ body: 'Shipped' }).expect(201);

    const delivered = await signedWebhook(app, {
      id: 'EV-delivered',
      type: 'message.updated',
      occurredAt: '2026-01-01T10:00:05.000Z',
      data: providerMessage({
        id: sent.body.message.providerMessageId,
        direction: 'outbound',
        author: 'Agent',
        body: 'Shipped',
        status: 'delivered',
        clientRef: sent.body.message.id,
        createdAt: '2026-01-01T10:00:00.000Z',
        updatedAt: '2026-01-01T10:00:05.000Z',
      }),
    });
    await processEvent(app, delivered.body.eventId).expect(200);

    const messages = await cache.listMessages('CH1');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ id: sent.body.message.id, status: 'delivered' });
  });

  it('acknowledges unsupported event types without changing the cache', async () => {
    const { app, cache } = buildTestApp();
    const res = await signedWebhook(app, { ...conversationCreated, id: 'EV-x', type: 'participant.joined' });
    expect((await processEvent(app, res.body.eventId)).body.outcome).toBe('processed');
    expect(cache.conversations.size).toBe(0);
  });

  it('requires the internal token and 404s unknown events', async () => {
    const { app } = buildTestApp();
    expect((await request(app).post('/internal/events/abc/process')).status).toBe(401);
    const res = await processEvent(app, 'does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('EVENT_NOT_FOUND');
  });
});
