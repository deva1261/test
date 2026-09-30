import { loadConfig } from './config';
import { buildContainer } from './container';
import { runConsumer } from './events/kafka';

const RELAY_INTERVAL_MS = 30_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const { pool, kafka, publisher, events } = buildContainer(config);

  const consumer = await runConsumer(kafka, config.kafka, async (eventId) => {
    const outcome = await events.process(eventId);
    if (outcome === 'already_processed') console.info(`Event ${eventId} redelivered; already applied`);
  });

  // Outbox relay: republish events whose webhook-time publish failed.
  const relay = setInterval(() => {
    events
      .relayUnpublished()
      .then((n) => n && console.info(`Relayed ${n} unpublished event(s)`))
      .catch((err) => console.error('Relay failed:', (err as Error).message));
  }, RELAY_INTERVAL_MS);

  console.log(`board-api worker consuming ${config.kafka.topic} as ${config.kafka.groupId}`);

  const shutdown = (signal: string) => {
    console.log(`${signal} received, shutting down worker`);
    clearInterval(relay);
    Promise.allSettled([consumer.disconnect(), publisher.disconnect()])
      .then(() => pool.end())
      .finally(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
