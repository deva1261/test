import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { ProviderError } from '../src/provider/types';
import { buildTestApp, conversation, providerMessage } from './helpers';

async function seeded() {
  const t = buildTestApp();
  await t.connect();
  t.provider.conversations = [
    conversation(),
    conversation({
      id: 'CH2',
      title: 'Refund request',
      participant: '+15550002222',
      lastMessagePreview: 'I want my money back',
      lastMessageAt: '2026-01-01T09:30:00.000Z',
    }),
  ];
  return t;
}

describe('GET /conversations', () => {
  it('fetches through to the provider on a cold cache, newest first', async () => {
    const { app } = await seeded();
    const res = await request(app).get('/conversations');
    expect(res.status).toBe(200);
    expect(res.body.conversations.map((c: { id: string }) => c.id)).toEqual(['CH2', 'CH1']);
    expect(res.body.conversations[0].status).toBe('open');
    expect(res.body.meta).toMatchObject({ connected: true, stale: false });
  });

  it('serves from cache within the TTL and asks only for changes after it', async () => {
    const { app, provider, advance } = await seeded();
    await request(app).get('/conversations');
    await request(app).get('/conversations');
    expect(provider.calls.filter((c) => c.method === 'listConversations')).toHaveLength(1);

    advance(30_000);
    await request(app).get('/conversations');
    const calls = provider.calls.filter((c) => c.method === 'listConversations');
    expect(calls).toHaveLength(2);
    expect(calls[1].args[0]).toEqual({ updatedSince: new Date('2026-01-01T10:00:00Z') });
  });

  it('serves stale cache with stale=true when the provider fails', async () => {
    const { app, provider, advance } = await seeded();
    await request(app).get('/conversations');
    advance(60_000);
    provider.failNext = new ProviderError('unavailable', 'timeout');
    const res = await request(app).get('/conversations');
    expect(res.status).toBe(200);
    expect(res.body.conversations).toHaveLength(2);
    expect(res.body.meta.stale).toBe(true);
  });

  it('filters by status and searches title, participant and preview', async () => {
    const { app } = await seeded();
    await request(app).get('/conversations');
    await request(app).patch('/conversations/CH1/status').send({ status: 'in_progress' }).expect(200);

    const byStatus = await request(app).get('/conversations?status=in_progress');
    expect(byStatus.body.conversations.map((c: { id: string }) => c.id)).toEqual(['CH1']);

    const byText = await request(app).get('/conversations?q=REFUND');
    expect(byText.body.conversations.map((c: { id: string }) => c.id)).toEqual(['CH2']);

    const byPhone = await request(app).get('/conversations?q=0001111');
    expect(byPhone.body.conversations.map((c: { id: string }) => c.id)).toEqual(['CH1']);
  });

  it('returns only what changed since a given time', async () => {
    const { app, advance } = await seeded();
    await request(app).get('/conversations');
    advance(1000);
    await request(app).patch('/conversations/CH2/status').send({ status: 'resolved' }).expect(200);

    const res = await request(app).get('/conversations').query({ since: '2026-01-01T10:00:00.500Z' });
    expect(res.body.conversations.map((c: { id: string }) => c.id)).toEqual(['CH2']);
  });

  it('applies limit and rejects bad query params', async () => {
    const { app } = await seeded();
    const limited = await request(app).get('/conversations?limit=1');
    expect(limited.body.conversations).toHaveLength(1);

    for (const q of ['status=closed', 'limit=0', 'limit=500', 'since=yesterday']) {
      const res = await request(app).get(`/conversations?${q}`);
      expect(res.status, q).toBe(400);
    }
  });

  it('serves the cache without calling the provider when disconnected', async () => {
    const { app, provider } = await seeded();
    await request(app).get('/conversations');
    await request(app).post('/integrations/disconnect');
    const before = provider.calls.length;

    const res = await request(app).get('/conversations');
    expect(res.body.conversations).toHaveLength(2);
    expect(res.body.meta.connected).toBe(false);
    expect(provider.calls.length).toBe(before);
  });
});

describe('GET /conversations/:id/messages', () => {
  it('fetches message history through the provider, oldest first', async () => {
    const { app, provider } = await seeded();
    await request(app).get('/conversations');
    provider.messages = [
      providerMessage({ id: 'IM2', body: 'Second', createdAt: '2026-01-01T09:05:00.000Z', updatedAt: '2026-01-01T09:05:00.000Z' }),
      providerMessage({ id: 'IM1', body: 'First' }),
    ];

    const res = await request(app).get('/conversations/CH1/messages');
    expect(res.status).toBe(200);
    expect(res.body.messages.map((m: { body: string }) => m.body)).toEqual(['First', 'Second']);
    expect(res.body.meta).toMatchObject({ connected: true, stale: false });

    await request(app).get('/conversations/CH1/messages');
    expect(provider.calls.filter((c) => c.method === 'listMessages')).toHaveLength(1);
  });

  it('returns 404 for a conversation that is not on the board', async () => {
    const { app } = await seeded();
    const res = await request(app).get('/conversations/nope/messages');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CONVERSATION_NOT_FOUND');
  });
});

describe('POST /conversations/:id/messages', () => {
  it('sends through the provider and returns the stored message', async () => {
    const { app, provider } = await seeded();
    await request(app).get('/conversations');

    const res = await request(app).post('/conversations/CH1/messages').send({ body: '  It ships today  ' });
    expect(res.status).toBe(201);
    expect(res.body.message).toMatchObject({
      conversationId: 'CH1',
      direction: 'outbound',
      body: 'It ships today',
      author: 'Agent',
      status: 'sent',
      providerMessageId: 'IM1',
    });
    const send = provider.calls.find((c) => c.method === 'sendMessage');
    expect(send?.args[1]).toMatchObject({ clientRef: res.body.message.id });
  });

  it('refuses to send when disconnected', async () => {
    const { app } = await seeded();
    await request(app).get('/conversations');
    await request(app).post('/integrations/disconnect');
    const res = await request(app).post('/conversations/CH1/messages').send({ body: 'hi' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INTEGRATION_NOT_CONNECTED');
  });

  it('marks the message failed and returns 502 when the provider errors', async () => {
    const { app, provider, cache } = await seeded();
    await request(app).get('/conversations');
    provider.failNext = new ProviderError('unavailable', 'HTTP 500');
    const res = await request(app).post('/conversations/CH1/messages').send({ body: 'hi' });
    expect(res.status).toBe(502);
    expect((await cache.listMessages('CH1')).map((m) => m.status)).toEqual(['failed']);
  });

  it.each([{}, { body: '   ' }, { body: 'x'.repeat(1601) }, { body: 'ok', extra: true }])(
    'rejects invalid body %j',
    async (body) => {
      const { app } = await seeded();
      await request(app).get('/conversations');
      const res = await request(app).post('/conversations/CH1/messages').send(body);
      expect(res.status).toBe(400);
    },
  );
});

describe('PATCH /conversations/:id/status', () => {
  it('moves through open -> in_progress -> resolved -> open', async () => {
    const { app } = await seeded();
    await request(app).get('/conversations');
    for (const status of ['in_progress', 'resolved', 'open']) {
      const res = await request(app).patch('/conversations/CH1/status').send({ status });
      expect(res.status).toBe(200);
      expect(res.body.conversation.status).toBe(status);
    }
  });

  it('rejects resolved -> in_progress', async () => {
    const { app } = await seeded();
    await request(app).get('/conversations');
    await request(app).patch('/conversations/CH1/status').send({ status: 'resolved' }).expect(200);
    const res = await request(app).patch('/conversations/CH1/status').send({ status: 'in_progress' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_STATUS_TRANSITION');
  });

  it('treats setting the same status as a no-op', async () => {
    const { app } = await seeded();
    await request(app).get('/conversations');
    const res = await request(app).patch('/conversations/CH1/status').send({ status: 'open' });
    expect(res.status).toBe(200);
  });

  it('keeps board status when the provider later updates the conversation', async () => {
    const { app, provider, advance } = await seeded();
    await request(app).get('/conversations');
    await request(app).patch('/conversations/CH1/status').send({ status: 'in_progress' }).expect(200);

    provider.conversations[0] = conversation({ title: 'Renamed', updatedAt: '2026-01-01T10:30:00.000Z' });
    advance(60_000);
    const res = await request(app).get('/conversations?q=renamed');
    expect(res.body.conversations[0]).toMatchObject({ title: 'Renamed', status: 'in_progress' });
  });

  it('validates status and 404s unknown conversations', async () => {
    const { app } = await seeded();
    await request(app).get('/conversations');
    expect((await request(app).patch('/conversations/CH1/status').send({ status: 'Done' })).status).toBe(400);
    expect((await request(app).patch('/conversations/nope/status').send({ status: 'open' })).status).toBe(404);
  });
});
