// Gezielte Nachanalyse: nur Leads MIT Website aber OHNE E-Mail.
// Nutzt den verbesserten Extractor (HTML-Entity-Dekodierung) und macht gefundene
// Adressen sofort versandfaehig. Outreach-Status werden nie angefasst.
require('dotenv/config');
const { analyzeWebsite } = require('../dist/analyzer/website-checker');
const { getDb } = require('../dist/db/schema');
const { refreshContactPoints } = require('../dist/db/leads-repo');
const { buildIdentity } = require('../dist/utils/identity');

const CONCURRENCY = 8;
const UPGRADE_VON = ['manual_review', 'missing_data', 'new'];

(async () => {
  const db = getDb();
  const leads = db.prepare(`
    SELECT id, name, website, status FROM leads
    WHERE website IS NOT NULL AND website != '' AND (email IS NULL OR email = '')
      AND status NOT IN ('contacted','replied','demo_booked','proposal_sent','won','lost','no_interest','do_not_contact','archived','duplicate')
  `).all();

  console.log(`Pruefe ${leads.length} Leads mit Website aber ohne E-Mail...`);
  const upd = db.prepare(`UPDATE leads SET email=@email, email_normalized=@email_normalized,
      kontaktformular_url=COALESCE(@form, kontaktformular_url),
      status=@status, bester_kanal='email', updated_at=datetime('now') WHERE id=@id`);

  let gefunden = 0, geprueft = 0, fehler = 0;
  const chunks = [];
  for (let i = 0; i < leads.length; i += CONCURRENCY) chunks.push(leads.slice(i, i + CONCURRENCY));

  for (const batch of chunks) {
    await Promise.all(batch.map(async (l) => {
      geprueft++;
      try {
        const a = await analyzeWebsite(l.website);
        if (a && a.email) {
          const ident = buildIdentity({ email: a.email });
          const status = UPGRADE_VON.includes(l.status) ? 'checked' : l.status;
          upd.run({
            id: l.id, email: a.email, email_normalized: ident.email_normalized || null,
            form: a.kontaktformular_url || null, status,
          });
          const full = db.prepare('SELECT * FROM leads WHERE id = ?').get(l.id);
          refreshContactPoints(full);
          gefunden++;
          console.log(`  + ${a.email.padEnd(38)} ${l.name.slice(0, 45)}`);
        }
      } catch (err) {
        fehler++;
      }
    }));
    if (geprueft % 40 === 0) console.log(`  … ${geprueft}/${leads.length} geprueft, ${gefunden} neue E-Mails`);
  }
  console.log(`\n=== FERTIG: ${gefunden} neue E-Mail-Adressen aus ${leads.length} Leads geholt (${fehler} Fehler) ===`);
})();
