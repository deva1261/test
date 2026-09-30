import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiError, createApi } from '../../public/js/api.js';

const JS_DIR = path.resolve(__dirname, '../../public/js');

function recordingFetch(responses: Record<string, { status: number; body?: unknown }> = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses[url] ?? { status: 200, body: {} };
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('REQ-009: the UI calls board-api, never Sprintle/Twilio', () => {
  it('sends every request to a same-origin board-api path', async () => {
    const { calls, fetchImpl } = recordingFetch();
    const api = createApi(fetchImpl);
    await api.status();
    await api.connect({ accountSid: 'AC1', authToken: 't' });
    await api.disconnect();
    await api.listConversations({ q: 'refund', status: 'open' });
    await api.listMessages('CH 1');
    await api.sendMessage('CH1', 'hi');
    await api.updateStatus('CH1', 'resolved');

    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      'GET /integrations/status',
      'POST /integrations/connect',
      'POST /integrations/disconnect',
      'GET /conversations?limit=200&q=refund&status=open',
      'GET /conversations/CH%201/messages',
      'POST /conversations/CH1/messages',
      'PATCH /conversations/CH1/status',
    ]);
    for (const c of calls) {
      expect(c.url.startsWith('/')).toBe(true);
      expect(c.init.credentials).toBe('same-origin');
    }
  });

  it('contains no Sprintle/Twilio endpoint anywhere in the UI code', () => {
    for (const file of readdirSync(JS_DIR)) {
      const src = readFileSync(path.join(JS_DIR, file), 'utf8');
      expect(src, file).not.toMatch(/https?:\/\//);
      expect(src, file).not.toMatch(/twilio\.com|sprintle\.(com|io)/i);
    }
  });
});

describe('error handling', () => {
  it('turns API errors into friendly ApiErrors', async () => {
    const { fetchImpl } = recordingFetch({
      '/conversations/CH1/messages': { status: 502, body: { error: { code: 'PROVIDER_ERROR', message: 'Sprintle/Twilio request failed: HTTP 500' } } },
    });
    const err = await createApi(fetchImpl).sendMessage('CH1', 'hi').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 502, code: 'PROVIDER_ERROR' });
    expect(err.message).toMatch(/did not respond/);
  });

  it('reports network failures clearly', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const err = await createApi(fetchImpl).status().catch((e) => e);
    expect(err).toMatchObject({ code: 'NETWORK_ERROR' });
    expect(err.message).toMatch(/Could not reach the board service/);
  });
});
