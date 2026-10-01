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
