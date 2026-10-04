import type { Request, Response, NextFunction } from 'express';
import { UpstreamError } from '../upstream/piped.js';
import { BadRequestError, LyricsUnavailableError, NoAudioStreamError, StreamTokenError } from '../errors.js';

// The last middleware: turns thrown errors into the API's { error: { code, message } } shape.
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  // A body express.json() could not read is the client's mistake, not a server error.
  const bodyError = (err as { type?: unknown } | null)?.type;
  if (bodyError === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'The request body is not valid JSON' } });
    return;
  }
  if (bodyError === 'entity.too.large') {
    res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'The request body is too large' } });
    return;
  }

  req.log.error(err);
  // The request logger records it in error_logs if this ends up a 5xx.
  res.locals.error = err;

  if (err instanceof NoAudioStreamError || (err as { code?: unknown } | null)?.code === 'NO_AUDIO_STREAM') {
    res.status(503).json({
      error: { code: 'NO_AUDIO_STREAM', message: err instanceof Error ? err.message : 'No audio streams found' },
    });
    return;
  }

  if (err instanceof BadRequestError) {
    res.status(err.status).json({
      error: { code: 'BAD_REQUEST', message: err.message },
    });
    return;
  }

  if (err instanceof UpstreamError) {
    res.status(502).json({
      error: { code: err.unreachable ? 'UPSTREAM_UNAVAILABLE' : 'UPSTREAM_ERROR', message: err.message },
    });
    return;
  }

  if (err instanceof LyricsUnavailableError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }

  if (err instanceof StreamTokenError) {
    res.status(403).json({
      error: { code: 'FORBIDDEN', message: err.message },
    });
    return;
  }

  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    },
  });
}
