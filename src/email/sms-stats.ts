// SMS-Statistik aus dem Voice-Agent-System (tawanodashboard / Supabase).
// Liest dort nur — verändert nichts. Klick-Daten kommen aus der lokalen web_visits-Tabelle
// (channel = 'sms', befüllt vom /track/sms/:id Redirect).

import { getDb } from '../db/schema';

export interface SmsStats {
  configured: boolean;
  total: number;
  today: number;
  delivered: number;
  failed: number;
  feedback_count: number;
  recent: Array<{ phone_number: string; message: string; status: string; created_at: string; tenant_id: string }>;
  error?: string;
}

// seven.io-Zustell-Status (via DLR-Webhook in sms_logs.status geschrieben).
const SMS_FAILURE_STATUSES = ['NOTDELIVERED', 'REJECTED', 'EXPIRED', 'FAILED'];

// Kategorien für eine verständliche, korrekte Darstellung. Eine SMS gilt NUR dann als
// "fehlgeschlagen", wenn der Anbieter das eindeutig bestätigt hat.
export type SmsStatusCode = 'queued' | 'processing' | 'handed_off' | 'sent' | 'delivered' | 'not_delivered' | 'failed' | 'expired' | 'rejected';

const SMS_STATUS_MAP: Record<string, { code: SmsStatusCode; label: string; tone: 'ok' | 'good' | 'info' | 'warn' | 'bad' }> = {
  DELIVERED: { code: 'delivered', label: 'Zugestellt', tone: 'good' },
  TRANSMITTED: { code: 'sent', label: 'Versendet', tone: 'ok' },
  SENT: { code: 'sent', label: 'Versendet', tone: 'ok' },
  ACCEPTED: { code: 'handed_off', label: 'An Anbieter übergeben', tone: 'info' },
  BUFFERED: { code: 'processing', label: 'Wird verarbeitet', tone: 'info' },
  QUEUED: { code: 'queued', label: 'In Warteschlange', tone: 'info' },
  NOTDELIVERED: { code: 'not_delivered', label: 'Nicht zugestellt', tone: 'bad' },
  REJECTED: { code: 'rejected', label: 'Abgelehnt', tone: 'bad' },
  EXPIRED: { code: 'expired', label: 'Abgelaufen', tone: 'warn' },
  FAILED: { code: 'failed', label: 'Fehlgeschlagen', tone: 'bad' },
};

export function classifySmsStatus(raw?: string | null): { code: SmsStatusCode; label: string; tone: 'ok' | 'good' | 'info' | 'warn' | 'bad' } {
  const key = String(raw || '').trim().toUpperCase();
  return SMS_STATUS_MAP[key] || { code: 'processing', label: 'Wird verarbeitet', tone: 'info' };
}

function getCfg() {
  return {
    url: (process.env.SMS_SUPABASE_URL || '').trim().replace(/\/$/, ''),
    key: (process.env.SMS_SUPABASE_KEY || '').trim(),
  };
}

async function sbGet(path: string): Promise<{ ok: boolean; data: any; count?: number }> {
  const cfg = getCfg();
  const res = await fetch(cfg.url + path, {
    headers: {
      apikey: cfg.key,
      Authorization: 'Bearer ' + cfg.key,
      Prefer: 'count=exact',
    },
    signal: AbortSignal.timeout(10000),
  });
  const raw = await res.text();
  let data: any = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
  const range = res.headers.get('content-range') || '';
  const count = range.includes('/') ? Number(range.split('/')[1]) : undefined;
  return { ok: res.ok, data, count };
}

export async function getSmsStats(): Promise<SmsStats> {
  const cfg = getCfg();
  const empty: SmsStats = { configured: false, total: 0, today: 0, delivered: 0, failed: 0, feedback_count: 0, recent: [] };
  if (!cfg.url || !cfg.key) return { ...empty, error: 'SMS_SUPABASE_URL / SMS_SUPABASE_KEY nicht in .env gesetzt' };

  try {
    const todayIso = new Date(new Date().setHours(0, 0, 0, 0)).toISOString();
    const failedFilter = `status=in.(${SMS_FAILURE_STATUSES.join(',')})`;
    const [totalRes, todayRes, deliveredRes, failedRes, recentRes, feedbackRes] = await Promise.all([
      sbGet('/rest/v1/sms_logs?select=id&limit=1'),
      sbGet(`/rest/v1/sms_logs?select=id&created_at=gte.${encodeURIComponent(todayIso)}&limit=1`),
      sbGet('/rest/v1/sms_logs?select=id&status=eq.DELIVERED&limit=1'),
      sbGet(`/rest/v1/sms_logs?select=id&${failedFilter}&limit=1`),
      sbGet('/rest/v1/sms_logs?select=id,phone_number,message,status,created_at,tenant_id&order=created_at.desc&limit=30'),
      sbGet('/rest/v1/feedback?select=id&limit=1').catch(() => ({ ok: false, data: null, count: 0 } as any)),
    ]);

    return {
      configured: true,
      total: totalRes.count ?? (Array.isArray(totalRes.data) ? totalRes.data.length : 0),
      today: todayRes.count ?? 0,
      delivered: deliveredRes.count ?? 0,
      failed: failedRes.count ?? 0,
      feedback_count: feedbackRes.ok ? (feedbackRes.count ?? 0) : 0,
      recent: Array.isArray(recentRes.data) ? recentRes.data : [],
    };
  } catch (err) {
    return { ...empty, configured: true, error: err instanceof Error ? err.message : String(err) };
  }
}

function maskPhone(raw?: string | null): string {
  const s = String(raw || '').trim();
  if (!s) return '—';
  const digits = s.replace(/[^\d+]/g, '');
  if (digits.length <= 4) return digits;
  const tail = digits.slice(-3);
  const head = digits.startsWith('+') ? digits.slice(0, 3) : digits.slice(0, 2);
  return `${head}••••${tail}`;
}

function extractLink(message?: string | null): string | null {
  const m = String(message || '').match(/https?:\/\/[^\s]+/i);
  return m ? m[0] : null;
}

export interface SmsAnalytics extends SmsStats {
  by_status: Array<{ code: SmsStatusCode; label: string; tone: string; count: number }>;
  clicks_total: number;
  clicks_unique: number;
  top_links: Array<{ url: string; clicks: number; visitors: number }>;
  recent_detailed: Array<{
    id: string | null;
    phone_masked: string;
    phone_number: string;
    message: string;
    link: string | null;
    status_code: SmsStatusCode;
    status_label: string;
    status_tone: string;
    created_at: string;
    clicked: boolean;
    click_count: number;
  }>;
}

/** SMS-Analyse inkl. Klicktracking (lokal aus web_visits) und korrekter Status-Kategorien. */
export async function getSmsAnalytics(): Promise<SmsAnalytics> {
  const base = await getSmsStats();
  const db = getDb();

  // Klick-Aggregate aus dem lokalen Tracking (channel = 'sms').
  const clicksTotal = (db.prepare(`SELECT COUNT(*) as n FROM web_visits WHERE channel = 'sms'`).get() as { n: number }).n;
  const clicksUnique = (db.prepare(`SELECT COUNT(DISTINCT visitor_id) as n FROM web_visits WHERE channel = 'sms'`).get() as { n: number }).n;
  const topLinks = db.prepare(
    `SELECT url, COUNT(*) as clicks, COUNT(DISTINCT visitor_id) as visitors
     FROM web_visits WHERE channel = 'sms' GROUP BY url ORDER BY clicks DESC LIMIT 8`
  ).all() as Array<{ url: string; clicks: number; visitors: number }>;

  // Status-Verteilung über die letzten (verfügbaren) Recent-Einträge + Gesamtzahlen.
  const byStatusMap = new Map<SmsStatusCode, { code: SmsStatusCode; label: string; tone: string; count: number }>();
  const recentDetailed = (base.recent || []).map((s: any) => {
    const cls = classifySmsStatus(s.status);
    const entry = byStatusMap.get(cls.code) || { code: cls.code, label: cls.label, tone: cls.tone, count: 0 };
    entry.count++;
    byStatusMap.set(cls.code, entry);
    // Klicks dieser konkreten SMS: visitor_id-Format ist "sms:{sms_id}:{signatur}".
    let clickCount = 0;
    if (s.id) {
      clickCount = (db.prepare(
        `SELECT COUNT(*) as n FROM web_visits WHERE channel = 'sms' AND visitor_id LIKE ?`
      ).get(`sms:${s.id}:%`) as { n: number }).n;
    }
    return {
      id: s.id ?? null,
      phone_masked: maskPhone(s.phone_number),
      phone_number: String(s.phone_number || ''),
      message: String(s.message || ''),
      link: extractLink(s.message),
      status_code: cls.code,
      status_label: cls.label,
      status_tone: cls.tone,
      created_at: s.created_at,
      clicked: clickCount > 0,
      click_count: clickCount,
    };
  });

  return {
    ...base,
    by_status: [...byStatusMap.values()].sort((a, b) => b.count - a.count),
    clicks_total: clicksTotal,
    clicks_unique: clicksUnique,
    top_links: topLinks,
    recent_detailed: recentDetailed,
  };
}
