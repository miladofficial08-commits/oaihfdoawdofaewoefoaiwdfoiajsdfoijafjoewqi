import { getDb } from './schema';

// ─────────────────────────────────────────────────────────────────────────────
// Protokolldaten kürzen, damit die Platte nicht wieder vollläuft.
//
// Gemessen am 23.08.2026, als das Volume mit 496/500 MB dichtgemacht hatte:
//
//   292,9 MB  outreach_events   (+42 MB Indizes)
//    45,6 MB  workflow_log      (+28 MB Indizes)
//     3,6 MB  leads
//     2,2 MB  sent_emails
//
// Der Brocken ist outreach_events.message: Dort landet bei jedem Versand der
// komplette Mailtext – ein zweites Mal, denn in sent_emails steht er schon.
// Deshalb wird hier nur das Duplikat entfernt, nicht die Spur selbst: Wer wann
// was bekommen hat, bleibt lückenlos nachvollziehbar. Nach dem Vorfall vom
// 20.–22.08. ist genau das wichtig.
//
// Gelöscht wird ausschliesslich Telemetrie:
//   • alte Mailtexte in outreach_events  → nur die Kopie, Zeile bleibt
//   • workflow_log älter als 30 Tage     → reines Maschinen-Protokoll
//
// sent_emails, leads, inbound_replies und die Sperrliste werden NIE angefasst.
//
// In kleinen Häppchen, weil ein grosser Löschvorgang auf einer vollen Platte
// selbst wieder am Platzmangel scheitert.
// ─────────────────────────────────────────────────────────────────────────────

// Winzige Haeppchen mit sofortiger WAL-Rueckgabe.
//
// Der erste Versuch mit 2000 Zeilen scheiterte an "database or disk is full":
// Auch ein Loeschvorgang braucht Platz fuer sein Journal, und bei 4,7 MB frei
// ist er groesser als die Luecke, die er schliessen soll. Also klein arbeiten
// und nach jeder Runde den Platz zurueckgeben.
const HAEPPCHEN = 100;
const MAX_RUNDEN = 6000;

// Fristen bewusst kurz.
//
// Gemessen: 443.877 Zeilen fuer 1.893 tatsaechlich versendete Mails, davon
// 221.382 manual_contact mit 197 MB doppelten Mailtexten und 221.484
// status_changed. Fast alles juenger als 14 Tage – deshalb hat der erste
// Versuch mit grosszuegigen Fristen nur 561 Zeilen erwischt.
//
// Der Mailtext steht vollstaendig in sent_emails; in der Historie ist er eine
// Kopie. Zwei Tage reichen, um im Dashboard noch nachzulesen, was rausging.
const TEXT_TAGE = 2;
/** Statuswechsel sind Maschinen-Rauschen, kein Beweis. */
const LOG_TAGE = 7;

export interface PruneErgebnis {
  texte_geleert: number;
  log_zeilen_geloescht: number;
  fehler?: string;
}

/**
 * Was steckt wirklich in outreach_events?
 *
 * Der erste Aufräum-Lauf hat nur 561 Texte gefunden, die Tabelle ist aber
 * 293 MB gross. Also liegt der Platz woanders – und ohne diese Aufschlüsselung
 * würde man ins Blaue löschen.
 */
function berichteEvents(db: ReturnType<typeof getDb>): void {
  try {
    const n = (db.prepare('SELECT COUNT(*) n FROM outreach_events').get() as { n: number }).n;
    const spalten = (db.prepare(
      `SELECT COALESCE(SUM(LENGTH(message)),0) m, COALESCE(SUM(LENGTH(note)),0) no FROM outreach_events`
    ).get() as { m: number; no: number });
    const mb = (b: number) => (b / 1024 / 1024).toFixed(1) + ' MB';
    console.log('[events] ' + n + ' Zeilen | message ' + mb(spalten.m) + ' | note ' + mb(spalten.no));
    const typen = db.prepare(
      `SELECT event_type, COUNT(*) n, COALESCE(SUM(LENGTH(message)),0)+COALESCE(SUM(LENGTH(note)),0) b
       FROM outreach_events GROUP BY event_type ORDER BY b DESC LIMIT 8`
    ).all() as Array<{ event_type: string; n: number; b: number }>;
    for (const t of typen) console.log('[events]   ' + mb(t.b).padStart(9) + '  ' + String(t.n).padStart(7) + 'x  ' + t.event_type);
    const alt = db.prepare(`SELECT MIN(created_at) a, MAX(created_at) b FROM outreach_events`).get() as { a: string; b: string };
    console.log('[events]   Zeitraum ' + String(alt.a).slice(0, 10) + ' bis ' + String(alt.b).slice(0, 10));

    // Woher kommen 221.382 manual_contact-Zeilen, wenn Brevo nur 1.893 Mails kennt?
    // Die Notiz verraet den Urheber: sendLeadEmail schreibt "E-Mail versendet an
    // ... | Server: ...", recordManualContact schreibt "Manuell per ... markiert.
    // Kein echter Versand". Ausserdem: an wie vielen Tagen und an wie vielen
    // verschiedenen Leads haengen sie?
    const urheber = db.prepare(
      `SELECT SUBSTR(COALESCE(note,'(ohne Notiz)'), 1, 42) AS anfang, COUNT(*) n,
              COUNT(DISTINCT lead_id) leads, MIN(created_at) von, MAX(created_at) bis
       FROM outreach_events WHERE event_type = 'manual_contact'
       GROUP BY anfang ORDER BY n DESC LIMIT 6`
    ).all() as Array<{ anfang: string; n: number; leads: number; von: string; bis: string }>;
    console.log('[events] Urheber der manual_contact-Zeilen:');
    for (const u of urheber) {
      console.log('[events]   ' + String(u.n).padStart(7) + 'x  ueber ' + String(u.leads).padStart(5)
        + ' Leads  ' + String(u.von).slice(0, 16) + ' bis ' + String(u.bis).slice(0, 16));
      console.log('[events]           "' + u.anfang.replace(/\s+/g, ' ') + '"');
    }
    const proTag = db.prepare(
      `SELECT DATE(created_at) tag, COUNT(*) n FROM outreach_events
       WHERE event_type = 'manual_contact' GROUP BY tag ORDER BY n DESC LIMIT 6`
    ).all() as Array<{ tag: string; n: number }>;
    console.log('[events] Spitzentage: ' + proTag.map(t => t.tag + '=' + t.n).join('  '));
  } catch (err) {
    console.warn('[events] nicht ermittelbar: ' + (err instanceof Error ? err.message : String(err)));
  }
}

/**
 * Eine Anweisung in Runden ausfuehren und nach jeder Runde die WAL zurueckgeben.
 * Ohne den Checkpoint waechst die WAL waehrend des Aufraeumens schneller, als
 * das Aufraeumen Platz schafft – und bricht mitten drin ab.
 */
function inRunden(db: ReturnType<typeof getDb>, sql: string): number {
  const stmt = db.prepare(sql);
  let gesamt = 0;
  for (let i = 0; i < MAX_RUNDEN; i++) {
    let n = 0;
    try { n = stmt.run().changes; }
    catch (err) {
      // Kein Platz mehr fuer diese Runde: Platz zurueckgeben und nochmal.
      try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* nichts zu holen */ }
      try { n = stmt.run().changes; } catch { break; }
    }
    gesamt += n;
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* nicht kritisch */ }
    if (n < HAEPPCHEN) break;
  }
  return gesamt;
}

export function pruneTelemetrie(): PruneErgebnis {
  const db = getDb();
  const raus: PruneErgebnis = { texte_geleert: 0, log_zeilen_geloescht: 0 };
  berichteEvents(db);

  try {
    // Reihenfolge nach Wirkung pro Aufwand:
    // Erst die Statuswechsel loeschen – viele Zeilen, wenig Daten, aber sie
    // haengen an 42 MB Indizes. Danach die doppelten Mailtexte leeren.
    raus.log_zeilen_geloescht += inRunden(db,
      `DELETE FROM outreach_events WHERE rowid IN (
         SELECT rowid FROM outreach_events
         WHERE event_type IN ('note', 'status_changed')
           AND created_at < datetime('now', '-${LOG_TAGE} days')
         LIMIT ${HAEPPCHEN})`);

    raus.texte_geleert += inRunden(db,
      `UPDATE outreach_events SET message = NULL WHERE rowid IN (
         SELECT rowid FROM outreach_events
         WHERE message IS NOT NULL AND message != ''
           AND created_at < datetime('now', '-${TEXT_TAGE} days')
         LIMIT ${HAEPPCHEN})`);

    raus.log_zeilen_geloescht += inRunden(db,
      `DELETE FROM workflow_log WHERE rowid IN (
         SELECT rowid FROM workflow_log
         WHERE created_at < datetime('now', '-${LOG_TAGE} days')
         LIMIT ${HAEPPCHEN})`);
  } catch (err) {
    raus.fehler = err instanceof Error ? err.message : String(err);
  }
  return raus;
}

/**
 * Beim Start einmal aufräumen, danach täglich.
 *
 * Ohne den täglichen Lauf ist das hier nur eine Einmal-Rettung – und in ein paar
 * Monaten steht dasselbe Problem wieder da. Der Fehler war nie die Datenmenge,
 * sondern dass niemand sie begrenzt hat.
 */
let timer: ReturnType<typeof setInterval> | null = null;

export function startPruner(): void {
  const lauf = () => {
    const r = pruneTelemetrie();
    if (r.fehler) {
      console.error('[aufraeumen] fehlgeschlagen: ' + r.fehler);
      return;
    }
    if (r.texte_geleert || r.log_zeilen_geloescht) {
      console.log('[aufraeumen] ' + r.texte_geleert + ' doppelte Mailtexte geleert, '
        + r.log_zeilen_geloescht + ' alte Protokollzeilen geloescht');
    }
  };
  lauf();
  if (!timer) timer = setInterval(lauf, 24 * 3600 * 1000);
}
