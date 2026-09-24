import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { hashToken } from '../src/services/authService';
import { buildTestApp, sessionCookie, validSignup } from './helpers';

const credentials = { email: validSignup.email, password: validSignup.password };

describe('POST /api/auth/login', () => {
  it('issues an HttpOnly Secure session cookie and stores only its hash', async () => {
    const { app, sessions } = buildTestApp();
    await request(app).post('/api/auth/signup').send(validSignup).expect(201);

    const res = await request(app).post('/api/auth/login').send(credentials);
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(validSignup.email);
    expect(JSON.stringify(res.body)).not.toMatch(/password/i);

    const cookie = sessionCookie(res);
    expect(cookie).toBeDefined();
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Expires=/);

    const token = decodeURIComponent(cookie!.split(';')[0].slice('sid='.length));
    expect(sessions.sessions.has(hashToken(token))).toBe(true);
    expect(sessions.sessions.has(token)).toBe(false);
  });

  it('accepts the email in any case', async () => {
    const { app } = buildTestApp();
    await request(app).post('/api/auth/signup').send(validSignup).expect(201);
    const res = await request(app)
      .post('/api/auth/login')
      .send({ ...credentials, email: 'ADA@EXAMPLE.COM' });
    expect(res.status).toBe(200);
  });

  it('returns the same 401 for a wrong password and an unknown email', async () => {
    const { app } = buildTestApp();
    await request(app).post('/api/auth/signup').send(validSignup).expect(201);

    const wrongPassword = await request(app)
      .post('/api/auth/login')
      .send({ ...credentials, password: 'wrongpass1' });
    const unknownEmail = await request(app)
      .post('/api/auth/login')
      .send({ ...credentials, email: 'nobody@example.com' });

    for (const res of [wrongPassword, unknownEmail]) {
      expect(res.status).toBe(401);
      expect(res.body.error).toEqual({ code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' });
      expect(sessionCookie(res)).toBeUndefined();
    }
  });

  it('rejects a missing password with 400', async () => {
    const { app } = buildTestApp();
    const res = await request(app).post('/api/auth/login').send({ email: validSignup.email });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});
