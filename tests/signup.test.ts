import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildTestApp, validSignup } from './helpers';

describe('POST /api/auth/signup', () => {
  it('creates an account and never returns the password', async () => {
    const { app, users } = buildTestApp();
    const res = await request(app).post('/api/auth/signup').send(validSignup);

    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ name: 'Ada Lovelace', email: 'ada@example.com' });
    expect(res.body.user.id).toEqual(expect.any(String));
    expect(JSON.stringify(res.body)).not.toMatch(/password/i);
    expect(res.headers['cache-control']).toBe('no-store');

    const stored = [...users.users.values()][0];
    expect(stored.passwordHash).not.toBe(validSignup.password);
    expect(stored.passwordHash).toMatch(/^\$2[aby]\$/);
  });

  it('normalises the email', async () => {
    const { app } = buildTestApp();
    const res = await request(app)
      .post('/api/auth/signup')
      .send({ ...validSignup, email: '  Ada@Example.COM ' });
    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe('ada@example.com');
  });

  it('rejects a duplicate email case-insensitively with 409', async () => {
    const { app } = buildTestApp();
    await request(app).post('/api/auth/signup').send(validSignup).expect(201);
    const res = await request(app)
      .post('/api/auth/signup')
      .send({ ...validSignup, email: 'ADA@example.com' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
  });

  it.each([
    ['missing name', { ...validSignup, name: '   ' }, 'name'],
    ['invalid email', { ...validSignup, email: 'not-an-email' }, 'email'],
    ['short password', { ...validSignup, password: 'a1', confirmPassword: 'a1' }, 'password'],
    ['password without digit', { ...validSignup, password: 'abcdefgh', confirmPassword: 'abcdefgh' }, 'password'],
    ['password over 72 bytes', { ...validSignup, password: 'a1'.repeat(37), confirmPassword: 'a1'.repeat(37) }, 'password'],
    ['mismatched confirmation', { ...validSignup, confirmPassword: 'different1' }, 'confirmPassword'],
    ['unknown field', { ...validSignup, role: 'admin' }, null],
  ])('rejects %s with 400', async (_label, body, field) => {
    const { app } = buildTestApp();
    const res = await request(app).post('/api/auth/signup').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.map((d: { field: string | null }) => d.field)).toContain(field);
  });

  it('rejects malformed JSON with 400', async () => {
    const { app } = buildTestApp();
    const res = await request(app)
      .post('/api/auth/signup')
      .set('Content-Type', 'application/json')
      .send('{"name":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });
});
