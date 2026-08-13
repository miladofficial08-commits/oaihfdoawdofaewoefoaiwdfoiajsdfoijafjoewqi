#!/usr/bin/env node
/**
 * Impressum-Anreicherung: macht aus einer Liste von Zentralen eine Liste von Namen.
 *
 * Die Nummer aus Google Maps ist die Zentrale — genau die Leitung, die eine Bürokraft
 * abschirmt. Dieses Skript holt aus Impressum/Kontakt (§5 DDG) den Namen des
 * Geschäftsführers und, wo vorhanden, eine Mobil-/Durchwahlnummer.
 *
 * Bestehende Werte werden nie überschrieben, nur Lücken gefüllt.
 *
 * Notdienstnummern landen in einer EIGENEN Spalte und nie in der Anrufliste:
 * wer eine Notdienstleitung mit einem Verkaufsanruf blockiert, hat verloren.
 *
 * Env:
 *   BRANCHE=SHK,Elektriker   Teilstring-Filter auf branche (Standard: alle)
 *   TRACK=voice_agent|consult|all   (Standard: all)
 *   LIMIT=600                max. Leads pro Lauf (Standard 600)
 *   CONCURRENCY=4            parallele Websites (Standard 4)
 *   RECHECK=1                auch bereits geprüfte Leads erneut laden
 */
require(require('path').join(__dirname, '..', 'node_modules', 'dotenv')).config({ path: require('path').join(__dirname, '..', '.env') });
const path = require('path');
const base = path.resolve(__dirname, '..', 'dist');
const { analyzeImpressum } = require(path.join(base, 'analyzer', 'website-checker.js'));
const { getDb } = require(path.join(base, 'db', 'schema.js'));

const LIMIT = Math.max(1, Math.min(2000, Number(process.env.LIMIT) || 600));
const CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.CONCURRENCY) || 4));
const RECHECK = process.env.RECHECK === '1';
const TRACK = process.env.TRACK && process.env.TRACK !== 'all' ? process.env.TRACK : null;
const BRANCHEN = (process.env.BRANCHE || '').split(',').map(s => s.trim()).filter(Boolean);

(async () => {
  const db = getDb();

  const where = [
    `website IS NOT NULL AND website != ''`,
    `duplicate_of IS NULL`,
    `status NOT IN ('archived','no_interest')`,
  ];
  const params = [];
  if (!RECHECK) where.push(`impressum_checked_at IS NULL`);
  if (TRACK) { where.push(`COALESCE(track,'voice_agent') = ?`); params.push(TRACK); }
  if (BRANCHEN.length) {
    where.push(`(${BRANCHEN.map(() => 'branche LIKE ?').join(' OR ')})`);
    params.push(...BRANCHEN.map(b => `%${b}%`));
  }

  const leads = db.prepare(
    `SELECT id, name, branche, stadt, website, telefon, geschaeftsfuehrer
       FROM leads
      WHERE ${where.join(' AND ')}
      ORDER BY CASE prioritaet WHEN 'A' THEN 0 WHEN 'B' THEN 1 ELSE 2 END, score_gesamt DESC
      LIMIT ?`
  ).all(...params, LIMIT);

  console.log(`\n=== Impressum-Anreicherung ===`);
  console.log(`Kandidaten (Website vorhanden${RECHECK ? '' : ', noch nicht geprüft'}): ${leads.length}`);
  if (BRANCHEN.length) console.log(`Branchen-Filter: ${BRANCHEN.join(', ')}`);
  console.log(`Parallel: ${CONCURRENCY}\n`);
  if (!leads.length) { console.log('Nichts zu tun.'); process.exit(0); }

  const upd = db.prepare(`
    UPDATE leads SET
      geschaeftsfuehrer   = COALESCE(NULLIF(geschaeftsfuehrer,''), @gf),
      telefon_direkt      = COALESCE(@direkt, telefon_direkt),
      telefon_direkt_typ  = COALESCE(@direkt_typ, telefon_direkt_typ),
      telefon_notdienst   = COALESCE(@notdienst, telefon_notdienst),
      whatsapp            = COALESCE(NULLIF(whatsapp,''), @whatsapp),
      impressum_url       = COALESCE(@impressum, impressum_url),
      impressum_checked_at = datetime('now'),
      updated_at          = datetime('now')
    WHERE id = @id`);

  const stats = { geprueft: 0, gf: 0, direkt: 0, mobil: 0, notdienst: 0, whatsapp: 0, fehler: 0 };
  let index = 0;

  async function worker() {
    while (index < leads.length) {
      const l = leads[index++];
      try {
        const r = await analyzeImpressum(l.website, l.telefon, l.name);
        upd.run({
          id: l.id,
          gf: r.geschaeftsfuehrer || null,
          direkt: r.telefon_direkt || null,
          direkt_typ: r.telefon_direkt_typ || null,
          notdienst: r.telefon_notdienst || null,
          whatsapp: r.whatsapp || null,
          impressum: r.impressum_url || null,
        });
        if (r.error) stats.fehler++;
        if (r.geschaeftsfuehrer && !l.geschaeftsfuehrer) stats.gf++;
        if (r.telefon_direkt) { stats.direkt++; if (r.telefon_direkt_typ === 'mobil') stats.mobil++; }
        if (r.telefon_notdienst) stats.notdienst++;
        if (r.whatsapp) stats.whatsapp++;
        if (r.geschaeftsfuehrer || r.telefon_direkt) {
          const teile = [r.geschaeftsfuehrer, r.telefon_direkt && `${r.telefon_direkt} (${r.telefon_direkt_typ})`].filter(Boolean);
          console.log(`  + ${l.name} — ${teile.join(' | ')}`);
        }
      } catch (err) {
        stats.fehler++;
      }
      stats.geprueft++;
      if (stats.geprueft % 25 === 0) {
        console.log(`  … ${stats.geprueft}/${leads.length} | Namen: ${stats.gf} | Direktnummern: ${stats.direkt}`);
      }
      await new Promise(r => setTimeout(r, 250)); // höflich bleiben
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  console.log(`\n=== ERGEBNIS ===`);
  console.log(`Geprüft:              ${stats.geprueft}`);
  console.log(`Neue GF-Namen:        ${stats.gf}`);
  console.log(`Direktnummern:        ${stats.direkt} (davon mobil: ${stats.mobil})`);
  console.log(`WhatsApp:             ${stats.whatsapp}`);
  console.log(`Notdienstnummern:     ${stats.notdienst}  ← separat gespeichert, NICHT anrufen`);
  console.log(`Nicht erreichbar:     ${stats.fehler}`);

  // Vorschau nur über denselben Ausschnitt, der auch angereichert wurde – sonst
  // stehen hier Autohäuser und Makler aus früheren Läufen mit drin.
  const vorschauWhere = [`duplicate_of IS NULL`, `geschaeftsfuehrer IS NOT NULL AND geschaeftsfuehrer != ''`,
    `COALESCE(telefon_direkt, telefon) IS NOT NULL`, `status NOT IN ('archived','no_interest')`];
  const vorschauParams = [];
  if (TRACK) { vorschauWhere.push(`COALESCE(track,'voice_agent') = ?`); vorschauParams.push(TRACK); }
  if (BRANCHEN.length) {
    vorschauWhere.push(`(${BRANCHEN.map(() => 'branche LIKE ?').join(' OR ')})`);
    vorschauParams.push(...BRANCHEN.map(b => `%${b}%`));
  }
  const anrufbar = db.prepare(`
    SELECT name, stadt, geschaeftsfuehrer, COALESCE(telefon_direkt, telefon) AS nummer, telefon_direkt_typ
      FROM leads WHERE ${vorschauWhere.join(' AND ')}
     ORDER BY telefon_direkt IS NULL, score_gesamt DESC`).all(...vorschauParams);

  console.log(`\n=== ANRUFLISTE: ${anrufbar.length} Betriebe mit Namen ===`);
  for (const a of anrufbar.slice(0, 20)) {
    // Auch eine Maps-Nummer kann eine Mobilnummer sein – dann geht der Chef selbst ran.
    const typ = a.telefon_direkt_typ ? `[${a.telefon_direkt_typ}]`
      : /^(\+49\s?|0)1[567]/.test(String(a.nummer)) ? '[mobil]' : '[Zentrale]';
    console.log(`  ${a.geschaeftsfuehrer.padEnd(26)} ${String(a.nummer).padEnd(20)}${typ.padEnd(11)} ${a.name} (${a.stadt})`);
  }
  if (anrufbar.length > 20) console.log(`  … und ${anrufbar.length - 20} weitere`);
  process.exit(0);
})();
