import { getDb } from '../db/schema';
import { getTemplateById, renderTemplate } from './template';
import { SendJob, GLOBAL_DAILY_CAP, warmupDailyLimit, naechsteLeads, PROBE_STATUS } from './auto-sender';
import { versandGestoppt } from './mailer';
import { v4 as uuid } from 'uuid';

// ─────────────────────────────────────────────────────────────────────────────
// Der Auto-Versand als Probelauf: man sieht jede einzelne Mail, es geht keine raus.
//
// Am 20.–22.08. bekamen 41 Praxen je rund 23 Mails, weil die volle Platte das
// Protokoll blockierte: der Versand galt als "nicht gesendet" und wurde wieder
// und wieder wiederholt. Nach so einem Vorfall reicht es nicht, den Versand
// einfach wieder anzuschalten. Man muss ihn erst trocken laufen lassen und mit
// eigenen Augen sehen, WER Post bekaeme, WAS drinsteht und WANN sie rausginge –
// bevor die erste echte Mail den Server verlaesst.
//
// Der Probelauf nimmt exakt dieselbe Lead-Auswahl, dieselben Vorlagen und
// dieselben Schutzlimits wie der echte Versand (Sendefenster, Tageslimit,
// Aufwaermrampe, globales Limit 200). Nur der letzte Schritt fehlt: es wird
// nichts verschickt.
//
// Was der Probelauf NICHT anfasst, und zwar bewusst:
//   • sent_emails      – sonst gaelten die Praxen als kontaktiert
//   • leads            – kein Status, kein gesendet_at
//   • outreach_events  – keine erfundene Historie
//   • scheduled_emails – nichts wird eingeplant
// Damit verfaelscht ein Probelauf keine einzige Auswertung. Er liegt allein in
// probe_versand und laesst sich mit einem Klick spurlos loeschen.
// ─────────────────────────────────────────────────────────────────────────────

export { PROBE_STATUS };

export interface ProbeZeile {
  id: string;
  job_id: string;
  lead_id: string | null;
  to_email: string;
  to_name: string | null;
  branche: string | null;
  stadt: string | null;
  template_id: string | null;
  template_name: string | null;
  subject: string | null;
  body: string | null;
  geplant_um: string;
}

export interface ProbeBericht {
  job_id: string;
  geplant: number;
  adressen: number;
  doppelt: number;
  von: string | null;
  bis: string | null;
  tage: number;
  vorlagen: Array<{ name: string; n: number }>;
  branchen: Array<{ branche: string; n: number }>;
  gewuenscht: number;
  fehlend: number;
}

let bereit = false;
function schema(): void {
  if (bereit) return;
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS probe_versand (
      id            TEXT PRIMARY KEY,
      job_id        TEXT NOT NULL,
      lead_id       TEXT,
      to_email      TEXT NOT NULL,
      to_name       TEXT,
      branche       TEXT,
      stadt         TEXT,
      template_id   TEXT,
      template_name TEXT,
      subject       TEXT,
      body          TEXT,
      geplant_um    TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_probe_job ON probe_versand(job_id);
  `);
  bereit = true;
}

/**
 * Wann ginge Mail Nr. 1, 2, 3 … raus? Rechnet mit denselben Bremsen wie der
 * echte Versand: Sendefenster, Pause zwischen Mails, Tageslimit inklusive
 * Aufwaermrampe und dem harten globalen Limit von 200 pro Tag.
 */
export function planZeiten(job: SendJob, anzahl: number, jetzt = new Date()): Date[] {
  const start = job.next_send_at && new Date(job.next_send_at) > jetzt ? new Date(job.next_send_at) : new Date(jetzt);
  const pause = Math.max(15, Math.round(((job.min_gap_s || 30) + (job.max_gap_s || 45)) / 2));
  const proTag = Math.max(1, Math.min(warmupDailyLimit(job), GLOBAL_DAILY_CAP));
  const von = Math.max(0, Math.min(23, job.window_start));
  const bis = Math.max(von + 1, Math.min(24, job.window_end));

  const raus: Date[] = [];
  const zaehler = new Map<string, number>();
  const t = new Date(start);
  const naechsterTag = () => { t.setDate(t.getDate() + 1); t.setHours(von, 0, 0, 0); };

  for (let i = 0; i < anzahl; i++) {
    // Ins Sendefenster schieben und das Tageslimit beachten. Jede Korrektur
    // springt hoechstens einen Tag weiter, der Durchlauf endet also immer.
    for (let schutz = 0; schutz < 400; schutz++) {
      if (t.getHours() < von) { t.setHours(von, 0, 0, 0); continue; }
      if (t.getHours() >= bis) { naechsterTag(); continue; }
      if ((zaehler.get(t.toDateString()) || 0) >= proTag) { naechsterTag(); continue; }
      break;
    }
    raus.push(new Date(t));
    const tag = t.toDateString();
    zaehler.set(tag, (zaehler.get(tag) || 0) + 1);
    t.setTime(t.getTime() + pause * 1000);
  }
  return raus;
}

/**
 * Fuehrt den Probelauf aus: waehlt die Empfaenger, rendert jede Mail fertig und
 * legt sie zum Ansehen ab. Kein Versand, kein Schreiben ausserhalb probe_versand.
 */
export function probeLauf(job: SendJob): ProbeBericht {
  schema();
  const db = getDb();
  const ziel = Math.max(1, job.total_target);

  // Grosszuegig auswaehlen und danach je Adresse nur einmal behalten: dieselbe
  // Praxis steht oft als mehrere Lead-Zeilen in der Datenbank, und genau eine
  // Mail pro Adresse ist der ganze Punkt.
  const roh = naechsteLeads(job, Math.min(5000, ziel * 2 + 50));
  const gesehen = new Set<string>();
  const leads = roh.filter(l => {
    const e = (l.email || '').trim().toLowerCase();
    if (!e || gesehen.has(e)) return false;
    gesehen.add(e);
    return true;
  }).slice(0, ziel);

  let vorlagen: string[] = [];
  try { vorlagen = JSON.parse(job.template_ids || '[]'); } catch { /* gleich unten abgefangen */ }

  // Vorlagen zuerst auflösen, bevor eine einzige Zeile geschrieben wird. Fehlt
  // eine, würde der echte Versand an dieser Stelle pausieren – dann darf der
  // Probelauf nicht so tun, als sei alles in Ordnung, und schon gar nicht
  // stillschweigend auf eine andere Vorlage ausweichen. Eine Vorschau voller
  // Platzhalter-Texte ist schlimmer als eine klare Fehlermeldung: sie sieht aus
  // wie eine fertige Liste, und danach startet jemand den echten Versand.
  if (!vorlagen.length) throw new Error('Keine Vorlage ausgewählt.');
  const aufgeloest = vorlagen.map(id => ({ id, tpl: getTemplateById(id) }));
  const fehlend = aufgeloest.filter(v => !v.tpl).map(v => v.id);
  if (fehlend.length) {
    throw new Error(
      `Diese Vorlage${fehlend.length > 1 ? 'n gibt' : ' gibt'} es nicht: ${fehlend.join(', ')}. `
      + 'Der echte Versand würde hier pausieren. Unter „Vorlagen" prüfen, dann erneut starten.'
    );
  }

  const zeiten = planZeiten(job, leads.length);
  const einfuegen = db.prepare(
    `INSERT INTO probe_versand (id, job_id, lead_id, to_email, to_name, branche, stadt, template_id, template_name, subject, body, geplant_um)
     VALUES (@id, @job_id, @lead_id, @to_email, @to_name, @branche, @stadt, @template_id, @template_name, @subject, @body, @geplant_um)`
  );
  const schreiben = db.transaction((zeilen: ProbeZeile[]) => { for (const z of zeilen) einfuegen.run(z); });

  const zeilen: ProbeZeile[] = leads.map((lead, i) => {
    const tpl = aufgeloest[i % aufgeloest.length].tpl!;
    const gerendert = renderTemplate(tpl, {
      name: lead.name, branche: lead.branche, stadt: lead.stadt, ansprechpartner: lead.geschaeftsfuehrer,
    });
    return {
      id: uuid(),
      job_id: job.id,
      lead_id: lead.id,
      to_email: (lead.email || '').trim().toLowerCase(),
      to_name: lead.name ?? null,
      branche: lead.branche ?? null,
      stadt: lead.stadt ?? null,
      template_id: tpl.id,
      template_name: tpl.name,
      subject: gerendert.subject,
      body: gerendert.body,
      geplant_um: zeiten[i].toISOString(),
    };
  });

  schreiben(zeilen);
  return probeBericht(job.id, ziel);
}

export function probeBericht(jobId: string, gewuenscht = 0): ProbeBericht {
  schema();
  const db = getDb();
  const k = db.prepare(
    `SELECT COUNT(*) geplant, COUNT(DISTINCT to_email) adressen, MIN(geplant_um) von, MAX(geplant_um) bis,
            COUNT(DISTINCT date(geplant_um)) tage
     FROM probe_versand WHERE job_id = ?`
  ).get(jobId) as { geplant: number; adressen: number; von: string | null; bis: string | null; tage: number };
  const vorlagen = db.prepare(
    `SELECT COALESCE(template_name,'?') name, COUNT(*) n FROM probe_versand WHERE job_id = ? GROUP BY name ORDER BY n DESC`
  ).all(jobId) as Array<{ name: string; n: number }>;
  const branchen = db.prepare(
    `SELECT COALESCE(branche,'ohne Branche') branche, COUNT(*) n FROM probe_versand WHERE job_id = ? GROUP BY branche ORDER BY n DESC LIMIT 12`
  ).all(jobId) as Array<{ branche: string; n: number }>;
  return {
    job_id: jobId,
    geplant: k.geplant,
    adressen: k.adressen,
    doppelt: k.geplant - k.adressen,
    von: k.von,
    bis: k.bis,
    tage: k.tage,
    vorlagen,
    branchen,
    gewuenscht,
    fehlend: Math.max(0, gewuenscht - k.geplant),
  };
}

export function probeZeilen(jobId: string, limit = 500): ProbeZeile[] {
  schema();
  return getDb().prepare(
    `SELECT id, job_id, lead_id, to_email, to_name, branche, stadt, template_id, template_name, subject, body, geplant_um
     FROM probe_versand WHERE job_id = ? ORDER BY geplant_um ASC LIMIT ?`
  ).all(jobId, limit) as ProbeZeile[];
}

export function probeLoeschen(jobId?: string): number {
  schema();
  const db = getDb();
  return jobId
    ? db.prepare('DELETE FROM probe_versand WHERE job_id = ?').run(jobId).changes
    : db.prepare('DELETE FROM probe_versand').run().changes;
}

/**
 * Muss dieser Job zwingend ein Probelauf sein? Solange der Not-Aus laeuft: ja.
 * Die Entscheidung liegt bewusst hier und nicht im Browser – ein Haekchen im
 * Dashboard darf den Stopp nicht aushebeln.
 */
export function probelaufErzwungen(): boolean {
  return versandGestoppt();
}
