#!/usr/bin/env node
/**
 * Gezielte, KOSTENLOSE E-Mail-Anreicherung: holt für Leads MIT Website, aber OHNE
 * E-Mail die Adresse aus dem Impressum/Kontakt (Website-Analyse). Setzt E-Mails NUR
 * hinzu – überschreibt bestehende NIE. Macht „nur Website"-Leads versandfähig.
 *
 * Env:
 *   TRACK=consult | voice_agent   (Standard consult)
 *   LIMIT=200                      (max Leads pro Lauf)
 */
require(require('path').join(__dirname,'..','node_modules','dotenv')).config({ path: require('path').join(__dirname,'..','.env') });
const path = require('path');
const base = path.resolve(__dirname, '..', 'dist');
const { analyzeWebsite } = require(path.join(base,'analyzer','website-checker.js'));
const { getDb } = require(path.join(base,'db','schema.js'));
const { buildIdentity } = require(path.join(base,'utils','identity.js'));

const TRACK = process.env.TRACK === 'voice_agent' ? 'voice_agent' : 'consult';
const LIMIT = Math.max(1, Math.min(1000, Number(process.env.LIMIT) || 200));

(async () => {
  const db = getDb();
  const leads = db.prepare(
    `SELECT * FROM leads
     WHERE COALESCE(track,'voice_agent') = ?
       AND website IS NOT NULL AND website != ''
       AND (email IS NULL OR email = '')
       AND status IN ('new','checked','missing_data','manual_review')
     ORDER BY CASE prioritaet WHEN 'A' THEN 0 WHEN 'B' THEN 1 ELSE 2 END, score_gesamt DESC
     LIMIT ?`
  ).all(TRACK, LIMIT);

  console.log(`\n=== E-Mail-Anreicherung (Track '${TRACK}') ===`);
  console.log(`Kandidaten (Website, keine E-Mail): ${leads.length}\n`);

  const upd = db.prepare(`UPDATE leads SET email=@email, email_normalized=@email_normalized,
    geschaeftsfuehrer=COALESCE(@gf, geschaeftsfuehrer),
    status=CASE WHEN status IN ('missing_data') THEN 'checked' ELSE status END,
    updated_at=datetime('now') WHERE id=@id`);

  let found = 0, checked = 0, errors = 0;
  for (const l of leads) {
    checked++;
    try {
      const a = await analyzeWebsite(l.website);
      if (a && a.email) {
        const ident = buildIdentity({ ...l, email: a.email });
        upd.run({ id: l.id, email: a.email, email_normalized: ident.email_normalized || a.email.toLowerCase(), gf: a.geschaeftsfuehrer || null });
        found++;
        if (found <= 25) console.log(`  ✓ ${l.branche} | ${l.name} -> ${a.email}`);
      }
    } catch (err) {
      errors++;
    }
    if (checked % 20 === 0) console.log(`  … ${checked}/${leads.length} geprüft, ${found} E-Mails gefunden`);
  }

  console.log(`\n=== ERGEBNIS ===`);
  console.log(`Geprüft: ${checked} | NEUE E-Mails: ${found} | Fehler/kein Treffer: ${checked - found}`);
  const sendable = db.prepare(
    `SELECT COUNT(*) n FROM leads WHERE COALESCE(track,'voice_agent')=? AND email IS NOT NULL AND email!=''
       AND status IN ('new','checked','draft_ready','approved','manual_review')
       AND LOWER(TRIM(email)) NOT IN (SELECT LOWER(TRIM(to_email)) FROM sent_emails WHERE success=1 AND to_email IS NOT NULL AND to_email!='')`
  ).get(TRACK).n;
  console.log(`Jetzt versandfähig (${TRACK}, noch nicht kontaktiert): ${sendable}`);
})().catch(e => { console.error('ABBRUCH:', e); process.exit(1); });
