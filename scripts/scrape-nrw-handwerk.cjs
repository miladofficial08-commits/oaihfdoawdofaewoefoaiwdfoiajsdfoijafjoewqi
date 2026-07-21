// Einmaliger Batch-Scrape: NRW Handwerk. skipAi=true (schnell, keine OpenAI-Kosten).
// Läuft die 4 Handwerk-Branchen sequentiell über 5 Rhein-Ruhr-Städte.
require('dotenv/config');
const { runPipeline } = require('../dist/pipeline');

const BRANCHEN = ['SHK Sanitär Heizung', 'Elektriker', 'KFZ Werkstatt', 'Kälte Klima'];
const STAEDTE = ['Duesseldorf', 'Koeln', 'Essen', 'Dortmund', 'Duisburg'];
const MAX = 40;

(async () => {
  const t0 = Date.now();
  let total = 0, inserted = 0, fails = 0;
  for (const branche of BRANCHEN) {
    for (const stadt of STAEDTE) {
      try {
        const r = await runPipeline({ branche, stadt, maxResults: MAX }, { maxResults: MAX, skipAi: true });
        total += r.total; inserted += r.inserted;
        console.log(`[OK] ${branche} / ${stadt}: ${r.total} Leads (${r.inserted} neu, ${r.updated} akt.)`);
      } catch (err) {
        fails++;
        console.log(`[ERR] ${branche} / ${stadt}: ${err && err.message ? err.message : err}`);
      }
    }
  }
  console.log(`\n=== FERTIG in ${Math.round((Date.now() - t0) / 1000)}s | ${total} Leads gesamt | ${inserted} neu | ${fails} Fehler-Läufe ===`);
})();
