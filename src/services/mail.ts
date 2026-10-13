import nodemailer, { type Transporter } from 'nodemailer';
import { request } from 'undici';
import { config } from '../config.js';

// Account email. With RESEND_API_KEY set it goes out through Resend's HTTP API (production:
// Render's free plan blocks outbound SMTP ports); otherwise through SMTP, which is Mailpit in
// development (its inbox: http://localhost:8025).

export const RESEND_API_URL = 'https://api.resend.com/emails';

export interface MailMessage {
  subject: string;
  text: string;
  html: string;
}

type Mail = MailMessage & { to: string };

let smtp: Transporter | undefined;

/** Made on first use, so a server that sends through Resend never opens an SMTP transport. */
const smtpTransport = (): Transporter => {
  smtp ??= nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASS } : undefined,
  });
  return smtp;
};

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

/** How mail leaves this server, for the startup log. */
export const mailTransportName = (): string => {
  if (config.RESEND_API_KEY) return 'Resend API';
  const mailpit =
    config.NODE_ENV === 'development' &&
    ['127.0.0.1', 'localhost'].includes(config.SMTP_HOST) &&
    config.SMTP_PORT === 1025;
  return `SMTP ${config.SMTP_HOST}:${config.SMTP_PORT}${mailpit ? ' (Mailpit inbox: http://localhost:8025)' : ''}`;
};

export const sendMail = async (mail: Mail): Promise<void> => {
  if (config.RESEND_API_KEY) return sendWithResend(config.RESEND_API_KEY, mail);
  await smtpTransport().sendMail({ from: config.MAIL_FROM, ...mail });
};

export const verifyEmailMessage = (link: string): MailMessage => {
  return {
    subject: 'Verify your Sonare email address',
    text: `Welcome to Sonare!\n\nVerify your email by clicking the link below. It expires in 24 hours.\n\n${link}\n\nIf you did not create an account, ignore this email.`,
    html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto">
  <h2 style="color:#111">Verify your email</h2>
  <p>Welcome to Sonare! Click the button below to verify your email address. The link expires in <strong>24 hours</strong>.</p>
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
