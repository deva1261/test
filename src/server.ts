import { createApp } from './app';
import { loadConfig } from './config';
import { buildContainer } from './container';

const config = loadConfig();
const { pool, publisher, integrations, conversations, events } = buildContainer(config);

const app = createApp({
  integrations,
  conversations,
  events,
  webhookSecret: config.provider.webhookSecret,
  internalApiToken: config.internalApiToken,
  healthCheck: async () => {
    await pool.query('SELECT 1');
  },
});

const server = app.listen(config.port, () => {
  console.log(`board-api listening on :${config.port}`);
});

function shutdown(signal: string): void {
  console.log(`${signal} received, shutting down`);
  server.close(() => {
    Promise.allSettled([publisher.disconnect(), pool.end()]).finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
