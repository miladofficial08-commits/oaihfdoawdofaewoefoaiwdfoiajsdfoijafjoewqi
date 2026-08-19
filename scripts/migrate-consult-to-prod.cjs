#!/usr/bin/env node
/**
 * Migriert die Consult-Leads aus der lokalen DB (data/leads.db) nach Railway/Prod
 * über den Endpunkt POST /api/admin/bulk-import.
 *
 *  - Überträgt den Status mit: die 37 bereits gesendeten kommen als "contacted"
 *    rüber und werden auf Prod NICHT erneut angeschrieben (pickNextLead ignoriert
 *    kontaktierte Leads). Die offenen (new/checked) stehen danach auf Prod bereit.
 *  - Überträgt track='consult' (Prod-Fix muss deployt sein, sonst landen sie als voice_agent).
 *
 * NUTZUNG:
 *   Trockenlauf (zeigt nur, was migriert würde – sendet nichts):
 *     node scripts/migrate-consult-to-prod.cjs
 *
 *   Echte Migration (dein Railway-Admin-Passwort NUR hier, wird nicht gespeichert):
 *     ADMIN_PASSWORD='dein-railway-passwort' node scripts/migrate-consult-to-prod.cjs
 *
 *   Optional andere Ziel-URL:  PROD_URL='https://...railway.app' ADMIN_PASSWORD='...' node ...
 */
const path = require('path');
const fs = require('fs');
const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));

const ROOT = path.join(__dirname, '..');
const DB_PATH = process.env.SQLITE_DB_PATH || path.join(ROOT, 'data', 'leads.db');

// PROD_URL aus Env oder aus .env (PUBLIC_BASE_URL) ableiten.
function readEnvPublicUrl() {
  try {
    const env = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    const m = env.match(/^PUBLIC_BASE_URL=(.*)$/m);
    return m ? m[1].trim() : '';
  } catch { return ''; }
}
const PROD_URL = (process.env.PROD_URL || readEnvPublicUrl()).replace(/\/+$/, '');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const TRACK = process.env.TRACK || 'consult';

const COLS = ['maps_place_id','name','branche','stadt','stadtbezirk','adresse','telefon','website','email','geschaeftsfuehrer','google_bewertung','google_anzahl_reviews','hat_notdienst_hinweis','hat_website','prioritaet','score_gesamt','score_telefon','status','bester_kanal','kontakt_hinweis','track'];

function loadLeads() {
  const db = new Database(DB_PATH, { readonly: true });
  const rows = db.prepare(
    `SELECT ${COLS.join(', ')} FROM leads
     WHERE COALESCE(track,'voice_agent') = ?
       AND maps_place_id IS NOT NULL AND maps_place_id != ''
       AND name IS NOT NULL AND name != ''`
  ).all(TRACK);
  db.close();
  return rows;
}

async function login() {
  const res = await fetch(`${PROD_URL}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `password=${encodeURIComponent(ADMIN_PASSWORD)}`,
    redirect: 'manual',
  });
  const setCookie = res.headers.get('set-cookie') || '';
  const cookie = setCookie.split(';')[0];
  if (!cookie || !cookie.includes('=') || res.status >= 400) {
    throw new Error(`Login fehlgeschlagen (Status ${res.status}). Passwort korrekt? URL: ${PROD_URL}`);
  }
  return cookie;
}

async function importBatch(cookie, leads) {
  const res = await fetch(`${PROD_URL}/api/admin/bulk-import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ leads }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Import fehlgeschlagen (Status ${res.status}): ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

function chunk(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }

(async () => {
  const leads = loadLeads();
  const byStatus = {}; const byBranche = {};
  for (const l of leads) { byStatus[l.status] = (byStatus[l.status]||0)+1; byBranche[l.branche] = (byBranche[l.branche]||0)+1; }

  console.log(`\n=== Consult-Migration (Track '${TRACK}') ===`);
  console.log('Quelle:', DB_PATH);
  console.log('Ziel:  ', PROD_URL || '(keine PROD_URL!)');
  console.log('Migrierbar (mit maps_place_id):', leads.length);
  console.log('nach Status:', JSON.stringify(byStatus));
  console.log('nach Branche:', JSON.stringify(byBranche));

  if (!PROD_URL) { console.error('\nFEHLER: keine PROD_URL/PUBLIC_BASE_URL.'); process.exit(1); }
  if (!ADMIN_PASSWORD) {
    console.log('\n[Trockenlauf] Kein ADMIN_PASSWORD gesetzt – es wird NICHTS gesendet.');
    console.log('Zum echten Migrieren:  ADMIN_PASSWORD=\'dein-passwort\' node scripts/migrate-consult-to-prod.cjs');
    return;
  }

  console.log('\nLogin bei Prod…');
  const cookie = await login();
  console.log('Login OK. Übertrage in Batches…');

  let neu = 0, aktualisiert = 0, fehler = 0;
  for (const [i, batch] of chunk(leads, 500).entries()) {
    const r = await importBatch(cookie, batch);
    neu += r.neu; aktualisiert += r.aktualisiert; fehler += r.fehler;
    console.log(`  Batch ${i+1}: neu ${r.neu}, aktualisiert ${r.aktualisiert}, fehler ${r.fehler} (von ${r.empfangen})`);
  }
  console.log(`\nFERTIG: ${neu} neu, ${aktualisiert} aktualisiert, ${fehler} Fehler.`);
  console.log('Prüfe jetzt auf Railway unter Consult → Leads / Auto-Versand.');
})().catch(err => { console.error('\nABBRUCH:', err.message); process.exit(1); });
