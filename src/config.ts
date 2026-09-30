export interface Config {
  port: number;
  databaseUrl: string;
  kafka: { brokers: string[]; clientId: string; topic: string; groupId: string };
  provider: { baseUrl: string; webhookSecret: string; timeoutMs: number };
  credentialsKey: Buffer;
  internalApiToken: string;
  cacheTtlMs: number;
}

function intFrom(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got "${value}"`);
  }
  return parsed;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const credentialsKey = Buffer.from(required(env, 'CREDENTIALS_ENCRYPTION_KEY'), 'base64');
  if (credentialsKey.length !== 32) {
    throw new Error('CREDENTIALS_ENCRYPTION_KEY must be 32 bytes, base64-encoded');
  }

  return {
    port: intFrom(env.PORT, 3000, 'PORT'),
    databaseUrl: required(env, 'DATABASE_URL'),
    kafka: {
      brokers: required(env, 'KAFKA_BROKERS').split(',').map((b) => b.trim()).filter(Boolean),
      clientId: env.KAFKA_CLIENT_ID || 'board-api',
      topic: env.KAFKA_TOPIC || 'conversation-events',
      groupId: env.KAFKA_GROUP_ID || 'board-api-events',
    },
    provider: {
      baseUrl: required(env, 'SPRINTLE_API_BASE_URL').replace(/\/+$/, ''),
      webhookSecret: required(env, 'SPRINTLE_WEBHOOK_SECRET'),
      timeoutMs: intFrom(env.PROVIDER_TIMEOUT_MS, 10_000, 'PROVIDER_TIMEOUT_MS'),
    },
    credentialsKey,
    internalApiToken: required(env, 'INTERNAL_API_TOKEN'),
    cacheTtlMs: intFrom(env.CACHE_TTL_SECONDS, 30, 'CACHE_TTL_SECONDS') * 1000,
  };
}
