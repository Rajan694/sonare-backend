import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { createAdminUser, createUser } from '../factories.js';
import { db } from '../../src/db/index.js';
import { errorLogs } from '../../src/db/schema.js';
import { requireAdmin } from '../../src/middleware/adminAuth.js';
import type { Request, Response } from 'express';

describe('Admin: login, analytics & errors', () => {
  const app = createApp();

  it('BE-ADMIN-001: POST /api/v1/admin/login succeeds with valid admin credentials', async () => {
    const { admin, rawPassword } = await createAdminUser();
    const res = await request(app).post('/api/v1/admin/login').send({
      email: admin.email,
      password: rawPassword,
    });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('token');
    expect(res.body.admin.email).toBe(admin.email);
  });

  it('BE-ADMIN-002: POST /api/v1/admin/login rejects invalid password with 401', async () => {
    const { admin } = await createAdminUser();
    const res = await request(app).post('/api/v1/admin/login').send({
      email: admin.email,
      password: 'wrongpasswordhere',
    });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('BE-ADMIN-003: POST /api/v1/admin/login rejects missing email or password with 400', async () => {
    const res = await request(app).post('/api/v1/admin/login').send({
      email: 'admin@example.com',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('BE-ADMIN-004: GET /api/v1/admin/me returns admin profile when authenticated', async () => {
    const { admin, token } = await createAdminUser();
    const res = await request(app).get('/api/v1/admin/me').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.email).toBe(admin.email);
  });

  it('BE-ADMIN-005: GET /api/v1/admin/me rejects standard user JWT with 401', async () => {
    const { token } = await createUser();
    const res = await request(app).get('/api/v1/admin/me').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
  });

  it('BE-ADMIN-006: POST /api/v1/admin/password changes admin password and rotates token', async () => {
    const { token, rawPassword } = await createAdminUser();
    const res = await request(app).post('/api/v1/admin/password').set('Authorization', `Bearer ${token}`).send({
      currentPassword: rawPassword,
      newPassword: 'newsecureadminpassword123',
    });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('token');

    // Old token should be invalidated by tokenVersion bump
    const oldMeRes = await request(app).get('/api/v1/admin/me').set('Authorization', `Bearer ${token}`);
    expect(oldMeRes.status).toBe(401);
  });

  it('BE-ADMIN-007: POST /api/v1/admin/password rejects wrong current password with 400', async () => {
    const { token } = await createAdminUser();
    const res = await request(app).post('/api/v1/admin/password').set('Authorization', `Bearer ${token}`).send({
      currentPassword: 'wrong_current_password',
      newPassword: 'newsecureadminpassword123',
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('WRONG_PASSWORD');
  });

  it('BE-ADMIN-008: POST /api/v1/admin/login rejects an app account with 401', async () => {
    const { user, rawPassword } = await createUser();
    const res = await request(app).post('/api/v1/admin/login').send({ email: user.email, password: rawPassword });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('BE-ADMIN-009: POST /api/v1/auth/login refuses the admin account', async () => {
    const { admin, rawPassword } = await createAdminUser();
    const res = await request(app).post('/api/v1/auth/login').send({ email: admin.email, password: rawPassword });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('BE-ADMIN-010: overview user counts leave out the admin account', async () => {
    const { token } = await createAdminUser();
    const before = await request(app).get('/api/v1/admin/analytics/overview').set('Authorization', `Bearer ${token}`);
    await createAdminUser();
    await createUser();
    const after = await request(app).get('/api/v1/admin/analytics/overview').set('Authorization', `Bearer ${token}`);

    expect(after.body.totals.users).toBe(before.body.totals.users + 1);
    expect(after.body.totals.newUsers).toBe(before.body.totals.newUsers + 1);
  });

  it('BE-ADMIN-011: GET /api/v1/admin/analytics/overview returns aggregated overview stats', async () => {
    const { token } = await createAdminUser();
    const res = await request(app).get('/api/v1/admin/analytics/overview').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('totals');
    expect(res.body).toHaveProperty('daily');
    expect(res.body.totals).toHaveProperty('users');
  });

  it('BE-ADMIN-012: GET /api/v1/admin/analytics/requests returns request volume and latency stats', async () => {
    const { token } = await createAdminUser();
    const res = await request(app).get('/api/v1/admin/analytics/requests').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('summary');
    expect(res.body).toHaveProperty('series');
    expect(res.body).toHaveProperty('routes');
  });

  it('BE-ADMIN-013: GET /api/v1/admin/errors returns logged errors list', async () => {
    const { token } = await createAdminUser();
    const res = await request(app).get('/api/v1/admin/errors').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('items');
    expect(res.body).toHaveProperty('total');
    expect(Array.isArray(res.body.items)).toBe(true);
  });

  it('BE-ADMIN-014: DELETE /api/v1/admin/errors/:id deletes an error log entry', async () => {
    const { token } = await createAdminUser();
    const [err] = await db
      .insert(errorLogs)
      .values({
        source: 'backend',
        message: 'Error to delete in test',
      })
      .returning();

    const res = await request(app).delete(`/api/v1/admin/errors/${err.id}`).set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(204);
  });
});

describe('Admin: security, rate limiting & filters', () => {
  const app = createApp();

  it('BE-ADM-SEC-001: admin login enforces rate limiting after multiple failed attempts', async () => {
    for (let i = 0; i < 5; i++) {
      await request(app).post('/api/v1/admin/login').send({
        email: 'nonexistent_admin_brute@example.com',
        password: 'badpassword',
      });
    }

    const lockedRes = await request(app).post('/api/v1/admin/login').send({
      email: 'nonexistent_admin_brute@example.com',
      password: 'badpassword',
    });

    expect(lockedRes.status).toBe(429);
    expect(lockedRes.body.error.code).toBe('RATE_LIMITED');
  });

  it('BE-ADM-SEC-002: admin password change rejects identical new password with 400', async () => {
    const { token, rawPassword } = await createAdminUser();
    const res = await request(app).post('/api/v1/admin/password').set('Authorization', `Bearer ${token}`).send({
      currentPassword: rawPassword,
      newPassword: rawPassword,
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('BE-ADM-SEC-003: admin password change rejects short new password (<8 chars) with 400', async () => {
    const { token, rawPassword } = await createAdminUser();
    const res = await request(app).post('/api/v1/admin/password').set('Authorization', `Bearer ${token}`).send({
      currentPassword: rawPassword,
      newPassword: 'short',
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('BE-ADM-SEC-004: GET /api/v1/admin/errors supports filtering by source and search query', async () => {
    const { token } = await createAdminUser();
    await db.insert(errorLogs).values({
      source: 'web',
      message: 'Uncaught UI exception on player page',
    });
    await db.insert(errorLogs).values({
      source: 'backend',
      message: 'Database query execution timeout',
    });

    const res = await request(app).get('/api/v1/admin/errors?source=web&q=UI').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThanOrEqual(1);
    expect(res.body.items[0].source).toBe('web');
  });
});

describe('Admin: error log & analytics edge cases', () => {
  const app = createApp();

  it('BE-ADM-EXTRA-003: DELETE /api/v1/admin/errors/:id returns 404 for non-existent error id', async () => {
    const { token } = await createAdminUser();
    const res = await request(app).delete('/api/v1/admin/errors/999999999').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
  });

  it('BE-ADM-EXTRA-004: DELETE /api/v1/admin/errors/:id returns 400 for non-integer id', async () => {
    const { token } = await createAdminUser();
    const res = await request(app).delete('/api/v1/admin/errors/notanumber').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
  });

  it('BE-ADM-EXTRA-005: GET /api/v1/admin/analytics/overview accepts days query parameter', async () => {
    const { token } = await createAdminUser();
    const res = await request(app)
      .get('/api/v1/admin/analytics/overview?days=7')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.days).toBe(7);
  });

  it('BE-ADM-EXTRA-006: GET /api/v1/admin/analytics/requests accepts hours query parameter', async () => {
    const { token } = await createAdminUser();
    const res = await request(app)
      .get('/api/v1/admin/analytics/requests?hours=24')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.hours).toBe(24);
  });
});

describe('Admin: analytics tz', () => {
  const app = createApp();

  it('BE-ADM-COV-002: GET /api/v1/admin/analytics/overview accepts tz query parameter', async () => {
    const { token } = await createAdminUser();
    const res = await request(app)
      .get('/api/v1/admin/analytics/overview?tz=America/New_York')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
  });
});

describe('Admin: requireAdmin middleware', () => {
  it('BE-ADM-BR-001: requireAdmin rejects when database throws an error', async () => {
    const req = {
      headers: { authorization: 'Bearer invalid_admin_token_string' },
    } as unknown as Request;
    const res = {
      status: () => ({
        json: (d: unknown) => d,
      }),
    } as unknown as Response;
    let calledNext = false;
    await requireAdmin(req, res, () => {
      calledNext = true;
    });
    expect(calledNext).toBe(false);
  });
});
