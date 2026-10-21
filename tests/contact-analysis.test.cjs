const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Resolver } = require('node:dns/promises');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tawano-contact-test-'));
process.env.SQLITE_DB_PATH = path.join(dir, 'test.db');
const { getDb } = require('../dist/db/schema');
const { normalizeAddress, addressCandidates, checkAddress, discoverContact, publicIpv4 } = require('../dist/email/contact-check');
const { classifyEmailDelivery } = require('../dist/email/email-status');
const { applyBrevoEvent, ensureBrevoWebhook } = require('../dist/email/brevo-sync');

after(() => { getDb().close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('address format rejects malformed addresses and handles IDN domains', () => {
  for (const bad of ['a..b@example.com', '.name@example.com', 'x@-domain.de', 'x@host', 'x y@example.com', 'x@example.com\r\nBcc:y@example.com']) assert.equal(normalizeAddress(bad), null);
  assert.equal(normalizeAddress('Name@BÜCHER.de'), 'name@xn--bcher-kva.de');
});

test('name candidates transliterate names without claiming a real mailbox', async () => {
  assert.ok(addressCandidates('Dr. Björn Olsen', 'firma.de').includes('bjoern.olsen@firma.de'));
  assert.ok(addressCandidates('Drake Olsen', 'firma.de').includes('drake.olsen@firma.de'));
  assert.deepEqual(addressCandidates('Unbekannt', 'firma.de'), []);
  const result = await discoverContact({ email: 'info@firma.de', geschaeftsfuehrer: 'Björn Olsen' });
  assert.equal(result.candidates.find(c => c.email === 'bjoern.olsen@firma.de').origin, 'suggested');
  const free = await discoverContact({ email: 'info@gmail.com', geschaeftsfuehrer: 'Björn Olsen' });
  assert.equal(free.candidates.length, 1);
});

test('public website lookup rejects internal and metadata addresses', () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '172.20.0.1', '192.168.0.1', '100.64.0.1', '::1']) assert.equal(publicIpv4(ip), false);
  assert.equal(publicIpv4('93.184.216.34'), true);
});

test('MX verifies domain only; null MX invalid; timeout unknown', async t => {
  const mx = t.mock.method(Resolver.prototype, 'resolveMx', async () => [{ priority: 10, exchange: 'mx.example.com' }]);
  let result = await checkAddress('bjoern@example.com');
  assert.equal(result.status, 'plausible');
  assert.equal(result.mailboxConfirmed, false);
  mx.mock.mockImplementation(async () => [{ priority: 0, exchange: '.' }]);
  assert.equal((await checkAddress('bjoern@example.com')).status, 'invalid');
  mx.mock.mockImplementation(async () => { throw Object.assign(Error('timeout'), { code: 'ETIMEOUT' }); });
  assert.equal((await checkAddress('bjoern@example.com')).status, 'unknown');
});

test('delivery claims require provider confirmation and failures remain distinct', () => {
  assert.equal(classifyEmailDelivery({success: 1, opened: true}).code, 'handed_off');
  assert.equal(classifyEmailDelivery({success: 1, deliveryStatus: 'delivered'}).code, 'delivered');
  assert.equal(classifyEmailDelivery({success: 0, error: 'Connection timeout'}).code, 'send_error');
  assert.equal(classifyEmailDelivery({deliveryStatus: 'bounced', error: '550 5.1.1 user unknown'}).code, 'invalid_address');
  assert.notEqual(classifyEmailDelivery({error: 'recipient address rejected by policy'}).code, 'invalid_address');
});

test('Brevo proxy events stay separate, preserve event time and deduplicate retries', () => {
  const db = getDb();
  db.prepare('INSERT INTO sent_emails (id,to_email,subject,body,success,message_id) VALUES (?,?,?,?,?,?)').run('proxy-test','person@example.com','Test','Test',1,'test-mid');
  const event = { event: 'proxy_open', 'message-id': 'test-mid', ts_event: 1700000000 };
  applyBrevoEvent(event); applyBrevoEvent(event);
  const rows = db.prepare('SELECT event_type,created_at FROM email_events WHERE sent_email_id = ?').all('proxy-test');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event_type, 'open_machine');
  assert.equal(rows[0].created_at, new Date(1700000000000).toISOString());
  assert.equal(applyBrevoEvent({event:'delivered','message-id':'unrelated',email:'person@example.com'}).matched,false);
});

test('existing webhook is repaired after a key rotation without changing events', async t => {
  const previous = { key: process.env.BREVO_API_KEY, base: process.env.PUBLIC_BASE_URL };
  process.env.BREVO_API_KEY = 'test-key'; process.env.PUBLIC_BASE_URL = 'https://app.example.com';
  const calls = [];
  t.mock.method(global, 'fetch', async (url, opts) => {
    calls.push({url,opts});
    if (calls.length === 1) return new Response(JSON.stringify({webhooks:[{id:12,url:'https://app.example.com/webhook/brevo?secret=old'}]}));
    return new Response(null, {status:204});
  });
  try {
    assert.equal((await ensureBrevoWebhook()).ok,true);
    assert.equal(calls[1].opts.method,'PUT');
    assert.deepEqual(Object.keys(JSON.parse(calls[1].opts.body)),['url']);
  } finally {
    if (previous.key === undefined) delete process.env.BREVO_API_KEY; else process.env.BREVO_API_KEY = previous.key;
    if (previous.base === undefined) delete process.env.PUBLIC_BASE_URL; else process.env.PUBLIC_BASE_URL = previous.base;
  }
});

test('contact endpoints validate input and do not alter lead emails', async t => {
  t.mock.method(Resolver.prototype, 'resolveMx', async () => [{priority:10,exchange:'mx.firma.de'}]);
  const app = require('fastify')();
  await require('../dist/email/contact-routes').registerContactRoutes(app);
  getDb().prepare('INSERT INTO leads (id,name,branche,stadt,email,geschaeftsfuehrer) VALUES (?,?,?,?,?,?)').run('contact-test','Firma','SHK','Koeln','info@firma.de','Bjoern Olsen');
  try {
    assert.equal((await app.inject({method:'POST',url:'/api/email/address-check',payload:{}})).statusCode,400);
    const res = await app.inject('/api/leads/contact-test/contact-suggestions');
    assert.equal(res.statusCode,200);
    assert.ok(res.json().candidates.some(c=>c.email==='bjoern.olsen@firma.de' && c.origin==='suggested'));
    assert.equal(getDb().prepare('SELECT email FROM leads WHERE id=?').get('contact-test').email,'info@firma.de');
  } finally { await app.close(); }
});

test('dashboard inline scripts parse after contact UI additions', () => {
  const html = fs.readFileSync(path.join(__dirname,'../src/approval/views/dashboard.html'),'utf8');
  for (const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) new (require('node:vm').Script)(m[1]);
});
