// SMS-Statistik aus dem Voice-Agent-System (tawanodashboard / Supabase).
// Liest nur — verändert dort nichts.

export interface SmsStats {
  configured: boolean;
  total: number;
  today: number;
  failed: number;
  feedback_count: number;
  recent: Array<{ phone_number: string; message: string; status: string; created_at: string; tenant_id: string }>;
  error?: string;
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
  const empty: SmsStats = { configured: false, total: 0, today: 0, failed: 0, feedback_count: 0, recent: [] };
  if (!cfg.url || !cfg.key) return { ...empty, error: 'SMS_SUPABASE_URL / SMS_SUPABASE_KEY nicht in .env gesetzt' };

  try {
    const todayIso = new Date(new Date().setHours(0, 0, 0, 0)).toISOString();
    const [totalRes, todayRes, failedRes, recentRes, feedbackRes] = await Promise.all([
      sbGet('/rest/v1/sms_logs?select=id&limit=1'),
      sbGet(`/rest/v1/sms_logs?select=id&created_at=gte.${encodeURIComponent(todayIso)}&limit=1`),
      sbGet(`/rest/v1/sms_logs?select=id&status=not.eq.sent&limit=1`),
      sbGet('/rest/v1/sms_logs?select=phone_number,message,status,created_at,tenant_id&order=created_at.desc&limit=15'),
      // Feedback-Einträge = Empfänger hat den SMS-Link geöffnet UND bewertet (bestes verfügbares Klick-Signal)
      sbGet('/rest/v1/feedback?select=id&limit=1').catch(() => ({ ok: false, data: null, count: 0 } as any)),
    ]);

    return {
      configured: true,
      total: totalRes.count ?? (Array.isArray(totalRes.data) ? totalRes.data.length : 0),
      today: todayRes.count ?? 0,
      failed: failedRes.count ?? 0,
      feedback_count: feedbackRes.ok ? (feedbackRes.count ?? 0) : 0,
      recent: Array.isArray(recentRes.data) ? recentRes.data : [],
    };
  } catch (err) {
    return { ...empty, configured: true, error: err instanceof Error ? err.message : String(err) };
  }
}
