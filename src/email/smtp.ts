import nodemailer from 'nodemailer';
import { Lead } from '../types';

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  requireTLS: boolean;
  user: string;
  pass: string;
  from: string;
}

function deriveSmtpHostFromImap(host: string | undefined): string | undefined {
  const clean = host?.trim();
  if (!clean) return undefined;
  if (/^imap\./i.test(clean)) return clean.replace(/^imap\./i, 'smtps.');
  if (/^mail\./i.test(clean)) return clean.replace(/^mail\./i, 'smtps.');
  return clean;
}

export function getSmtpConfig(env: NodeJS.ProcessEnv = process.env): SmtpConfig | undefined {
  const host = env.SMTP_HOST || deriveSmtpHostFromImap(env.IMAP_HOST);
  const user = env.SMTP_USER || env.IMAP_USER;
  const pass = env.SMTP_PASS || env.IMAP_PASS;
  const from = env.SMTP_FROM || user;
  if (!host || !user || !pass || !from) return undefined;
  return {
    host,
    port: Number(env.SMTP_PORT ?? 587),
    secure: env.SMTP_SECURE === 'true',
    requireTLS: env.SMTP_REQUIRE_TLS !== 'false',
    user,
    pass,
    from,
  };
}

export function getEmailStatus(env: NodeJS.ProcessEnv = process.env) {
  const cfg = getSmtpConfig(env);
  return {
    configured: Boolean(cfg),
    host: cfg?.host,
    port: cfg?.port,
    from: cfg?.from,
  };
}

export function assertLeadCanBeEmailed(lead: Lead) {
  if (lead.status === 'archived' || lead.status === 'do_not_contact') throw new Error('Archivierte oder DNC-Leads duerfen nicht versendet werden.');
  if (lead.status !== 'approved') throw new Error('Lead muss vor echtem E-Mail-Versand freigegeben sein.');
  if (lead.approved_kanal !== 'email') throw new Error('Lead ist nicht fuer E-Mail freigegeben.');
  if (!lead.email) throw new Error('Keine echte E-Mail-Adresse fuer diesen Lead gespeichert.');
  if (!lead.approved_nachricht) throw new Error('Keine freigegebene Nachricht vorhanden.');
}

export async function sendApprovedLeadEmail(lead: Lead, subject?: string) {
  assertLeadCanBeEmailed(lead);
  const cfg = getSmtpConfig();
  if (!cfg) throw new Error('SMTP ist nicht konfiguriert.');

  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    requireTLS: cfg.requireTLS,
    auth: { user: cfg.user, pass: cfg.pass },
  });

  return transporter.sendMail({
    from: cfg.from,
    to: lead.email,
    subject: subject?.trim() || `Kurze Idee fuer ${lead.name}`,
    text: lead.approved_nachricht,
  });
}
