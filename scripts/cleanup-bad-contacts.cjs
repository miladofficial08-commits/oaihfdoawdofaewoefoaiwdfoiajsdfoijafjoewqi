const Database = require('better-sqlite3');

const db = new Database('data/leads.db');

const badEmail = db.prepare(`
  UPDATE leads
  SET email = NULL
  WHERE lower(email) GLOB '*.png'
     OR lower(email) GLOB '*.jpg'
     OR lower(email) GLOB '*.jpeg'
     OR lower(email) GLOB '*.gif'
     OR lower(email) GLOB '*.webp'
     OR lower(email) GLOB '*.svg'
     OR lower(email) GLOB '*.css'
     OR lower(email) GLOB '*.js'
     OR lower(email) GLOB '*.woff'
     OR lower(email) GLOB '*.woff2'
     OR lower(email) GLOB '*.ttf'
     OR lower(email) GLOB '*.ico'
     OR lower(email) GLOB '*@*x-*.png'
`).run();

const badForm = db.prepare(`
  UPDATE leads
  SET kontaktformular_url = NULL
  WHERE lower(kontaktformular_url) LIKE '%/wp-content/%'
     OR lower(kontaktformular_url) LIKE '%/plugins/%'
     OR lower(kontaktformular_url) LIKE '%/themes/%'
     OR lower(kontaktformular_url) LIKE '%.css%'
     OR lower(kontaktformular_url) LIKE '%.js%'
     OR lower(kontaktformular_url) LIKE '%.woff%'
`).run();

const rows = db.prepare(`
  SELECT id, whatsapp, email, kontaktformular_url, telefon, score_telefon, website_evidence
  FROM leads
`).all();

const update = db.prepare(`
  UPDATE leads
  SET bester_kanal = @bester_kanal,
      kontakt_hinweis = @kontakt_hinweis,
      telefonstrategie_empfohlen = @telefonstrategie_empfohlen,
      website_evidence = @website_evidence
  WHERE id = @id
`);

const tx = db.transaction((items) => {
  for (const row of items) {
    let bester_kanal = 'manuell';
    let kontakt_hinweis = 'Kein sicherer Kontaktweg gefunden; manuelle Recherche erforderlich';

    if (row.whatsapp) {
      bester_kanal = 'whatsapp';
      kontakt_hinweis = 'WhatsApp ist oeffentlich auf der Website verlinkt';
    } else if (row.email) {
      bester_kanal = 'email';
      kontakt_hinweis = 'Oeffentliche E-Mail gefunden';
    } else if (row.kontaktformular_url) {
      bester_kanal = 'kontaktformular';
      kontakt_hinweis = 'Keine E-Mail gefunden; Kontaktformular verwenden';
    } else if (row.telefon && row.score_telefon >= 70) {
      bester_kanal = 'telefon';
      kontakt_hinweis = 'Stark telefonisch abhaengig; manuelle Telefonstrategie moeglich, kein automatischer Anruf';
    } else if (row.telefon) {
      bester_kanal = 'telefon';
      kontakt_hinweis = 'Nur Telefon gefunden; manuell kontaktieren';
    }

    update.run({
      id: row.id,
      bester_kanal,
      kontakt_hinweis,
      telefonstrategie_empfohlen: row.score_telefon >= 70 ? 1 : 0,
      website_evidence: cleanEvidence(row.website_evidence),
    });
  }
});

tx(rows);

console.log(JSON.stringify({
  badEmailCleared: badEmail.changes,
  badContactFormsCleared: badForm.changes,
  contactHintsUpdated: rows.length,
}, null, 2));

function cleanEvidence(value) {
  if (!value) return value;
  try {
    const items = JSON.parse(value);
    if (!Array.isArray(items)) return value;
    const cleaned = items.filter(item => {
      const lower = String(item).toLowerCase();
      if (lower.includes('2x-150x150.png')) return false;
      if (lower.includes('/wp-content/') && (lower.includes('.css') || lower.includes('.js') || lower.includes('.woff'))) return false;
      if (/oeffentliche e-mail gefunden: .*\.(png|jpg|jpeg|gif|webp|svg|css|js|woff2?|ttf|ico)$/i.test(String(item))) return false;
      return true;
    });
    return JSON.stringify(cleaned);
  } catch {
    return value;
  }
}
