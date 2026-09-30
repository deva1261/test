import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { CONTENT_SECURITY_POLICY } from '../src/app';
import { buildTestApp, conversation, INTERNAL_TOKEN, providerMessage, signedWebhook } from './helpers';

const servers: { close: () => void }[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

/** Opens the SSE stream on a real socket and collects parsed `change` events. */
async function openStream(app: Parameters<typeof request>[0] & { listen: Function }) {
  const server = (app as any).listen(0);
  servers.push({ close: () => server.close() });
  const { port } = server.address() as AddressInfo;
  const controller = new AbortController();
  servers.push({ close: () => controller.abort() });
  const res = await fetch(`http://127.0.0.1:${port}/conversations/stream`, { signal: controller.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events: { event: string; data: any }[] = [];

  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (event) events.push({ event, data: data ? JSON.parse(data) : null });
        }
      }
    } catch {
      // aborted
    }
  })();
  void pump;

  const waitFor = async (predicate: () => boolean, timeoutMs = 1000) => {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) throw new Error(`Timed out; got ${JSON.stringify(events)}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  return { res, events, waitFor };
}

describe('GET /conversations/stream (REQ-002: new conversations appear without a refresh)', () => {
  it('pushes a change event when a webhook adds a new conversation', async () => {
    const { app, events } = buildTestApp();
    const stream = await openStream(app as any);
    expect(stream.res.headers.get('content-type')).toContain('text/event-stream');
    await stream.waitFor(() => stream.events.some((e) => e.event === 'ready'));

    const hook = await signedWebhook(app, {
      id: 'EV-new-conv',
      type: 'conversation.created',
      occurredAt: '2026-01-01T09:00:00.000Z',
      data: conversation({ id: 'CH-new' }),
    });
    await events.process(hook.body.eventId);

    await stream.waitFor(() => stream.events.some((e) => e.event === 'change'));
    expect(stream.events.filter((e) => e.event === 'change').map((e) => e.data)).toContainEqual({
      type: 'conversation.changed',
      conversationId: 'CH-new',
    });
  });

  it('pushes message, status and integration changes', async () => {
    const { app, connect, provider, emitted } = buildTestApp();
    await connect();
    provider.conversations = [conversation()];
    await request(app).get('/conversations');
    await request(app).patch('/conversations/CH1/status').send({ status: 'in_progress' }).expect(200);
    await request(app).post('/conversations/CH1/messages').send({ body: 'hello' }).expect(201);
    await request(app).post('/integrations/disconnect').expect(200);

    expect(emitted).toContainEqual({ type: 'integration.changed' });
    expect(emitted).toContainEqual({ type: 'conversation.changed', conversationId: 'CH1' });
    expect(emitted.some((c) => c.type === 'message.changed' && c.conversationId === 'CH1')).toBe(true);
  });

  it('unsubscribes when the client goes away', async () => {
    const { app, changes } = buildTestApp();
    const stream = await openStream(app as any);
    await stream.waitFor(() => stream.events.some((e) => e.event === 'ready'));
    const withStream = changes.listenerCount;
    for (const s of servers.splice(0).reverse()) s.close();
    const start = Date.now();
    while (changes.listenerCount >= withStream && Date.now() - start < 1000) await new Promise((r) => setTimeout(r, 10));
    expect(changes.listenerCount).toBe(withStream - 1);
  });
});

describe('REQ-003: messages carry sender and receiver identity', () => {
  it('records the participant as receiver of outbound messages and the agent for inbound ones', async () => {
    const { app, connect, provider } = buildTestApp();
    await connect();
    provider.conversations = [conversation()];
    provider.messages = [providerMessage()];
    await request(app).get('/conversations');

    const sent = await request(app).post('/conversations/CH1/messages').send({ body: 'On its way' }).expect(201);
    expect(sent.body.message).toMatchObject({ author: 'Agent', recipient: '+15550001111' });

    const res = await request(app).get('/conversations/CH1/messages').expect(200);
    const inbound = res.body.messages.find((m: { direction: string }) => m.direction === 'inbound');
    expect(inbound).toMatchObject({ author: '+15550001111', recipient: 'Agent' });
    for (const m of res.body.messages) {
      expect(m).toEqual(
        expect.objectContaining({
          author: expect.any(String),
          recipient: expect.any(String),
          body: expect.any(String),
          createdAt: expect.any(String),
          status: expect.any(String),
        }),
      );
    }
  });

  it('keeps an explicit recipient from the provider', async () => {
    const { app, cache } = buildTestApp();
    const conv = await signedWebhook(app, { id: 'E1', type: 'conversation.created', occurredAt: '2026-01-01T09:00:00Z', data: conversation() });
    const msg = await signedWebhook(app, {
      id: 'E2',
      type: 'message.created',
      occurredAt: '2026-01-01T09:00:00Z',
      data: providerMessage({ recipient: 'Support queue' }),
    });
    for (const id of [conv.body.eventId, msg.body.eventId]) {
      await request(app).post(`/internal/events/${id}/process`).set('authorization', `Bearer ${INTERNAL_TOKEN}`).expect(200);
    }
    expect((await cache.listMessages('CH1'))[0].recipient).toBe('Support queue');
  });
});

describe('REQ-006 / REQ-008: empty and failure responses the board can render', () => {
  it('returns 200 with an empty list, not an error, when a search matches nothing', async () => {
    const { app, connect, provider } = buildTestApp();
    await connect();
    provider.conversations = [conversation()];
    const res = await request(app).get('/conversations?q=no-such-thing&status=resolved');
    expect(res.status).toBe(200);
    expect(res.body.conversations).toEqual([]);
    expect(res.body.error).toBeUndefined();
  });

  it('returns 200 with an empty list when there are no conversations at all', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/conversations');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ conversations: [], meta: { connected: false } });
  });

  it('keeps serving the board when the provider is down on a cold cache', async () => {
    const { app, connect, provider } = buildTestApp();
    await connect();
    provider.failNext = new (await import('../src/provider/types')).ProviderError('unavailable', 'HTTP 503');
    const res = await request(app).get('/conversations');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ conversations: [], meta: { connected: true, stale: true } });
  });

  it('gives every failure one clear, structured error shape', async () => {
    const { app } = buildTestApp();
    for (const res of [
      await request(app).get('/conversations?limit=abc'),
      await request(app).get('/conversations/nope/messages'),
      await request(app).post('/conversations/CH1/messages').send({ body: 'hi' }),
    ]) {
      expect(res.body.error).toEqual(expect.objectContaining({ code: expect.any(String), message: expect.any(String) }));
      expect(res.body.error.message.length).toBeGreaterThan(5);
    }
  });
});

describe('REQ-009: the board UI is served by board-api and may only call board-api', () => {
  it('serves the UI with a CSP that blocks direct calls to Sprintle/Twilio', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<div id="app"');
    expect(res.headers['content-security-policy']).toBe(CONTENT_SECURITY_POLICY);
    expect(CONTENT_SECURITY_POLICY).toContain("connect-src 'self'");
    expect((await request(app).get('/js/api.js')).status).toBe(200);
  });
});
