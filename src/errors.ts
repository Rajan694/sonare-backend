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

/**
 * An account email that did not go out, so the app can say so instead of "sent".
 * MAIL_UNAVAILABLE: this server has no RESEND_API_KEY. MAIL_FAILED: Resend refused or didn't answer.
 */
export class MailError extends Error {
  public status: number;
  public code: 'MAIL_UNAVAILABLE' | 'MAIL_FAILED';
  constructor(code: 'MAIL_UNAVAILABLE' | 'MAIL_FAILED', options?: { cause?: unknown }) {
    super(
      code === 'MAIL_UNAVAILABLE'
        ? "This server can't send email yet. Ask the admin to set it up."
        : "The email couldn't be sent. Try again in a moment.",
      options,
    );
    this.name = 'MailError';
    this.status = code === 'MAIL_UNAVAILABLE' ? 503 : 502;
    this.code = code;
  }
}

/** A short reason for a caught error: its code (ECONNREFUSED, …) when it has one, else its message. */
export const describeError = (e: unknown): string => {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code) return code;
  return e instanceof Error ? e.message : String(e);
};
