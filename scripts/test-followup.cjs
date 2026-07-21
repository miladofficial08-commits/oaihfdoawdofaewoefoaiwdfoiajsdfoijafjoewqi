// Funktionstest der Follow-up-Auswahl-Logik gegen eine temporäre DB. Kein echter Mailversand.
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = path.join(os.tmpdir(), 'followup-test-' + Date.now() + '.db');
process.env.SQLITE_DB_PATH = tmp;
process.env.ADMIN_PASSWORD = 'x';

const { getDb } = require('../dist/db/schema');
const { dueFollowupCandidate, getFollowupConfig, setFollowupConfig, followupStats } = require('../dist/email/followup-sender');
const { v4: uuid } = require('uuid');

let pass = 0, fail = 0;
const assert = (cond, msg) => { if (cond) { pass++; console.log('ok  - ' + msg); } else { fail++; console.log('NOT OK - ' + msg); } };

const db = getDb();
const daysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString();

function insLead(o) {
  const id = uuid();
  db.prepare(`INSERT INTO leads (id, name, branche, stadt, email, status, followup_stage, followup_stopped, gesendet_at, contacted_at, updated_at)
    VALUES (@id,@name,@branche,@stadt,@email,@status,@stage,@stopped,@ts,@ts,@ts)`).run({
    id, name: o.name, branche: o.branche || 'SHK', stadt: o.stadt || 'Duesseldorf',
    email: o.email, status: o.status || 'contacted', stage: o.stage || 0, stopped: o.stopped || 0,
    ts: o.ts,
  });
  return id;
}
function addEvent(leadId, type, ua) {
  const sid = uuid();
  db.prepare(`INSERT INTO sent_emails (id, lead_id, to_email, success, sent_at) VALUES (?,?,?,1,datetime('now'))`).run(sid, leadId, 'x@y.de');
  db.prepare(`INSERT INTO email_events (id, sent_email_id, event_type, user_agent) VALUES (?,?,?,?)`).run(uuid(), sid, type, ua || null);
}

// Config: gap1=3 Tage, gap2=4 Tage
setFollowupConfig({ enabled: true, gap1_days: 3, gap2_days: 4, daily_cap: 50 });
assert(getFollowupConfig().enabled === 1, 'Config: enabled speichert als 1');
assert(getFollowupConfig().gap1_days === 3, 'Config: gap1_days=3 gespeichert');

// 1) Lead vor 5 Tagen kontaktiert, Stage 0 → fällig für Stage-1-Follow-up
const dueLead = insLead({ name: 'Due', email: 'due@a.de', stage: 0, ts: daysAgo(5) });
// 2) Lead vor 1 Tag kontaktiert → NICHT fällig (gap1=3)
insLead({ name: 'TooRecent', email: 'recent@a.de', stage: 0, ts: daysAgo(1) });
// 3) Lead vor 10 Tagen, aber bereits geantwortet (status=replied) → nie auswählen
insLead({ name: 'Replied', email: 'replied@a.de', status: 'replied', stage: 0, ts: daysAgo(10) });
// 4) Lead vor 10 Tagen, Stage bereits 2 (max) → fertig, nicht auswählen
insLead({ name: 'Maxed', email: 'maxed@a.de', stage: 2, ts: daysAgo(10) });

const first = dueFollowupCandidate();
assert(first && first.lead.id === dueLead && first.stage === 0, 'Auswahl: fälliger 5-Tage-Lead wird für Stage 0→1 gewählt');

// Simuliere: dueLead Stage 1 gesendet vor 5 Tagen → jetzt fällig für Stage 2 (gap2=4)
db.prepare(`UPDATE leads SET followup_stage=1, followup_last_at=? WHERE id=?`).run(daysAgo(5), dueLead);
const second = dueFollowupCandidate();
assert(second && second.lead.id === dueLead && second.stage === 1, 'Auswahl: nach Stage 1 wird Stage 1→2 fällig');

// Stage 1 erst vor 2 Tagen gesendet → NICHT fällig (gap2=4)
db.prepare(`UPDATE leads SET followup_last_at=? WHERE id=?`).run(daysAgo(2), dueLead);
assert(dueFollowupCandidate() === null, 'Auswahl: Stage-2 zu früh (2<4 Tage) → nichts fällig');

// 5) Echter Klick → Lead wird gestoppt, nicht ausgewählt
db.prepare(`UPDATE leads SET followup_last_at=? WHERE id=?`).run(daysAgo(9), dueLead); // wieder fällig machen
addEvent(dueLead, 'click', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1');
const afterClick = dueFollowupCandidate();
assert(afterClick === null, 'Stop: Lead mit echtem Klick wird nicht mehr angeschrieben');
const stoppedRow = db.prepare(`SELECT followup_stopped, followup_stopped_reason FROM leads WHERE id=?`).get(dueLead);
assert(stoppedRow.followup_stopped === 1 && /Klick/.test(stoppedRow.followup_stopped_reason || ''), 'Stop: followup_stopped=1 mit Grund "Klick" gesetzt');

// 6) Maschinen-Klick (Scanner) darf NICHT stoppen/zählen
const scanLead = insLead({ name: 'Scanned', email: 'scan@a.de', stage: 0, ts: daysAgo(6) });
addEvent(scanLead, 'click', 'Mozilla/5.0 (compatible; Proofpoint) SafeLinks');
const afterScan = dueFollowupCandidate();
assert(afterScan && afterScan.lead.id === scanLead, 'Stop: Scanner-Klick stoppt NICHT – Lead bleibt fällig');

// 7) Bounce → Stop
const bounceLead = insLead({ name: 'Bounced', email: 'bounce@a.de', stage: 0, ts: daysAgo(6) });
addEvent(bounceLead, 'bounce', null);
// scanLead ist jetzt der erste fällige; bounceLead separat prüfen: scanLead stoppen wir künstlich weg
db.prepare(`UPDATE leads SET followup_stopped=1 WHERE id=?`).run(scanLead);
const afterBounce = dueFollowupCandidate();
assert(afterBounce === null, 'Stop: Lead mit Bounce wird nicht angeschrieben');
const bRow = db.prepare(`SELECT followup_stopped, followup_stopped_reason FROM leads WHERE id=?`).get(bounceLead);
assert(bRow.followup_stopped === 1 && /Bounce/.test(bRow.followup_stopped_reason || ''), 'Stop: Bounce setzt followup_stopped mit Grund "Bounce"');

// 8) Stats plausibel
const st = followupStats();
assert(typeof st.sent_total === 'number' && st.max_stages === 2, 'Stats: liefert max_stages=2 und sent_total');

console.log(`\n${pass} passed, ${fail} failed`);
try { db.close(); } catch {}
for (const f of [tmp, tmp + '-wal', tmp + '-shm']) { try { fs.unlinkSync(f); } catch {} }
process.exit(fail ? 1 : 0);
