import fsMod from 'fs';
import { getDb } from './schema';

// ─────────────────────────────────────────────────────────────────────────────
// Was ist tatsächlich rausgegangen – und steht noch etwas an?
//
// Nach dem Vorfall vom 20.–22.08. reicht die Zusage "der Versand ist gestoppt"
// nicht. Man muss die Zahlen sehen können, ohne sich einzuloggen und ohne der
// Anzeige im Dashboard zu glauben. Deshalb schreibt dieser Bericht bei jedem
// Start in die Protokolle:
//
//   • wie viele Mails an wie viele Empfänger pro Tag rausgingen
//   • wie oft dieselbe Praxis in den letzten Tagen angeschrieben wurde
//   • was heute rausging – Adresse für Adresse
//   • was noch in der Warteschlange steht und welche Motoren scharf sind
//
// Ausschließlich SELECT. Dieser Bericht ändert nichts.
// ─────────────────────────────────────────────────────────────────────────────

const TAGE = 3;

export function druckeVersandBericht(): void {
  const db = getDb();
  const p = (s: string) => console.log('[versand-bericht] ' + s);
  const still = <T>(fn: () => T, fallback: T): T => { try { return fn(); } catch (err) { p('  (nicht ermittelbar: ' + (err instanceof Error ? err.message : String(err)) + ')'); return fallback; } };

  p('──────────── Versand-Bericht ────────────');

  const gesamt = still(() => db.prepare(
    `SELECT COUNT(*) n, SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) ok, MAX(sent_at) letzte FROM sent_emails`
  ).get() as { n: number; ok: number; letzte: string | null }, { n: -1, ok: -1, letzte: null });
  p(`Bestand sent_emails: ${gesamt.n} Zeilen, davon erfolgreich ${gesamt.ok}. Letzter Versand: ${gesamt.letzte || 'keiner'}`);

  // Pro Tag: Mails und verschiedene Empfänger – die letzten 10 Tage.
  still(() => {
    const proTag = db.prepare(
      `SELECT date(sent_at) tag, COUNT(*) mails, COUNT(DISTINCT LOWER(TRIM(to_email))) empfaenger
       FROM sent_emails WHERE success = 1 AND sent_at >= date('now','-10 days')
       GROUP BY tag ORDER BY tag DESC`
    ).all() as Array<{ tag: string; mails: number; empfaenger: number }>;
    p('Pro Tag (letzte 10 Tage, nur erfolgreiche):');
    if (!proTag.length) p('  keine einzige Mail in den letzten 10 Tagen');
    for (const t of proTag) p(`  ${t.tag}: ${t.mails} Mails an ${t.empfaenger} Empfaenger`);
    return null;
  }, null);

  // Die letzten drei Tage: wie oft bekam dieselbe Adresse Post?
  still(() => {
    const fenster = `date(sent_at) >= date('now','-${TAGE - 1} days')`;
    const summe = db.prepare(
      `SELECT COUNT(*) mails, COUNT(DISTINCT LOWER(TRIM(to_email))) empfaenger
       FROM sent_emails WHERE success = 1 AND ${fenster}`
    ).get() as { mails: number; empfaenger: number };
    p(`Letzte ${TAGE} Tage gesamt: ${summe.mails} Mails an ${summe.empfaenger} Empfaenger`);
    const je = db.prepare(
      `SELECT LOWER(TRIM(to_email)) email, MAX(to_name) name, COUNT(*) n
       FROM sent_emails WHERE success = 1 AND ${fenster}
       GROUP BY email ORDER BY n DESC, email ASC LIMIT 200`
    ).all() as Array<{ email: string; name: string | null; n: number }>;
    for (const e of je) p(`  ${String(e.n).padStart(3)}x  ${e.email}  (${e.name || 'ohne Namen'})`);
    return null;
  }, null);

  // Heute, Adresse für Adresse.
  still(() => {
    const heute = db.prepare(
      `SELECT LOWER(TRIM(to_email)) email, MAX(to_name) name, COUNT(*) n,
              MIN(time(sent_at)) von, MAX(time(sent_at)) bis, MAX(COALESCE(campaign,'')) kampagne
       FROM sent_emails WHERE date(sent_at) = date('now')
       GROUP BY email ORDER BY n DESC LIMIT 200`
    ).all() as Array<{ email: string; name: string | null; n: number; von: string; bis: string; kampagne: string }>;
    p(`Heute (${new Date().toISOString().slice(0, 10)}): ${heute.reduce((s, h) => s + h.n, 0)} Mails an ${heute.length} Empfaenger`);
    for (const h of heute) p(`  ${String(h.n).padStart(3)}x  ${h.email}  ${h.von}-${h.bis}  ${h.kampagne}`);
    return null;
  }, null);

  // Gegenprobe aus einer zweiten Spur.
  //
  // sent_emails ist genau die Tabelle, die am 20.–22.08. nichts mehr schreiben
  // konnte, weil das Volume voll war. Eine Null dort beweist also noch nichts.
  // outreach_events und leads.gesendet_at werden von anderen Stellen gefuellt –
  // stimmen alle drei ueberein, ist die Null echt.
  still(() => {
    const ev = db.prepare(
      `SELECT date(created_at) tag, event_type, COUNT(*) n FROM outreach_events
       WHERE created_at >= date('now','-7 days') GROUP BY tag, event_type ORDER BY tag DESC, n DESC`
    ).all() as Array<{ tag: string; event_type: string; n: number }>;
    p('Gegenprobe outreach_events (letzte 7 Tage):');
    if (!ev.length) p('  keine einzige Spur in den letzten 7 Tagen');
    for (const e of ev) p(`  ${e.tag}  ${String(e.n).padStart(7)}x  ${e.event_type}`);
    return null;
  }, null);
  still(() => {
    const g = db.prepare(
      `SELECT date(gesendet_at) tag, COUNT(*) n FROM leads
       WHERE gesendet_at IS NOT NULL AND gesendet_at >= date('now','-7 days')
       GROUP BY tag ORDER BY tag DESC`
    ).all() as Array<{ tag: string; n: number }>;
    p('Gegenprobe leads.gesendet_at (letzte 7 Tage):');
    if (!g.length) p('  kein Lead in den letzten 7 Tagen als versendet markiert');
    for (const x of g) p(`  ${x.tag}: ${x.n} Leads`);
    return null;
  }, null);

  // Steht noch etwas an?
  p('Warteschlange und Motoren:');
  still(() => {
    const geplant = db.prepare(
      `SELECT status, COUNT(*) n, MIN(scheduled_at) naechste FROM scheduled_emails GROUP BY status`
    ).all() as Array<{ status: string; n: number; naechste: string | null }>;
    if (!geplant.length) p('  scheduled_emails: leer');
    for (const g of geplant) p(`  scheduled_emails ${g.status}: ${g.n} (naechste ${g.naechste || '-'})`);
    return null;
  }, null);
  still(() => {
    const jobs = db.prepare(`SELECT status, COUNT(*) n FROM send_jobs GROUP BY status`).all() as Array<{ status: string; n: number }>;
    if (!jobs.length) p('  send_jobs: keine');
    for (const j of jobs) p(`  send_jobs ${j.status}: ${j.n}`);
    return null;
  }, null);
  // Probelaeufe: stehen bewusst getrennt und zaehlen nirgends als Versand mit.
  // Die Tabelle entsteht erst beim ersten Probelauf – vorher ist "keine" die
  // richtige Antwort und kein Fehler.
  still(() => {
    const da = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'probe_versand'`).get();
    if (!da) { p('  Probelaeufe: keiner'); return null; }
    const pr = db.prepare(
      `SELECT COUNT(*) zeilen, COUNT(DISTINCT job_id) jobs FROM probe_versand`
    ).get() as { zeilen: number; jobs: number };
    p(`  Probelaeufe: ${pr.zeilen} vorgemerkte Mails in ${pr.jobs} Trockenlauf/-laeufen – davon versendet: 0`);
    return null;
  }, null);
  still(() => {
    const wf = db.prepare(`SELECT name, enabled FROM workflows`).all() as Array<{ name: string; enabled: number }>;
    if (!wf.length) p('  Strategien: keine');
    for (const w of wf) p(`  Strategie "${w.name}": ${w.enabled ? 'AKTIV' : 'aus'}`);
    return null;
  }, null);
  still(() => {
    const f = db.prepare(`SELECT enabled FROM followup_config WHERE id = 1`).get() as { enabled: number } | undefined;
    p(`  Follow-up-Motor: ${f ? (f.enabled ? 'AKTIV' : 'aus') : 'nicht konfiguriert'}`);
    return null;
  }, null);
  p(`  DAILY_ENGINE (Tagesmotor): ${process.env.DAILY_ENGINE || 'nicht gesetzt'}`);
  p(`  VERSAND_STOPP: ${process.env.VERSAND_STOPP || 'NICHT GESETZT'}`);
  // Platz auf dem Volume: die volle Platte war der Ausloeser des Vorfalls.
  still(() => {
    const dir = (process.env.SQLITE_DB_PATH || '/data/leadgen.sqlite').replace(/\/[^/]*$/, '') || '/data';
    const st = (fsMod as unknown as { statfsSync?: (x: string) => { bsize: number; bavail: number; blocks: number } }).statfsSync?.(dir);
    if (!st) { p('  Plattenplatz: nicht ermittelbar'); return null; }
    const frei = st.bsize * st.bavail / 1024 / 1024;
    const ges = st.bsize * st.blocks / 1024 / 1024;
    p(`  Plattenplatz ${dir}: ${frei.toFixed(1)} MB frei von ${ges.toFixed(1)} MB`);
    return null;
  }, null);
  p('─────────────────────────────────────────');
}
