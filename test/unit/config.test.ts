import { describe, it, expect } from 'vitest';
import { config, parseDatabaseUrl } from '../../src/config.js';
import { z } from 'zod';

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
  });
});
