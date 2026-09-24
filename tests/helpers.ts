import request from 'supertest';
import { createApp } from '../src/app';
import { InMemorySessionRepository, InMemoryUserRepository } from '../src/repositories/memory';
import { AuthService } from '../src/services/authService';
import { PasswordHasher } from '../src/services/password';

export const validSignup = {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  password: 'analytical1',
  confirmPassword: 'analytical1',
};

export function buildTestApp(options: { sessionTtlMs?: number; now?: () => Date } = {}) {
  const users = new InMemoryUserRepository();
  const sessions = new InMemorySessionRepository();
  const clock = { current: new Date('2026-01-01T00:00:00Z') };
  const auth = new AuthService(users, sessions, new PasswordHasher(4), {
    sessionTtlMs: options.sessionTtlMs ?? 60 * 60 * 1000,
    now: options.now ?? (() => clock.current),
  });
  const app = createApp({ auth, cookieSecure: true });
  return { app, users, sessions, clock, agent: () => request.agent(app) };
}

export function sessionCookie(res: request.Response): string | undefined {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  return raw?.find((c) => c.startsWith('sid='));
}
