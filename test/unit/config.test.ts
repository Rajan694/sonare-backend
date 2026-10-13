import { describe, it, expect } from 'vitest';
import { assertProductionConfig, config, corsOrigins, parseDatabaseUrl, parseTrustProxy } from '../../src/config.js';

describe('config.ts Configuration Parsing', () => {
  it('BE-CONF-001: parseDatabaseUrl parses standard TCP postgres URL correctly', () => {
    const parsed = parseDatabaseUrl('postgres://testuser:testpass@localhost:5432/testdb');
    expect(parsed.host).toBe('localhost');
    expect(parsed.port).toBe(5432);
    expect(parsed.user).toBe('testuser');
    expect(parsed.password).toBe('testpass');
    expect(parsed.database).toBe('testdb');
  });

  it('BE-CONF-002: parseDatabaseUrl parses Unix domain socket postgres URL', () => {
    const parsed = parseDatabaseUrl('postgres:///testdb?host=/var/run/postgresql');
    expect(parsed.host).toBe('/var/run/postgresql');
    expect(parsed.database).toBe('testdb');
  });

  it('BE-CONF-003: parseDatabaseUrl parses postgres URL without port using default 5432', () => {
    const parsed = parseDatabaseUrl('postgres://user:pass@127.0.0.1/mydb');
    expect(parsed.host).toBe('127.0.0.1');
    expect(parsed.port).toBe(5432);
    expect(parsed.database).toBe('mydb');
  });

  it('BE-CONF-004: environment schema validates required config values correctly', () => {
    expect(config.JWT_SECRET).toBeDefined();
    expect(config.DATABASE_URL).toBeDefined();
    expect(config.REDIS_URL).toBeDefined();
    expect(config.PORT).toBeDefined();
    expect(Array.isArray(corsOrigins)).toBe(true);
  });

  describe('assertProductionConfig', () => {
    const prod = {
      ...config,
      NODE_ENV: 'production' as const,
      JWT_SECRET: 'a'.repeat(40),
      RESEND_API_KEY: 're_key',
      APP_URL: 'https://sonare.vip',
    };

    it('BE-CONF-005: accepts a complete production config', () => {
      expect(() => assertProductionConfig(prod)).not.toThrow();
    });

    it('BE-CONF-006: rejects the dev JWT secret or a short one in production', () => {
      expect(() => assertProductionConfig({ ...prod, JWT_SECRET: '__sonare_dev_secret__' })).toThrow(/JWT_SECRET/);
      expect(() => assertProductionConfig({ ...prod, JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
    });

    it('BE-CONF-007: rejects a missing Resend API key in production', () => {
      expect(() => assertProductionConfig({ ...prod, RESEND_API_KEY: undefined })).toThrow(/RESEND_API_KEY/);
    });

    it('BE-CONF-008: rejects a non-https APP_URL in production', () => {
      expect(() => assertProductionConfig({ ...prod, APP_URL: 'http://sonare.vip' })).toThrow(/APP_URL/);
    });

    it('BE-CONF-009: skips all checks outside production', () => {
      expect(() =>
        assertProductionConfig({ ...prod, NODE_ENV: 'development', JWT_SECRET: 'x', RESEND_API_KEY: undefined }),
      ).not.toThrow();
    });
  });

  it('BE-CONF-010: parseTrustProxy turns TRUST_PROXY into the Express setting', () => {
    expect(parseTrustProxy(undefined)).toBeUndefined();
    expect(parseTrustProxy('')).toBeUndefined();
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('2')).toBe(2);
    expect(parseTrustProxy('loopback')).toBe('loopback');
  });
});
