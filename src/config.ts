export interface Config {
  port: number;
  databaseUrl: string;
  sessionTtlHours: number;
  cookieSecure: boolean;
  bcryptRounds: number;
}

function intFrom(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got "${value}"`);
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  return {
    port: intFrom(env.PORT, 3000, 'PORT'),
    databaseUrl,
    sessionTtlHours: intFrom(env.SESSION_TTL_HOURS, 24 * 7, 'SESSION_TTL_HOURS'),
    // Secure cookies are the default; only an explicit "false" turns them off (local HTTP dev).
    cookieSecure: env.COOKIE_SECURE !== 'false',
    bcryptRounds: intFrom(env.BCRYPT_ROUNDS, 12, 'BCRYPT_ROUNDS'),
  };
}
