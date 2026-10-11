export class BadRequestError extends Error {
  public status: number;
  constructor(message: string) {
    super(message);
    this.name = 'BadRequestError';
    this.status = 400;
  }
}

export class NoAudioStreamError extends Error {
  public status: number;
  public code: string;
  constructor(message: string = 'No audio streams found') {
    super(message);
    this.name = 'NoAudioStreamError';
    this.status = 503;
    this.code = 'NO_AUDIO_STREAM';
  }
}

export class StreamTokenError extends Error {
  public status: number;
  public code: string;
  constructor(message: string) {
    super(message);
    this.name = 'StreamTokenError';
    this.status = 403;
    this.code = 'FORBIDDEN';
  }
}

/** LRCLIB didn't answer, so "no lyrics" would be a guess. Not cached; the next open retries. */
export class LyricsUnavailableError extends Error {
  public status: number;
  public code: string;
  constructor(message: string = "The lyrics service isn't responding. Try again in a moment.") {
    super(message);
    this.name = 'LyricsUnavailableError';
    this.status = 502;
    this.code = 'LYRICS_UNAVAILABLE';
  }
}

/** A short reason for a caught error: its code (ECONNREFUSED, …) when it has one, else its message. */
export const describeError = (e: unknown): string => {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code) return code;
  return e instanceof Error ? e.message : String(e);
};
