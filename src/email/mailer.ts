import nodemailer from 'nodemailer';
import { recordOutreachEvent, updateLeadStatus } from '../db/leads-repo';

export interface EmailPayload {
  leadId: string;
  to: string;
  subject: string;
  body: string;
  /** ID des sent_emails-Eintrags — aktiviert Öffnungs-Pixel + Klick-Tracking in der HTML-Version */
  trackingId?: string;
}

export interface SmtpStatus {
  ok: boolean;
  configured: boolean;
  host?: string;
  from?: string;
  error?: string;
}

export interface SendResult {
  success: boolean;
  messageId?: string;
  to?: string;
  error?: string;
}

function getSmtpConfig() {
  return {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === 'true',
    requireTLS: process.env.SMTP_REQUIRE_TLS !== 'false',
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.SMTP_FROM ?? process.env.SMTP_USER,
  };
}

function createTransport() {
  const cfg = getSmtpConfig();
  if (!cfg.host || !cfg.user || !cfg.pass) {
    throw new Error('SMTP nicht konfiguriert. SMTP_HOST, SMTP_USER und SMTP_PASS in .env setzen.');
  }
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    requireTLS: cfg.requireTLS,
    auth: { user: cfg.user, pass: cfg.pass },
    tls: { rejectUnauthorized: false },
  });
}

export async function getSmtpStatus(): Promise<SmtpStatus> {
  const cfg = getSmtpConfig();
  if (!cfg.host || !cfg.user || !cfg.pass) {
    return { ok: false, configured: false, error: 'SMTP_HOST, SMTP_USER oder SMTP_PASS fehlen in .env' };
  }
  try {
    const transport = createTransport();
    await transport.verify();
    return { ok: true, configured: true, host: cfg.host, from: cfg.from };
  } catch (err) {
    return {
      ok: false,
      configured: true,
      host: cfg.host,
      from: cfg.from,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function sendLeadEmail(payload: EmailPayload): Promise<SendResult> {
  const cfg = getSmtpConfig();
  const transport = createTransport();

  try {
    const htmlBody = buildHtml(payload.body, payload.trackingId);

    const info = await transport.sendMail({
      from: cfg.from,
      to: payload.to,
      bcc: cfg.user,
      subject: payload.subject,
      text: payload.body,
      html: htmlBody,
    });

    // Mark lead as contacted + log actual send event
    updateLeadStatus(payload.leadId, 'contacted', {
      approved_kanal: 'email',
      approved_nachricht: payload.body,
      gesendet_at: new Date().toISOString(),
    });
    recordOutreachEvent({
      lead_id: payload.leadId,
      event_type: 'manual_contact',
      channel: 'email',
      message: payload.body,
      status: 'contacted',
      user: 'dashboard',
      note: `E-Mail versendet an ${payload.to} | Betreff: "${payload.subject}" | Server: ${cfg.host} | MessageID: ${info.messageId}`,
    });

    return { success: true, messageId: info.messageId, to: payload.to };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    recordOutreachEvent({
      lead_id: payload.leadId,
      event_type: 'status_changed',
      channel: 'email',
      note: `E-Mail-Versand FEHLGESCHLAGEN an ${payload.to}: ${error}`,
    });
    return { success: false, error, to: payload.to };
  }
}

export async function sendBulkEmail(payload: { to: string; subject: string; body: string; trackingId?: string }): Promise<SendResult> {
  const transport = createTransport();
  const cfg = getSmtpConfig();
  try {
    const htmlBody = buildHtml(payload.body, payload.trackingId);
    const info = await transport.sendMail({
      from: cfg.from,
      to: payload.to,
      bcc: cfg.user,
      subject: payload.subject,
      text: payload.body,
      html: htmlBody,
    });
    return { success: true, messageId: info.messageId, to: payload.to };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err), to: payload.to };
  }
}

/** Basis-URL unter der der Server aus dem Internet erreichbar ist — nötig für Öffnungs-/Klick-Tracking. */
export function getTrackingBaseUrl(): string {
  const base = (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');
  return base;
}

function buildHtml(body: string, trackingId?: string): string {
  const base = getTrackingBaseUrl();
  const track = Boolean(trackingId && base);

  const lines = body.split('\n').map(l => {
    if (l.trim() === '') return '<br>';
    let html = escHtml(l);
    // URLs klickbar machen; mit Tracking-ID über unseren Klick-Redirect leiten.
    // Erkennt auch www.-Links ohne Protokoll (kommen in Vorlagen häufig vor).
    html = html.replace(/(https?:\/\/[^\s<>"]+|www\.[^\s<>"]+)/g, (url) => {
      const full = url.startsWith('http') ? url : 'https://' + url;
      const href = track ? `${base}/track/click/${trackingId}?u=${encodeURIComponent(full)}` : full;
      return `<a href="${href}" style="color:#1a73e8">${url}</a>`;
    });
    return `<p style="margin:0 0 10px">${html}</p>`;
  }).join('');

  const pixel = track
    ? `<img src="${base}/track/open/${trackingId}.gif" width="1" height="1" alt="" style="display:block;border:0;width:1px;height:1px">`
    : '';

  return `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;max-width:600px;color:#1a1a1a">
${lines}
${pixel}
</div>`;
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
