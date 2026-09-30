import { existsSync } from 'node:fs';
import path from 'node:path';
import { createApp } from './app';
import { loadConfig } from './config';
import { buildContainer } from './container';
import { listenForChanges } from './events/pgListener';

// Resolves to <repo>/public both from src/ (tsx) and dist/src/ (compiled).
const staticDir = [path.resolve(__dirname, '../public'), path.resolve(__dirname, '../../public')].find((dir) =>
  existsSync(path.join(dir, 'index.html')),
);

const config = loadConfig();
const { pool, publisher, changes, integrations, conversations, events } = buildContainer(config);
const listener = listenForChanges(config.databaseUrl, changes);

const app = createApp({
  integrations,
  conversations,
  events,
  changes,
  staticDir,
  webhookSecret: config.provider.webhookSecret,
  internalApiToken: config.internalApiToken,
  healthCheck: async () => {
    await pool.query('SELECT 1');
  },
});

const server = app.listen(config.port, () => {
  console.log(`board-api listening on :${config.port}${staticDir ? ' (serving board UI)' : ''}`);
});

function shutdown(signal: string): void {
  console.log(`${signal} received, shutting down`);
  // Open SSE streams would otherwise keep server.close() waiting.
  server.closeAllConnections();
  server.close(() => {
    Promise.allSettled([publisher.disconnect(), listener.close(), pool.end()]).finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
