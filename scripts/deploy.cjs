#!/usr/bin/env node
/**
 * Sicherer Deploy für DIESES Projekt (Lead-Gen-Dashboard).
 *
 * Hintergrund: In derselben Railway-Organisation liegt auch der Voice-Agent
 * (Projekt "tawano"). Ein `railway up` aus diesem Ordner in den falschen Service
 * ersetzt das Live-Produkt durch das Dashboard. Genau das ist am 18.08.2026
 * passiert. Dieses Skript prüft deshalb VOR dem Upload, ob das verlinkte Ziel
 * stimmt, und bricht sonst ab.
 *
 * NUTZUNG:  npm run deploy
 * Ziel ändern:  Werte unten in EXPECTED anpassen.
 */
const { execSync, spawnSync } = require('child_process');

const EXPECTED = {
  project: 'thorough-truth',
  service: 'oaihfdoawdofaewoefoaiwdfoiajsdfoijafjoewqi',
  environment: 'production',
};

// Projekte, in die dieser Ordner NIEMALS deployt werden darf.
const FORBIDDEN_PROJECTS = ['tawano'];

function railway(args) {
  try {
    return execSync(`railway ${args}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    return String(err.stdout || '') + String(err.stderr || '');
  }
}

function field(text, label) {
  const m = text.match(new RegExp('^\\s*' + label + ':\\s*(.+)$', 'im'));
  return m ? m[1].trim() : '';
}

const status = railway('status');
const project = field(status, 'Project');
const environment = field(status, 'Environment');
// Der Service steht unter "Linked service" in der Folgezeile.
const serviceMatch = status.match(/Linked service\s*\n\s*(\S+)/i);
const service = serviceMatch ? serviceMatch[1].trim() : '';

console.log(`Verlinktes Ziel: Projekt "${project}" · Service "${service}" · Umgebung "${environment}"`);

const problems = [];
if (FORBIDDEN_PROJECTS.includes(project)) {
  problems.push(`Projekt "${project}" ist gesperrt – dort läuft der Voice-Agent, NICHT dieses Dashboard.`);
}
if (project !== EXPECTED.project) problems.push(`Projekt sollte "${EXPECTED.project}" sein, ist aber "${project}".`);
if (service && service !== EXPECTED.service) problems.push(`Service sollte "${EXPECTED.service}" sein, ist aber "${service}".`);
if (environment && environment !== EXPECTED.environment) problems.push(`Umgebung sollte "${EXPECTED.environment}" sein, ist aber "${environment}".`);

if (problems.length) {
  console.error('\n✗ DEPLOY ABGEBROCHEN – falsches Ziel:');
  for (const p of problems) console.error('  • ' + p);
  console.error(`\nRichtig verlinken mit:\n  railway link -p ${EXPECTED.project} -e ${EXPECTED.environment} -s ${EXPECTED.service}\n`);
  process.exit(1);
}

console.log('✓ Ziel stimmt – starte Upload …\n');
const res = spawnSync('railway', ['up', ...process.argv.slice(2)], { stdio: 'inherit', shell: true });
process.exit(res.status ?? 1);
