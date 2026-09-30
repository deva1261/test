import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { ProviderError } from '../src/provider/types';
import { buildTestApp, conversation, validCredentials } from './helpers';

describe('POST /integrations/connect', () => {
  it('verifies the credentials and records an active integration', async () => {
    const { app, provider, integrationRepo } = buildTestApp();
    const res = await request(app).post('/integrations/connect').send(validCredentials);

    expect(res.status).toBe(201);
    expect(res.body.integration).toMatchObject({ status: 'connected', health: 'ok', accountSid: 'AC••••••1234' });
    expect(provider.calls.map((c) => c.method)).toEqual(['verify']);
    expect(JSON.stringify(res.body)).not.toContain(validCredentials.authToken);

    const stored = integrationRepo.integrations[0];
    expect(stored.credentialsCiphertext).not.toContain(validCredentials.authToken);
  });

  it('rejects credentials the provider refuses with 422 and stores nothing', async () => {
    const { app, integrationRepo } = buildTestApp();
    const res = await request(app)
      .post('/integrations/connect')
      .send({ ...validCredentials, authToken: 'wrong' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INVALID_PROVIDER_CREDENTIALS');
    expect(integrationRepo.integrations).toHaveLength(0);
  });

  it('returns 502 when the provider is unreachable', async () => {
    const { app, provider } = buildTestApp();
    provider.failNext = new ProviderError('unavailable', 'HTTP 503');
    const res = await request(app).post('/integrations/connect').send(validCredentials);
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('PROVIDER_ERROR');
  });

  it('validates the body', async () => {
    const { app } = buildTestApp();
    const res = await request(app).post('/integrations/connect').send({ accountSid: '', extra: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('replaces the previous integration when connecting again', async () => {
    const { connect, integrationRepo } = buildTestApp();
    await connect();
    await connect();
    expect(integrationRepo.integrations.map((i) => i.status)).toEqual(['disconnected', 'connected']);
  });
});

describe('POST /integrations/disconnect', () => {
  it('disconnects the active integration', async () => {
    const { app, connect } = buildTestApp();
    await connect();
    const res = await request(app).post('/integrations/disconnect');
    expect(res.status).toBe(200);
    expect(res.body.integration.status).toBe('disconnected');
    expect(res.body.cancelledSends).toBe(0);
  });

  it('is idempotent when nothing is connected', async () => {
    const { app } = buildTestApp();
    const res = await request(app).post('/integrations/disconnect');
    expect(res.status).toBe(200);
    expect(res.body.integration.status).toBe('not_configured');
  });

  it('cancels a message send in flight', async () => {
    const { app, connect, provider, cache } = buildTestApp();
    await connect();
    provider.conversations = [conversation()];
    await request(app).get('/conversations').expect(200);

    provider.sendGate = new Promise(() => undefined); // never answers on its own
    const sending = request(app).post('/conversations/CH1/messages').send({ body: 'On its way' }).then((r) => r);
    await new Promise((r) => setTimeout(r, 20));

    const disconnect = await request(app).post('/integrations/disconnect');
    expect(disconnect.body.cancelledSends).toBe(1);

    const res = await sending;
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SEND_CANCELLED');
    expect((await cache.listMessages('CH1')).map((m) => m.status)).toEqual(['cancelled']);
  });
});

describe('GET /integrations/status', () => {
  it('reports not_configured before any connection', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/integrations/status');
    expect(res.status).toBe(200);
    expect(res.body.integration).toMatchObject({ status: 'not_configured', accountSid: null });
  });

  it('reports degraded health after a failed sync, and ok after the next good one', async () => {
    const { app, connect, provider, advance } = buildTestApp();
    await connect();
    provider.failNext = new ProviderError('unavailable', 'HTTP 503');
    await request(app).get('/conversations').expect(200);

    let res = await request(app).get('/integrations/status');
    expect(res.body.integration).toMatchObject({ status: 'connected', health: 'degraded', lastError: 'HTTP 503' });

    advance(1);
    await request(app).get('/conversations').expect(200);
    res = await request(app).get('/integrations/status');
    expect(res.body.integration).toMatchObject({ health: 'ok', lastError: null });
    expect(res.body.integration.lastSyncAt).toBe('2026-01-01T10:00:00.001Z');
  });
});
