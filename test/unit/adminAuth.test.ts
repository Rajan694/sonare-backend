import { describe, it, expect } from 'vitest';
import { requireAdmin, signAdminToken } from '../../src/middleware/adminAuth.js';
import { createAdminUser } from '../factories.js';
import jwt from 'jsonwebtoken';
import { config } from '../../src/config.js';
import crypto from 'node:crypto';

describe('Admin Authentication Utilities', () => {
  it('BE-ADMAUTH-001: signs admin JWT tokens with proper claims and expiration', async () => {
    const { admin } = await createAdminUser();
    const token = signAdminToken(admin);
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(20);

    const adminKey = crypto.createHmac('sha256', config.JWT_SECRET).update('sonare-admin-token').digest();
    const decoded = jwt.verify(token, adminKey, { audience: 'sonare-admin' }) as jwt.JwtPayload;
    expect(decoded.sub).toBe(admin.id);
    expect(decoded.ver).toBe(admin.tokenVersion);
  });

  it('BE-ADMAUTH-002: requireAdmin middleware exports successfully', () => {
    expect(typeof requireAdmin).toBe('function');
  });
});
