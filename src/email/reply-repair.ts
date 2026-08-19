import { getDb } from '../db/schema';
import { decodeMailText } from './mime';
import { classifyReply } from './reply-scanner';
import { detectOptOut, suppressEmail, isSuppressed } from '../workflow/optout';
import { updateLeadStatus } from '../db/leads-repo';
import { logWorkflow } from '../workflow/schema';

// ─────────────────────────────────────────────────────────────────────────────
// Altlasten aus dem Postfach geradeziehen.
//
// Antworten wurden bisher unentschlüsselt gespeichert: Bei einer Base64-Mail stand
// „U1RPUCEN…" in der Datenbank statt „STOP!". Alles, was danach kam – Abmelde-
// Erkennung, Absage, Interesse – urteilte über diesen Buchstabensalat.
//
// Konkret ist genau das passiert: Ein Betrieb hat „STOP!" geantwortet, das System
// hat es als „unklar" verbucht, den Lead auf „hat geantwortet" gesetzt und ihn als
// INTERESSENT einsortiert. Beim nächsten Schritt wäre Werbung an jemanden gegangen,
// der ausdrücklich widersprochen hat.
//
// Diese Datei liest jede gespeicherte Antwort neu, entschlüsselt sie, urteilt neu
// und zieht die Konsequenz. Sie läuft automatisch beim Start und ist idempotent:
// Was schon richtig steht, wird nicht angefasst.
// ─────────────────────────────────────────────────────────────────────────────

export interface RepairResult {
  geprueft: number;
  entschluesselt: number;
  neu_eingestuft: number;
  gesperrt: string[];
  aus_interessiert_geholt: number;
}

interface ReplyRow {
  uid: number;
  lead_id: string | null;
  from_email: string | null;
  subject: string | null;
  snippet: string | null;
  category: string | null;
}

/** Sieht der gespeicherte Text noch nach Kodierung aus? */
function wirktKodiert(s: string): boolean {
  if (!s) return false;
  if (/=[0-9A-F]{2}/i.test(s)) return true;                       // Quoted-Printable
  if (/content-(type|transfer-encoding)\s*:/i.test(s)) return true; // roher MIME-Kopf
  const kompakt = s.replace(/\s+/g, '');
  if (kompakt.length > 24 && /^[A-Za-z0-9+/]+={0,2}$/.test(kompakt)) return true; // Base64
  return false;
}

/**
 * Holt einen Lauf von der Interessenten-Stage auf die Sonderfall-Stage desselben
 * Astes. Dort passiert nichts von allein und ein Mensch entscheidet – genau das,
 * was bei einer unklaren Antwort passieren soll.
 */
function verschiebeAufPruefen(leadId: string, leadName: string, grund: string, dryRun: boolean): boolean {
  const db = getDb();
  const run = db.prepare(
    `SELECT id, node_id, workflow_id FROM workflow_runs WHERE lead_id = ? AND status = 'active' LIMIT 1`
  ).get(leadId) as { id: string; node_id: string | null; workflow_id: string } | undefined;
  if (!run?.node_id || !/_int\d*$/.test(run.node_id)) return false;

  const ziel = run.node_id.replace(/_int(\d*)$/, '_pruef$1');
  const wf = db.prepare('SELECT graph FROM workflows WHERE id = ?').get(run.workflow_id) as { graph: string } | undefined;
  if (!wf || !String(wf.graph).includes(`"${ziel}"`)) return false;

  if (!dryRun) {
    db.prepare(`UPDATE workflow_runs SET node_id = ?, due_at = '9999-12-31T00:00:00.000Z', updated_at = datetime('now') WHERE id = ?`)
      .run(ziel, run.id);
    logWorkflow({
      run_id: run.id, lead_id: leadId, lead_name: leadName, node_id: ziel,
      action: 'Kein belegtes Interesse – zur Prüfung verschoben', level: 'warn',
      detail: `Stand auf der Interessenten-Stage, die Antwort ist aber "${grund}". Bitte kurz ansehen.`,
    });
  }
  return true;
}

export function repairStoredReplies(dryRun = false): RepairResult {
  const db = getDb();
  const raus: RepairResult = { geprueft: 0, entschluesselt: 0, neu_eingestuft: 0, gesperrt: [], aus_interessiert_geholt: 0 };

  let rows: ReplyRow[];
  try {
    rows = db.prepare(
      `SELECT uid, lead_id, from_email, subject, snippet, category FROM inbound_replies`
    ).all() as ReplyRow[];
  } catch {
    return raus;   // Tabelle noch nicht angelegt
  }

  for (const r of rows) {
    raus.geprueft++;
    const alt = r.snippet || '';
    const klartext = wirktKodiert(alt) ? decodeMailText(alt) : alt;
    const wurdeEntschluesselt = Boolean(klartext) && klartext !== alt;
    if (wurdeEntschluesselt) raus.entschluesselt++;

    const neueEinstufung = classifyReply(r.subject || '', klartext).category;
    const optOut = detectOptOut(r.subject || '', klartext);
    const aendert = wurdeEntschluesselt || neueEinstufung !== r.category;
    if (!aendert && !optOut) continue;

    if (!dryRun && aendert) {
      db.prepare(`UPDATE inbound_replies SET snippet = ?, category = ? WHERE uid = ?`)
        .run(klartext.slice(0, 300), neueEinstufung, r.uid);
    }
    if (neueEinstufung !== r.category) raus.neu_eingestuft++;

    // Kein Widerspruch, aber auch kein Interesse: Der Lead darf nicht auf der
    // Interessenten-Stage stehen bleiben. Eine Eingangsbestätigung und eine
    // unlesbare Mail sind keine Interessenten – der Nutzer sieht sonst eine Zahl,
    // die es nicht gibt, und ruft Leute an, die nie etwas gesagt haben.
    if (!optOut && r.lead_id && neueEinstufung !== 'interested') {
      const l = db.prepare('SELECT id, name, status FROM leads WHERE id = ?').get(r.lead_id) as
        { id: string; name: string; status: string } | undefined;
      if (l && l.status === 'replied') {
        if (!dryRun) {
          updateLeadStatus(l.id, 'contacted' as never, {
            notiz: `Antwort neu bewertet: ${neueEinstufung === 'auto_reply' ? 'Auto-Antwort' : 'nicht eindeutig'} – kein Interesse belegt.`,
          });
        }
        if (verschiebeAufPruefen(l.id, l.name, neueEinstufung, dryRun)) raus.aus_interessiert_geholt++;
      }
    }

    if (!optOut) continue;

    // Ab hier: Widerspruch oder Absage. Beide Adressen sperren – die des Absenders
    // und die, an die wir geschrieben haben.
    const lead = r.lead_id
      ? db.prepare('SELECT id, name, email, status FROM leads WHERE id = ?').get(r.lead_id) as
          { id: string; name: string; email: string | null; status: string } | undefined
      : undefined;

    const adressen = [r.from_email, lead?.email]
      .map(a => (a || '').trim().toLowerCase())
      .filter((a, i, arr) => a && arr.indexOf(a) === i);

    // Nur wirklich Neues anfassen. Die Reparatur läuft bei jedem Start; ohne diese
    // Prüfung stünde nach zehn Neustarts zehnmal dieselbe Sperr-Notiz in der Historie.
    const offen = adressen.filter(a => !isSuppressed(a));
    for (const a of offen) {
      if (!dryRun) suppressEmail(a, `Nachträglich erkannt: "${optOut.phrase}" in der Antwort`, 'reparatur');
      raus.gesperrt.push(a);
    }

    if (!lead) continue;

    const zielStatus = optOut.hard ? 'do_not_contact' : 'no_interest';
    if (!dryRun && lead.status !== zielStatus) {
      updateLeadStatus(lead.id, zielStatus as never, {
        notiz: `Nachträglich erkannt: "${optOut.phrase}". Die Antwort war kodiert gespeichert und wurde falsch eingestuft.`,
      });
    }

    // Und aus einer Interessenten-Stage herausholen. Dort zu stehen wäre nicht nur
    // falsch, sondern gefährlich: Ein Klick auf „Termin anbahnen" würde eine Mail
    // an jemanden schicken, der ausdrücklich widersprochen hat.
    const run = db.prepare(
      `SELECT r.id, r.node_id, r.workflow_id FROM workflow_runs r
       WHERE r.lead_id = ? AND r.status = 'active' LIMIT 1`
    ).get(lead.id) as { id: string; node_id: string | null; workflow_id: string } | undefined;

    if (run && run.node_id && /_int\d*$/.test(run.node_id)) {
      const ziel = run.node_id.replace(/_int(\d*)$/, '_kein$1');
      const gibtEs = db.prepare('SELECT graph FROM workflows WHERE id = ?').get(run.workflow_id) as { graph: string } | undefined;
      const vorhanden = gibtEs ? String(gibtEs.graph).includes(`"${ziel}"`) : false;
      if (vorhanden && !dryRun) {
        db.prepare(`UPDATE workflow_runs SET node_id = ?, updated_at = datetime('now') WHERE id = ?`).run(ziel, run.id);
        logWorkflow({
          run_id: run.id, lead_id: lead.id, lead_name: lead.name, node_id: ziel,
          action: 'Falsch als Interessent einsortiert – korrigiert', level: 'warn',
          detail: `Die Antwort war kodiert gespeichert. Im Klartext: "${optOut.phrase}". Adresse gesperrt.`,
        });
      }
      if (vorhanden) raus.aus_interessiert_geholt++;
    }
  }

  return raus;
}

/** Beim Start einmal durchlaufen – still, wenn nichts zu tun ist. */
export function runReplyRepairOnBoot(): void {
  try {
    const r = repairStoredReplies(false);
    if (r.entschluesselt || r.neu_eingestuft || r.gesperrt.length) {
      console.log(`[antwort-reparatur] ${r.geprueft} Antworten geprueft · ${r.entschluesselt} entschluesselt · `
        + `${r.neu_eingestuft} neu eingestuft · ${r.gesperrt.length} Adresse(n) gesperrt · `
        + `${r.aus_interessiert_geholt} faelschlich als Interessent gefuehrt`);
      for (const a of r.gesperrt) console.log(`[antwort-reparatur] GESPERRT: ${a}`);
    }
  } catch (err) {
    console.error('[antwort-reparatur] fehlgeschlagen:', err instanceof Error ? err.message : err);
  }
}
