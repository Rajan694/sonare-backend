import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from 'undici';
import { config } from '../../src/config.js';
import { mailTransportName, resetPasswordMessage, sendMail, verifyEmailMessage } from '../../src/services/mail.js';

const mail = { to: 'a@example.com', subject: 'Hi', text: 'Text body', html: '<p>HTML body</p>' };

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

  describe('through Resend', () => {
    let agent: MockAgent;
    let original: Dispatcher;
    const savedKey = config.RESEND_API_KEY;

    beforeEach(() => {
      original = getGlobalDispatcher();
      agent = new MockAgent();
      agent.disableNetConnect();
      setGlobalDispatcher(agent);
      config.RESEND_API_KEY = 're_test_key';
    });

    afterEach(async () => {
      config.RESEND_API_KEY = savedKey;
      await agent.close();
      setGlobalDispatcher(original);
    });

    it('BE-MAIL-003: posts the message to the Resend API with the key as a bearer token', async () => {
      let sent: { headers: Record<string, string>; body: unknown } | undefined;
      agent
        .get('https://api.resend.com')
        .intercept({ path: '/emails', method: 'POST' })
        .reply(200, (opts) => {
          sent = { headers: opts.headers as Record<string, string>, body: JSON.parse(String(opts.body)) };
          return { id: 'email_1' };
        });

      await sendMail(mail);

      expect(sent?.headers.Authorization ?? sent?.headers.authorization).toBe('Bearer re_test_key');
      expect(sent?.body).toEqual({
        from: config.MAIL_FROM,
        to: ['a@example.com'],
        subject: 'Hi',
        html: '<p>HTML body</p>',
        text: 'Text body',
      });
      expect(mailTransportName()).toBe('Resend API');
    });

    it("BE-MAIL-004: a refusal throws with Resend's status and message, never the key", async () => {
      agent
        .get('https://api.resend.com')
        .intercept({ path: '/emails', method: 'POST' })
        .reply(403, { statusCode: 403, name: 'validation_error', message: 'The sonare.vip domain is not verified' });

      const err = await sendMail(mail).catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe('Resend answered 403: The sonare.vip domain is not verified');
      expect((err as Error).message).not.toContain('re_test_key');
    });
  });

  it('BE-MAIL-005: without a Resend key, mail goes to SMTP (Mailpit in development)', () => {
    expect(config.RESEND_API_KEY).toBeFalsy();
    expect(mailTransportName()).toBe(`SMTP ${config.SMTP_HOST}:${config.SMTP_PORT}`);
  });
});
