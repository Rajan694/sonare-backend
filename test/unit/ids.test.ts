import { describe, it, expect } from 'vitest';
import { idHelpers } from '../../src/ids.js';

describe('ids.ts Comprehensive Suite', () => {
  it('BE-IDS-001: extracts youtube id from valid prefixed string', () => {
    expect(idHelpers.extractYtId('yt:dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(idHelpers.extractYtId('yt:1234567890_')).toBe('1234567890_');
  });

  it('BE-IDS-002: extractYtId throws error for string missing yt: prefix', () => {
    expect(() => idHelpers.extractYtId('dQw4w9WgXcQ')).toThrow('Invalid yt ID: dQw4w9WgXcQ');
    expect(() => idHelpers.extractYtId('sonare:12345')).toThrow();
  });

  it('BE-IDS-003: prefixLocal adds local: prefix', () => {
    expect(idHelpers.prefixLocal('hash123')).toBe('local:hash123');
  });

  it('BE-IDS-004: prefixSonare adds sonare: prefix', () => {
    expect(idHelpers.prefixSonare('pl_123')).toBe('sonare:pl_123');
  });

  it('BE-IDS-005: prefixYt prepends yt: prefix', () => {
    expect(idHelpers.prefixYt('dQw4w9WgXcQ')).toBe('yt:dQw4w9WgXcQ');
  });

  it('BE-IDS-006: extractChannelIdFromUrl parses various channel url patterns', () => {
    expect(idHelpers.extractChannelIdFromUrl('/channel/UCuAXFkgsw1L7xaCfnd5JJOw')).toBe('UCuAXFkgsw1L7xaCfnd5JJOw');
    expect(idHelpers.extractChannelIdFromUrl('https://youtube.com/channel/UC123456')).toBe('UC123456');
    expect(idHelpers.extractChannelIdFromUrl('/channel/UCabc123/featured')).toBe('UCabc123');
  });

  it('BE-IDS-007: extractChannelIdFromUrl returns null for unparseable url', () => {
    expect(idHelpers.extractChannelIdFromUrl('invalid_channel_url')).toBeNull();
    expect(idHelpers.extractChannelIdFromUrl('')).toBeNull();
    expect(idHelpers.extractChannelIdFromUrl(undefined)).toBeNull();
  });

  it('BE-IDS-008: artistIdFromUrl returns yt: prefixed channel ID or empty string', () => {
    expect(idHelpers.artistIdFromUrl('/channel/UCuAXFkgsw1L7xaCfnd5JJOw')).toBe('yt:UCuAXFkgsw1L7xaCfnd5JJOw');
    expect(idHelpers.artistIdFromUrl('/channel/InvalidNameWithoutUC')).toBe('');
    expect(idHelpers.artistIdFromUrl(null)).toBe('');
  });

  it('BE-IDS-009: extractListIdFromUrl extracts playlist list query parameter', () => {
    expect(idHelpers.extractListIdFromUrl('https://youtube.com/playlist?list=PL12345678')).toBe('PL12345678');
    expect(idHelpers.extractListIdFromUrl('/playlist?list=OLAK5uy_sample')).toBe('OLAK5uy_sample');
    expect(idHelpers.extractListIdFromUrl('https://music.youtube.com/watch?v=123&list=PLabc')).toBe('PLabc');
  });

  it('BE-IDS-010: extractListIdFromUrl returns null if no list query parameter present', () => {
    expect(idHelpers.extractListIdFromUrl('PL123456')).toBeNull();
    expect(idHelpers.extractListIdFromUrl('')).toBeNull();
    expect(idHelpers.extractListIdFromUrl(undefined)).toBeNull();
  });
});
