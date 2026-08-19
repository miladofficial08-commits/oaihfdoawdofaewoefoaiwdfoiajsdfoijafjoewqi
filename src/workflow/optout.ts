import { getDb } from '../db/schema';

// ─────────────────────────────────────────────────────────────────────────────
// Harte Abmelde-Erkennung (Rechtsschutz).
//
// Wenn ein Empfänger ausdrücklich sagt, dass er keine E-Mails mehr will, darf ihn
// KEIN Versandweg jemals wieder anschreiben – sonst drohen Abmahnung/Unterlassung.
// Diese Datei ist die einzige Wahrheit dafür:
//   • isHardOptOut()  – erkennt die Formulierung im Antworttext
//   • suppressEmail() – trägt die Adresse global in die Sperrliste ein
//   • isSuppressed()  – fragt die Sperrliste ab (vor JEDEM Versand aufrufen)
//
// Die Sperre läuft über die normalisierte E-Mail-Adresse, nicht über die Lead-ID.
// Dieselbe Adresse bleibt damit auch dann gesperrt, wenn sie als mehrere Lead-Zeilen
// (Duplikate, Neu-Scrape) im Bestand liegt.
// ─────────────────────────────────────────────────────────────────────────────

const norm = (s: string): string =>
  (s || '').toLowerCase().replace(/[äöüß]/g, m => ({ ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' }[m] || m));

// Ausdrücklicher Widerspruch gegen weitere Werbung. Bewusst breit gefasst – lieber
// eine Adresse zu viel gesperrt als eine Abmahnung.
const HARD_OPT_OUT = [
  'keine mails', 'keine e-mails', 'keine emails', 'keine weiteren mails', 'keine weiteren e-mails',
  'keine weiteren nachrichten', 'keine werbung', 'keine werbemails', 'keine newsletter',
  'nicht mehr schreiben', 'nicht mehr kontaktieren', 'nicht mehr anschreiben', 'nicht mehr anrufen',
  'nicht kontaktieren', 'kontaktaufnahme unterlassen', 'bitte unterlassen', 'unterlassung',
  'unterlassungserklaerung', 'abmahnung', 'anwalt', 'rechtsanwalt', 'rechtliche schritte',
  'widerspruch', 'widerspreche', 'widersprechen', 'art. 21', 'artikel 21', 'dsgvo',
  'datenschutz', 'loeschen sie meine daten', 'daten loeschen', 'bitte loeschen', 'bitte um loeschung',
  'austragen', 'abmelden', 'unsubscribe', 'opt-out', 'opt out', 'remove me', 'take me off',
  'stop sending', 'do not contact', 'no further emails',
];

// Klares Desinteresse ohne juristischen Ton. Zählt ebenfalls als Sperrgrund – wer
// „kein Interesse" schreibt, bekommt nie wieder eine automatische Mail.
const NO_INTEREST = [
  'kein interesse', 'keine interesse', 'keinerlei interesse', 'nicht interessiert',
  'kein bedarf', 'keinen bedarf', 'besteht kein interesse', 'derzeit kein interesse',
  'aktuell kein interesse', 'momentan kein interesse', 'nein danke', 'nein, danke',
  'not interested', 'no interest',
];

/**
 * Kurze, für sich allein stehende Abmeldewörter.
 *
 * Ein Betrieb antwortet auf eine Werbemail gern mit einem einzigen Wort: „STOP".
 * Als Teilstring wäre das gefährlich („Stopfen", „Stoppuhr"), deshalb nur mit
 * Wortgrenzen. Genau dieses Wort ist uns durchgerutscht – die Antwort kam
 * Base64-kodiert, wurde nie dekodiert, und der Absender landete als
 * „Interessent" im Baum.
 */
const HARD_OPT_OUT_WORTE = [
  'stop', 'stopp', 'stoppen', 'halt', 'loeschen', 'entfernen', 'raus',
  'unsubscribe', 'remove', 'delete',
];

export interface OptOutHit {
  hard: boolean;   // ausdrücklicher Widerspruch → immer sperren
  phrase: string;  // welche Formulierung ausgelöst hat (fürs Protokoll)
}

/**
 * Prüft Betreff + Text auf einen ausdrücklichen Abmelde-/Widerspruchswunsch.
 * Gibt null zurück, wenn nichts gefunden wurde.
 *
 * WICHTIG: Hier muss bereits dekodierter Klartext ankommen. Auf einem
 * Base64-Block findet diese Funktion nichts – siehe email/mime.ts.
 */
export function detectOptOut(subject: string, body: string): OptOutHit | null {
  const text = norm(`${subject}\n${body}`);
  for (const p of HARD_OPT_OUT) if (text.includes(p)) return { hard: true, phrase: p };

  // Einzelne Signalwörter zählen NUR, wenn sie die Nachricht sind – nicht, wenn sie
  // irgendwo im Fließtext vorkommen.
  //
  // Das ist die Absicherung gegen den umgekehrten Fehler: „Wir haben an der
  // Haltestelle Stopp gemacht und möchten gerne mehr wissen" ist ein Interessent,
  // keine Abmeldung. Eine echte Abmeldung besteht aus einem Wort, allein in der
  // ersten Zeile. Genau darauf – und nur darauf – reagieren wir.
  const zeilen = text.split('\n').map(z => z.trim()).filter(Boolean);
  const ersteZeile = (zeilen[0] || '').replace(/^(betreff|subject)\s*:/i, '').trim();
  const nurWorte = (s: string) => s.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

  // Zeile 0 ist der Betreff, ab Zeile 1 der Text. Zusätzlich die ganze Nachricht,
  // falls sie insgesamt nur aus dem einen Wort besteht.
  const kandidaten = [ersteZeile, zeilen[1] || '', zeilen.slice(1).join(' ')];
  for (const kandidat of kandidaten) {
    const sauber = nurWorte(kandidat);
    if (!sauber) continue;
    const woerter = sauber.split(' ');
    if (woerter.length > 2) continue;                       // ein Satz ist keine Abmeldung
    for (const w of HARD_OPT_OUT_WORTE) {
      if (woerter.includes(w)) return { hard: true, phrase: w.toUpperCase() };
    }
  }

  for (const p of NO_INTEREST) if (text.includes(p)) return { hard: false, phrase: p };
  return null;
}

/** Nur der juristisch harte Fall (Widerspruch, Abmahnung, DSGVO-Löschung …). */
export function isHardOptOut(subject: string, body: string): boolean {
  return detectOptOut(subject, body)?.hard === true;
}

export function normalizeEmail(email: string): string {
  return (email || '').trim().toLowerCase();
}

/** Trägt eine Adresse dauerhaft in die globale Sperrliste ein (idempotent). */
export function suppressEmail(email: string, reason: string, source = 'opt-out'): void {
  const em = normalizeEmail(email);
  if (!em || !em.includes('@')) return;
  getDb().prepare(
    `INSERT INTO email_suppression (email_normalized, reason, source)
     VALUES (?, ?, ?)
     ON CONFLICT(email_normalized) DO UPDATE SET reason = excluded.reason, source = excluded.source`
  ).run(em, reason.slice(0, 300), source);
}

/**
 * Ist diese Adresse gesperrt? MUSS vor jedem automatischen Versand aufgerufen werden.
 * Berücksichtigt neben der Sperrliste auch Leads, die auf 'do_not_contact' oder
 * 'no_interest' stehen – auch die dürfen nie wieder angeschrieben werden.
 */
export function isSuppressed(email: string): boolean {
  const em = normalizeEmail(email);
  if (!em) return true;
  const db = getDb();
  const listed = db.prepare(
    `SELECT 1 FROM email_suppression WHERE email_normalized = ? LIMIT 1`
  ).get(em);
  if (listed) return true;
  const blocked = db.prepare(
    `SELECT 1 FROM leads
     WHERE LOWER(TRIM(email)) = ? AND status IN ('do_not_contact','no_interest') LIMIT 1`
  ).get(em);
  return Boolean(blocked);
}

/** Warum ist diese Adresse gesperrt? Für Protokoll und Fehlermeldung. */
export function suppressionReason(email: string): string {
  const em = normalizeEmail(email);
  if (!em) return '';
  const row = getDb().prepare(
    `SELECT reason FROM email_suppression WHERE email_normalized = ? LIMIT 1`
  ).get(em) as { reason: string | null } | undefined;
  if (row?.reason) return row.reason;
  const lead = getDb().prepare(
    `SELECT status FROM leads WHERE LOWER(TRIM(email)) = ? AND status IN ('do_not_contact','no_interest') LIMIT 1`
  ).get(em) as { status: string } | undefined;
  return lead ? `Status "${lead.status}"` : '';
}

/** SQL-Baustein für Kandidatenabfragen: schließt gesperrte Adressen aus. */
export const NOT_SUPPRESSED_SQL = `LOWER(TRIM(email)) NOT IN (
    SELECT email_normalized FROM email_suppression WHERE email_normalized IS NOT NULL AND email_normalized != ''
  )`;

export function suppressionCount(): number {
  return (getDb().prepare(`SELECT COUNT(*) n FROM email_suppression`).get() as { n: number }).n;
}
