import fs from 'fs';
import path from 'path';
import { getDb } from './schema';
import { stoppStatus } from '../email/stopp';
import { suppressEmail } from '../workflow/optout';

// ─────────────────────────────────────────────────────────────────────────────
// Zwei Fragen, die das Dashboard seit dem 19.08. nicht mehr beantwortet hat:
//
//   1. Was ist am 20.–22.08. wirklich passiert?
//   2. Auf welchem Stand ist das System HEUTE?
//
// Der Vorfall gehört in eine eigene Tabelle und in kein einziges Diagramm der
// normalen Auswertung. 890 Mails an 41 Adressen in drei Tagen würden jede
// Öffnungs- und Antwortquote unbrauchbar machen: die Zahlen sind echt, aber
// sie beschreiben einen Defekt und kein Kundenverhalten. Deshalb liegen sie
// hier getrennt, sind an einer Stelle sichtbar – und mit einem Klick wieder weg.
//
// Der Stand-Bericht dagegen rechnet live aus der Datenbank. Er sagt, wann die
// letzte Mail rausging, wie viele Tage seitdem still sind, was in der
// Warteschlange steht und welche Motoren scharf wären. Keine gespeicherte
// Momentaufnahme, die wieder veralten kann.
// ─────────────────────────────────────────────────────────────────────────────

export interface VorfallZeile {
  email: string;
  anzahl: number;
  erste: string | null;
  letzte: string | null;
  betreff: string | null;
}

export interface VorfallBericht {
  vorhanden: boolean;
  quelle: string | null;
  importiert_am: string | null;
  adressen: number;
  mails: number;
  max_pro_adresse: number;
  schnitt_pro_adresse: number;
  von: string | null;
  bis: string | null;
  zeilen: VorfallZeile[];
}

let bereit = false;
function schema(): void {
  if (bereit) return;
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS vorfall_versand (
      email         TEXT PRIMARY KEY,
      anzahl        INTEGER NOT NULL,
      erste         TEXT,
      letzte        TEXT,
      betreff       TEXT,
      quelle        TEXT,
      importiert_am TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  // domain wird beim Import gefüllt – aber nur, wenn sie der Praxis gehört.
  try { getDb().exec('ALTER TABLE vorfall_versand ADD COLUMN domain TEXT'); } catch { /* schon da */ }
  bereit = true;
}

/**
 * Freemail-Anbieter. Vier der 41 Betroffenen sitzen bei GMX oder T-Online.
 * Über deren Domain zu sperren würde hunderte fremde Betriebe mitreissen, die
 * nie eine Mail von uns bekommen haben. Bei diesen Adressen zählt deshalb nur
 * die exakte Adresse.
 */
const FREEMAIL = new Set([
  'gmx.de', 'gmx.net', 'gmx.at', 'gmx.ch', 't-online.de', 'gmail.com', 'googlemail.com',
  'web.de', 'yahoo.de', 'yahoo.com', 'outlook.de', 'outlook.com', 'hotmail.de', 'hotmail.com',
  'live.de', 'aol.com', 'freenet.de', 'mail.de', 'posteo.de', 'arcor.de', 'icloud.com',
  'me.com', 'vodafone.de', '1und1.de', 'unitybox.de',
]);

function eigeneDomain(email: string): string | null {
  const d = email.split('@')[1]?.trim().toLowerCase();
  if (!d || FREEMAIL.has(d)) return null;
  return d;
}

/**
 * SQL-Bedingung: dieser Lead gehört NICHT zu einer Praxis aus dem Vorfall.
 *
 * Wer 23 Mails von uns bekommen hat und jetzt noch einen Anruf obendrauf,
 * beschwert sich zu Recht – und dann steht nicht mehr die Mail im Raum, sondern
 * hartnäckige Belästigung. Deshalb wird auf drei Wegen abgeglichen, denn
 * dieselbe Praxis steckt oft mit anderer Adresse in den Leads:
 *   1. exakt dieselbe E-Mail-Adresse
 *   2. dieselbe Praxis-Domain in der E-Mail (info@ vs. praxis@ derselben Domain)
 *   3. dieselbe Domain in der hinterlegten Webseite
 *
 * Gibt es die Tabelle noch nicht, greift die Sperre nicht – dann gibt es aber
 * auch keine Betroffenendaten. Der Zustand wird im Dashboard angezeigt, statt
 * dass die Anrufliste kommentarlos kaputtgeht.
 */
export function vorfallAusschlussSql(alias = 'l'): string {
  const da = (() => {
    try {
      return Boolean(getDb().prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'vorfall_versand'`
      ).get());
    } catch { return false; }
  })();
  if (!da) return '1 = 1';
  return `NOT EXISTS (
    SELECT 1 FROM vorfall_versand v WHERE
         (${alias}.email IS NOT NULL AND LOWER(TRIM(${alias}.email)) = v.email)
      OR (v.domain IS NOT NULL AND v.domain != '' AND (
            LOWER(TRIM(COALESCE(${alias}.email, ''))) LIKE '%@' || v.domain
         OR LOWER(COALESCE(${alias}.website, '')) LIKE '%' || v.domain || '%'
      ))
  )`;
}

/** Steht die Sperre, und wen trifft sie? Für die Anzeige in der Anrufliste. */
export function vorfallSperre(): { aktiv: boolean; adressen: number; gesperrte_leads: number } {
  try {
    schema();
    const db = getDb();
    const adressen = (db.prepare('SELECT COUNT(*) n FROM vorfall_versand').get() as { n: number }).n;
    if (!adressen) return { aktiv: false, adressen: 0, gesperrte_leads: 0 };
    const gesperrt = (db.prepare(
      `SELECT COUNT(*) n FROM leads l WHERE NOT (${vorfallAusschlussSql('l')})`
    ).get() as { n: number }).n;
    return { aktiv: true, adressen, gesperrte_leads: gesperrt };
  } catch {
    return { aktiv: false, adressen: 0, gesperrte_leads: 0 };
  }
}

/**
 * Liest die Betroffenenliste ein. Erwartet eine Zeile je Adresse:
 * E-Mail;Anzahl;erste;letzte;Betreff – Semikolon oder Komma, Kopfzeile optional.
 * Ein erneuter Import ersetzt den Bestand vollständig, damit nichts doppelt zählt.
 */
export function vorfallImportCsv(text: string, quelle = 'CSV-Import'): { zeilen: number; mails: number; mailsperre: number; sperre: ReturnType<typeof vorfallSperre> } {
  schema();
  const db = getDb();
  const zeilen: VorfallZeile[] = [];

  for (const roh of text.split(/\r?\n/)) {
    const zeile = roh.trim();
    if (!zeile) continue;
    const teile = zeile.includes(';') ? zeile.split(';') : zeile.split(',');
    const email = (teile[0] || '').trim().toLowerCase();
    if (!email.includes('@')) continue; // Kopfzeile und Müll fallen hier raus
    const anzahl = Math.max(1, Math.round(Number((teile[1] || '1').trim()) || 1));
    zeilen.push({
      email,
      anzahl,
      erste: (teile[2] || '').trim() || null,
      letzte: (teile[3] || '').trim() || null,
      betreff: (teile[4] || '').trim() || null,
    });
  }
  if (!zeilen.length) throw new Error('Keine gültige Zeile gefunden – erwartet wird "adresse@beispiel.de;23;…"');

  const schreiben = db.transaction((rows: VorfallZeile[]) => {
    db.prepare('DELETE FROM vorfall_versand').run();
    const ins = db.prepare(
      `INSERT INTO vorfall_versand (email, anzahl, erste, letzte, betreff, quelle, domain)
       VALUES (@email, @anzahl, @erste, @letzte, @betreff, @quelle, @domain)`
    );
    for (const r of rows) ins.run({ ...r, quelle, domain: eigeneDomain(r.email) });
  });
  schreiben(zeilen);

  // Auch den Mailweg zumachen, nicht nur den Anrufweg.
  //
  // Der Auto-Versand meidet Adressen, die in sent_emails stehen – aber genau
  // diese 41 stehen dort NICHT, weil am 20.–22.08. die Platte voll war und
  // nichts protokolliert werden konnte. Für den Versand sind sie also
  // unkontaktierte, frische Leads. Ohne diesen Eintrag würden sie beim nächsten
  // echten Versand als Erste wieder angeschrieben.
  let gesperrteMails = 0;
  for (const z of zeilen) {
    try {
      suppressEmail(z.email, `Vorfall 20.–22.08.2026: ${z.anzahl} Mails erhalten – kein weiterer Kontakt`, 'vorfall-import');
      gesperrteMails++;
    } catch { /* eine einzelne Adresse darf den Import nicht kippen */ }
  }

  return {
    zeilen: zeilen.length,
    mails: zeilen.reduce((s, z) => s + z.anzahl, 0),
    mailsperre: gesperrteMails,
    sperre: vorfallSperre(),
  };
}

/**
 * Beim Start einmal nachsehen, ob die Betroffenenliste lokal daneben liegt.
 * Auf dem Server ist sie das nicht – die Datei enthält Kundendaten und gehört
 * deshalb nicht ins Repository. Dort wird sie über das Dashboard eingelesen.
 */
export function vorfallAusDateiLaden(verzeichnis = process.cwd()): string | null {
  schema();
  const db = getDb();
  const schonDa = (db.prepare('SELECT COUNT(*) n FROM vorfall_versand').get() as { n: number }).n;
  if (schonDa) return null;
  let treffer: string[] = [];
  try {
    treffer = fs.readdirSync(verzeichnis).filter(f => /^betroffene-.*\.csv$/i.test(f)).sort();
  } catch { return null; }
  if (!treffer.length) return null;
  const datei = path.join(verzeichnis, treffer[0]);
  try {
    vorfallImportCsv(fs.readFileSync(datei, 'utf8'), 'Datei ' + treffer[0]);
    return datei;
  } catch { return null; }
}

export function vorfallBericht(): VorfallBericht {
  schema();
  const db = getDb();
  const zeilen = db.prepare(
    'SELECT email, anzahl, erste, letzte, betreff FROM vorfall_versand ORDER BY anzahl DESC, email ASC'
  ).all() as VorfallZeile[];
  const kopf = db.prepare(
    `SELECT COUNT(*) adressen, COALESCE(SUM(anzahl),0) mails, COALESCE(MAX(anzahl),0) hoechst,
            MIN(erste) von, MAX(letzte) bis, MAX(quelle) quelle, MAX(importiert_am) importiert_am
     FROM vorfall_versand`
  ).get() as { adressen: number; mails: number; hoechst: number; von: string | null; bis: string | null; quelle: string | null; importiert_am: string | null };
  return {
    vorhanden: kopf.adressen > 0,
    quelle: kopf.quelle,
    importiert_am: kopf.importiert_am,
    adressen: kopf.adressen,
    mails: kopf.mails,
    max_pro_adresse: kopf.hoechst,
    schnitt_pro_adresse: kopf.adressen ? Math.round((kopf.mails / kopf.adressen) * 10) / 10 : 0,
    von: kopf.von,
    bis: kopf.bis,
    zeilen,
  };
}

export function vorfallLoeschen(): number {
  schema();
  return getDb().prepare('DELETE FROM vorfall_versand').run().changes;
}

// ── Stand: was ist heute wahr? ───────────────────────────────────────────────

export interface VersandStand {
  heute: string;
  letzter_versand: string | null;
  tage_ohne_versand: number | null;
  gesendet_heute: number;
  gesendet_gesamt: number;
  pro_tag: Array<{ tag: string; mails: number; empfaenger: number }>;
  stopp: { gestoppt: boolean; text: string };
  warteschlange: { geplant: number; jobs_laufend: number; jobs_probelauf: number };
  motoren: Array<{ name: string; aktiv: boolean; hinweis: string }>;
  vorfall: { vorhanden: boolean; adressen: number; mails: number; von: string | null; bis: string | null };
}

export function versandStand(): VersandStand {
  schema();
  const db = getDb();
  const still = <T>(fn: () => T, fallback: T): T => { try { return fn(); } catch { return fallback; } };
  const zahl = (sql: string) => still(() => (db.prepare(sql).get() as { n: number }).n, 0);

  const letzter = still(
    () => (db.prepare(`SELECT MAX(sent_at) t FROM sent_emails WHERE success = 1`).get() as { t: string | null }).t,
    null
  );
  const tageOhne = letzter
    ? Math.max(0, Math.floor((Date.now() - new Date(String(letzter).replace(' ', 'T')).getTime()) / 86_400_000))
    : null;

  const proTag = still(() => db.prepare(
    `SELECT date(sent_at) tag, COUNT(*) mails, COUNT(DISTINCT LOWER(TRIM(to_email))) empfaenger
     FROM sent_emails WHERE success = 1 AND sent_at >= date('now','-13 days')
     GROUP BY tag ORDER BY tag ASC`
  ).all() as Array<{ tag: string; mails: number; empfaenger: number }>, []);

  const strategien = still(
    () => db.prepare('SELECT name, enabled FROM workflows').all() as Array<{ name: string; enabled: number }>,
    []
  );
  const followup = still(
    () => (db.prepare('SELECT enabled FROM followup_config WHERE id = 1').get() as { enabled: number } | undefined)?.enabled === 1,
    false
  );
  const tagesmotor = /^(1|true|on|yes|ja|an)$/i.test((process.env.DAILY_ENGINE || '').trim());

  const v = vorfallBericht();

  return {
    heute: new Date().toISOString().slice(0, 10),
    letzter_versand: letzter,
    tage_ohne_versand: tageOhne,
    gesendet_heute: zahl(`SELECT COUNT(*) n FROM sent_emails WHERE success = 1 AND date(sent_at) = date('now','localtime')`),
    gesendet_gesamt: zahl('SELECT COUNT(*) n FROM sent_emails WHERE success = 1'),
    pro_tag: proTag,
    stopp: stoppStatus(),
    warteschlange: {
      geplant: zahl(`SELECT COUNT(*) n FROM scheduled_emails WHERE status IN ('scheduled','processing')`),
      jobs_laufend: zahl(`SELECT COUNT(*) n FROM send_jobs WHERE status = 'running'`),
      jobs_probelauf: zahl(`SELECT COUNT(*) n FROM send_jobs WHERE status = 'probelauf'`),
    },
    motoren: [
      ...strategien.map(s => ({
        name: 'Strategie „' + s.name + '“',
        aktiv: s.enabled === 1,
        hinweis: s.enabled === 1 ? 'würde Leads durch den Baum schieben' : 'steht still',
      })),
      { name: 'Follow-up-Motor', aktiv: followup, hinweis: followup ? 'würde Nachfass-Mails auslösen' : 'abgeschaltet' },
      { name: 'Tagesmotor (DAILY_ENGINE)', aktiv: tagesmotor, hinweis: tagesmotor ? 'würde täglich Leads nachlegen' : 'nicht gesetzt' },
    ],
    vorfall: { vorhanden: v.vorhanden, adressen: v.adressen, mails: v.mails, von: v.von, bis: v.bis },
  };
}
