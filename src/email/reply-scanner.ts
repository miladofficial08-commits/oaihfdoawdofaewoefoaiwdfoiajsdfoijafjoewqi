import { getDb } from '../db/schema';
import { fetchInboxEmails, InboxEmail, purgeInboxNoise } from './inbox';
import { updateLeadStatus, recordOutreachEvent } from '../db/leads-repo';
import { LeadStatus } from '../types';
import { isNoise } from './noise-filter';
import { detectOptOut } from '../workflow/optout';

// ─────────────────────────────────────────────────────────────────────────────
// Antwort-Scanner: liest eingehende Antworten aus dem Postfach, ordnet sie dem
// angeschriebenen Lead zu, klassifiziert den Inhalt (Interesse / kein Interesse /
// Rückfrage) und zieht die Konsequenz:
//
//   • JEDE echte menschliche Antwort  → Follow-up wird dauerhaft gestoppt.
//     (Wer geantwortet hat, bekommt nie wieder eine automatische Nachfass-Mail.)
//   • "Kein Interesse"                → Status 'no_interest' + Adresse gesperrt,
//     damit auch der Auto-Versand sie nie erneut anschreibt.
//   • Interesse / Rückfrage           → Status 'replied' (heißer Lead, Mensch übernimmt).
//   • Auto-Antwort (Abwesenheit/Urlaub) → NUR geloggt, kein Stopp (kein echter Mensch).
//
// Idempotent über die Postfach-UID: dieselbe Nachricht wird nie doppelt verarbeitet.
// ─────────────────────────────────────────────────────────────────────────────

export type ReplyCategory = 'not_interested' | 'interested' | 'question' | 'unknown' | 'auto_reply';

export interface ReplyClassification {
  category: ReplyCategory;
  confidence: number; // 0–100, grobe Sicherheit der Heuristik
  reason: string;     // welches Signal ausgelöst hat (fürs Dashboard/Debug)
}

const norm = (s: string): string =>
  (s || '').toLowerCase().replace(/[äöüß]/g, m => ({ ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' }[m] || m));

// Auto-Antworten zuerst erkennen – ein Abwesenheits-Autoresponder ist KEINE echte
// Reaktion und darf das Follow-up nicht stoppen.
const AUTO_REPLY = [
  'abwesend', 'abwesenheit', 'out of office', 'outofoffice', 'automatische antwort',
  'automatische bestaetigung', 'auto-reply', 'autoreply', 'nicht im buero', 'nicht im hause',
  'im urlaub', 'bin bis', 'bin ab', 'erreichen sie mich wieder', 'urlaubsvertretung',
  'automatisch generiert', 'do not reply', 'noreply', 'no-reply',
  // Eingangsbestaetigungen. Bewusst nur mit eindeutigem Marker – ein blosses
  // „vielen Dank fuer Ihre Nachricht" schreiben auch echte Menschen, und eine
  // echte Antwort als Auto-Antwort abzutun waere der schlimmere Fehler.
  'eingangsbestaetigung', 'schnellstmoeglich bearbeiten', 'schnellstmoeglich bearbeitet',
  'wir werden diese schnellstmoeglich', 'ihre anfrage ist bei uns eingegangen',
  'ihre nachricht ist bei uns eingegangen', 'wir haben ihre anfrage erhalten',
  'wir haben ihre nachricht erhalten', 'dies ist eine automatische',
  'diese e-mail wurde automatisch', 'diese nachricht wurde automatisch',
];

// Klares Desinteresse – stärkstes Geschäftssignal, hat Vorrang vor "interessiert".
const NOT_INTERESTED = [
  'kein interesse', 'keine interesse', 'keinerlei interesse', 'nicht interessiert',
  'kein bedarf', 'keinen bedarf', 'nein danke', 'nein, danke', 'nee danke', 'nee, danke',
  'danke, aber', 'leider kein', 'besteht kein interesse',
  'derzeit kein interesse', 'aktuell kein interesse', 'momentan kein interesse',
  'bitte keine weiteren', 'keine weiteren mails', 'keine weiteren e-mails', 'keine werbung',
  'nicht kontaktieren', 'nicht mehr kontaktieren', 'bitte um loeschung', 'bitte loeschen',
  'austragen', 'abmelden', 'unsubscribe', 'from our list', 'no interest', 'not interested',
];

// Positives Signal – Interesse / Gesprächswunsch.
const INTERESTED = [
  'interesse', 'interessiert', 'gerne', 'gern', 'mehr erfahren', 'mehr informationen',
  'termin', 'rueckruf', 'rufen sie', 'melden sie sich', 'callback', 'demo', 'vorstellen',
  'angebot', 'preis', 'preise', 'kosten', 'was kostet', 'konditionen', 'ja, gerne', 'ja gerne',
  'klingt interessant', 'passt', 'lass uns', 'lassen sie uns',
];

const QUESTION = ['frage', 'fragen', 'wie funktioniert', 'wie laeuft', 'koennen sie', 'was genau'];

function hit(haystack: string, needles: string[]): string | null {
  for (const n of needles) if (haystack.includes(n)) return n;
  return null;
}

/**
 * Klassifiziert eine Antwort rein aus Betreff + Text (deutsche Heuristik).
 * Reihenfolge = Priorität: Auto-Antwort → kein Interesse → Interesse → Rückfrage → unbekannt.
 * Exportiert, damit die Logik ohne Postfach testbar ist.
 */
export function classifyReply(subject: string, body: string): ReplyClassification {
  const text = norm(`${subject}\n${body}`);

  const auto = hit(text, AUTO_REPLY);
  if (auto) return { category: 'auto_reply', confidence: 80, reason: `Auto-Antwort erkannt ("${auto}")` };

  const neg = hit(text, NOT_INTERESTED);
  if (neg) return { category: 'not_interested', confidence: 90, reason: `Absage erkannt ("${neg}")` };

  const pos = hit(text, INTERESTED);
  if (pos) return { category: 'interested', confidence: 75, reason: `Interesse erkannt ("${pos}")` };

  // Rückfrage-Signale NUR im Text suchen, und mit Wortgrenzen.
  //
  // Der Betreff ist zum grössten Teil unser eigener: „Kurze Nachfrage, …",
  // „Ihre Anfrage". Beide enthalten „frage" – als Teilstring gelesen wurde damit
  // praktisch jede Antwort zur „Rückfrage" gestempelt, egal was drinstand.
  const koerper = norm(body);
  const q = QUESTION.find(w => new RegExp('\\b' + w + '\\b').test(koerper)) ?? null;
  if (q || /\?/.test(body)) return { category: 'question', confidence: 55, reason: q ? `Rückfrage erkannt ("${q}")` : 'Fragezeichen im Text' };

  return { category: 'unknown', confidence: 30, reason: 'Kein eindeutiges Signal – Antwort trotzdem als Reaktion gewertet' };
}

// ── Filter: was ist gar keine echte Antwort? ────────────────────────────────
function isDeliveryNotification(m: InboxEmail): boolean {
  return (
    /mailer-daemon|postmaster|delivery status|mail delivery|delivery subsystem/i.test(m.from + ' ' + m.fromName) ||
    /delivery status notification|undelivered|delivery has failed|failure notice|zustellung fehlgeschlagen|unzustellbar/i.test(m.subject)
  );
}

function ownAddresses(): Set<string> {
  return new Set(
    [process.env.SMTP_USER, process.env.IMAP_USER, process.env.SMTP_FROM, 'info@tawano.de']
      .map(a => (a || '').trim().toLowerCase())
      .filter(Boolean)
  );
}

interface MatchedLead {
  id: string; name: string; status: LeadStatus; followup_stopped: number | null;
  /** Die Adresse, die wir angeschrieben haben – nicht zwingend die, von der geantwortet wurde. */
  email?: string | null;
  /** true = über die Firmen-Domain zugeordnet, nicht über die exakte Adresse. */
  viaDomain?: boolean;
}

/**
 * Freemail- und Provider-Domains. Hier darf NIE über die Domain zugeordnet werden:
 * hinter @gmail.com stecken Millionen Fremde, nicht eine Firma. Manche Betriebe
 * nutzen so eine Adresse geschäftlich – die trifft dann weiterhin der exakte
 * Abgleich, nur eben nicht die Domain-Regel.
 */
const FREEMAIL = new Set([
  'gmail.com', 'googlemail.com', 'gmx.de', 'gmx.net', 'gmx.at', 'gmx.ch', 'web.de',
  't-online.de', 'outlook.com', 'outlook.de', 'hotmail.com', 'hotmail.de', 'live.de',
  'live.com', 'yahoo.com', 'yahoo.de', 'icloud.com', 'me.com', 'aol.com', 'aol.de',
  'freenet.de', 'mail.de', 'posteo.de', 'mailbox.org', 'arcor.de', 'online.de',
  'unity-mail.de', 'vodafone.de', 'ok.de', 'gmx.com', 'protonmail.com', 'proton.me',
]);

const domainOf = (email: string): string => (email.split('@')[1] || '').trim().toLowerCase();

/**
 * Findet den Lead zu einer Absenderadresse – nur wenn wir ihn tatsächlich angeschrieben haben.
 *
 * Der dritte Schritt ist der wichtige: Wir schreiben an info@firma.de, und der
 * Chef antwortet von chef@firma.de. Ohne Domain-Abgleich sieht die Kampagne diese
 * Antwort NICHT – sie schickt dem Mann, der gerade geantwortet hat, anschliessend
 * noch „Letzter Versuch". Das ist der peinlichste Fehler, den dieses System machen
 * kann, und er ist im Bestand messbar haeufig.
 *
 * Streng abgesichert, damit nicht das Gegenteil passiert:
 *   • keine Freemail-Domains (dahinter steht keine Firma)
 *   • nur Domains, an die wir wirklich gesendet haben
 *   • nur wenn GENAU EIN Lead dieser Domain angeschrieben wurde – sonst waere
 *     unklar, welche Firma gemeint ist, und Raten ist hier verboten.
 */
function findLeadForSender(fromEmail: string): MatchedLead | undefined {
  const db = getDb();
  const email = fromEmail.trim().toLowerCase();
  if (!email) return undefined;

  // 1) Über eine tatsächlich versendete Mail (sichere Zuordnung: wir haben ihn kontaktiert).
  const viaSent = db.prepare(
    `SELECT l.id, l.name, l.status, l.followup_stopped, l.email
     FROM sent_emails se JOIN leads l ON l.id = se.lead_id
     WHERE LOWER(TRIM(se.to_email)) = ? AND se.lead_id IS NOT NULL
     ORDER BY se.sent_at DESC LIMIT 1`
  ).get(email) as MatchedLead | undefined;
  if (viaSent) return viaSent;

  // 2) Direkte Übereinstimmung mit der Lead-Adresse.
  const direkt = db.prepare(
    `SELECT id, name, status, followup_stopped, email FROM leads WHERE LOWER(TRIM(email)) = ? LIMIT 1`
  ).get(email) as MatchedLead | undefined;
  if (direkt) return direkt;

  // 3) Gleiche Firma, andere Adresse.
  const domain = domainOf(email);
  if (!domain || FREEMAIL.has(domain)) return undefined;

  const kandidaten = db.prepare(
    `SELECT DISTINCT l.id, l.name, l.status, l.followup_stopped, l.email
     FROM leads l
     WHERE l.email IS NOT NULL AND l.email != ''
       AND LOWER(TRIM(SUBSTR(l.email, INSTR(l.email,'@') + 1))) = @domain
       AND EXISTS (SELECT 1 FROM sent_emails se WHERE se.success = 1
                   AND LOWER(TRIM(se.to_email)) = LOWER(TRIM(l.email)))
     LIMIT 2`
  ).all({ domain }) as MatchedLead[];

  if (kandidaten.length !== 1) return undefined;   // 0 = nie angeschrieben, 2+ = mehrdeutig
  return { ...kandidaten[0], viaDomain: true };
}

/**
 * Antwort, die niemand sicher deuten kann → Aufgabe für einen Menschen.
 *
 * Der Nutzer hat es klar gesagt: Bei unklarem Status soll nichts automatisch
 * passieren, die Sache soll dort landen, wo er selbst nachsehen kann. Genau das
 * ist die Aufgabenliste. Ohne diesen Schritt verschwaende eine echte Antwort
 * im Postfach – oder schlimmer, sie wuerde als Interesse fehlgedeutet.
 */
function legeNachseh_Aufgabe(lead: MatchedLead, von: string, betreff: string, text: string, grund: string): void {
  const db = getDb();
  const titel = `Antwort prüfen: ${lead.name}`.slice(0, 200);
  if (db.prepare(`SELECT 1 FROM tasks WHERE lead_id = ? AND title = ? AND status = 'open' LIMIT 1`).get(lead.id, titel)) return;
  db.prepare(
    `INSERT INTO tasks (id, lead_id, kind, title, note, due_at, status, source)
     VALUES (lower(hex(randomblob(16))), @lead_id, 'todo', @title, @note, datetime('now'), 'open', 'reply-scan')`
  ).run({
    lead_id: lead.id,
    title: titel,
    note: `Von ${von}
Betreff: ${betreff}

${text.slice(0, 600)}

(${grund} – nicht eindeutig, deshalb wurde nichts automatisch gesetzt.)`,
  });
}

function suppress(email: string, reason: string): void {
  const em = email.trim().toLowerCase();
  if (!em) return;
  getDb().prepare(
    `INSERT INTO email_suppression (email_normalized, reason, source)
     VALUES (?, ?, 'reply-scan') ON CONFLICT(email_normalized) DO UPDATE SET reason = excluded.reason, source = excluded.source`
  ).run(em, reason);
}

function stopFollowup(leadId: string, reason: string): void {
  getDb().prepare(
    `UPDATE leads SET followup_stopped = 1, followup_stopped_reason = @reason, updated_at = @now WHERE id = @id`
  ).run({ id: leadId, reason: reason.slice(0, 200), now: new Date().toISOString() });
}

// Status, die eine bereits weiter fortgeschrittene Beziehung NICHT zurückstufen sollen.
const KEEP_STATUS: LeadStatus[] = ['demo_booked', 'proposal_sent', 'won', 'lost', 'do_not_contact', 'archived'];

export interface ScanResult {
  scanned: number;
  processed: number;   // neue, echte Antworten in diesem Lauf
  stopped: number;     // davon: Follow-up gestoppt
  not_interested: number;
  interested: number;
  question: number;
  unknown: number;
  auto_reply: number;
  unmatched: number;   // Antworten ohne zuordenbaren Lead
  error?: string;
}

const emptyResult = (): ScanResult => ({
  scanned: 0, processed: 0, stopped: 0, not_interested: 0, interested: 0,
  question: 0, unknown: 0, auto_reply: 0, unmatched: 0,
});

/**
 * Liest das Postfach, verarbeitet neue Antworten und gibt eine Zusammenfassung zurück.
 * Idempotent: bereits verarbeitete UIDs werden übersprungen.
 */
export async function scanReplies(limit = 60): Promise<ScanResult> {
  const res = emptyResult();
  let mails: InboxEmail[];
  try {
    mails = await fetchInboxEmails(limit);
  } catch (err) {
    return { ...res, error: err instanceof Error ? err.message : 'Posteingang nicht erreichbar' };
  }
  res.scanned = mails.length;

  const db = getDb();
  const seen = db.prepare('SELECT 1 FROM inbound_replies WHERE uid = ?');
  const insert = db.prepare(
    `INSERT OR IGNORE INTO inbound_replies
       (uid, lead_id, from_email, from_name, subject, snippet, category, confidence, reason, followup_stopped, received_at)
     VALUES (@uid, @lead_id, @from_email, @from_name, @subject, @snippet, @category, @confidence, @reason, @followup_stopped, @received_at)`
  );
  const mine = ownAddresses();

  for (const m of mails) {
    const from = (m.from || '').trim().toLowerCase();
    if (!from || mine.has(from)) continue;          // eigene / leere Absender überspringen
    if (isDeliveryNotification(m)) continue;         // Bounces macht der Bounce-Scan
    // Defense-in-depth: fetchInboxEmails filtert Rauschen bereits vor, aber falls
    // jemand die Funktion mal umgeht, verhindern wir hier False-Positive-"heiße Antworten"
    // (z. B. italienische "Verifica profilo"-Challenge → würde Follow-up fälschlich stoppen).
    if (isNoise({ fromEmail: from, fromName: m.fromName, subject: m.subject })) continue;
    if (seen.get(m.uid)) continue;                   // schon verarbeitet (idempotent)

    const cls = classifyReply(m.subject || '', m.body || '');
    const lead = findLeadForSender(from);

    if (!lead) {
      // Unbekannter Absender: einmalig festhalten (kein Lead, keine Wirkung), damit
      // dieselbe Mail nicht bei jedem Lauf erneut auftaucht.
      insert.run({
        uid: m.uid, lead_id: null, from_email: from, from_name: m.fromName || null,
        subject: (m.subject || '').slice(0, 300), snippet: (m.snippet || '').slice(0, 300),
        category: cls.category, confidence: cls.confidence, reason: cls.reason,
        followup_stopped: 0, received_at: m.date || null,
      });
      res.unmatched++;
      continue;
    }

    let followupStopped = 0;
    if (cls.category === 'auto_reply') {
      // Abwesenheitsnotiz: nur protokollieren, Follow-up läuft weiter.
      recordOutreachEvent({
        lead_id: lead.id, event_type: 'note', channel: 'email', user: 'reply-scan',
        note: `Auto-Antwort von ${from}: ${(m.snippet || '').slice(0, 160)}`,
      });
    } else {
      // Echte menschliche Reaktion → Follow-up dauerhaft stoppen.
      followupStopped = 1;
      stopFollowup(lead.id, `Antwort erhalten (${cls.category}) – ${cls.reason}`);

      // Status setzen (fortgeschrittene Beziehungen nicht zurückstufen).
      //
      // NUR bei eindeutigem Signal. Vorher galt jede Antwort ausser einer Absage
      // als 'replied' – und 'replied' ist der Status der Stage „Interessiert".
      // Dadurch landeten Eingangsbestaetigungen, unlesbare Mails und sogar ein
      // „STOP!" als Interessenten im Baum. Ist die Antwort unklar, wird der Status
      // NICHT angefasst; stattdessen entsteht unten eine Aufgabe zum Nachsehen.
      if (!KEEP_STATUS.includes(lead.status)) {
        if (cls.category === 'not_interested') {
          updateLeadStatus(lead.id, 'no_interest' as LeadStatus, {
            notiz: `Absage erkannt: "${(m.snippet || '').slice(0, 200)}"`,
          });
        } else if (cls.category === 'interested') {
          updateLeadStatus(lead.id, 'replied' as LeadStatus, {
            notiz: `Interesse erkannt: "${(m.snippet || '').slice(0, 200)}"`,
          });
        }
      }

      // Unklare Antwort: nichts automatisch entscheiden, sondern vorlegen.
      if (cls.category === 'question' || cls.category === 'unknown') {
        legeNachseh_Aufgabe(lead, from, m.subject || '', m.snippet || '', cls.reason);
      }

      // Klares Desinteresse zusätzlich global sperren (auch Auto-Versand meidet die Adresse).
      //
      // Beide Adressen sperren, nicht nur die des Absenders: Wenn der Chef von
      // chef@firma.de absagt, wir aber an info@firma.de schreiben, wuerde eine
      // Sperre auf chef@ gar nichts bremsen – die Kampagne schriebe munter weiter
      // an info@. Eine Absage gilt der Firma, nicht dem Postfach.
      if (cls.category === 'not_interested') {
        const grund = `Kein Interesse (Antwort): ${(m.snippet || '').slice(0, 120)}`;
        suppress(from, grund);
        if (lead.email && lead.email.trim().toLowerCase() !== from) {
          suppress(lead.email, `${grund} – Absage kam von ${from}`);
        }
      }

      // Rechtsschutz: ein ausdrücklicher Widerspruch (Abmeldung, DSGVO, Anwalt …) sperrt
      // die Adresse IMMER – auch wenn die Heuristik oben die Antwort als Rückfrage
      // eingeordnet hat. Lieber eine Adresse zu viel gesperrt als eine Abmahnung.
      const optOut = detectOptOut(m.subject || '', m.body || '');
      if (optOut?.hard) {
        suppress(from, `Ausdrücklicher Widerspruch ("${optOut.phrase}")`);
        // Auch hier: der Widerspruch gilt der Firma. Sonst laeuft die Kampagne
        // nach einer Abmahnungsdrohung weiter an die Hauptadresse.
        if (lead.email && lead.email.trim().toLowerCase() !== from) {
          suppress(lead.email, `Ausdrücklicher Widerspruch ("${optOut.phrase}") – kam von ${from}`);
        }
        if (!KEEP_STATUS.includes(lead.status)) {
          updateLeadStatus(lead.id, 'do_not_contact', {
            notiz: `Widerspruch erkannt ("${optOut.phrase}") – dauerhaft gesperrt`,
          });
        }
      }

      recordOutreachEvent({
        lead_id: lead.id, event_type: 'reply_received', channel: 'email',
        status: cls.category === 'not_interested' ? 'no_interest' : 'replied', user: 'reply-scan',
        note: `Antwort (${cls.category}, ${cls.confidence}%) von ${from}`
          + (lead.viaDomain ? ` [über die Firmen-Domain zugeordnet, angeschrieben war ${lead.email}]` : '')
          + ` | Betreff: "${m.subject}" | ${cls.reason}`,
      });
    }

    insert.run({
      uid: m.uid, lead_id: lead.id, from_email: from, from_name: m.fromName || null,
      subject: (m.subject || '').slice(0, 300), snippet: (m.snippet || '').slice(0, 300),
      category: cls.category, confidence: cls.confidence, reason: cls.reason,
      followup_stopped: followupStopped, received_at: m.date || null,
    });

    res.processed++;
    if (followupStopped) res.stopped++;
    res[cls.category]++;
  }

  return res;
}

// ── Dashboard-Daten ─────────────────────────────────────────────────────────
export interface ReplyRow {
  uid: number;
  lead_id: string | null;
  lead_name: string | null;
  from_email: string;
  from_name: string | null;
  subject: string | null;
  snippet: string | null;
  category: ReplyCategory;
  confidence: number;
  followup_stopped: number;
  received_at: string | null;
  created_at: string;
}

export function listReplies(limit = 100): { replies: ReplyRow[]; summary: Record<string, number> } {
  const db = getDb();
  // Nur Antworten von tatsächlich angeschriebenen Firmen (lead_id gesetzt). Unzugeordnete
  // Postfach-Mails (Newsletter, Systembenachrichtigungen) bleiben zur Idempotenz gespeichert,
  // gehören aber nicht in die Antworten-Übersicht.
  const rows = db.prepare(
    `SELECT r.uid, r.lead_id, l.name AS lead_name, r.from_email, r.from_name, r.subject,
            r.snippet, r.category, r.confidence, r.followup_stopped, r.received_at, r.created_at
     FROM inbound_replies r JOIN leads l ON l.id = r.lead_id
     ORDER BY COALESCE(r.received_at, r.created_at) DESC LIMIT ?`
  ).all(limit) as ReplyRow[];

  const summary: Record<string, number> = {
    total: rows.length, not_interested: 0, interested: 0, question: 0, unknown: 0, auto_reply: 0, stopped: 0,
  };
  for (const r of rows) {
    summary[r.category] = (summary[r.category] || 0) + 1;
    if (r.followup_stopped) summary.stopped++;
  }
  return { replies: rows, summary };
}

// ── Worker ──────────────────────────────────────────────────────────────────
const TICK_MS = 5 * 60 * 1000; // alle 5 Minuten nach neuen Antworten sehen

function imapConfigured(): boolean {
  return Boolean((process.env.IMAP_USER || process.env.SMTP_USER) && (process.env.IMAP_PASS || process.env.SMTP_PASS));
}

let timer: ReturnType<typeof setInterval> | null = null;
let busy = false;

export function startReplyScanner(): void {
  if (timer) return;
  if (!imapConfigured()) {
    console.log('[reply-scan] deaktiviert – IMAP_USER/IMAP_PASS (oder SMTP_*) fehlen');
    return;
  }
  const run = async () => {
    if (busy) return;
    busy = true;
    try {
      const r = await scanReplies();
      if (r.processed > 0) {
        console.log(`[reply-scan] ${r.processed} neue Antworten verarbeitet (${r.not_interested} Absagen, ${r.interested} Interesse, ${r.stopped} Follow-ups gestoppt)`);
      }
      // Nach dem Scan: Bounces / Auto-Reply / Verifica-Challenges / System-Noise
      // direkt aus dem Postfach räumen. Standard: aktiv (opt-out über INBOX_AUTO_CLEAN=false).
      if (process.env.INBOX_AUTO_CLEAN !== 'false') {
        try {
          const purge = await purgeInboxNoise(200);
          if (purge.deleted > 0) console.log(`[reply-scan] Posteingang geräumt: ${purge.deleted} Rauschmail(s) gelöscht`);
        } catch (err) {
          console.error('[reply-scan] Purge-Fehler:', err instanceof Error ? err.message : err);
        }
      }
    } catch (err) {
      console.error('[reply-scan] Fehler:', err instanceof Error ? err.message : err);
    } finally {
      busy = false;
    }
  };
  run().catch(() => {});
  timer = setInterval(run, TICK_MS);
  console.log('[reply-scan] Worker gestartet (Tick ' + TICK_MS / 60000 + ' Min) – Antworten stoppen Follow-ups automatisch');
}
