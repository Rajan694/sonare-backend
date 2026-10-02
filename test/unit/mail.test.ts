import { describe, it, expect } from 'vitest';
import { resetPasswordMessage, verifyEmailMessage } from '../../src/mail.js';

describe('mail.ts', () => {
  it('BE-MAIL-001: verifyEmailMessage includes link in text and html', () => {
    const link = 'http://localhost:5183/verify?token=abc123';
    const msg = verifyEmailMessage(link);
    expect(msg.subject).toBe('Verify your Sonare email address');
    expect(msg.text).include(link);
    expect(msg.html).include(link);
  });

  it('BE-MAIL-002: resetPasswordMessage includes link in text and html', () => {
    const link = 'http://localhost:5183/reset-password?token=xyz789';
    const msg = resetPasswordMessage(link);
    expect(msg.subject).toBe('Reset your Sonare password');
    expect(msg.text).include(link);
    expect(msg.html).include(link);
  });
});
