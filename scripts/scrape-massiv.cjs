// Großer Lead-Aufbau: Ziel ~1000 Leads pro Branche über ganz NRW.
// skipAi=true (keine OpenAI-Kosten). Läuft lange – im Hintergrund starten.
require('dotenv/config');
const { runPipeline } = require('../dist/pipeline');

// Branche-Label = zugleich Google-Suchbegriff. Labels bleiben konstant, damit die
// Branchen-Filter im Auto-Versand sauber matchen (nicht mischen!).
const BRANCHEN = ['SHK Sanitär Heizung', 'Elektriker', 'Kaelte Klima', 'KFZ Werkstatt'];

const STAEDTE = [
  'Duesseldorf', 'Koeln', 'Essen', 'Dortmund', 'Duisburg', 'Bochum', 'Wuppertal', 'Bielefeld',
  'Bonn', 'Muenster', 'Gelsenkirchen', 'Moenchengladbach', 'Aachen', 'Krefeld', 'Oberhausen', 'Neuss',
];

const MAX_PRO_STADT = 60;

(async () => {
  const t0 = Date.now();
  let total = 0, inserted = 0, fails = 0, runs = 0;
  const gesamtRuns = BRANCHEN.length * STAEDTE.length;
  for (const branche of BRANCHEN) {
    for (const stadt of STAEDTE) {
      runs++;
      try {
        const r = await runPipeline(
          { branche, stadt, maxResults: MAX_PRO_STADT },
          { maxResults: MAX_PRO_STADT, skipAi: true, concurrency: 8 }
        );
        total += r.total; inserted += r.inserted;
        console.log(`[${runs}/${gesamtRuns}] OK ${branche} / ${stadt}: ${r.total} gefunden, ${r.inserted} neu`);
      } catch (err) {
        fails++;
        console.log(`[${runs}/${gesamtRuns}] FEHLER ${branche} / ${stadt}: ${err && err.message ? err.message : err}`);
      }
    }
  }
  console.log(`\n=== FERTIG in ${Math.round((Date.now() - t0) / 60000)} Min | ${total} gefunden | ${inserted} neu | ${fails} Fehler-Läufe ===`);
})();
