import crypto from 'node:crypto';
import { config } from './config.js';

const STREAM_TOKEN_SECRET = config.JWT_SECRET || crypto.randomBytes(32).toString('hex');

export interface StreamTokenData {
  url: string;
  exp: number;
}

export function signStreamToken(url: string, expiresInMs: number = 3600_000): string {
  const exp = Date.now() + expiresInMs;
  const payload = JSON.stringify({ url, exp });
  const payloadB64 = Buffer.from(payload).toString('base64url');
  
  const hmac = crypto.createHmac('sha256', STREAM_TOKEN_SECRET);
  hmac.update(payloadB64);
  const signature = hmac.digest('base64url');
  
  return `${payloadB64}.${signature}`;
}

export function verifyStreamToken(token: string): StreamTokenData {
  const [payloadB64, signature] = token.split('.');
  if (!payloadB64 || !signature) {
    throw new Error('Invalid token format');
  }

  const hmac = crypto.createHmac('sha256', STREAM_TOKEN_SECRET);
  hmac.update(payloadB64);
  const expectedSignature = hmac.digest('base64url');
  
  // Constant time comparison
  const sigBuf = Buffer.from(signature, 'ascii');
  const expectedBuf = Buffer.from(expectedSignature, 'ascii');
  
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    throw new Error('Invalid signature');
  }

  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  
  if (Date.now() > payload.exp) {
    throw new Error('Token expired');
  }

  return payload;
}
