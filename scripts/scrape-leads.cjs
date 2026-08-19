#!/usr/bin/env node
/**
 * Aktive Lead-Beschaffung über den Apify-Google-Maps-Scraper (runPipeline).
 * Scrapet je Branche × Stadt, extrahiert E-Mails via Website-Analyse, dedupliziert
 * über maps_place_id und schreibt in die lokale DB. Für Consult-Branchen wird
 * danach track='consult' gesetzt (Apify vergibt sonst voice_agent).
 *
 * Steuerung über Env-Variablen:
 *   BRANCHES='Immobilienmakler;Autohäuser'   (mit ; getrennt)
 *   CITIES='Bonn;Aachen;Münster'             (mit ; getrennt)
 *   MAX=40                                    (max Ergebnisse je Branche×Stadt)
 *   TRACK=consult | voice_agent               (Track, der den Branchen zugewiesen wird)
 *
 * Beispiel:
 *   BRANCHES='Immobilienmakler' CITIES='Bonn' MAX=12 TRACK=consult node scripts/scrape-leads.cjs
 */
require(require('path').join(__dirname, '..', 'node_modules', 'dotenv')).config({ path: require('path').join(__dirname, '..', '.env') });
const path = require('path');
const base = path.join(__dirname, '..', 'dist');
const { runPipeline } = require(path.join(base, 'pipeline.js'));
const { getDb } = require(path.join(base, 'db', 'schema.js'));

const split = v => String(v || '').split(';').map(s => s.trim()).filter(Boolean);
const BRANCHES = split(process.env.BRANCHES);
const CITIES = split(process.env.CITIES);
const MAX = Math.max(1, Math.min(200, Number(process.env.MAX) || 40));
const TRACK = process.env.TRACK === 'consult' ? 'consult' : 'voice_agent';

if (!BRANCHES.length || !CITIES.length) {
  console.error('FEHLER: BRANCHES und CITIES setzen (mit ; getrennt).');
  process.exit(1);
}

(async () => {
  console.log(`\n=== Lead-Scrape (Track '${TRACK}', max ${MAX}/Branche×Stadt) ===`);
  console.log('Branchen:', BRANCHES.join(', '));
  console.log('Städte:  ', CITIES.join(', '));
  console.log('Apify-Token gesetzt:', Boolean(process.env.APIFY_API_TOKEN));

  let totalNew = 0, totalFound = 0, totalUpd = 0, errors = 0;
  for (const branche of BRANCHES) {
    for (const stadt of CITIES) {
      const t0 = Date.now();
      try {
        const r = await runPipeline({ branche, stadt, maxResults: MAX }, { maxResults: MAX, skipAi: true });
        totalNew += r.inserted; totalFound += r.total; totalUpd += r.updated;
        console.log(`  ${branche} / ${stadt}: ${r.total} gefunden, ${r.inserted} neu, ${r.updated} akt. (${Math.round((Date.now()-t0)/1000)}s)`);
      } catch (err) {
        errors++;
        console.log(`  ${branche} / ${stadt}: FEHLER – ${(err instanceof Error ? err.message : String(err)).slice(0,120)}`);
      }
    }
  }

  // Track für die gescrapten Branchen setzen (Apify vergibt sonst voice_agent).
  if (TRACK === 'consult') {
    const db = getDb();
    let flipped = 0;
    for (const branche of BRANCHES) {
      const res = db.prepare(`UPDATE leads SET track='consult', updated_at=datetime('now') WHERE branche=? AND COALESCE(track,'voice_agent')!='consult'`).run(branche);
      flipped += res.changes;
    }
    console.log(`\n  track='consult' gesetzt für ${flipped} Leads (Branchen: ${BRANCHES.join(', ')})`);
  }

  // Wie viele davon haben eine E-Mail (versandfähig)?
  const db = getDb();
  const ph = BRANCHES.map(()=>'?').join(',');
  const withEmail = db.prepare(`SELECT COUNT(*) n FROM leads WHERE branche IN (${ph}) AND email IS NOT NULL AND email!=''`).all ? db.prepare(`SELECT COUNT(*) n FROM leads WHERE branche IN (${ph}) AND email IS NOT NULL AND email!=''`).get(...BRANCHES).n : 0;

  console.log(`\n=== ERGEBNIS ===`);
  console.log(`Gefunden gesamt: ${totalFound} | NEU: ${totalNew} | aktualisiert: ${totalUpd} | Fehler: ${errors}`);
  console.log(`Leads mit E-Mail in diesen Branchen (gesamt): ${withEmail}`);
})().catch(e => { console.error('ABBRUCH:', e); process.exit(1); });
