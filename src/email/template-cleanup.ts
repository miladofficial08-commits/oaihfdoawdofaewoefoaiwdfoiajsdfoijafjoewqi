import { getDb } from '../db/schema';

// ─────────────────────────────────────────────────────────────────────────────
// Es gibt genau die Vorlagen, die der Nutzer selbst geschrieben hat. Punkt.
//
// Vorher hat das System beim Start eigene Vorlagen nachgelegt (INSERT OR IGNORE
// auf feste IDs). Wer sie loeschte, hatte sie beim naechsten Start wieder da –
// deshalb war jedes Aufraeumen umsonst. Diese Datei dreht das um: gesaet wird
// nichts mehr, und was nicht zum eigenen Bestand gehoert, fliegt bei jedem Start
// raus. Damit koennen die alten Texte nirgendwo mehr auftauchen.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Der eigene Bestand. Teilstuecke, keine vollen Namen – so ueberlebt eine
 * Vorlage auch, wenn hinten noch ein Zusatz steht ("Follow-up 1 – Nachfrage")
 * oder die Schreibweise leicht abweicht ("nicht erreicht" / "nicht erreichbar").
 */
export const EIGENE_VORLAGEN: string[] = [
  'anruf um 17 40',              // Erstkontakt 1
  'verpasster anruf',            // Erstkontakt 2
  'follow up 1',
  'follow up 2',
  'letzter versuch',
  'antwort auf interesse',       // nach echtem Interesse
  'anruf ausserhalb',            // nach Anruf ausserhalb der Geschaeftszeiten
  'telefonisch leider nicht erreich',
  'vielen dank fuer die weiterleitung',
];

const norm = (v: string): string =>
  String(v || '').toLowerCase()
    .replace(/[äöüß]/g, m => ({ ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' }[m] || m))
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Gehoert diese Vorlage zum eigenen Bestand? */
export function istEigeneVorlage(name: string): boolean {
  const n = norm(name);
  if (!n) return false;
  return EIGENE_VORLAGEN.some(teil => n.includes(teil));
}

/**
 * Loescht alles, was nicht zum eigenen Bestand gehoert. Idempotent: laeuft bei
 * jedem Start und findet danach nichts mehr. Die Historie bleibt heil – in
 * sent_emails steht die Vorlagen-ID als reiner Text, ohne Fremdschluessel.
 */
export function nurEigeneVorlagen(): { geloescht: string[]; behalten: string[] } {
  const db = getDb();
  const alle = db.prepare('SELECT id, name FROM email_templates').all() as Array<{ id: string; name: string }>;
  const raus = alle.filter(t => !istEigeneVorlage(t.name));
  if (raus.length) {
    const del = db.prepare('DELETE FROM email_templates WHERE id = ?');
    const tx = db.transaction((liste: typeof raus) => { for (const t of liste) del.run(t.id); });
    tx(raus);
  }
  return {
    geloescht: raus.map(t => t.name),
    behalten: alle.filter(t => istEigeneVorlage(t.name)).map(t => t.name),
  };
}
