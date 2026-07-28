#!/usr/bin/env node
/**
 * Migriert die LOKALEN Leads (data/leads.db) in die PRODUKTIONS-Datenbank auf Railway.
 *
 * Hintergrund: `railway up` deployt nur den Code, NICHT die lokale SQLite-DB. Prod hat
 * ein eigenes Volume. Dieses Skript überträgt die lokalen Leads einmalig über die
 * API (/api/admin/bulk-import), inkl. Dedup über maps_place_id (mehrfach ausführbar).
 *
 * Aufruf (aus dem Projektordner):
 *   ADMIN_PASSWORD="dein-railway-passwort" node scripts/migrate-to-prod.cjs
 *
 * Optional andere Ziel-URL:
 *   PROD_URL="https://deine-app.up.railway.app" ADMIN_PASSWORD="..." node scripts/migrate-to-prod.cjs
 */
const path = require('path');
const Database = require('better-sqlite3');

const DEFAULT_PROD = 'https://oaihfdoawdofaewoefoaiwdfoiajsdfoijafjoewqi-production.up.railway.app';
const PROD = (process.env.PROD_URL || DEFAULT_PROD).replace(/\/+$/, '');
const PW = process.env.ADMIN_PASSWORD;
const DB_PATH = process.env.SQLITE_DB_PATH || path.join(process.cwd(), 'data', 'leads.db');
const BATCH = 200;

const COLS = [
  'maps_place_id', 'name', 'branche', 'stadt', 'stadtbezirk', 'adresse', 'telefon', 'website',
  'email', 'geschaeftsfuehrer', 'google_bewertung', 'google_anzahl_reviews', 'hat_notdienst_hinweis',
  'hat_website', 'prioritaet', 'score_gesamt', 'score_telefon', 'status', 'bester_kanal', 'kontakt_hinweis',
];

async function main() {
  if (!PW) {
    console.error('FEHLER: Bitte das Railway-Admin-Passwort setzen:\n  ADMIN_PASSWORD="..." node scripts/migrate-to-prod.cjs');
    process.exit(1);
  }
  const db = new Database(DB_PATH, { readonly: true });
  // maps_place_id fehlt bei manchen Alt-Leads → synthetischen Schlüssel aus der id bilden.
  const rows = db.prepare(
    `SELECT COALESCE(maps_place_id, 'local:' || id) AS maps_place_id,
            ${COLS.filter(c => c !== 'maps_place_id').join(', ')}
     FROM leads WHERE status != 'archived'`
  ).all();
  console.log(`Lokale Leads gefunden: ${rows.length}`);
  console.log(`Ziel: ${PROD}`);

  const login = await fetch(PROD + '/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PW }), redirect: 'manual',
  });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  if (!cookie) {
    console.error(`Login fehlgeschlagen (Status ${login.status}). Passwort/URL prüfen.`);
    process.exit(1);
  }
  console.log('Login OK. Übertrage in Batches …\n');

  let neu = 0, aktualisiert = 0, fehler = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const r = await fetch(PROD + '/api/admin/bulk-import', {
      method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ leads: batch }),
    });
    const b = await r.json().catch(() => ({}));
    if (!r.ok) { console.error(`  Batch ${i}-${i + batch.length} FEHLER ${r.status}:`, b); continue; }
    neu += b.neu || 0; aktualisiert += b.aktualisiert || 0; fehler += b.fehler || 0;
    console.log(`  ${Math.min(i + BATCH, rows.length)}/${rows.length} übertragen → neu ${neu}, aktualisiert ${aktualisiert}, übersprungen/Fehler ${fehler}`);
  }
  console.log(`\nFertig. ${neu} neu, ${aktualisiert} aktualisiert, ${fehler} Fehler auf ${PROD}`);
  console.log('Tipp: danach auf der Seite „Leads finden" einmal „Kontakte + GF nachtragen" laufen lassen.');
}

main().catch(err => { console.error(err); process.exit(1); });
