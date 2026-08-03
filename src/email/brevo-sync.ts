import { createHmac } from 'crypto';
import { getDb } from '../db/schema';
import { updateLeadStatus } from '../db/leads-repo';
import { v4 as uuid } from 'uuid';

/**
 * Brevo als EINZIGE Quelle der Wahrheit für den Zustellstatus.
 *
 * Bisher wurde "zugestellt" nur geschätzt (success=1 minus per IMAP gescannte Bounces).
 * Dieses Modul ersetzt die Schätzung durch echte Brevo-Events:
 *   - Webhook  (/webhook/brevo)  → Echtzeit-Status pro Mail (delivered/bounce/open/click/unsub)
 *   - Aggregat (API)             → Gesamtzahlen als Kreuzprobe fürs Dashboard
 *
 * Statuslogik auf sent_emails.delivery_status:
 *   sent        an Brevo übergeben, noch kein Event
 *   delivered   Brevo bestätigt Zustellung  → Lead gilt sicher als kontaktiert
 *   bounced     Hard-Bounce/ungültig (dauerhaft) → Adresse gesperrt, Lead → manual_review
 *   soft_failed Soft-Bounce/deferred/blocked/error (vorübergehend) → success=0 ⇒ Lead wieder kontaktierbar
 *   spam        Spam-Beschwerde → Adresse gesperrt
 */

const BREVO_API = 'https://api.brevo.com/v3';

// ── Webhook-Signatur (Schutz gegen gefälschte Events, die Leads sperren könnten) ──
export function webhookSecret(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = (env.BREVO_WEBHOOK_SECRET || '').trim();
  if (explicit) return explicit;
  // Stabiler Fallback aus dem API-Key abgeleitet (nie der Key selbst).
  const key = (env.BREVO_API_KEY || 'tawano').trim();
  return createHmac('sha256', key).update('brevo-webhook-v1').digest('hex').slice(0, 32);
}

export function verifyWebhookSecret(token: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  return typeof token === 'string' && token.length > 0 && token === webhookSecret(env);
}

// ── Normalisierung ──────────────────────────────────────────────────────────
function normEmail(e?: string | null): string {
  return String(e || '').trim().toLowerCase();
}
function normMsgId(id?: string | null): string {
  return String(id || '').trim().replace(/^<|>$/g, '').toLowerCase();
}

// ── Brevo-Event-Form (Webhook + API sind leicht unterschiedlich benannt) ──────
export interface BrevoEvent {
  event?: string;
  email?: string;
  'message-id'?: string;
  messageId?: string;
  date?: string;
  ts?: number;
  reason?: string;
  link?: string;
  subject?: string;
  tag?: string;
}

type Canonical =
  | 'delivered' | 'bounced' | 'soft_failed' | 'spam'
  | 'opened' | 'clicked' | 'unsubscribed' | 'ignore';

/** Übersetzt die vielen Brevo-Event-Namen (Webhook & API) in unsere Handvoll Fälle. */
function canonicalize(raw?: string): Canonical {
  const e = String(raw || '').toLowerCase().replace(/[\s-]+/g, '_');
  switch (e) {
    case 'delivered':                         return 'delivered';
    case 'hard_bounce': case 'invalid_email': return 'bounced';
    case 'soft_bounce': case 'deferred':
    case 'blocked':     case 'error':         return 'soft_failed';
    case 'spam': case 'complaint':            return 'spam';
    case 'opened': case 'unique_opened':
    case 'proxy_open':                        return 'opened';
    case 'click': case 'clicks':              return 'clicked';
    case 'unsubscribed': case 'unsubscribe':
    case 'list_addition':                     return 'unsubscribed';
    default:                                  return 'ignore';
  }
}

function nowIso(): string { return new Date().toISOString(); }

function suppress(email: string, reason: string, source: string): void {
  const em = normEmail(email);
  if (!em) return;
  getDb().prepare(
    `INSERT INTO email_suppression (email_normalized, reason, source)
     VALUES (?, ?, ?) ON CONFLICT(email_normalized) DO UPDATE SET reason = excluded.reason, source = excluded.source`
  ).run(em, reason, source);
}

interface SentRow { id: string; lead_id: string | null; to_email: string; delivery_status: string; }

/** Findet die zugehörige sent_emails-Zeile: erst per Brevo-Message-ID, sonst neueste Mail an die Adresse. */
function findSentRow(ev: BrevoEvent): SentRow | undefined {
  const db = getDb();
  const mid = normMsgId(ev['message-id'] || ev.messageId);
  if (mid) {
    const row = db.prepare(
      `SELECT id, lead_id, to_email, delivery_status FROM sent_emails
       WHERE REPLACE(REPLACE(LOWER(TRIM(message_id)),'<',''),'>','') = ? LIMIT 1`
    ).get(mid) as SentRow | undefined;
    if (row) return row;
  }
  const email = normEmail(ev.email);
  if (email) {
    return db.prepare(
      `SELECT id, lead_id, to_email, delivery_status FROM sent_emails
       WHERE LOWER(TRIM(to_email)) = ? ORDER BY sent_at DESC LIMIT 1`
    ).get(email) as SentRow | undefined;
  }
  return undefined;
}

function setRow(id: string, fields: Record<string, unknown>): void {
  const sets = Object.keys(fields).map(k => `${k} = @${k}`).join(', ');
  getDb().prepare(`UPDATE sent_emails SET ${sets} WHERE id = @id`).run({ ...fields, id });
}

/** Spiegelt ein Brevo-Event zusätzlich ins email_events-Log, damit die bestehende Analytics-Ansicht es sieht. */
function logEvent(sentId: string, type: string, url?: string | null): void {
  getDb().prepare(
    `INSERT INTO email_events (id, sent_email_id, event_type, url, user_agent, ip)
     VALUES (?, ?, ?, ?, 'brevo:verified', NULL)`
  ).run(uuid(), sentId, type, url ?? null);
}

export interface ApplyResult { matched: boolean; canonical: Canonical; sentId?: string; }

/** Verarbeitet EIN Brevo-Event idempotent und zieht die Konsequenzen (Status, Sperrliste, Lead-Rückführung). */
export function applyBrevoEvent(ev: BrevoEvent): ApplyResult {
  const canonical = canonicalize(ev.event);
  if (canonical === 'ignore') return { matched: false, canonical };

  const row = findSentRow(ev);

  // Sicherheitsnetz: Sperr-relevante Events auch ohne Treffer per Adresse eintragen.
  if (!row) {
    if (canonical === 'bounced')      suppress(ev.email || '', `Hard-Bounce: ${ev.reason || ''}`.trim(), 'brevo');
    if (canonical === 'spam')         suppress(ev.email || '', 'Spam-Beschwerde', 'brevo');
    if (canonical === 'unsubscribed') suppress(ev.email || '', 'Abgemeldet', 'brevo');
    return { matched: false, canonical };
  }

  const at = nowIso();
  switch (canonical) {
    case 'delivered':
      // 'bounced' nie überschreiben (ein späteres delivered wäre widersprüchlich).
      if (row.delivery_status !== 'bounced') {
        setRow(row.id, { delivery_status: 'delivered', delivered_at: at, brevo_event_at: at, success: 1 });
      }
      break;

    case 'bounced':
      setRow(row.id, {
        delivery_status: 'bounced', bounced_at: at, brevo_event_at: at,
        bounce_reason: (ev.reason || 'Hard-Bounce').slice(0, 300),
      });
      suppress(row.to_email, `Hard-Bounce: ${ev.reason || ''}`.trim(), 'brevo');
      logEvent(row.id, 'bounce', ev.reason || null);
      if (row.lead_id) {
        updateLeadStatus(row.lead_id, 'manual_review', {
          notiz: `E-Mail an ${row.to_email} gebounced (dauerhaft ungültig) – anderer Kanal nötig.`,
        });
      }
      break;

    case 'soft_failed':
      // Vorübergehender Fehler: success=0 ⇒ die bestehenden „bereits kontaktiert"-Filter
      // (alle prüfen success=1) geben den Lead automatisch für einen erneuten Versuch frei.
      setRow(row.id, {
        delivery_status: 'soft_failed', success: 0, brevo_event_at: at,
        bounce_reason: (ev.reason || ev.event || 'Soft-Fehler').slice(0, 300),
      });
      break;

    case 'spam':
      setRow(row.id, { delivery_status: 'spam', brevo_event_at: at });
      suppress(row.to_email, 'Spam-Beschwerde', 'brevo');
      break;

    case 'opened':
      setRow(row.id, { brevo_opened_at: at, brevo_event_at: at });
      logEvent(row.id, 'open');
      break;

    case 'clicked':
      setRow(row.id, { brevo_clicked_at: at, brevo_event_at: at });
      logEvent(row.id, 'click', ev.link || null);
      break;

    case 'unsubscribed':
      setRow(row.id, { unsubscribed_at: at, brevo_event_at: at });
      suppress(row.to_email, 'Abgemeldet', 'brevo');
      logEvent(row.id, 'unsubscribe');
      if (row.lead_id) {
        getDb().prepare(
          `UPDATE leads SET followup_stopped = 1, followup_stopped_reason = 'Abgemeldet (Brevo)', updated_at = datetime('now') WHERE id = ?`
        ).run(row.lead_id);
      }
      break;
  }

  return { matched: true, canonical, sentId: row.id };
}

/** Verarbeitet einen Webhook-Body (Brevo sendet mal ein einzelnes Event, mal ein Array). */
export function applyBrevoWebhookBody(body: unknown): { processed: number; matched: number } {
  const events: BrevoEvent[] = Array.isArray(body)
    ? body as BrevoEvent[]
    : (body && typeof body === 'object' && Array.isArray((body as { events?: unknown }).events))
      ? (body as { events: BrevoEvent[] }).events
      : [body as BrevoEvent];
  let matched = 0;
  for (const ev of events) {
    try { if (applyBrevoEvent(ev).matched) matched++; } catch { /* einzelnes Event darf den Rest nicht killen */ }
  }
  return { processed: events.length, matched };
}

// ── Verifizierte Zahlen fürs Dashboard ───────────────────────────────────────
export interface VerifiedCounts {
  delivered: number;
  bounced: number;
  soft_failed: number;
  opened_verified: number;
  suppressed: number;
  awaiting: number; // versendet, aber noch kein Brevo-Event
}

export function verifiedSendCounts(): VerifiedCounts {
  const db = getDb();
  const one = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return {
    delivered:       one(`SELECT COUNT(*) n FROM sent_emails WHERE delivery_status = 'delivered'`),
    bounced:         one(`SELECT COUNT(*) n FROM sent_emails WHERE delivery_status = 'bounced'`),
    soft_failed:     one(`SELECT COUNT(*) n FROM sent_emails WHERE delivery_status = 'soft_failed'`),
    opened_verified: one(`SELECT COUNT(*) n FROM sent_emails WHERE brevo_opened_at IS NOT NULL`),
    suppressed:      one(`SELECT COUNT(*) n FROM email_suppression`),
    awaiting:        one(`SELECT COUNT(*) n FROM sent_emails WHERE success = 1 AND delivery_status = 'sent'`),
  };
}

// ── Aggregat-Report (Kreuzprobe direkt aus dem Brevo-Konto) ───────────────────
export interface BrevoAggregate {
  range: string; requests: number; delivered: number;
  hardBounces: number; softBounces: number; blocked: number;
  opens: number; uniqueOpens: number; clicks: number; uniqueClicks: number;
  spamReports: number; unsubscribed: number; fetched_at: string;
}

let aggregateCache: BrevoAggregate | null = null;
export function getBrevoAggregateCached(): BrevoAggregate | null { return aggregateCache; }

export async function refreshBrevoAggregate(days = 90): Promise<BrevoAggregate | null> {
  const key = (process.env.BREVO_API_KEY || '').trim();
  if (!key) return null;
  const end = new Date();
  const start = new Date(end.getTime() - days * 86400000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  try {
    const res = await fetch(
      `${BREVO_API}/smtp/statistics/aggregatedReport?startDate=${fmt(start)}&endDate=${fmt(end)}`,
      { headers: { 'api-key': key, accept: 'application/json' } }
    );
    if (!res.ok) return aggregateCache;
    const j = await res.json() as Partial<BrevoAggregate>;
    aggregateCache = {
      range: j.range || `${fmt(start)}|${fmt(end)}`,
      requests: j.requests || 0, delivered: j.delivered || 0,
      hardBounces: j.hardBounces || 0, softBounces: j.softBounces || 0, blocked: j.blocked || 0,
      opens: j.opens || 0, uniqueOpens: j.uniqueOpens || 0,
      clicks: j.clicks || 0, uniqueClicks: j.uniqueClicks || 0,
      spamReports: j.spamReports || 0, unsubscribed: j.unsubscribed || 0,
      fetched_at: nowIso(),
    };
    return aggregateCache;
  } catch {
    return aggregateCache;
  }
}

// ── Webhook automatisch bei Brevo registrieren (idempotent, hands-off) ────────
export async function ensureBrevoWebhook(): Promise<{ ok: boolean; created?: boolean; url?: string; error?: string }> {
  const key = (process.env.BREVO_API_KEY || '').trim();
  const base = (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');
  if (!key) return { ok: false, error: 'BREVO_API_KEY fehlt' };
  if (!base) return { ok: false, error: 'PUBLIC_BASE_URL fehlt – Webhook-URL nicht bildbar' };

  const url = `${base}/webhook/brevo?secret=${webhookSecret()}`;
  const H = { 'api-key': key, accept: 'application/json', 'content-type': 'application/json' };
  try {
    const list = await fetch(`${BREVO_API}/webhooks?type=transactional`, { headers: H });
    if (list.ok) {
      const data = await list.json() as { webhooks?: Array<{ url?: string }> };
      if ((data.webhooks || []).some(w => (w.url || '').split('?')[0] === url.split('?')[0])) {
        return { ok: true, created: false, url };
      }
    }
    const create = await fetch(`${BREVO_API}/webhooks`, {
      method: 'POST', headers: H,
      body: JSON.stringify({
        type: 'transactional',
        url,
        description: 'Tawano Lead-Gen: verifizierter Zustellstatus',
        events: ['delivered', 'hardBounce', 'softBounce', 'blocked', 'spam', 'invalid', 'deferred', 'error', 'opened', 'click', 'unsubscribed'],
      }),
    });
    if (!create.ok) return { ok: false, error: `Brevo Webhook-Anlage fehlgeschlagen (${create.status}): ${(await create.text()).slice(0, 200)}` };
    return { ok: true, created: true, url };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const REFRESH_MS = 60 * 60 * 1000; // stündlich Aggregat + Webhook prüfen
let timer: ReturnType<typeof setInterval> | null = null;

export function startBrevoSync(): void {
  if (!(process.env.BREVO_API_KEY || '').trim()) {
    console.log('[brevo-sync] deaktiviert – BREVO_API_KEY fehlt');
    return;
  }
  const run = () => {
    ensureBrevoWebhook().then(r => {
      if (r.created) console.log(`[brevo-sync] Webhook bei Brevo registriert: ${r.url}`);
      else if (!r.ok) console.warn(`[brevo-sync] Webhook nicht registriert: ${r.error}`);
    }).catch(() => {});
    refreshBrevoAggregate().catch(() => {});
  };
  run();
  if (!timer) timer = setInterval(run, REFRESH_MS);
  console.log('[brevo-sync] aktiv – Brevo ist Quelle der Wahrheit für Zustellung/Öffnung');
}
