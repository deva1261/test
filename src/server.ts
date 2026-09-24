import { Pool } from 'pg';
import { createApp } from './app';
import { loadConfig } from './config';
import { PostgresSessionRepository, PostgresUserRepository } from './repositories/postgres';
import { AuthService } from './services/authService';
import { PasswordHasher } from './services/password';

const config = loadConfig();
const pool = new Pool({ connectionString: config.databaseUrl });

const auth = new AuthService(
  new PostgresUserRepository(pool),
  new PostgresSessionRepository(pool),
  new PasswordHasher(config.bcryptRounds),
  { sessionTtlMs: config.sessionTtlHours * 60 * 60 * 1000 },
);

const app = createApp({
  auth,
  cookieSecure: config.cookieSecure,
  healthCheck: async () => {
    await pool.query('SELECT 1');
  },
});

const server = app.listen(config.port, () => {
  console.log(`auth-api listening on :${config.port}`);
});

function shutdown(signal: string): void {
  console.log(`${signal} received, shutting down`);
  server.close(() => {
    pool.end().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
