import nodemailer from 'nodemailer';
import { config } from '../config.js';

const transport = nodemailer.createTransport({
  host: config.SMTP_HOST,
  port: config.SMTP_PORT,
  secure: config.SMTP_SECURE,
  auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASS } : undefined,
});

export interface MailMessage {
  subject: string;
  text: string;
  html: string;
}

export async function sendMail(opts: { to: string; subject: string; text: string; html: string }): Promise<void> {
  await transport.sendMail({ from: config.MAIL_FROM, ...opts });
}

export function verifyEmailMessage(link: string): MailMessage {
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
}

export function resetPasswordMessage(link: string): MailMessage {
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
}
