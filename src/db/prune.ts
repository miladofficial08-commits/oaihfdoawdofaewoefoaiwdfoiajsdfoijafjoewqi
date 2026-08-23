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

const HAEPPCHEN = 2000;
const MAX_RUNDEN = 400;

/** Tage, nach denen der doppelte Mailtext entbehrlich ist. */
const TEXT_TAGE = 14;
/** Tage, die das Maschinen-Protokoll aufgehoben wird. */
const LOG_TAGE = 30;

export interface PruneErgebnis {
  texte_geleert: number;
  log_zeilen_geloescht: number;
  fehler?: string;
}

export function pruneTelemetrie(): PruneErgebnis {
  const db = getDb();
  const raus: PruneErgebnis = { texte_geleert: 0, log_zeilen_geloescht: 0 };

  try {
    // 1. Doppelte Mailtexte aus der Historie nehmen. Die Zeile bleibt stehen,
    //    nur das grosse Textfeld wird geleert.
    const leeren = db.prepare(
      `UPDATE outreach_events SET message = NULL
       WHERE rowid IN (
         SELECT rowid FROM outreach_events
         WHERE message IS NOT NULL AND message != ''
           AND created_at < datetime('now', '-${TEXT_TAGE} days')
         LIMIT ${HAEPPCHEN}
       )`
    );
    for (let i = 0; i < MAX_RUNDEN; i++) {
      const n = leeren.run().changes;
      raus.texte_geleert += n;
      if (n < HAEPPCHEN) break;
    }

    // 2. Altes Maschinen-Protokoll wegräumen.
    const loeschen = db.prepare(
      `DELETE FROM workflow_log WHERE rowid IN (
         SELECT rowid FROM workflow_log
         WHERE created_at < datetime('now', '-${LOG_TAGE} days')
         LIMIT ${HAEPPCHEN}
       )`
    );
    for (let i = 0; i < MAX_RUNDEN; i++) {
      const n = loeschen.run().changes;
      raus.log_zeilen_geloescht += n;
      if (n < HAEPPCHEN) break;
    }

    // WAL zurückgeben, sonst wächst die Datei durch das Aufräumen erst recht.
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* nicht kritisch */ }
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
