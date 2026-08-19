#!/usr/bin/env node
/**
 * Startet die Consult-Auto-Versand-Jobs auf Railway/Prod sauber neu:
 *  1) loggt sich ein,
 *  2) STOPPT alte laufende Consult-Jobs (räumt Duplikate/gedeckelte Jobs weg),
 *  3) legt pro Branche EINEN frischen Job an – Track 'consult', passende Vorlage,
 *     Ziel hoch genug, um ALLE offenen Leads zu senden (stoppt automatisch, wenn leer).
 *
 * NUTZUNG (PowerShell):
 *   $env:ADMIN_PASSWORD='dein-passwort'; node scripts/start-consult-send-on-prod.cjs
 *   (ohne ADMIN_PASSWORD nur Trockenlauf)
 */
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
function readEnvPublicUrl() { try { const e = fs.readFileSync(path.join(ROOT, '.env'), 'utf8'); const m = e.match(/^PUBLIC_BASE_URL=(.*)$/m); return m ? m[1].trim() : ''; } catch { return ''; } }
const PROD_URL = (process.env.PROD_URL || readEnvPublicUrl()).replace(/\/+$/, '');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

const JOBS = [
  { name: 'Consult – Autohäuser',       verticalId: 'autohaus',       templateIds: ['consult-auto'],   totalTarget: 100 },
  { name: 'Consult – Immobilienmakler', verticalId: 'immobilien',     templateIds: ['consult-immo'],   totalTarget: 100 },
  { name: 'Consult – Steuerberater',    verticalId: 'steuerberater',  templateIds: ['consult-steuer'], totalTarget: 100 },
];

async function login() {
  const res = await fetch(`${PROD_URL}/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `password=${encodeURIComponent(ADMIN_PASSWORD)}`, redirect: 'manual' });
  const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
  if (!cookie || !cookie.includes('=') || res.status >= 400) throw new Error(`Login fehlgeschlagen (Status ${res.status}). Passwort korrekt?`);
  return cookie;
}
async function stopExistingConsultJobs(cookie) {
  const res = await fetch(`${PROD_URL}/api/send-jobs?track=consult`, { headers: { cookie } });
  if (!res.ok) { console.log('  (konnte bestehende Jobs nicht lesen – überspringe Cleanup)'); return; }
  const jobs = await res.json();
  const running = (Array.isArray(jobs) ? jobs : []).filter(j => j.status === 'running');
  for (const j of running) {
    await fetch(`${PROD_URL}/api/send-jobs/${j.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ status: 'stopped' }) });
    console.log(`  ⏹ alten Job gestoppt: ${j.name}`);
  }
}
async function createJob(cookie, job) {
  const res = await fetch(`${PROD_URL}/api/send-jobs`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: job.name, verticalId: job.verticalId, track: 'consult', totalTarget: job.totalTarget, dailyLimit: 50, templateIds: job.templateIds, windowStart: 7, windowEnd: 23, gapSeconds: 60 }) });
  const text = await res.text();
  if (!res.ok) throw new Error(`Job "${job.name}" fehlgeschlagen (Status ${res.status}): ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

(async () => {
  console.log('\n=== Consult-Auto-Versand auf Prod (frisch) ===');
  console.log('Ziel:', PROD_URL || '(keine PROD_URL!)');
  for (const j of JOBS) console.log(`  - ${j.name}: Vorlage ${j.templateIds[0]}, Ziel bis ${j.totalTarget}`);
  if (!PROD_URL) { console.error('FEHLER: keine PROD_URL.'); process.exit(1); }
  if (!ADMIN_PASSWORD) { console.log('\n[Trockenlauf] Kein ADMIN_PASSWORD – es wird nichts gestartet.'); return; }

  const cookie = await login();
  console.log('Login OK. Räume alte Consult-Jobs weg…');
  await stopExistingConsultJobs(cookie);
  console.log('Lege frische Jobs an…');
  for (const j of JOBS) { const r = await createJob(cookie, j); console.log(`  ✓ ${j.name} gestartet (id ${r.id})`); }
  console.log('\nFERTIG. Railway sendet jetzt an ALLE offenen Consult-Leads (bereits kontaktierte werden übersprungen).');
})().catch(err => { console.error('\nABBRUCH:', err.message); process.exit(1); });
