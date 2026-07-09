import nodemailer from 'nodemailer';
import { recordOutreachEvent, updateLeadStatus } from '../db/leads-repo';
import { getSmtpConfig as getSharedSmtpConfig } from './smtp';

export interface EmailPayload {
  leadId: string;
  to: string;
  toName?: string;
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

export interface BrevoStatus {
  ok: boolean;
  configured: boolean;
  error?: string;
  apiKeySet?: boolean;
}

export interface BrevoEmailInput {
  to: string;
  toName?: string;
  subject: string;
  body: string;
  trackingId?: string;
}

export interface BrevoEmailPayload {
  sender: { name: string; email: string };
  to: Array<{ email: string; name?: string }>;
  subject: string;
  htmlContent: string;
  textContent: string;
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

export function getBrevoStatus(env: NodeJS.ProcessEnv = process.env): BrevoStatus {
  const apiKeySet = Boolean(env.BREVO_API_KEY?.trim());
  if (!apiKeySet) return { ok: false, configured: false, error: 'BREVO_API_KEY fehlt' };
  return { ok: true, configured: true, apiKeySet: true };
}

export function buildBrevoEmailPayload(input: BrevoEmailInput, env: NodeJS.ProcessEnv = process.env): BrevoEmailPayload {
  return {
    sender: { name: 'Tawano', email: 'info@tawano.de' },
    to: [{ email: input.to, ...(input.toName ? { name: input.toName } : {}) }],
    subject: input.subject,
    htmlContent: buildHtml(input.body, input.trackingId, env),
    textContent: input.body,
  };
}

function classifyBrevoApiError(status: number, body: string): string {
  const trimmed = body.trim();
  if (status === 401 || status === 403) return `Brevo API Auth fehlgeschlagen (${status}). BREVO_API_KEY pruefen.`;
  if (status === 400 && /sender|from|verified|unauthorized/i.test(trimmed)) return `Brevo API lehnt den Absender ab. info@tawano.de pruefen. [${trimmed.slice(0, 200)}]`;
  if (status === 429 || /quota|limit|rate/i.test(trimmed)) return `Brevo API Rate-Limit/Kontingent erreicht. [${trimmed.slice(0, 200)}]`;
  return `Brevo API Fehler (${status}). [${trimmed.slice(0, 200)}]`;
}

async function sendViaBrevoApi(payload: BrevoEmailInput): Promise<SendResult> {
  const apiKey = process.env.BREVO_API_KEY?.trim();
  if (!apiKey) return { success: false, error: 'BREVO_API_KEY fehlt', to: payload.to };

  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildBrevoEmailPayload(payload)),
    });
    const body = await res.text();
    if (!res.ok) return { success: false, error: classifyBrevoApiError(res.status, body), to: payload.to };
    const data = body ? JSON.parse(body) as { messageId?: string } : {};
    return { success: true, messageId: data.messageId, to: payload.to };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Brevo API Versand fehlgeschlagen. [${error}]`, to: payload.to };
  }
}

export async function getSmtpStatus(): Promise<SmtpStatus> {
  if (process.env.BREVO_API_KEY?.trim()) {
    return { ok: true, configured: true, host: 'api.brevo.com', port: 443, from: 'Tawano <info@tawano.de>' };
  }
  const cfg = getSharedSmtpConfig();
  if (!cfg) {
    return { ok: false, configured: false, error: 'BREVO_API_KEY fehlt' };
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
      error: classifySmtpError(err),
      attempts,
    };
  }
}

export async function sendLeadEmail(payload: EmailPayload): Promise<SendResult> {
  try {
    let result: SendResult;
    let server = 'Brevo API';
    if (process.env.BREVO_API_KEY?.trim()) {
      result = await sendViaBrevoApi(payload);
    } else {
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
      server = cfg.host;
      result = { success: true, messageId: info.messageId, to: payload.to };
    }

    if (!result.success) throw new Error(result.error || 'E-Mail-Versand fehlgeschlagen');

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
      note: `E-Mail versendet an ${payload.to} | Betreff: "${payload.subject}" | Server: ${server} | MessageID: ${result.messageId}`,
    });

    return result;
  } catch (err) {
    const error = process.env.BREVO_API_KEY?.trim() ? (err instanceof Error ? err.message : String(err)) : classifySmtpError(err);
    console.error(`[email] Versand an ${payload.to} fehlgeschlagen: ${error}`);
    recordOutreachEvent({
      lead_id: payload.leadId,
      event_type: 'status_changed',
      channel: 'email',
      note: `E-Mail-Versand FEHLGESCHLAGEN an ${payload.to}: ${error}`,
    });
    return { success: false, error, to: payload.to };
  }
}

export async function sendBulkEmail(payload: { to: string; toName?: string; subject: string; body: string; trackingId?: string }): Promise<SendResult> {
  try {
    if (process.env.BREVO_API_KEY?.trim()) return await sendViaBrevoApi(payload);

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
    const error = classifySmtpError(err);
    console.error(`[smtp] Bulk-Versand an ${payload.to} fehlgeschlagen: ${error}`);
    return { success: false, error, to: payload.to };
  }
}

/** Basis-URL unter der der Server aus dem Internet erreichbar ist — nötig für Öffnungs-/Klick-Tracking. */
export function getTrackingBaseUrl(): string {
  const base = getTrackingBaseUrlFromEnv(process.env);
  return base;
}

function getTrackingBaseUrlFromEnv(env: NodeJS.ProcessEnv): string {
  const base = (env.PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');
  return base;
}

function buildHtml(body: string, trackingId?: string, env: NodeJS.ProcessEnv = process.env): string {
  const base = getTrackingBaseUrlFromEnv(env);
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

/** Uebersetzt technische SMTP-Fehler in klare, handlungsleitende Meldungen (Brevo-spezifisch). */
export function classifySmtpError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const code = String((err as any)?.code ?? (err as any)?.responseCode ?? '');
  const low = raw.toLowerCase();
  if (low.includes('nicht konfiguriert') || (low.includes('smtp') && low.includes('fehlen'))) return raw;
  if (code === 'ETIMEDOUT' || low.includes('timeout') || low.includes('timed out')) {
    return `Verbindungs-Timeout zum SMTP-Server. Host/Port pruefen (Brevo: smtp-relay.brevo.com:587). [${raw}]`;
  }
  if (code === 'ECONNREFUSED' || low.includes('econnrefused')) {
    return `SMTP-Server verweigert die Verbindung. Host/Port pruefen. [${raw}]`;
  }
  if (low.includes('unauthorized ip') || low.includes('525') || low.includes('5.7.1') && low.includes('ip')) {
    return `Brevo blockiert die Server-IP ("Unauthorized IP address"). Loesung: In Brevo unter "SMTP & API" → "Authorized IPs" die IP-Beschraenkung deaktivieren (oder die Railway-Server-IP freigeben). Railway-IPs sind dynamisch – deaktivieren ist am sichersten. [${raw}]`;
  }
  if (code === 'EAUTH' || code === '535' || low.includes('authentication') || low.includes('invalid login') || low.includes('535')) {
    return `Authentifizierung fehlgeschlagen. Bei Brevo: SMTP_USER = Login (…@smtp-brevo.com), SMTP_PASS = SMTP-Key (nicht API-Key, nicht Konto-Passwort). [${raw}]`;
  }
  if (low.includes('not verified') || low.includes('unauthorized sender') || (low.includes('sender') && low.includes('verif'))) {
    return `Absender nicht verifiziert. info@tawano.de in Brevo unter "Senders & IP" bestaetigen. [${raw}]`;
  }
  if (code === '550' || code === '554' || low.includes('rate limit') || low.includes('quota') || low.includes('too many')) {
    return `Rate-Limit/Kontingent erreicht oder Nachricht abgelehnt. [${raw}]`;
  }
  return raw;
}

/** Sendet eine echte Test-Mail ueber den aktiven SMTP-Server (Verbindung + Auth + Versand live pruefen). */
export async function sendTestEmail(to?: string): Promise<SendResult & { host?: string; port?: number }> {
  const cfg0 = getSharedSmtpConfig();
  if (!cfg0) return { success: false, error: 'SMTP nicht konfiguriert (SMTP_HOST/USER/PASS fehlen in den Variablen).' };
  const target = (to && to.trim()) || cfg0.user;
  try {
    const { transport, cfg } = await createTransport();
    const info = await transport.sendMail({
      from: cfg.from,
      to: target,
      subject: 'Tawano SMTP-Test ✓',
      text: `SMTP-Test erfolgreich.\n\nServer: ${cfg.host}:${cfg.port}\nAbsender: ${cfg.from}\nZeit: ${new Date().toLocaleString('de-DE')}`,
    });
    console.log(`[smtp] Test-Mail gesendet ueber ${cfg.host}:${cfg.port} an ${target} (id ${info.messageId})`);
    return { success: true, messageId: info.messageId, to: target, host: cfg.host, port: cfg.port };
  } catch (err) {
    const error = classifySmtpError(err);
    console.error(`[smtp] Test fehlgeschlagen: ${error}`);
    return { success: false, error, to: target };
  }
}

/** Sendet eine echte Test-Mail ueber die Brevo Transactional Email API. */
export async function sendBrevoTestEmail(to?: string): Promise<SendResult & { apiKeySet: boolean; provider: string }> {
  const apiKeySet = Boolean(process.env.BREVO_API_KEY?.trim());
  if (!apiKeySet) {
    console.error('[brevo] Test fehlgeschlagen: BREVO_API_KEY fehlt (BREVO_API_KEY_SET=false)');
    return { success: false, error: 'BREVO_API_KEY fehlt', apiKeySet: false, provider: 'brevo-api' };
  }
  const target = (to && to.trim()) || 'info@tawano.de';
  const result = await sendViaBrevoApi({
    to: target,
    subject: 'Tawano Brevo API-Test',
    body: `Brevo API-Test erfolgreich.\n\nProvider: Brevo Transactional Email API\nZeit: ${new Date().toLocaleString('de-DE')}`,
  });
  if (result.success) {
    console.log(`[brevo] Test-Mail gesendet an ${target} (BREVO_API_KEY_SET=true, id ${result.messageId || 'n/a'})`);
  } else {
    console.error(`[brevo] Test fehlgeschlagen: ${result.error} (BREVO_API_KEY_SET=true)`);
  }
  return { ...result, apiKeySet: true, provider: 'brevo-api' };
}
