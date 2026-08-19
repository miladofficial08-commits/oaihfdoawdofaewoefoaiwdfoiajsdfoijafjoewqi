import { getDb } from '../db/schema';
import { isRealClick } from '../email/tracking';
import { detectOptOut } from './optout';
import { CheckPort } from './types';

// Erkennt, wie ein Lead auf unsere Mails reagiert hat. Bewusst von der Engine
// getrennt: hier steckt die gesamte Auslegung eingehender Signale (Antwort, Klick,
// Bounce, Abwesenheitsnotiz), die Engine entscheidet nur, was daraus folgt.

export const parseTs = (v: string | null | undefined): number =>
  v ? new Date(String(v).replace(' ', 'T') + (/[Z+]/.test(String(v)) ? '' : 'Z')).getTime() : 0;

const norm = (s: string): string =>
  (s || '').toLowerCase().replace(/[äöüß]/g, m => ({ ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' }[m] || m));

// „Melden Sie sich im Herbst nochmal" – Interesse ja, aber nicht jetzt.
const LATER = [
  'spaeter nochmal', 'spaeter noch mal', 'zu einem spaeteren zeitpunkt', 'im naechsten jahr',
  'naechstes jahr', 'im naechsten quartal', 'in ein paar monaten', 'in einigen monaten',
  'melden sie sich in', 'melden sie sich im', 'fragen sie in', 'bitte spaeter', 'aktuell keine zeit',
  'derzeit keine kapazitaet', 'momentan keine zeit', 'nach dem urlaub', 'nach der saison',
  'kommen sie im', 'erinnern sie mich',
];

// Wir schreiben die falsche Person an.
const WRONG_CONTACT = [
  'nicht zustaendig', 'nicht mehr zustaendig', 'bin nicht der richtige', 'nicht der richtige ansprechpartner',
  'falscher ansprechpartner', 'wenden sie sich an', 'zustaendig ist', 'kollege', 'kollegin',
  'bitte an meinen kollegen', 'ich leite das weiter', 'leite ich weiter', 'nicht mehr im unternehmen',
  'nicht mehr bei uns', 'hat das unternehmen verlassen', 'ausgeschieden',
];

export interface Reaction {
  port: CheckPort;
  uid: number | null;
  detail: string;
  optOutPhrase?: string;
  hardOptOut?: boolean;
}

interface ReplyRow {
  uid: number; category: string; subject: string | null; snippet: string | null; received_at: string | null;
}

function hit(haystack: string, needles: string[]): string | null {
  for (const n of needles) if (haystack.includes(n)) return n;
  return null;
}

/**
 * Neue Antwort seit dem letzten geprüften Stand? Liefert auch Abmelde-Treffer mit.
 * Reihenfolge = Priorität: Abmeldung → Absage → falscher Ansprechpartner →
 * später → Abwesenheit → Interesse → Rückfrage.
 */
export function newReply(run: { lead_id: string; last_reaction_uid: number | null }): Reaction | null {
  const row = getDb().prepare(
    `SELECT uid, category, subject, snippet, received_at FROM inbound_replies
     WHERE lead_id = ? AND uid > COALESCE(?, 0)
     ORDER BY uid DESC LIMIT 1`
  ).get(run.lead_id, run.last_reaction_uid) as ReplyRow | undefined;
  if (!row) return null;

  const text = norm(`${row.subject || ''}\n${row.snippet || ''}`);
  const optOut = detectOptOut(row.subject || '', row.snippet || '');

  let port: CheckPort;
  if (optOut) port = 'not_interested';
  else if (row.category === 'not_interested') port = 'not_interested';
  else if (hit(text, WRONG_CONTACT)) port = 'wrong_contact';
  else if (row.category === 'auto_reply') port = 'auto_reply';
  else if (hit(text, LATER)) port = 'later';
  else if (row.category === 'interested') port = 'interested';
  else port = 'question'; // 'unknown' = ein Mensch hat geschrieben → Mensch übernimmt

  return {
    port,
    uid: row.uid,
    detail: `Antwort: "${(row.subject || row.snippet || '').slice(0, 120)}"`,
    optOutPhrase: optOut?.phrase,
    hardOptOut: optOut?.hard,
  };
}

/** Ist die Adresse als unzustellbar bestätigt? (Brevo-Status oder Bounce-Event) */
export function hasBounce(leadId: string): boolean {
  const db = getDb();
  const byStatus = db.prepare(
    `SELECT 1 x FROM sent_emails WHERE lead_id = ? AND delivery_status = 'bounced' LIMIT 1`
  ).get(leadId);
  if (byStatus) return true;
  const byEvent = db.prepare(
    `SELECT 1 x FROM email_events ev JOIN sent_emails se ON se.id = ev.sent_email_id
     WHERE se.lead_id = ? AND ev.event_type = 'bounce' LIMIT 1`
  ).get(leadId);
  return Boolean(byEvent);
}

/** Echter Klick ohne Antwort – heißer Lead, aber noch kein Gespräch. */
export function hasRealClick(leadId: string, sinceMs: number): boolean {
  const rows = getDb().prepare(
    `SELECT ev.event_type, ev.user_agent, ev.created_at FROM email_events ev
     JOIN sent_emails se ON se.id = ev.sent_email_id
     WHERE se.lead_id = ?`
  ).all(leadId) as Array<{ event_type: string; user_agent: string | null; created_at: string }>;
  return rows.some(e => isRealClick({ event_type: e.event_type, user_agent: e.user_agent }) && parseTs(e.created_at) >= sinceMs);
}

/** Rückkehrdatum aus einer Abwesenheitsnotiz lesen ("bin ab 14.08. wieder da"). */
export function parseReturnDate(text: string, now = new Date()): Date | null {
  const m = String(text || '').match(/(?:ab|bis|wieder ab|zurück am|zurueck am)\s+(?:dem\s+)?(\d{1,2})\.\s*(\d{1,2})\.?\s*(\d{2,4})?/i);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  if (!(day >= 1 && day <= 31 && month >= 1 && month <= 12)) return null;
  let year = m[3] ? Number(m[3]) : now.getFullYear();
  if (year < 100) year += 2000;
  const d = new Date(year, month - 1, day, 9, 0, 0);
  if (!m[3] && d.getTime() < now.getTime()) d.setFullYear(year + 1);
  const maxAhead = now.getTime() + 120 * 86_400_000;
  if (d.getTime() < now.getTime() || d.getTime() > maxAhead) return null;
  return d;
}

export function lastAutoReplyText(leadId: string): string {
  const row = getDb().prepare(
    `SELECT subject, snippet FROM inbound_replies
     WHERE lead_id = ? AND category = 'auto_reply' ORDER BY uid DESC LIMIT 1`
  ).get(leadId) as { subject: string | null; snippet: string | null } | undefined;
  return `${row?.subject || ''} ${row?.snippet || ''}`;
}
