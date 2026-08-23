import fs from 'fs';
import path from 'path';

// ─────────────────────────────────────────────────────────────────────────────
// Läuft als Allererstes beim Start – noch bevor irgendjemand die Datenbank öffnet.
//
// Am 22.08.2026 stand das ganze System still: Das Railway-Volume war mit 496 von
// 500 MB voll, SQLite konnte nichts mehr schreiben, und der Server stürzte schon
// beim Anlegen der Tabellen ab (SQLITE_FULL in initSchema). Damit war auch der
// Weg zurück versperrt: Aufräumen ging nur über einen laufenden Container, und
// der Container lief nicht mehr, weil nicht aufgeräumt war.
//
// Diese Datei durchbricht diesen Kreis. Sie schaut vor dem ersten Datenbank-
// Zugriff nach, wie viel Platz da ist, und schafft im Notfall selbst welchen.
// Sie wirft NIEMALS – ein Aufräumer, der den Start verhindert, wäre genau das
// Problem, das er lösen soll.
// ─────────────────────────────────────────────────────────────────────────────

/** Ab hier gilt es als eng: Unter dieser Grenze wird eingegriffen. */
const ENG_MB = 25;
/** Eine WAL-Datei über dieser Größe ist der wahrscheinlichste Platzfresser. */
const WAL_GROSS_MB = 20;

const mb = (bytes: number): string => (bytes / 1024 / 1024).toFixed(1) + ' MB';

function freierPlatz(dir: string): { frei: number; gesamt: number } | null {
  try {
    // statfsSync gibt es erst ab neueren Node-Versionen; fehlt es, arbeiten wir ohne.
    const st = (fs as unknown as { statfsSync?: (p: string) => { bsize: number; bavail: number; blocks: number } })
      .statfsSync?.(dir);
    if (!st) return null;
    return { frei: st.bsize * st.bavail, gesamt: st.bsize * st.blocks };
  } catch { return null; }
}

function dateien(dir: string): Array<{ name: string; size: number }> {
  try {
    return fs.readdirSync(dir)
      .map(n => {
        try { return { name: n, size: fs.statSync(path.join(dir, n)).size }; }
        catch { return { name: n, size: 0 }; }
      })
      .sort((a, b) => b.size - a.size);
  } catch { return []; }
}

/**
 * Die WAL-Datei abschneiden.
 *
 * Letztes Mittel. SQLite behandelt nicht übertragene Transaktionen danach so,
 * als hätte es sie nie gegeben – die Hauptdatei bleibt in sich stimmig. Man
 * verliert also die letzten Schreibvorgänge, aber genau die sind ohnehin nie
 * angekommen, weil die Platte voll war. Stillstand ist teurer.
 */
function walAbschneiden(dbPfad: string): number {
  const wal = dbPfad + '-wal';
  try {
    const size = fs.statSync(wal).size;
    if (size < WAL_GROSS_MB * 1024 * 1024) return 0;
    fs.truncateSync(wal, 0);
    try { fs.unlinkSync(dbPfad + '-shm'); } catch { /* darf fehlen */ }
    return size;
  } catch { return 0; }
}

/**
 * Prüft den Platz und schafft im Notfall welchen. Gibt zurück, ob es eng war.
 */
export function pruefeUndBefreiePlatz(dbPfad: string): void {
  try {
    const dir = path.dirname(dbPfad);
    if (!fs.existsSync(dir)) return;

    const platz = freierPlatz(dir);
    const liste = dateien(dir);

    console.log('[platz] Verzeichnis ' + dir);
    for (const f of liste.slice(0, 8)) console.log('[platz]   ' + mb(f.size).padStart(10) + '  ' + f.name);
    if (platz) {
      console.log('[platz] frei: ' + mb(platz.frei) + ' von ' + mb(platz.gesamt));
    }

    const eng = platz ? platz.frei < ENG_MB * 1024 * 1024 : false;
    if (!eng) return;

    console.warn('[platz] ENG – es wird aufgeraeumt, sonst startet der Server nicht.');

    // 1. Sauberer Weg: WAL in die Hauptdatei uebertragen und abschneiden.
    let befreit = 0;
    try {
      // Lokales require, damit ein fehlendes Modul den Start nicht kippt.
      const Database = require('better-sqlite3');
      const db = new Database(dbPfad);
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.close();
      console.log('[platz] WAL sauber uebertragen und abgeschnitten.');
    } catch (err) {
      // 2. Geht nicht (typisch bei wirklich voller Platte): hart abschneiden.
      console.warn('[platz] Sauberes Uebertragen nicht moeglich (' +
        (err instanceof Error ? err.message : String(err)) + ') – WAL wird hart abgeschnitten.');
      befreit = walAbschneiden(dbPfad);
      if (befreit) console.warn('[platz] WAL abgeschnitten, ' + mb(befreit) + ' frei gemacht.');
    }

    const danach = freierPlatz(dir);
    if (danach) console.log('[platz] jetzt frei: ' + mb(danach.frei));
    if (danach && danach.frei < ENG_MB * 1024 * 1024) {
      console.error('[platz] IMMER NOCH ENG. Das Volume muss vergroessert werden – '
        + 'die groessten Dateien stehen oben.');
    }
  } catch (err) {
    // Niemals den Start verhindern.
    console.error('[platz] Pruefung fehlgeschlagen (Start laeuft trotzdem weiter): '
      + (err instanceof Error ? err.message : String(err)));
  }
}
