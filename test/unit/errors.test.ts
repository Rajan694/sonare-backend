import { describe, expect, it } from 'vitest';
import { BadRequestError, NoAudioStreamError, StreamTokenError } from '../../src/errors.js';
import { UpstreamError } from '../../src/upstream/piped.js';

describe('errors.ts: error hierarchy', () => {
  it('BE-ERR-CLASS-001: instantiates BadRequestError with message and 400 status', () => {
    const err = new BadRequestError('Bad input');
    expect(err.status).toBe(400);
    expect(err.name).toBe('BadRequestError');
    expect(err.message).toBe('Bad input');
  });

  it('BE-ERR-CLASS-002: BadRequestError has default behavior', () => {
    const err = new BadRequestError('Invalid query');
    expect(err.message).toBe('Invalid query');
  });

  it('BE-ERR-CLASS-003: NoAudioStreamError defaults to standard message', () => {
    const err = new NoAudioStreamError();
    expect(err.message).toBe('No audio streams found');
    expect(err.status).toBe(503);
    expect(err.code).toBe('NO_AUDIO_STREAM');
  });

  it('BE-ERR-CLASS-004: NoAudioStreamError supports custom message', () => {
    const err = new NoAudioStreamError('Custom no stream message');
    expect(err.message).toBe('Custom no stream message');
  });

  it('BE-ERR-CLASS-005: UpstreamError defaults to unreachable=false', () => {
    const err = new UpstreamError('Upstream 500 error', 502);
    expect(err.status).toBe(502);
    expect(err.unreachable).toBe(false);
  });

  it('BE-ERR-CLASS-006: UpstreamError supports unreachable=true', () => {
    const err = new UpstreamError('Host down', 502, true);
    expect(err.unreachable).toBe(true);
  });

  it('BE-ERR-CLASS-007: UpstreamError name is UpstreamError', () => {
    const err = new UpstreamError('Failed', 502);
    expect(err.name).toBe('UpstreamError');
  });

  it('BE-ERR-CLASS-008: Error instances inherit from standard Error class', () => {
    expect(new BadRequestError('test') instanceof Error).toBe(true);
    expect(new NoAudioStreamError() instanceof Error).toBe(true);
    expect(new UpstreamError('test', 502) instanceof Error).toBe(true);
    expect(new StreamTokenError('test') instanceof Error).toBe(true);
  });

  it('StreamTokenError instantiates with 403 status and FORBIDDEN code', () => {
    const err = new StreamTokenError('Token expired');
    expect(err.status).toBe(403);
    expect(err.code).toBe('FORBIDDEN');
    expect(err.name).toBe('StreamTokenError');
    expect(err.message).toBe('Token expired');
  });
});

describe('errors.ts: constructors', () => {
  it('BE-PURE-005: BadRequestError constructs with correct status code 400', () => {
    const err = new BadRequestError('Invalid input provided');
    expect(err.status).toBe(400);
    expect(err.name).toBe('BadRequestError');
    expect(err.message).toBe('Invalid input provided');
  });

  it('BE-PURE-006: NoAudioStreamError constructs with correct status code 503', () => {
    const err = new NoAudioStreamError('No playable audio streams found');
    expect(err.status).toBe(503);
    expect(err.name).toBe('NoAudioStreamError');
  });

  it('BE-PURE-007: UpstreamError constructs with custom status and unreachable flag', () => {
    const err = new UpstreamError('Piped service unreachable', 503, true);
    expect(err.status).toBe(503);
    expect(err.unreachable).toBe(true);
    expect(err.message).toBe('Piped service unreachable');
  });
});
