import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildTestApp, sessionCookie, validSignup } from './helpers';

const credentials = { email: validSignup.email, password: validSignup.password };

async function signedInAgent(ctx: ReturnType<typeof buildTestApp>) {
  await request(ctx.app).post('/api/auth/signup').send(validSignup).expect(201);
  // supertest's agent does not send Secure cookies over plain HTTP, so carry it by hand.
  const login = await request(ctx.app).post('/api/auth/login').send(credentials).expect(200);
  return sessionCookie(login)!.split(';')[0];
}

describe('GET /api/auth/me', () => {
  it('returns the caller profile without any password field', async () => {
    const ctx = buildTestApp();
    const cookie = await signedInAgent(ctx);

    const res = await request(ctx.app).get('/api/auth/me').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.user).sort()).toEqual(['createdAt', 'email', 'id', 'name']);
    expect(res.body.user.email).toBe(validSignup.email);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('returns 401 without a cookie', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('returns 401 for a forged token', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/api/auth/me').set('Cookie', 'sid=forged-token');
    expect(res.status).toBe(401);
  });

  it('returns 401 once the session has expired', async () => {
    const ctx = buildTestApp({ sessionTtlMs: 1000 });
    const cookie = await signedInAgent(ctx);
    ctx.clock.current = new Date(ctx.clock.current.getTime() + 1000);

    const res = await request(ctx.app).get('/api/auth/me').set('Cookie', cookie);
    expect(res.status).toBe(401);
  });
});

describe('POST /api/auth/logout', () => {
  it('revokes the session server-side and clears the cookie', async () => {
    const ctx = buildTestApp();
    const cookie = await signedInAgent(ctx);

    const res = await request(ctx.app).post('/api/auth/logout').set('Cookie', cookie);
    expect(res.status).toBe(204);
    expect(sessionCookie(res)).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect([...ctx.sessions.sessions.values()][0].revokedAt).toBeInstanceOf(Date);

    // Replaying the old cookie must not work.
    await request(ctx.app).get('/api/auth/me').set('Cookie', cookie).expect(401);
  });

  it('only revokes the caller session, not other devices', async () => {
    const ctx = buildTestApp();
    const first = await signedInAgent(ctx);
    const secondLogin = await request(ctx.app).post('/api/auth/login').send(credentials).expect(200);
    const second = sessionCookie(secondLogin)!.split(';')[0];

    await request(ctx.app).post('/api/auth/logout').set('Cookie', first).expect(204);
    await request(ctx.app).get('/api/auth/me').set('Cookie', second).expect(200);
  });

  it('is idempotent without a session', async () => {
    const { app } = buildTestApp();
    await request(app).post('/api/auth/logout').expect(204);
    await request(app).post('/api/auth/logout').set('Cookie', 'sid=unknown').expect(204);
  });
});
