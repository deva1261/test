import { randomBytes } from 'node:crypto';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../src/app';
import { SecretBox } from '../src/crypto/secretBox';
import { ChangeHub, type BoardChange } from '../src/events/changes';
import type { EventPublisher, QueuedEvent } from '../src/events/publisher';
import { signPayload } from '../src/provider/webhookSignature';
import {
  ProviderError,
  type ProviderClient,
  type ProviderConversation,
  type ProviderCredentials,
  type ProviderMessage,
} from '../src/provider/types';
import { InMemoryBoardCache, InMemoryEventRepository, InMemoryIntegrationRepository } from '../src/repositories/memory';
import { ConversationService } from '../src/services/conversationService';
import { EventService } from '../src/services/eventService';
import { InFlightSends } from '../src/services/inFlightSends';
import { IntegrationService } from '../src/services/integrationService';

export const WEBHOOK_SECRET = 'whsec_test';
export const INTERNAL_TOKEN = 'internal-test-token';
export const validCredentials = { accountSid: 'AC00000000000000000000000000001234', authToken: 'tok_secret' };

/** Scriptable stand-in for Sprintle/Twilio. */
export class FakeProvider {
  conversations: ProviderConversation[] = [];
  messages: ProviderMessage[] = [];
  acceptedToken = validCredentials.authToken;
  failNext: ProviderError | null = null;
  /** When set, sendMessage waits for this promise (or an abort) before answering. */
  sendGate: Promise<void> | null = null;
  readonly calls: { method: string; args: unknown[]; credentials: ProviderCredentials }[] = [];

  client(credentials: ProviderCredentials): ProviderClient {
    const call = async <T>(method: string, args: unknown[], fn: () => T | Promise<T>): Promise<T> => {
      this.calls.push({ method, args, credentials });
      if (credentials.authToken !== this.acceptedToken) throw new ProviderError('unauthorized', 'HTTP 401');
      if (this.failNext) {
        const err = this.failNext;
        this.failNext = null;
        throw err;
      }
      return fn();
    };
    return {
      verify: () => call('verify', [], () => undefined),
      listConversations: (opts) =>
        call('listConversations', [opts], () =>
          this.conversations.filter((c) => !opts.updatedSince || new Date(c.updatedAt) > opts.updatedSince),
        ),
      listMessages: (id) => call('listMessages', [id], () => this.messages.filter((m) => m.conversationId === id)),
      sendMessage: (id, input, signal) =>
        call('sendMessage', [id, input], async () => {
          if (this.sendGate) {
            await Promise.race([
              this.sendGate,
              new Promise((_, reject) =>
                signal.addEventListener('abort', () => reject(new ProviderError('aborted', 'Request cancelled'))),
              ),
            ]);
          }
          const at = new Date().toISOString();
          const message: ProviderMessage = {
            id: `IM${this.messages.length + 1}`,
            conversationId: id,
            direction: 'outbound',
            author: input.author,
            body: input.body,
            status: 'sent',
            clientRef: input.clientRef,
            createdAt: at,
            updatedAt: at,
          };
          this.messages.push(message);
          return message;
        }),
    };
  }
}

export class FakePublisher implements EventPublisher {
  readonly published: QueuedEvent[] = [];
  failing = false;

  async publish(event: QueuedEvent): Promise<void> {
    if (this.failing) throw new Error('broker unavailable');
    this.published.push(event);
  }
}

export function conversation(overrides: Partial<ProviderConversation> = {}): ProviderConversation {
  return {
    id: 'CH1',
    title: 'Order #1001 delivery',
    participant: '+15550001111',
    lastMessagePreview: 'Where is my order?',
    lastMessageAt: '2026-01-01T09:00:00.000Z',
    updatedAt: '2026-01-01T09:00:00.000Z',
    ...overrides,
  };
}

export function providerMessage(overrides: Partial<ProviderMessage> = {}): ProviderMessage {
  return {
    id: 'IM100',
    conversationId: 'CH1',
    direction: 'inbound',
    author: '+15550001111',
    body: 'Where is my order?',
    status: 'received',
    createdAt: '2026-01-01T09:00:00.000Z',
    updatedAt: '2026-01-01T09:00:00.000Z',
    ...overrides,
  };
}

export const PUBLIC_DIR = path.resolve(__dirname, '../public');

export function buildTestApp(options: { cacheTtlMs?: number; streamHeartbeatMs?: number } = {}) {
  const clock = { current: new Date('2026-01-01T10:00:00Z') };
  const now = () => clock.current;
  const provider = new FakeProvider();
  const publisher = new FakePublisher();
  const changes = new ChangeHub();
  const emitted: BoardChange[] = [];
  changes.subscribe((c) => emitted.push(c));
  const integrationRepo = new InMemoryIntegrationRepository((c) => changes.emit(c));
  const cache = new InMemoryBoardCache((c) => changes.emit(c));
  const eventRepo = new InMemoryEventRepository(cache);
  const sends = new InFlightSends();

  const integrations = new IntegrationService({
    integrations: integrationRepo,
    providerFactory: (creds) => provider.client(creds),
    secretBox: new SecretBox(randomBytes(32)),
    sends,
    now,
  });
  const conversations = new ConversationService({
    cache,
    integrations,
    sends,
    cacheTtlMs: options.cacheTtlMs ?? 30_000,
    now,
  });
  const events = new EventService({ events: eventRepo, publisher, now });
  const app = createApp({
    integrations,
    conversations,
    events,
    changes,
    staticDir: PUBLIC_DIR,
    streamHeartbeatMs: options.streamHeartbeatMs,
    webhookSecret: WEBHOOK_SECRET,
    internalApiToken: INTERNAL_TOKEN,
  });

  const advance = (ms: number) => {
    clock.current = new Date(clock.current.getTime() + ms);
  };
  const connect = () => request(app).post('/integrations/connect').send(validCredentials).expect(201);

  return {
    app,
    clock,
    advance,
    provider,
    publisher,
    integrationRepo,
    cache,
    eventRepo,
    events,
    sends,
    changes,
    emitted,
    connect,
  };
}

export function signedWebhook(app: Parameters<typeof request>[0], event: unknown, secret = WEBHOOK_SECRET) {
  const raw = JSON.stringify(event);
  return request(app)
    .post('/webhooks/sprintle-twilio/events')
    .set('content-type', 'application/json')
    .set('x-sprintle-signature', signPayload(raw, secret))
    .send(raw);
}
