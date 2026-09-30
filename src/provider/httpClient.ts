import { z, type ZodType } from 'zod';
import {
  ProviderError,
  providerConversationSchema,
  providerMessageSchema,
  type ProviderClient,
  type ProviderClientFactory,
  type ProviderCredentials,
} from './types';

export interface HttpClientOptions {
  baseUrl: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}

export function httpProviderFactory(options: HttpClientOptions): ProviderClientFactory {
  return (credentials) => new HttpProviderClient(credentials, options);
}

export class HttpProviderClient implements ProviderClient {
  private readonly authHeader: string;
  private readonly fetchImpl: typeof fetch;

  constructor(
    credentials: ProviderCredentials,
    private readonly options: HttpClientOptions,
  ) {
    this.authHeader = `Basic ${Buffer.from(`${credentials.accountSid}:${credentials.authToken}`).toString('base64')}`;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async verify(): Promise<void> {
    await this.request('GET', '/v1/account', z.unknown());
  }

  async listConversations({ updatedSince }: { updatedSince?: Date | null }) {
    const query = updatedSince ? `?updatedSince=${encodeURIComponent(updatedSince.toISOString())}` : '';
    const res = await this.request(
      'GET',
      `/v1/conversations${query}`,
      z.object({ conversations: z.array(providerConversationSchema) }),
    );
    return res.conversations;
  }

  async listMessages(conversationId: string) {
    const res = await this.request(
      'GET',
      `/v1/conversations/${encodeURIComponent(conversationId)}/messages`,
      z.object({ messages: z.array(providerMessageSchema) }),
    );
    return res.messages;
  }

  async sendMessage(
    conversationId: string,
    input: { body: string; author: string; clientRef: string },
    signal: AbortSignal,
  ) {
    const res = await this.request(
      'POST',
      `/v1/conversations/${encodeURIComponent(conversationId)}/messages`,
      z.object({ message: providerMessageSchema }),
      { body: input, signal, idempotencyKey: input.clientRef },
    );
    return res.message;
  }

  private async request<T>(
    method: string,
    path: string,
    schema: ZodType<T, z.ZodTypeDef, unknown>,
    extra: { body?: unknown; signal?: AbortSignal; idempotencyKey?: string } = {},
  ): Promise<T> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs);
    const signal = extra.signal ? AbortSignal.any([extra.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.options.baseUrl}${path}`, {
        method,
        signal,
        headers: {
          authorization: this.authHeader,
          accept: 'application/json',
          ...(extra.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(extra.idempotencyKey ? { 'idempotency-key': extra.idempotencyKey } : {}),
        },
        body: extra.body !== undefined ? JSON.stringify(extra.body) : undefined,
      });
    } catch (err) {
      if (extra.signal?.aborted) throw new ProviderError('aborted', 'Request cancelled');
      if (timeout.aborted) throw new ProviderError('unavailable', `Timed out after ${this.options.timeoutMs}ms`);
      throw new ProviderError('unavailable', (err as Error).message);
    }

    if (res.status === 401 || res.status === 403) throw new ProviderError('unauthorized', `HTTP ${res.status}`);
    if (res.status === 404) throw new ProviderError('not_found', `HTTP 404 for ${path}`);
    if (!res.ok) throw new ProviderError('unavailable', `HTTP ${res.status}`);

    const parsed = schema.safeParse(await res.json().catch(() => undefined));
    if (!parsed.success) throw new ProviderError('bad_response', `Unexpected response shape for ${path}`);
    return parsed.data;
  }
}
