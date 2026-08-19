import { getDb } from '../db/schema';
import { sendBulkEmail } from './mailer';
import { recordSentEmail, sentTodayCount, GLOBAL_DAILY_CAP } from './auto-sender';
import { recordOutreachEvent } from '../db/leads-repo';
import { isRealClick } from './tracking';
import { Lead } from '../types';
import { NOT_SUPPRESSED_SQL } from '../workflow/optout';
import { NOT_IN_ACTIVE_WORKFLOW_SQL } from '../workflow/schema';
import { anyWorkflowActive } from '../workflow/health';
import { v4 as uuid } from 'uuid';

// ─────────────────────────────────────────────────────────────────────────────
// Follow-up-Worker: verschickt zeitversetzt Nachfass-Mails an bereits kontaktierte
// Leads, die NICHT geantwortet und NICHT geklickt haben. Bei Cold Mail kommen die
// meisten Antworten erst ab der 2.–4. Mail – ohne Follow-up bleibt Reichweite liegen.
//
// Stoppt automatisch, sobald ein Lead reagiert:
//   • Status wechselt weg von 'contacted' (z.B. 'replied') → fällt aus der Auswahl
//   • echter Klick registriert → heißer Lead, Mensch übernimmt (kein weiteres Follow-up)
//   • Bounce → Adresse ungültig, kein weiteres Anschreiben
// ─────────────────────────────────────────────────────────────────────────────

const TICK_MS = 15_000;
const MAX_STAGES = 2; // Anzahl Follow-ups nach der Erstmail (Stage 1 = Bump, Stage 2 = Break-up)

// Der tatsächliche Follow-up-VERSAND geht bewusst NUR an den Voice-Agent-Track (Tawano).
// Consult-Leads bekommen vorerst keine automatischen Nachfass-Mails – die werden persönlich
// bearbeitet. WICHTIG: Nur das Senden ist gesperrt; Analyse, Statistik, Antwort-Erkennung und
// Dashboard-Übersicht laufen für Consult unverändert weiter. Zum Erweitern: Track hier ergänzen.
const FOLLOWUP_TRACK = 'voice_agent';
// SQL-Baustein – wird ausschließlich in der Versand-Kandidatenauswahl verwendet.
const FOLLOWUP_TRACK_SQL = `COALESCE(track,'voice_agent') = '${FOLLOWUP_TRACK}'`;

export interface FollowupConfig {
  enabled: number;
  gap1_days: number;
  gap2_days: number;
  daily_cap: number;
  window_start: number;
  window_end: number;
  min_gap_s: number;
  updated_at: string;
}

interface StageTemplate { subject: string; body: string; }

// Strategische Cold-Mail-Follow-ups. Ein klarer CTA, Antwort-basiert (kein unbekannter Link nötig).
const STAGES: StageTemplate[] = [
  {
    // Stage 1 – kurzer Bump nach ~3 Tagen. Bringt die Mail wieder nach oben.
    subject: 'Kurze Nachfrage, {name}',
    body: `Guten Tag {name}-Team,

ich wollte kurz nachhaken, ob meine letzte Nachricht bei Ihnen angekommen ist.

Viele {branche}-Betriebe verpassen täglich Anrufe – unser KI-Telefonassistent nimmt sie rund um die Uhr entgegen, bucht Termine und leitet nur die wichtigen Gespräche an Sie weiter.

Testen Sie die Demo-KI direkt: +49 211 86943411

Reicht Ihnen ein kurzer Anruf (10 Min.) diese Woche? Antworten Sie einfach auf diese E-Mail.

Mit freundlichen Grüßen
Tawano – KI-Telefonassistent
www.tawano.de | info@tawano.de`,
  },
  {
    // Stage 2 – Break-up-Mail nach ~7 Tagen. Höchste Antwortrate im Cold Mailing.
    subject: 'Letzter Versuch – {name}',
    body: `Guten Tag {name}-Team,

ich möchte Ihnen nicht weiter schreiben, wenn das Thema gerade nicht passt – das ist völlig in Ordnung.

Falls verpasste Anrufe bei Ihnen aber ein Thema sind: Unser KI-Assistent nimmt sie 24/7 an, bucht Termine und beantwortet Standardfragen. Schon ein paar zusätzlich angenommene Anrufe pro Woche rechnen sich.

Wenn ich Ihnen die 3 wichtigsten Vorteile in 10 Minuten zeigen darf, antworten Sie einfach mit „Ja".
Andernfalls wünsche ich Ihnen weiterhin viel Erfolg.

Mit freundlichen Grüßen
Tawano – KI-Telefonassistent
www.tawano.de | info@tawano.de`,
  },
];

function render(tpl: StageTemplate, lead: Lead): { subject: string; body: string } {
  const r = (s: string) => s
    .replace(/\{name\}/g, lead.name || '')
    .replace(/\{branche\}/g, lead.branche || '')
    .replace(/\{stadt\}/g, lead.stadt || '');
  return { subject: r(tpl.subject), body: r(tpl.body) };
}

export function getFollowupConfig(): FollowupConfig {
  const db = getDb();
  db.prepare('INSERT OR IGNORE INTO followup_config (id) VALUES (1)').run();
  return db.prepare('SELECT * FROM followup_config WHERE id = 1').get() as FollowupConfig;
}

export function setFollowupConfig(
  patch: Partial<{ enabled: boolean | number; gap1_days: number; gap2_days: number; daily_cap: number; window_start: number; window_end: number; min_gap_s: number }>
): FollowupConfig {
  const cur = getFollowupConfig();
  const next = {
    enabled: patch.enabled != null ? (patch.enabled ? 1 : 0) : cur.enabled,
    gap1_days: clampNum(patch.gap1_days, cur.gap1_days, 0.02, 60),
    gap2_days: clampNum(patch.gap2_days, cur.gap2_days, 0.02, 60),
    daily_cap: Math.round(clampNum(patch.daily_cap, cur.daily_cap, 1, GLOBAL_DAILY_CAP)),
    window_start: Math.round(clampNum(patch.window_start, cur.window_start, 0, 23)),
    window_end: Math.round(clampNum(patch.window_end, cur.window_end, 1, 24)),
    min_gap_s: Math.round(clampNum(patch.min_gap_s, cur.min_gap_s, 15, 600)),
  };
  getDb().prepare(
    `UPDATE followup_config SET enabled=@enabled, gap1_days=@gap1_days, gap2_days=@gap2_days,
       daily_cap=@daily_cap, window_start=@window_start, window_end=@window_end, min_gap_s=@min_gap_s,
       updated_at=@now WHERE id = 1`
  ).run({ ...next, now: new Date().toISOString() });
  return getFollowupConfig();
}

function clampNum(v: unknown, fallback: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/** Anzahl heute erfolgreich versendeter Follow-ups (für das Follow-up-Tageslimit). */
export function followupsSentToday(): number {
  return (getDb().prepare(
    `SELECT COUNT(*) as n FROM sent_emails
     WHERE success = 1 AND campaign LIKE 'followup-%'
       AND sent_at >= datetime('now','start of day','localtime')`
  ).get() as { n: number }).n;
}

export function followupStats() {
  const db = getDb();
  const cfg = getFollowupConfig();
  const stageRows = db.prepare(
    `SELECT COALESCE(followup_stage,0) as stage, COUNT(*) as n
     FROM leads WHERE status = 'contacted' AND COALESCE(followup_stopped,0) = 0
     GROUP BY COALESCE(followup_stage,0)`
  ).all() as Array<{ stage: number; n: number }>;
  const stages: Record<number, number> = {};
  for (const r of stageRows) stages[r.stage] = r.n;
  const stopped = (db.prepare(`SELECT COUNT(*) as n FROM leads WHERE COALESCE(followup_stopped,0) = 1`).get() as { n: number }).n;
  const total = (db.prepare(`SELECT COUNT(*) as n FROM sent_emails WHERE success = 1 AND campaign LIKE 'followup-%'`).get() as { n: number }).n;
  return {
    ...cfg,
    max_stages: MAX_STAGES,
    in_sequence: (stages[0] || 0) + (stages[1] || 0),
    awaiting_stage1: stages[0] || 0,
    awaiting_stage2: stages[1] || 0,
    stopped,
    sent_today: followupsSentToday(),
    sent_total: total,
  };
}

/** Grund für Stopp ermitteln (echter Klick oder Bounce). Öffnungen zählen bewusst NICHT (unzuverlässig). */
function engagementStop(leadId: string): string | null {
  const events = getDb().prepare(
    `SELECT ev.event_type, ev.user_agent FROM email_events ev
     JOIN sent_emails se ON se.id = ev.sent_email_id
     WHERE se.lead_id = ?`
  ).all(leadId) as Array<{ event_type: string; user_agent: string | null }>;
  if (events.some(e => e.event_type === 'bounce')) return 'Bounce – Adresse ungültig';
  if (events.some(e => isRealClick({ event_type: e.event_type, user_agent: e.user_agent }))) {
    return 'Klick erhalten – heißer Lead, bitte manuell übernehmen';
  }
  return null;
}

function requiredGapDays(stage: number, cfg: FollowupConfig): number {
  return stage === 0 ? cfg.gap1_days : cfg.gap2_days;
}

function stopFollowup(leadId: string, reason: string) {
  getDb().prepare(
    `UPDATE leads SET followup_stopped = 1, followup_stopped_reason = @reason, updated_at = @now WHERE id = @id`
  ).run({ id: leadId, reason, now: new Date().toISOString() });
}

/**
 * Ermittelt den nächsten fälligen Follow-up-Kandidaten. Reagierende Leads (Klick/Bounce)
 * werden dabei dauerhaft gestoppt (Seiteneffekt). Gibt {lead, stage} zurück oder null.
 * Exportiert, damit die Auswahl-Logik ohne echten Versand testbar ist.
 */
export function dueFollowupCandidate(cfg: FollowupConfig = getFollowupConfig(), nowMs: number = Date.now()): { lead: Lead; stage: number } | null {
  const candidates = getDb().prepare(
    `SELECT * FROM leads
     WHERE status = 'contacted' AND email IS NOT NULL AND email != ''
       AND COALESCE(followup_stopped,0) = 0
       AND ${NOT_SUPPRESSED_SQL}
       AND ${NOT_IN_ACTIVE_WORKFLOW_SQL}
       AND COALESCE(followup_stage,0) < @maxStages
       AND ${FOLLOWUP_TRACK_SQL}
     ORDER BY COALESCE(followup_last_at, gesendet_at, contacted_at, updated_at) ASC
     LIMIT 40`
  ).all({ maxStages: MAX_STAGES }) as Lead[];

  for (const lead of candidates) {
    const stage = lead.followup_stage || 0;

    // Reagiert? → dauerhaft stoppen und weiter zum nächsten Kandidaten.
    const stop = engagementStop(lead.id);
    if (stop) { stopFollowup(lead.id, stop); continue; }

    // Fällig? (genug Zeit seit letzter Berührung vergangen)
    const lastTouch = lead.followup_last_at || lead.gesendet_at || lead.contacted_at || lead.updated_at;
    const lastMs = lastTouch ? new Date(String(lastTouch).replace(' ', 'T')).getTime() : 0;
    const elapsedDays = (nowMs - lastMs) / 86_400_000;
    if (elapsedDays < requiredGapDays(stage, cfg)) continue;

    return { lead, stage };
  }
  return null;
}

let nextSendAt = 0;

async function tick(): Promise<void> {
  const cfg = getFollowupConfig();
  if (!cfg.enabled) return;

  const now = new Date();
  const hour = now.getHours();
  if (hour < cfg.window_start || hour >= cfg.window_end) return;   // Sendefenster
  if (Date.now() < nextSendAt) return;                            // Abstand einhalten
  if (followupsSentToday() >= cfg.daily_cap) return;              // Follow-up-Tageslimit
  if (sentTodayCount() >= GLOBAL_DAILY_CAP) return;               // globaler Schutz

  // Genau EIN Follow-up pro Tick versenden (Anti-Spam-Takt, wie beim Auto-Versand).
  const due = dueFollowupCandidate(cfg);
  if (due) await sendFollowup(due.lead, due.stage, cfg);
}

async function sendFollowup(lead: Lead, stage: number, cfg: FollowupConfig): Promise<void> {
  const tpl = STAGES[stage];
  const { subject, body } = render(tpl, lead);
  const trackingId = uuid();
  const campaign = `followup-${stage + 1}`;

  let res;
  try {
    res = await sendBulkEmail({ to: lead.email!, toName: lead.name, subject, body, trackingId });
  } catch (err) {
    res = { success: false, error: err instanceof Error ? err.message : String(err) };
  }

  recordSentEmail({
    id: trackingId, lead_id: lead.id, campaign, to_email: lead.email!, to_name: lead.name,
    subject, body, template_id: campaign,
    success: res.success, error: res.error, message_id: (res as { messageId?: string }).messageId,
  });

  const now = new Date().toISOString();
  if (res.success) {
    getDb().prepare(
      `UPDATE leads SET followup_stage = @stage, followup_last_at = @now, updated_at = @now WHERE id = @id`
    ).run({ id: lead.id, stage: stage + 1, now });
    recordOutreachEvent({
      lead_id: lead.id, event_type: 'followup_sent', channel: 'email', status: 'contacted', user: 'followup-worker',
      note: `Follow-up ${stage + 1}/${MAX_STAGES} gesendet an ${lead.email} | Betreff: "${subject}"`,
    });
    nextSendAt = Date.now() + cfg.min_gap_s * 1000;
  } else {
    // Fehlschlag: Stage NICHT hochzählen, kurze Backoff-Pause, Zeitstempel setzen (nicht sofort erneut).
    getDb().prepare(`UPDATE leads SET followup_last_at = @now, updated_at = @now WHERE id = @id`)
      .run({ id: lead.id, now });
    recordOutreachEvent({
      lead_id: lead.id, event_type: 'status_changed', channel: 'email', user: 'followup-worker',
      note: `Follow-up ${stage + 1} FEHLGESCHLAGEN an ${lead.email}: ${(res.error || '').slice(0, 160)}`,
    });
    nextSendAt = Date.now() + cfg.min_gap_s * 1000;
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
let busy = false;

export function startFollowupSender() {
  if (timer) return;
  timer = setInterval(async () => {
    if (busy) return;
    // Eine Strategie ist zustaendig oder das alte System - nie beide. Sonst
    // bekommt dieselbe Firma Post aus zwei Kanaelen und der alte Text geht
    // trotz aufgeraeumter Vorlagen wieder raus.
    if (anyWorkflowActive()) return;
    busy = true;
    try { await tick(); }
    catch (err) { console.error('[followup] Tick-Fehler:', err instanceof Error ? err.message : err); }
    finally { busy = false; }
  }, TICK_MS);
  console.log('[followup] Worker gestartet (Tick ' + TICK_MS / 1000 + 's, ' + MAX_STAGES + ' Stufen)');
}
