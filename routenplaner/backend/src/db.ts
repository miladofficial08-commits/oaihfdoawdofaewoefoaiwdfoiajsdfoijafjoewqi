// SQLite-Zugriff. Eine Datei, synchrone Zugriffe (better-sqlite3) — bei einer
// Handvoll Nutzern und einigen hundert Praxen ist das schnell genug und spart
// den ganzen Pool-/Async-Aufwand.

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { config } from './config';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  migrieren(db);
  return db;
}

/** Nur für Tests: Datenbank im Arbeitsspeicher. */
export function setTestDb(instanz: Database.Database): void {
  instanz.pragma('journal_mode = memory');
  migrieren(instanz);
  db = instanz;
}

function migrieren(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS praxen (
      id            TEXT PRIMARY KEY,   -- z. B. "osm:node/123" oder "google:ChIJ…"
      name          TEXT NOT NULL,
      kategorie     TEXT NOT NULL,      -- hausarzt | physio | arzt_unklar | prio_facharzt | aerztehaus | pflege
      fachrichtung  TEXT,
      strasse       TEXT,
      hausnummer    TEXT,
      plz           TEXT,
      ort           TEXT,
      stadtteil     TEXT,
      lat           REAL NOT NULL,
      lon           REAL NOT NULL,
      telefon       TEXT,
      website       TEXT,
      email         TEXT,
      oeffnungszeiten TEXT,
      barrierefrei  TEXT,
      quelle        TEXT NOT NULL,      -- osm | google | manuell
      source_url    TEXT,
      adress_key    TEXT NOT NULL,      -- gleiche Tür = gleicher Schlüssel
      entfernung_m  INTEGER,            -- Luftlinie zum Betriebssitz
      aktiv         INTEGER NOT NULL DEFAULT 1,
      angelegt_am   TEXT NOT NULL,
      geaendert_am  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_praxen_adresse  ON praxen(adress_key);
    CREATE INDEX IF NOT EXISTS idx_praxen_kat      ON praxen(kategorie);
    CREATE INDEX IF NOT EXISTS idx_praxen_entf     ON praxen(entfernung_m);

    -- Ein Datensatz pro Praxis, nicht pro Besuch: im Feld zählt der aktuelle
    -- Stand ("waren wir da?"), die Historie steckt im Verlauf unten.
    CREATE TABLE IF NOT EXISTS besuche (
      praxis_id        TEXT PRIMARY KEY REFERENCES praxen(id) ON DELETE CASCADE,
      status           TEXT NOT NULL DEFAULT 'offen',
      notiz            TEXT,
      ansprechpartner  TEXT,
      potenzial        INTEGER,         -- 1 = gering, 2 = mittel, 3 = hoch
      material_da      INTEGER NOT NULL DEFAULT 0,  -- Flyer/Visitenkarte abgegeben
      wiedervorlage    TEXT,            -- ISO-Datum für "nochmal hin"
      bearbeiter       TEXT,
      besucht_am       TEXT,
      geaendert_am     TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS besuch_verlauf (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      praxis_id    TEXT NOT NULL,
      status       TEXT NOT NULL,
      notiz        TEXT,
      bearbeiter   TEXT,
      zeitpunkt    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_verlauf_praxis ON besuch_verlauf(praxis_id);

    CREATE TABLE IF NOT EXISTS touren (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      erstellt_am    TEXT NOT NULL,
      start_adresse  TEXT NOT NULL,
      start_lat      REAL NOT NULL,
      start_lon      REAL NOT NULL,
      params         TEXT NOT NULL,     -- JSON der Bauparameter
      tage           INTEGER NOT NULL,
      stopps         INTEGER NOT NULL,
      strecke_m      INTEGER,
      fahrzeit_s     INTEGER,
      matrix_quelle  TEXT               -- osrm | luftlinie
    );

    -- Ein Stopp ist eine Adresse, nicht eine Praxis: im Ärztehaus steigt man
    -- einmal aus und klingelt oben an mehreren Türen.
    CREATE TABLE IF NOT EXISTS tour_stopps (
      tour_id     INTEGER NOT NULL REFERENCES touren(id) ON DELETE CASCADE,
      tag         INTEGER NOT NULL,
      position    INTEGER NOT NULL,
      adress_key  TEXT NOT NULL,
      lat         REAL NOT NULL,
      lon         REAL NOT NULL,
      strecke_m   INTEGER,              -- vom vorherigen Stopp hierher
      fahrzeit_s  INTEGER,
      PRIMARY KEY (tour_id, tag, position)
    );

    -- Tageswerte getrennt von den Stopps, weil zwei Angaben nirgends sonst
    -- hinpassen: der Rückweg vom letzten Stopp zum Betrieb (er gehört zu
    -- keinem Stopp, zählt aber zur Tagesstrecke) und der Straßenverlauf für
    -- die Karte.
    CREATE TABLE IF NOT EXISTS tour_tage (
      tour_id     INTEGER NOT NULL REFERENCES touren(id) ON DELETE CASCADE,
      tag         INTEGER NOT NULL,
      strecke_m   INTEGER NOT NULL,
      fahrzeit_s  INTEGER NOT NULL,
      rueckweg_m  INTEGER,
      rueckweg_s  INTEGER,
      geometrie   TEXT,
      PRIMARY KEY (tour_id, tag)
    );

    CREATE TABLE IF NOT EXISTS einstellungen (
      schluessel TEXT PRIMARY KEY,
      wert       TEXT NOT NULL
    );
  `);
}

export function setzeEinstellung(schluessel: string, wert: string): void {
  getDb()
    .prepare(
      `INSERT INTO einstellungen (schluessel, wert) VALUES (?, ?)
       ON CONFLICT(schluessel) DO UPDATE SET wert = excluded.wert`,
    )
    .run(schluessel, wert);
}

export function leseEinstellung(schluessel: string): string | null {
  const row = getDb()
    .prepare(`SELECT wert FROM einstellungen WHERE schluessel = ?`)
    .get(schluessel) as { wert: string } | undefined;
  return row ? row.wert : null;
}

export const STATUS_WERTE = [
  'offen',
  'besucht',
  'nochmal',
  'kein_interesse',
  'geschlossen',
] as const;

export type Status = (typeof STATUS_WERTE)[number];

export function istStatus(wert: unknown): wert is Status {
  return typeof wert === 'string' && (STATUS_WERTE as readonly string[]).includes(wert);
}
