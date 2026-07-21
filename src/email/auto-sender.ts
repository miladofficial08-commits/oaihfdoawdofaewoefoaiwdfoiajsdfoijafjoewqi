import { getDb } from '../db/schema';
import { sendLeadEmail } from './mailer';
import { getTemplateById, renderTemplate } from './template';
import { verticalPresets } from '../config/markets';
import { Lead } from '../types';
import { v4 as uuid } from 'uuid';

// ── Sicherheits-Limits (Schutz vor SMTP-Account-Sperrung) ──────────────────
// Neue Mail-Konten ohne Aufwärmphase sollten <150/Tag bleiben; hartes Limit global.
export const GLOBAL_DAILY_CAP = 200;
export const ALLOWED_DAILY_LIMITS = [30, 50, 100, 150, 200];
// Worker-Takt: alle 10s prüfen, damit auch kurze Pausen (min. 15s) sauber greifen.
const TICK_MS = 10_000;

export interface SendJob {
  id: string;
  name: string;
  vertical_id: string | null;
  branche_terms: string | null;
  template_ids: string;
  total_target: number;
  daily_limit: number;
  min_gap_s: number;
  max_gap_s: number;
  window_start: number;
  window_end: number;
  sent_count: number;
  failed_count: number;
  status: string;
  note: string | null;
  next_send_at: string | null;
  created_at: string;
  finished_at: string | null;
}

export function recordSentEmail(entry: {
  id?: string;
  job_id?: string | null;
  lead_id?: string | null;
  scheduled_id?: string | null;
  campaign?: string | null;
  to_email: string;
  to_name?: string | null;
  subject?: string | null;
  body?: string | null;
  template_id?: string | null;
  success: boolean;
  error?: string | null;
  message_id?: string | null;
}) {
  getDb().prepare(
    `INSERT INTO sent_emails (id, job_id, lead_id, scheduled_id, campaign, to_email, to_name, subject, body, template_id, success, error, message_id)
     VALUES (@id, @job_id, @lead_id, @scheduled_id, @campaign, @to_email, @to_name, @subject, @body, @template_id, @success, @error, @message_id)`
  ).run({
    id: entry.id ?? uuid(),
    job_id: entry.job_id ?? null,
    lead_id: entry.lead_id ?? null,
    scheduled_id: entry.scheduled_id ?? null,
    campaign: entry.campaign ?? null,
    to_email: entry.to_email,
    to_name: entry.to_name ?? null,
    subject: entry.subject ?? null,
    body: entry.body ?? null,
    template_id: entry.template_id ?? null,
    success: entry.success ? 1 : 0,
    error: entry.error ?? null,
    message_id: entry.message_id ?? null,
  });
}

export function sentTodayCount(jobId?: string): number {
  const db = getDb();
  const base = `SELECT COUNT(*) as n FROM sent_emails WHERE success = 1 AND sent_at >= datetime('now','start of day','localtime')`;
  const row = jobId
    ? db.prepare(base + ' AND job_id = ?').get(jobId) as { n: number }
    : db.prepare(base).get() as { n: number };
  return row.n;
}

function brancheTermsForJob(job: SendJob): string[] {
  if (job.vertical_id) {
    const vt = verticalPresets.find(v => v.id === job.vertical_id);
    if (vt) return vt.searchTerms;
  }
  try { const t = JSON.parse(job.branche_terms || '[]'); if (Array.isArray(t) && t.length) return t; } catch {}
  return [];
}

// Ausschluss-Klausel gegen Doppel-Mails an dieselbe Praxis.
// Greift GLOBAL über ALLE Jobs, Bulk- und Plan-Versand hinweg – und per E-Mail-Adresse
// (nicht per lead_id), damit dieselbe Praxis auch dann nur einmal angeschrieben wird,
// wenn sie als mehrere Lead-Zeilen existiert.
const ALREADY_CONTACTED_SQL = `LOWER(TRIM(email)) NOT IN (
    SELECT LOWER(TRIM(to_email)) FROM sent_emails      WHERE success = 1                          AND to_email IS NOT NULL AND to_email != ''
    UNION
    SELECT LOWER(TRIM(to_email)) FROM scheduled_emails WHERE status IN ('scheduled','processing') AND to_email IS NOT NULL AND to_email != ''
  )`;

function brancheClause(terms: string[], params: Record<string, unknown>): string {
  if (!terms.length) return '';
  const parts = terms.map((_, i) => `LOWER(branche) LIKE @t${i}`);
  terms.forEach((t, i) => { params['t' + i] = '%' + t.toLowerCase() + '%'; });
  return ` AND (${parts.join(' OR ')})`;
}

function pickNextLead(job: SendJob): Lead | undefined {
  const db = getDb();
  const terms = brancheTermsForJob(job);
  // Nur unkontaktierte, sichere Status; nie DNC/archiviert; Lead braucht E-Mail.
  const statusOk = `status IN ('new','checked','draft_ready','approved','manual_review')`;
  const params: Record<string, unknown> = {};
  const sql = `SELECT * FROM leads
               WHERE email IS NOT NULL AND email != '' AND ${statusOk} AND ${ALREADY_CONTACTED_SQL}`
    + brancheClause(terms, params)
    + ` ORDER BY CASE prioritaet WHEN 'A' THEN 0 WHEN 'B' THEN 1 ELSE 2 END, score_gesamt DESC LIMIT 1`;
  return db.prepare(sql).get(params) as Lead | undefined;
}

/** Wie viele versandfähige, noch nicht kontaktierte Leads gibt es? Für aussagekräftige Hinweise, wenn ein Job leerläuft. */
function availableLeadCounts(job: SendJob): { branche: number; total: number } {
  const db = getDb();
  const statusOk = `status IN ('new','checked','draft_ready','approved','manual_review')`;
  const base = `SELECT COUNT(*) as n FROM leads WHERE email IS NOT NULL AND email != '' AND ${statusOk} AND ${ALREADY_CONTACTED_SQL}`;
  const total = (db.prepare(base).get() as { n: number }).n;
  const params: Record<string, unknown> = {};
  const branche = (db.prepare(base + brancheClause(brancheTermsForJob(job), params)).get(params) as { n: number }).n;
  return { branche, total };
}

function setJob(id: string, fields: Record<string, unknown>) {
  const sets = Object.keys(fields).map(k => `${k} = @${k}`).join(', ');
  getDb().prepare(`UPDATE send_jobs SET ${sets} WHERE id = @id`).run({ ...fields, id });
}

function randGap(job: SendJob): number {
  // Harter Sicherheits-Floor: nie unter 15s (Schutz vor SMTP-Sperrung/Spam-Einstufung).
  const min = Math.max(15, job.min_gap_s);
  const max = Math.max(min + 10, job.max_gap_s);
  return min + Math.floor(Math.random() * (max - min));
}

async function processJob(job: SendJob): Promise<void> {
  const now = new Date();

  if (job.sent_count >= job.total_target) {
    setJob(job.id, { status: 'done', finished_at: now.toISOString(), note: 'Ziel erreicht' });
    return;
  }
  // Sendefenster (lokale Zeit)
  const hour = now.getHours();
  if (hour < job.window_start || hour >= job.window_end) {
    setJob(job.id, { note: `Außerhalb Sendefenster (${job.window_start}–${job.window_end} Uhr) – wartet` });
    return;
  }
  // Limits
  if (sentTodayCount(job.id) >= job.daily_limit) {
    setJob(job.id, { note: 'Tageslimit erreicht – geht morgen weiter' });
    return;
  }
  if (sentTodayCount() >= GLOBAL_DAILY_CAP) {
    setJob(job.id, { note: `Globales Tageslimit (${GLOBAL_DAILY_CAP}) erreicht – Schutz vor Sperrung` });
    return;
  }
  // Abstand einhalten
  if (job.next_send_at && new Date(job.next_send_at) > now) return;

  const lead = pickNextLead(job);
  if (!lead) {
    // Aussagekräftiger Hinweis: erklärt, warum gerade nicht (mehr) versendet wird.
    const { branche, total } = availableLeadCounts(job);
    const hasVertical = Boolean(job.vertical_id) || Boolean(job.branche_terms);
    const note = hasVertical && total > branche
      ? `Keine neuen Leads in dieser Branche (0 offen). ${total} weitere versandfähige Leads in anderen Branchen – für mehr Reichweite einen Job „Alle Branchen“ starten oder neue Leads scrapen.`
      : `Alle ${total} versandfähigen Leads sind kontaktiert – neue Leads scrapen, dann läuft der Job weiter.`;
    setJob(job.id, { note });
    return;
  }

  // Zufällige Vorlage wählen
  let templateIds: string[] = [];
  try { templateIds = JSON.parse(job.template_ids || '[]'); } catch {}
  if (!templateIds.length) templateIds = ['default'];
  const tplId = templateIds[Math.floor(Math.random() * templateIds.length)];
  const tpl = getTemplateById(tplId) ?? getTemplateById('default');
  if (!tpl) { setJob(job.id, { status: 'paused', note: 'Vorlage nicht gefunden – Job pausiert' }); return; }

  const rendered = renderTemplate(tpl, { name: lead.name, branche: lead.branche, stadt: lead.stadt });
  const trackingId = uuid();
  const result = await sendLeadEmail({ leadId: lead.id, to: lead.email!, toName: lead.name, subject: rendered.subject, body: rendered.body, trackingId });

  recordSentEmail({
    id: trackingId,
    job_id: job.id, lead_id: lead.id, to_email: lead.email!, to_name: lead.name,
    subject: rendered.subject, body: rendered.body, template_id: tpl.id,
    success: result.success, error: result.error, message_id: result.messageId,
  });

  const nextAt = new Date(now.getTime() + randGap(job) * 1000).toISOString();
  if (result.success) {
    setJob(job.id, {
      sent_count: job.sent_count + 1,
      next_send_at: nextAt,
      note: `Zuletzt: ${lead.name} (${lead.email})`,
    });
    if (job.sent_count + 1 >= job.total_target) {
      setJob(job.id, { status: 'done', finished_at: new Date().toISOString(), note: 'Alle E-Mails versendet ✓' });
    }
  } else {
    const failed = job.failed_count + 1;
    // Nach 5 Fehlern in Folge pausieren (SMTP-Problem → nicht weiter hämmern)
    const fields: Record<string, unknown> = { failed_count: failed, next_send_at: nextAt, note: `Fehler bei ${lead.email}: ${(result.error||'').slice(0,120)}` };
    if (failed >= 5 && failed % 5 === 0) { fields.status = 'paused'; fields.note = `Pausiert nach ${failed} Fehlern – SMTP prüfen. Letzter: ${(result.error||'').slice(0,100)}`; }
    setJob(job.id, fields);
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
let busy = false;

export function startAutoSender() {
  if (timer) return;
  timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const jobs = getDb().prepare(`SELECT * FROM send_jobs WHERE status = 'running'`).all() as SendJob[];
      for (const job of jobs) {
        try { await processJob(job); } catch (err) {
          setJob(job.id, { note: 'Worker-Fehler: ' + (err instanceof Error ? err.message : String(err)).slice(0, 150) });
        }
      }
    } finally {
      busy = false;
    }
  }, TICK_MS);
  console.log('[auto-sender] Worker gestartet (Tick ' + TICK_MS / 1000 + 's, globales Tageslimit ' + GLOBAL_DAILY_CAP + ')');
}
