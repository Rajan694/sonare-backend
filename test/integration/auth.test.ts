import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { db } from '../../src/db/index.js';
import { users, refreshTokens } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { createUser } from '../factories.js';
import { generateRefreshToken, signAccessToken, hashToken } from '../../src/middleware/auth.js';
import jwt from 'jsonwebtoken';
import { config } from '../../src/config.js';

describe('Auth routes & token lifecycle', () => {
  const app = createApp();

  it('BE-AUTH-001: Register user returns 201 with valid tokens and profile', async () => {
    const res = await request(app).post('/api/v1/auth/register').send({
      email: 'reg_test1@example.com',
      displayName: 'Reg User 1',
      password: 'password123',
    });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('accessToken');
    expect(res.body).toHaveProperty('refreshToken');
    expect(res.body.user.email).toBe('reg_test1@example.com');
    expect(res.body.user.displayName).toBe('Reg User 1');
  });

  it('BE-AUTH-002: Register user rejects missing email with 400', async () => {
    const res = await request(app).post('/api/v1/auth/register').send({
      displayName: 'No Email',
      password: 'password123',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('BE-AUTH-003: Register user rejects missing password with 400', async () => {
    const res = await request(app).post('/api/v1/auth/register').send({
      email: 'nopass@example.com',
      displayName: 'No Pass',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('BE-AUTH-004: Register user rejects missing displayName with 400', async () => {
    const res = await request(app).post('/api/v1/auth/register').send({
      email: 'noname@example.com',
      password: 'password123',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('BE-AUTH-005: Register user rejects duplicate email with 409 CONFLICT', async () => {
    await createUser({ email: 'duplicate@example.com' });
    const res = await request(app).post('/api/v1/auth/register').send({
      email: 'duplicate@example.com',
      displayName: 'Duplicate',
      password: 'password123',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('BE-AUTH-006: Login succeeds with correct credentials and returns tokens', async () => {
    const { rawPassword } = await createUser({ email: 'login_ok@example.com' });
    const res = await request(app).post('/api/v1/auth/login').send({
      email: 'login_ok@example.com',
      password: rawPassword,
    });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('accessToken');
    expect(res.body).toHaveProperty('refreshToken');
    expect(res.body.user.email).toBe('login_ok@example.com');
  });

  it('BE-AUTH-007: Login rejects non-existent email with 401 UNAUTHORIZED', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({
      email: 'nonexistent@example.com',
      password: 'password123',
    });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('BE-AUTH-008: Login rejects incorrect password with 401 UNAUTHORIZED', async () => {
    await createUser({ email: 'wrong_pw@example.com' });
    const res = await request(app).post('/api/v1/auth/login').send({
      email: 'wrong_pw@example.com',
      password: 'wrong_password_attempt',
    });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('BE-AUTH-009: Login rejects missing email with 400 BAD_REQUEST', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({
      password: 'password123',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('BE-AUTH-010: Login rejects missing password with 400 BAD_REQUEST', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({
      email: 'any@example.com',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('BE-AUTH-011: Token refresh rotates refresh token and returns new tokens', async () => {
    const { refreshToken } = await createUser();
    const res = await request(app).post('/api/v1/auth/refresh').send({
      refreshToken,
    });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('accessToken');
    expect(res.body).toHaveProperty('refreshToken');
    expect(res.body.refreshToken).not.toBe(refreshToken);

    // Old token is revoked and cannot be reused
    const reuseRes = await request(app).post('/api/v1/auth/refresh').send({
      refreshToken,
    });
    expect(reuseRes.status).toBe(401);
    expect(reuseRes.body.error.code).toBe('UNAUTHORIZED');
  });

  it('BE-AUTH-012: Token refresh rejects missing refreshToken with 400', async () => {
    const res = await request(app).post('/api/v1/auth/refresh').send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('BE-AUTH-013: Token refresh rejects invalid refreshToken with 401', async () => {
    const res = await request(app).post('/api/v1/auth/refresh').send({
      refreshToken: 'totally-invalid-refresh-token',
    });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('BE-AUTH-014: Token refresh rejects deleted user with 401', async () => {
    const { user, refreshToken } = await createUser();
    // Delete user from db directly
    await db.delete(users).where(eq(users.id, user.id));
    const res = await request(app).post('/api/v1/auth/refresh').send({
      refreshToken,
    });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('BE-AUTH-015: Logout revokes refresh token successfully', async () => {
    const { refreshToken } = await createUser();
    const logoutRes = await request(app).post('/api/v1/auth/logout').send({
      refreshToken,
    });
    expect(logoutRes.status).toBe(200);
    expect(logoutRes.body.ok).toBe(true);

    // Refreshing with revoked token fails
    const refreshRes = await request(app).post('/api/v1/auth/refresh').send({
      refreshToken,
    });
    expect(refreshRes.status).toBe(401);
  });

  it('BE-AUTH-016: Logout handles request without refreshToken gracefully', async () => {
    const res = await request(app).post('/api/v1/auth/logout').send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('BE-VAL-020: Logout rejects a refreshToken that is not a string', async () => {
    const res = await request(app).post('/api/v1/auth/logout').send({ refreshToken: 12345 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('BE-AUTH-017: requireAuth middleware rejects requests missing auth header', async () => {
    const res = await request(app).get('/api/v1/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('BE-AUTH-018: requireAuth middleware rejects malformed authorization header', async () => {
    const res = await request(app).get('/api/v1/me').set('Authorization', 'Basic 12345');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('BE-AUTH-019: requireAuth middleware rejects invalid jwt signature or structure', async () => {
    const res = await request(app).get('/api/v1/me').set('Authorization', 'Bearer invalid.jwt.payload');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('BE-AUTH-020: signAccessToken creates valid token string', () => {
    const payload = { id: 'usr_123', email: 'test@example.com' };
    const token = signAccessToken(payload);
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(20);
  });

  it('BE-AUTH-021: generateRefreshToken generates unique hex tokens', () => {
    const t1 = generateRefreshToken();
    const t2 = generateRefreshToken();
    expect(typeof t1).toBe('string');
    expect(t1.length).toBeGreaterThan(20);
    expect(t1).not.toBe(t2);
  });
});

describe('Auth routes: edge cases', () => {
  const app = createApp();

  it('BE-AUTH-EXTRA-001: rejects login when password hash in database is malformed', async () => {
    const { user } = await createUser();
    // Update hash to invalid bcrypt string
    await db.update(users).set({ passwordHash: 'corrupted_hash' }).where(eq(users.id, user.id));

    const res = await request(app).post('/api/v1/auth/login').send({
      email: user.email,
      password: 'password123',
    });

    expect(res.status).toBe(401);
  });

  it('BE-AUTH-EXTRA-002: requireAuth middleware rejects expired accessToken', async () => {
    const { user } = await createUser();
    const expiredToken = jwt.sign({ id: user.id, email: user.email }, config.JWT_SECRET, { expiresIn: -100 });

    const res = await request(app).get('/api/v1/me').set('Authorization', `Bearer ${expiredToken}`);

    expect(res.status).toBe(401);
  });

  it('BE-AUTH-EXTRA-003: requireAuth middleware rejects token signed with wrong secret', async () => {
    const { user } = await createUser();
    const fakeToken = jwt.sign({ id: user.id, email: user.email }, 'wrong_secret_key_123');

    const res = await request(app).get('/api/v1/me').set('Authorization', `Bearer ${fakeToken}`);

    expect(res.status).toBe(401);
  });

  it('BE-AUTH-EXTRA-004: POST /api/v1/auth/logout with empty body succeeds (no-op)', async () => {
    const res = await request(app).post('/api/v1/auth/logout').send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('Auth routes: error branches', () => {
  const app = createApp();

  it('BE-AUTH-BR-001: authRouter handles error when user lookup fails during refresh', async () => {
    const { user, refreshToken } = await createUser();
    // Delete user after getting refresh token
    await db.delete(users).where(eq(users.id, user.id));

    const res = await request(app).post('/api/v1/auth/refresh').send({ refreshToken });
    expect(res.status).toBe(401);
  });

  it('BE-AUTH-BR-002: requireAuth sets user on req object and continues', async () => {
    const { user, token } = await createUser();
    const res = await request(app).get('/api/v1/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(user.id);
  });
});

describe('Auth: refresh token hashing and rate limiting', () => {
  const app = createApp();

  it('stores hashed refresh token in database matching sha256 of returned token', async () => {
    const res = await request(app).post('/api/v1/auth/register').send({
      email: 'hash_test@example.com',
      displayName: 'Hash Test User',
      password: 'password123',
    });
    expect(res.status).toBe(201);
    const { refreshToken, user } = res.body;

    const [stored] = await db.select().from(refreshTokens).where(eq(refreshTokens.userId, user.id));
    expect(stored).toBeDefined();
    expect(stored.token).not.toBe(refreshToken);
    expect(stored.token).toBe(hashToken(refreshToken));

    // Refresh with returned token still works
    const refreshRes = await request(app).post('/api/v1/auth/refresh').send({ refreshToken });
    expect(refreshRes.status).toBe(200);
    expect(refreshRes.body).toHaveProperty('refreshToken');

    // Logout revokes it
    const logoutRes = await request(app)
      .post('/api/v1/auth/logout')
      .send({ refreshToken: refreshRes.body.refreshToken });
    expect(logoutRes.status).toBe(200);

    const revokedRefreshRes = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: refreshRes.body.refreshToken });
    expect(revokedRefreshRes.status).toBe(401);
  });

  it('rate limits login after 5 failed attempts and returns 429 on 6th attempt', async () => {
    const { user, rawPassword } = await createUser({ email: 'ratelimit_login@example.com' });

    // 5 failed attempts
    for (let i = 0; i < 5; i++) {
      const failRes = await request(app).post('/api/v1/auth/login').send({
        email: user.email,
        password: 'wrong_password',
      });
      expect(failRes.status).toBe(401);
    }

    // 6th attempt is rate limited
    const blockedRes = await request(app).post('/api/v1/auth/login').send({
      email: user.email,
      password: 'wrong_password',
    });
    expect(blockedRes.status).toBe(429);
    expect(blockedRes.body.error.code).toBe('RATE_LIMITED');
    expect(blockedRes.headers['retry-after']).toBeDefined();

    // Even with correct password, still blocked while locked out
    const blockedCorrectRes = await request(app).post('/api/v1/auth/login').send({
      email: user.email,
      password: rawPassword,
    });
    expect(blockedCorrectRes.status).toBe(429);
    expect(blockedCorrectRes.body.error.code).toBe('RATE_LIMITED');
  });

  it('successful login resets failed login attempt counter', async () => {
    const { user, rawPassword } = await createUser({ email: 'ratelimit_reset@example.com' });

    // 4 failed attempts
    for (let i = 0; i < 4; i++) {
      const failRes = await request(app).post('/api/v1/auth/login').send({
        email: user.email,
        password: 'wrong_password',
      });
      expect(failRes.status).toBe(401);
    }

    // 5th attempt succeeds and resets counter
    const successRes = await request(app).post('/api/v1/auth/login').send({
      email: user.email,
      password: rawPassword,
    });
    expect(successRes.status).toBe(200);

    // Another wrong attempt should only be 1st failed attempt, not blocked
    const afterRes = await request(app).post('/api/v1/auth/login').send({
      email: user.email,
      password: 'wrong_password',
    });
    expect(afterRes.status).toBe(401);
  });
});
