import { getDb } from '../db/schema';
import { Lead } from '../types';
import { Workflow, findNode, logWorkflow } from './schema';
import { startRun } from './enroll';
import { parseTs } from './reactions';
import { detectOptOut } from './optout';
import { v4 as uuid } from 'uuid';

// ─────────────────────────────────────────────────────────────────────────────
// Bestandsdaten einsortieren.
//
// Der Bestand ist über Monate gewachsen: manche Leads wurden angeschrieben, andere
// haben geantwortet, wieder andere sind Kunde geworden. Diese Datei ordnet JEDEN
// bestehenden Lead anhand seiner echten Daten der richtigen Stage zu, damit die
// Strategie nicht bei Null anfängt und niemand eine Erstmail doppelt bekommt.
//
// Grundsätze:
//   • Nichts wird gelöscht oder überschrieben – es entstehen nur Läufe.
//   • Wer schon angeschrieben wurde, startet NIE wieder bei „Erstkontakt".
//   • Die nächste Fälligkeit wird aus der letzten Berührung berechnet, damit nach
//     dem Einsortieren nicht sofort ein Schwall Mails rausgeht.
// ─────────────────────────────────────────────────────────────────────────────

export interface BackfillPlanRow {
  node_id: string;
  node_title: string;
  count: number;
  reason: string;
}

export interface BackfillResult {
  total: number;
  assigned: number;
  skipped: number;
  rows: BackfillPlanRow[];
  dryRun: boolean;
  /** Angeschriebene Adressen ohne Lead – wiederhergestellt, damit nichts verloren geht. */
  recovered: { found: number; created: number };
}

interface Placement { node: string; reason: string; dueAt: string }

interface LeadFacts extends Lead {
  emails_sent: number;
  last_send_at: string | null;
  emails_by_address: number;
  last_send_by_address: string | null;
  has_reply: number;
  bounced: number;
  last_reply_cat: string | null;
  last_reply_subject: string | null;
  last_reply_snippet: string | null;
}

/** Alle Leads mit den Kennzahlen, die für die Einordnung nötig sind. */
function leadFacts(track: string): LeadFacts[] {
  return getDb().prepare(
    `SELECT l.*,
            (SELECT COUNT(*) FROM sent_emails se WHERE se.lead_id = l.id AND se.success = 1) AS emails_sent,
            (SELECT MAX(se.sent_at) FROM sent_emails se WHERE se.lead_id = l.id AND se.success = 1) AS last_send_at,
            -- Zusätzlich über die ADRESSE zählen: Bulk- und Kampagnen-Mails wurden
            -- teils ohne lead_id gespeichert. Ohne diesen Abgleich wäre ein längst
            -- angeschriebener Betrieb im Board unsichtbar (weder Stage noch wartend).
            (SELECT COUNT(*) FROM sent_emails se WHERE se.success = 1 AND l.email IS NOT NULL AND l.email != ''
                AND LOWER(TRIM(se.to_email)) = LOWER(TRIM(l.email))) AS emails_by_address,
            (SELECT MAX(se.sent_at) FROM sent_emails se WHERE se.success = 1 AND l.email IS NOT NULL AND l.email != ''
                AND LOWER(TRIM(se.to_email)) = LOWER(TRIM(l.email))) AS last_send_by_address,
            (SELECT COUNT(*) FROM inbound_replies r WHERE r.lead_id = l.id AND r.category != 'auto_reply') AS has_reply,
            (SELECT r.category FROM inbound_replies r WHERE r.lead_id = l.id ORDER BY r.uid DESC LIMIT 1) AS last_reply_cat,
            (SELECT r.subject  FROM inbound_replies r WHERE r.lead_id = l.id ORDER BY r.uid DESC LIMIT 1) AS last_reply_subject,
            (SELECT r.snippet  FROM inbound_replies r WHERE r.lead_id = l.id ORDER BY r.uid DESC LIMIT 1) AS last_reply_snippet,
            (SELECT COUNT(*) FROM sent_emails se WHERE se.lead_id = l.id AND se.delivery_status = 'bounced') AS bounced
     FROM leads l
     WHERE COALESCE(l.track,'voice_agent') = ?
       -- Aussortierte Status werden übersprungen – ABER nie, wenn die Firma bereits
       -- angeschrieben wurde. Wer eine Mail von uns hat, gehört in die Strategie.
       AND (COALESCE(l.status,'') NOT IN ('duplicate','archived','not_suitable','missing_data')
            OR EXISTS (SELECT 1 FROM sent_emails se WHERE se.success = 1
                       AND l.email IS NOT NULL AND l.email != ''
                       AND LOWER(TRIM(se.to_email)) = LOWER(TRIM(l.email))))
       AND l.id NOT IN (SELECT lead_id FROM workflow_runs WHERE status = 'active')`
  ).all(track) as LeadFacts[];
}

/** Wartezeit nach der jeweiligen Stufe – spiegelt die Wartezeiten im Standardgraphen. */
const GAP_DAYS = [3, 5, 6, 7];

function dueFromLastTouch(lead: LeadFacts, stage: number): string {
  const last = Math.max(parseTs(lead.last_send_at), parseTs(lead.last_send_by_address))
    || parseTs(lead.updated_at) || Date.now();
  const gap = (GAP_DAYS[Math.min(stage, GAP_DAYS.length - 1)] || 3) * 86_400_000;
  // Nie in der Vergangenheit stapeln: frühestens in 5 Minuten, damit der Versand
  // gestaffelt anläuft statt alles auf einmal.
  return new Date(Math.max(last + gap, Date.now() + 5 * 60_000)).toISOString();
}

/**
 * Bestimmt anhand der vorhandenen Daten, wo ein Lead im Graphen steht.
 * Reihenfolge = Priorität: Abschluss → Absage → Termin → Antwort → Sonderfall → Sequenz.
 */
export function placeLead(lead: LeadFacts, nodeIds: Set<string>): Placement | null {
  const hold = new Date(Date.now() + 5 * 60_000).toISOString();
  const has = (id: string) => nodeIds.has(id);

  if (lead.status === 'won' && has('alt_kunde')) return { node: 'alt_kunde', reason: 'Kunde gewonnen', dueAt: hold };
  if (lead.status === 'lost' && has('alt_kein_kunde')) return { node: 'alt_kein_kunde', reason: 'Als verloren markiert', dueAt: hold };
  if ((lead.status === 'no_interest' || lead.status === 'do_not_contact') && has('alt_kein1')) {
    return { node: 'alt_kein1', reason: 'Absage vorhanden', dueAt: hold };
  }
  if (lead.status === 'proposal_sent' && has('int_angebot')) return { node: 'int_angebot', reason: 'Angebot raus', dueAt: hold };
  if (lead.status === 'demo_booked' && has('alt_gespraech')) return { node: 'alt_gespraech', reason: 'Termin gebucht', dueAt: hold };
  if (lead.status === 'replied' && has('alt_int1')) return { node: 'alt_int1', reason: 'Hat geantwortet', dueAt: hold };

  if (lead.bounced && has('alt_sonder')) return { node: 'alt_sonder', reason: 'Adresse unzustellbar', dueAt: hold };

  // Antwort im Postfach, die nie in den Status übernommen wurde: Inhalt entscheidet.
  // Eine Absage darf NICHT als heiße Spur einsortiert werden.
  if (lead.last_reply_cat) {
    const optOut = detectOptOut(lead.last_reply_subject || '', lead.last_reply_snippet || '');
    if ((optOut || lead.last_reply_cat === 'not_interested') && has('alt_kein1')) {
      return { node: 'alt_kein1', reason: 'Absage im Postfach', dueAt: hold };
    }
    if (lead.has_reply && has('alt_int1')) return { node: 'alt_int1', reason: 'Antwort im Postfach', dueAt: hold };
  }

  // Wiedervorlage vom Menschen gesetzt → dort abholen.
  if (lead.wiedervorlage_at && parseTs(lead.wiedervorlage_at) > Date.now() && has('alt_wv')) {
    return { node: 'alt_wv', reason: 'Wiedervorlage gesetzt', dueAt: lead.wiedervorlage_at };
  }

  // Angeschrieben, keine Reaktion: in die NEUANLAUF-Spur, und zwar genau dort, wo
  // die alte Kampagne aufgehört hat. Die Zahl kommt aus drei Quellen, weil keine
  // allein vollständig ist:
  //   • sent_emails über lead_id (sauber verknüpfte Sends)
  //   • sent_emails über die Adresse (Bulk-Versand ohne lead_id)
  //   • followup_stage/Status aus der Zeit vor dem Sende-Log
  //
  // Rechnung dahinter: alte + neue Mails zusammen bleiben bei rund vier pro Adresse.
  //   1 alte Mail  → 3 neue (Neuanlauf 1–3)
  //   2 alte Mails → 2 neue (Neuanlauf 2–3)
  //   3 alte Mails → 1 neue (nur der Schlusspunkt)
  //   4+ alte      → KEINE weitere Mail; der Mensch entscheidet (Anruf/Reaktivierung)
  const sent = Math.max(
    lead.emails_sent || 0,
    lead.emails_by_address || 0,
    (lead.followup_stage || 0) + (lead.status === 'contacted' ? 1 : 0),
  );
  if (sent > 0) {
    if (sent >= 4 && has('alt_ende')) {
      return { node: 'alt_ende', reason: `${sent} Mails gesendet – Grenze erreicht, keine weitere Mail`, dueAt: hold };
    }
    const lane = ['alt_mail1', 'alt_mail2', 'alt_mail3'];
    const stufe = Math.min(sent, lane.length);
    const target = lane[stufe - 1];
    const restMails = lane.length - (stufe - 1);
    if (has(target)) {
      return {
        node: target,
        reason: `${sent} alte Mail(s) – Neuanlauf ab Stufe ${stufe} (${restMails} neue)`,
        dueAt: dueFromLastTouch(lead, sent - 1),
      };
    }
  }

  // Noch nie kontaktiert: nicht einsortieren – der Start-Knoten nimmt sie regulär auf,
  // damit Tageslimit und Sendefenster greifen.
  return null;
}

/**
 * Stellt Leads für Adressen wieder her, an die wir gesendet haben, zu denen es
 * aber keinen Lead (mehr) gibt – etwa aus Bulk-Versand ohne Lead-Bezug oder weil
 * der Lead später gelöscht wurde.
 *
 * Ohne diesen Schritt wären genau die Firmen unsichtbar, in die schon Arbeit und
 * Zustellkosten geflossen sind: angeschrieben, aber in keiner Stage, in keiner
 * Auswertung, in keiner Nachfassliste.
 */
export function recoverOrphanRecipients(track: string, dryRun = true): { found: number; created: number } {
  const db = getDb();
  const rows = db.prepare(
    `SELECT LOWER(TRIM(se.to_email)) AS email,
            MAX(COALESCE(se.to_name, '')) AS name,
            COUNT(*) AS mails,
            MAX(se.sent_at) AS last_send
     FROM sent_emails se
     WHERE se.success = 1 AND se.to_email IS NOT NULL AND se.to_email != ''
       AND LOWER(TRIM(se.to_email)) NOT IN (
         SELECT LOWER(TRIM(email)) FROM leads WHERE email IS NOT NULL AND email != ''
       )
     GROUP BY LOWER(TRIM(se.to_email))`
  ).all() as Array<{ email: string; name: string; mails: number; last_send: string }>;

  if (dryRun || !rows.length) return { found: rows.length, created: 0 };

  const insert = db.prepare(
    `INSERT INTO leads (id, name, branche, stadt, email, email_normalized, status, prioritaet,
                        hat_website, track, bester_kanal, kontakt_hinweis, contacted_at, notiz)
     VALUES (@id, @name, 'Unbekannt', 'Unbekannt', @email, @email, 'contacted', 'B',
             0, @track, 'email', 'Aus dem Sendeprotokoll wiederhergestellt', @last_send, @notiz)`
  );
  const tx = db.transaction(() => {
    for (const r of rows) {
      insert.run({
        id: uuid(),
        name: r.name?.trim() || r.email.split('@')[1] || r.email,
        email: r.email,
        track,
        last_send: r.last_send,
        notiz: `${r.mails} Mail(s) aus der alten Kampagne, zuletzt ${String(r.last_send).slice(0, 10)}`,
      });
    }
  });
  tx();
  return { found: rows.length, created: rows.length };
}

export function backfillWorkflow(wf: Workflow, dryRun = true): BackfillResult {
  const nodeIds = new Set(wf.graph.nodes.map(n => n.id));
  const recovered = recoverOrphanRecipients(wf.track, dryRun);
  const leads = leadFacts(wf.track);
  const buckets = new Map<string, BackfillPlanRow>();
  let assigned = 0, skipped = 0;

  const apply = getDb().transaction((items: Array<{ lead: LeadFacts; place: Placement }>) => {
    for (const { lead, place } of items) {
      startRun(wf.id, lead.id, null, place.node, place.dueAt);
    }
  });

  const toApply: Array<{ lead: LeadFacts; place: Placement }> = [];
  for (const lead of leads) {
    const place = placeLead(lead, nodeIds);
    if (!place) { skipped++; continue; }
    assigned++;
    toApply.push({ lead, place });
    const key = place.node + '|' + place.reason;
    const row = buckets.get(key);
    if (row) row.count++;
    else buckets.set(key, { node_id: place.node, node_title: findNode(wf.graph, place.node)?.title ?? place.node, count: 1, reason: place.reason });
  }

  if (!dryRun && toApply.length) {
    apply(toApply);
    logWorkflow({
      action: 'Bestandsdaten einsortiert',
      detail: `${assigned} Leads auf ihre Stage gesetzt, ${skipped} bleiben für den regulären Start`,
      level: 'hot',
    });
  }

  return {
    total: leads.length,
    assigned,
    skipped,
    dryRun,
    recovered,
    rows: [...buckets.values()].sort((a, b) => b.count - a.count),
  };
}
