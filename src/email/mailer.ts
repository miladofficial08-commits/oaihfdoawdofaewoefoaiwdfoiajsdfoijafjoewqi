import nodemailer from 'nodemailer';
import { recordOutreachEvent, updateLeadStatus } from '../db/leads-repo';
import { getSmtpConfig as getSharedSmtpConfig } from './smtp';

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
  port?: number;
  from?: string;
  error?: string;
  attempts?: Array<{ host: string; port: number; secure: boolean; ok: boolean; error?: string }>;
}

export interface SendResult {
  success: boolean;
  messageId?: string;
  to?: string;
  error?: string;
}

type SmtpConfig = NonNullable<ReturnType<typeof getSharedSmtpConfig>>;

let workingConfigCache: { cfg: SmtpConfig; until: number } | null = null;

function smtpCandidates(cfg: SmtpConfig): SmtpConfig[] {
  const seen = new Set<string>();
  const add = (candidate: SmtpConfig, list: SmtpConfig[]) => {
    const key = `${candidate.host}:${candidate.port}:${candidate.secure}:${candidate.requireTLS}`;
    if (!seen.has(key)) {
      seen.add(key);
      list.push(candidate);
    }
  };
  const list: SmtpConfig[] = [];
  add(cfg, list);

  const hosts = new Set([cfg.host]);
  if (/^smtps\./i.test(cfg.host)) hosts.add(cfg.host.replace(/^smtps\./i, 'smtp.'));
  if (/^imap\./i.test(cfg.host)) hosts.add(cfg.host.replace(/^imap\./i, 'smtp.'));
  for (const host of hosts) {
    add({ ...cfg, host, port: 587, secure: false, requireTLS: true }, list);
    add({ ...cfg, host, port: 465, secure: true, requireTLS: false }, list);
  }
  return list;
}

function createTransportFor(cfg: SmtpConfig) {
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    requireTLS: cfg.requireTLS,
    auth: { user: cfg.user, pass: cfg.pass },
    connectionTimeout: 8000,
    greetingTimeout: 8000,
    socketTimeout: 12000,
    tls: { rejectUnauthorized: false },
  });
}

async function resolveWorkingConfig(baseCfg: SmtpConfig): Promise<{ cfg: SmtpConfig; attempts: SmtpStatus['attempts'] }> {
  if (workingConfigCache && workingConfigCache.until > Date.now()) {
    return { cfg: workingConfigCache.cfg, attempts: [{ host: workingConfigCache.cfg.host, port: workingConfigCache.cfg.port, secure: workingConfigCache.cfg.secure, ok: true }] };
  }
  const attempts: SmtpStatus['attempts'] = [];
  let lastError = 'SMTP Verbindung fehlgeschlagen';
  for (const cfg of smtpCandidates(baseCfg)) {
    const transport = createTransportFor(cfg);
    try {
      await transport.verify();
      workingConfigCache = { cfg, until: Date.now() + 10 * 60 * 1000 };
      attempts.push({ host: cfg.host, port: cfg.port, secure: cfg.secure, ok: true });
      return { cfg, attempts };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      attempts.push({ host: cfg.host, port: cfg.port, secure: cfg.secure, ok: false, error: lastError });
    } finally {
      transport.close();
    }
  }
  const error = new Error(lastError);
  (error as any).attempts = attempts;
  throw error;
}

async function createTransport() {
  const cfg = getSharedSmtpConfig();
  if (!cfg) {
    throw new Error('SMTP nicht konfiguriert. SMTP_HOST/USER/PASS oder IMAP_HOST/USER/PASS in .env setzen.');
  }
  const resolved = await resolveWorkingConfig(cfg);
  return { transport: createTransportFor(resolved.cfg), cfg: resolved.cfg };
}

export async function getSmtpStatus(): Promise<SmtpStatus> {
  const cfg = getSharedSmtpConfig();
  if (!cfg) {
    return { ok: false, configured: false, error: 'SMTP_HOST/USER/PASS oder IMAP_HOST/USER/PASS fehlen in .env' };
  }
  try {
    const resolved = await resolveWorkingConfig(cfg);
    return { ok: true, configured: true, host: resolved.cfg.host, port: resolved.cfg.port, from: resolved.cfg.from, attempts: resolved.attempts };
  } catch (err) {
    const attempts = (err as any)?.attempts as SmtpStatus['attempts'] | undefined;
    return {
      ok: false,
      configured: true,
      host: cfg.host,
      port: cfg.port,
      from: cfg.from,
      error: err instanceof Error ? err.message : String(err),
      attempts,
    };
  }
}

export async function sendLeadEmail(payload: EmailPayload): Promise<SendResult> {
  try {
    const { transport, cfg } = await createTransport();
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
  try {
    const { transport, cfg } = await createTransport();
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
