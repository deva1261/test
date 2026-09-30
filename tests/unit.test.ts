import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { SecretBox } from '../src/crypto/secretBox';
import { HttpProviderClient } from '../src/provider/httpClient';
import { isValidSignature, signPayload } from '../src/provider/webhookSignature';
import { maskSid } from '../src/services/integrationService';

describe('SecretBox', () => {
  it('round-trips and detects tampering', () => {
    const box = new SecretBox(randomBytes(32));
    const sealed = box.seal('{"authToken":"s3cret"}');
    expect(sealed).not.toContain('s3cret');
    expect(box.open(sealed)).toBe('{"authToken":"s3cret"}');
    const parts = sealed.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => box.open(parts.join('.'))).toThrow();
  });
});

describe('webhook signature', () => {
  it('accepts only the exact signed bytes', () => {
    const body = Buffer.from('{"id":"EV1"}');
    const header = signPayload(body, 'secret');
    expect(isValidSignature(body, header, 'secret')).toBe(true);
    expect(isValidSignature(Buffer.from('{"id":"EV2"}'), header, 'secret')).toBe(false);
    expect(isValidSignature(body, undefined, 'secret')).toBe(false);
    expect(isValidSignature(body, 'sha256=short', 'secret')).toBe(false);
  });
});

describe('maskSid', () => {
  it('keeps the prefix and last four characters', () => {
    expect(maskSid('AC1234567890abcd')).toBe('AC••••••abcd');
    expect(maskSid('short')).toBe('••••');
  });
});

describe('HttpProviderClient', () => {
  const creds = { accountSid: 'AC1', authToken: 'tok' };
  const respond = (status: number, body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it('sends basic auth and parses conversations', async () => {
    let seen: RequestInit | undefined;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seen = init;
      return new Response(JSON.stringify({ conversations: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new HttpProviderClient(creds, { baseUrl: 'http://p', timeoutMs: 1000, fetch: fetchImpl });
    await expect(client.listConversations({})).resolves.toEqual([]);
    expect((seen?.headers as Record<string, string>).authorization).toBe(
      `Basic ${Buffer.from('AC1:tok').toString('base64')}`,
    );
  });

  it.each([
    [401, 'unauthorized'],
    [404, 'not_found'],
    [500, 'unavailable'],
  ])('maps HTTP %i to %s', async (status, kind) => {
    const client = new HttpProviderClient(creds, { baseUrl: 'http://p', timeoutMs: 1000, fetch: respond(status, {}) });
    await expect(client.verify()).rejects.toMatchObject({ kind });
  });

  it('rejects unexpected response shapes', async () => {
    const client = new HttpProviderClient(creds, {
      baseUrl: 'http://p',
      timeoutMs: 1000,
      fetch: respond(200, { conversations: [{ id: 1 }] }),
    });
    await expect(client.listConversations({})).rejects.toMatchObject({ kind: 'bad_response' });
  });
});

describe('loadConfig', () => {
  const base = {
    DATABASE_URL: 'postgres://x',
    KAFKA_BROKERS: 'a:9092, b:9092',
    SPRINTLE_API_BASE_URL: 'https://api.example.com/',
    SPRINTLE_WEBHOOK_SECRET: 's',
    INTERNAL_API_TOKEN: 't',
    CREDENTIALS_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  };

  it('parses brokers and trims the base URL', () => {
    const config = loadConfig(base);
    expect(config.kafka.brokers).toEqual(['a:9092', 'b:9092']);
    expect(config.provider.baseUrl).toBe('https://api.example.com');
    expect(config.cacheTtlMs).toBe(30_000);
  });

  it('rejects a key that is not 32 bytes', () => {
    expect(() => loadConfig({ ...base, CREDENTIALS_ENCRYPTION_KEY: 'c2hvcnQ=' })).toThrow(/32 bytes/);
  });
});
