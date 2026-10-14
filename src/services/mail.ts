import { request } from 'undici';
import { config } from '../config.js';
import { MailError } from '../errors.js';

// Account email goes out through Resend's HTTP API, in development too, so a mail the app
// calls sent really reaches the inbox. Without RESEND_API_KEY nothing can be sent, and the
// routes that send on request answer MAIL_UNAVAILABLE instead of pretending.

export const RESEND_API_URL = 'https://api.resend.com/emails';

export interface MailMessage {
  subject: string;
  text: string;
  html: string;
}

type Mail = MailMessage & { to: string };

/** Mail can only go out once RESEND_API_KEY is set. */
export const mailConfigured = (): boolean => Boolean(config.RESEND_API_KEY);

const sendWithResend = async (apiKey: string, mail: Mail): Promise<void> => {
  const { statusCode, body } = await request(RESEND_API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: config.MAIL_FROM,
      to: [mail.to],
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    }),
    headersTimeout: 10_000,
    bodyTimeout: 10_000,
  });
  const text = await body.text();
  if (statusCode >= 200 && statusCode < 300) return;
  let detail = text.slice(0, 200);
  try {
    detail = (JSON.parse(text) as { message?: string }).message ?? detail;
  } catch {
    // Not JSON: keep the start of the body.
  }
  throw new Error(`Resend answered ${statusCode}: ${detail}`);
};

/** Throws MailError: MAIL_UNAVAILABLE without a key, MAIL_FAILED (Resend's answer as the cause) otherwise. */
export const sendMail = async (mail: Mail): Promise<void> => {
  if (!config.RESEND_API_KEY) throw new MailError('MAIL_UNAVAILABLE');
  try {
    await sendWithResend(config.RESEND_API_KEY, mail);
  } catch (err) {
    throw new MailError('MAIL_FAILED', { cause: err });
  }
};

/** The link opens the web app; the code is for typing into whichever app is open (it lasts 30 minutes). */
export const verifyEmailMessage = (link: string, code: string): MailMessage => {
  const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
  return {
    subject: 'Verify your Sonare email address',
    text: `Welcome to Sonare!\n\nYour verification code is ${spaced}. Enter it in the app; it expires in 30 minutes.\n\nOr verify by opening this link (it expires in 24 hours):\n${link}\n\nIf you did not create an account, ignore this email.`,
    html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto">
  <h2 style="color:#111">Verify your email</h2>
  <p>Welcome to Sonare! Enter this code in the app to verify your email address. It expires in <strong>30 minutes</strong>.</p>
  <p style="margin:24px 0;font-size:32px;font-weight:700;letter-spacing:6px;color:#111;font-family:monospace">${spaced}</p>
  <p>Or click the button below. The link expires in <strong>24 hours</strong>.</p>
  <p style="margin:24px 0">
    <a href="${link}" style="background:#6366f1;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block">Verify email</a>
  </p>
  <p style="color:#666;font-size:13px">Or copy this link: <a href="${link}" style="color:#6366f1">${link}</a></p>
  <p style="color:#999;font-size:12px">If you did not create a Sonare account, you can ignore this email.</p>
</div>`,
  };
};

export const resetPasswordMessage = (link: string): MailMessage => {
  return {
    subject: 'Reset your Sonare password',
    text: `You requested a password reset for your Sonare account.\n\nClick the link below to set a new password. It expires in 1 hour.\n\n${link}\n\nIf you did not request this, ignore this email. Your password will not change.`,
    html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto">
  <h2 style="color:#111">Reset your password</h2>
  <p>You requested a password reset for your Sonare account. Click the button below to set a new password. The link expires in <strong>1 hour</strong>.</p>
  <p style="margin:24px 0">
    <a href="${link}" style="background:#6366f1;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block">Reset password</a>
  </p>
  <p style="color:#666;font-size:13px">Or copy this link: <a href="${link}" style="color:#6366f1">${link}</a></p>
  <p style="color:#999;font-size:12px">If you did not request a password reset, ignore this email. Your password will not change.</p>
</div>`,
  };
};
