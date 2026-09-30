import { Pool } from 'pg';
import type { Config } from './config';
import { SecretBox } from './crypto/secretBox';
import { ChangeHub } from './events/changes';
import { createKafka, KafkaEventPublisher } from './events/kafka';
import { httpProviderFactory } from './provider/httpClient';
import { PostgresBoardCache, PostgresEventRepository, PostgresIntegrationRepository } from './repositories/postgres';
import { ConversationService } from './services/conversationService';
import { EventService } from './services/eventService';
import { InFlightSends } from './services/inFlightSends';
import { IntegrationService } from './services/integrationService';

/** Production wiring shared by the HTTP server and the Kafka worker. */
export function buildContainer(config: Config) {
  const pool = new Pool({ connectionString: config.databaseUrl });
  const kafka = createKafka(config.kafka);
  const publisher = new KafkaEventPublisher(kafka, config.kafka.topic);
  const sends = new InFlightSends();
  const changes = new ChangeHub();

  const integrations = new IntegrationService({
    integrations: new PostgresIntegrationRepository(pool),
    providerFactory: httpProviderFactory(config.provider),
    secretBox: new SecretBox(config.credentialsKey),
    sends,
  });
  const conversations = new ConversationService({
    cache: new PostgresBoardCache(pool),
    integrations,
    sends,
    cacheTtlMs: config.cacheTtlMs,
  });
  const events = new EventService({ events: new PostgresEventRepository(pool), publisher });

  return { pool, kafka, publisher, changes, integrations, conversations, events };
}
