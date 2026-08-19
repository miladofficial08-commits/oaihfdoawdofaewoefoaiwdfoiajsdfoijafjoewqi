import { getDb } from '../db/schema';
import { sendLeadEmail, sendBulkEmail } from './mailer';
import { recordSentEmail, sentTodayCount, GLOBAL_DAILY_CAP } from './auto-sender';
import { v4 as uuid } from 'uuid';
import { anyWorkflowActive } from '../workflow/health';

// Serverseitiger Worker für zeitversetzte Einzel-E-Mails (E-Mail-Center → "Planen").
// Läuft unabhängig vom Browser: solange der Server an ist, werden fällige Mails gesendet.

const TICK_MS = 10_000;

export interface ScheduledEmail {
  id: string;
  lead_id: string | null;
  to_email: string;
  to_name: string | null;
  template_id: string | null;
  subject: string;
  body: string;
  campaign: string | null;
  scheduled_at: string;
  status: string;
  attempts: number;
  sent_email_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Beansprucht eine fällige Zeile atomar (status scheduled -> processing).
 * Gibt true zurück, wenn genau diese Ausführung die Zeile übernommen hat (verhindert Doppelversand).
 */
function claim(id: string): boolean {
  const res = getDb().prepare(
    `UPDATE scheduled_emails SET status = 'processing', updated_at = @now
     WHERE id = @id AND status = 'scheduled'`
  ).run({ id, now: nowIso() });
  return res.changes === 1;
}

function release(id: string, note: string) {
  getDb().prepare(
    `UPDATE scheduled_emails SET status = 'scheduled', updated_at = @now, error = @note WHERE id = @id`
  ).run({ id, now: nowIso(), note });
}

async function processOne(row: ScheduledEmail): Promise<void> {
  // Globales Tageslimit als harte Schutzgrenze (Account-Sperr-Schutz). Wenn erreicht:
  // Anspruch zurückgeben, damit die Mail zum nächsten möglichen Zeitpunkt gesendet wird.
  if (sentTodayCount() >= GLOBAL_DAILY_CAP) {
    release(row.id, `Globales Tageslimit (${GLOBAL_DAILY_CAP}) erreicht – Versand verschoben`);
    return;
  }

  const trackingId = uuid();
  let result;
  try {
    result = row.lead_id
      ? await sendLeadEmail({ leadId: row.lead_id, to: row.to_email, toName: row.to_name || undefined, subject: row.subject, body: row.body, trackingId })
      : await sendBulkEmail({ to: row.to_email, toName: row.to_name || undefined, subject: row.subject, body: row.body, trackingId });
  } catch (err) {
    result = { success: false, error: err instanceof Error ? err.message : String(err) };
  }

  recordSentEmail({
    id: trackingId,
    scheduled_id: row.id,
    lead_id: row.lead_id,
    campaign: row.campaign,
    to_email: row.to_email,
    to_name: row.to_name,
    subject: row.subject,
    body: row.body,
    template_id: row.template_id,
    success: result.success,
    error: result.error,
    message_id: (result as { messageId?: string }).messageId,
  });

  if (result.success) {
    getDb().prepare(
      `UPDATE scheduled_emails SET status = 'sent', sent_email_id = @sid, sent_at = @now, updated_at = @now,
              attempts = attempts + 1, error = NULL WHERE id = @id`
    ).run({ id: row.id, sid: trackingId, now: nowIso() });
  } else {
    getDb().prepare(
      `UPDATE scheduled_emails SET status = 'failed', updated_at = @now, attempts = attempts + 1, error = @err WHERE id = @id`
    ).run({ id: row.id, now: nowIso(), err: (result.error || 'Versand fehlgeschlagen').slice(0, 400) });
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
let busy = false;

export function startScheduledSender() {
  if (timer) return;
  timer = setInterval(async () => {
    if (busy) return;
    // Eine Strategie ist zustaendig oder das alte System - nie beide. Sonst
    // bekommt dieselbe Firma Post aus zwei Kanaelen und der alte Text geht
    // trotz aufgeraeumter Vorlagen wieder raus.
    if (anyWorkflowActive()) return;
    busy = true;
    try {
      const due = getDb().prepare(
        `SELECT * FROM scheduled_emails WHERE status = 'scheduled' AND scheduled_at <= @now
         ORDER BY scheduled_at ASC LIMIT 25`
      ).all({ now: nowIso() }) as ScheduledEmail[];
      for (const row of due) {
        if (!claim(row.id)) continue; // bereits von anderer Ausführung übernommen
        try {
          await processOne(row);
        } catch (err) {
          getDb().prepare(
            `UPDATE scheduled_emails SET status = 'failed', updated_at = @now, error = @err WHERE id = @id`
          ).run({ id: row.id, now: nowIso(), err: ('Worker-Fehler: ' + (err instanceof Error ? err.message : String(err))).slice(0, 400) });
        }
      }
    } finally {
      busy = false;
    }
  }, TICK_MS);
  console.log('[scheduled-sender] Worker gestartet (Tick ' + TICK_MS / 1000 + 's)');
}
