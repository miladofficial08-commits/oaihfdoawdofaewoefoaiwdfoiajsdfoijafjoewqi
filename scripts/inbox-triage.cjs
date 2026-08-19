#!/usr/bin/env node
// Read INBOX, classify each message, print a report and (with --apply) delete noise.
//
// Categories:
//   bounce        - MAILER-DAEMON / postmaster / delivery failure
//   auto-reply    - out-of-office / vacation / auto-response
//   confirmation  - "please confirm", captcha, opt-in, DSGVO-Bestätigung
//   list          - newsletter / mailing list / marketing / unsubscribe headers
//   spam          - obvious junk (crypto, seo, "click here", nigerian, etc.)
//   own           - sent by ourselves (loops back via IMAP)
//   real          - kept, shown to user
//
// Usage:
//   node scripts/inbox-triage.cjs           # dry-run classification report
//   node scripts/inbox-triage.cjs --apply   # delete everything except "real"

require('dotenv').config();
const { ImapFlow } = require('imapflow');

const APPLY = process.argv.includes('--apply');

function extractEmail(raw) {
  if (!raw) return '';
  const m = raw.match(/<([^>]+)>/) || raw.match(/([^\s<>"]+@[^\s<>"]+)/);
  return (m ? m[1] : raw).trim().toLowerCase();
}
const OWN_USER = extractEmail(process.env.SMTP_FROM || process.env.SMTP_USER || '');
const OWN_DOMAIN = OWN_USER.split('@').pop() || 'tawano.de';

function cfg() {
  const smtpHost = process.env.SMTP_HOST || '';
  const derived = smtpHost.replace(/^smtps?\./i, 'imap.');
  return {
    host: process.env.IMAP_HOST || derived || 'imap.udag.de',
    port: Number(process.env.IMAP_PORT || 993),
    secure: process.env.IMAP_SECURE_SSL !== 'false',
    user: process.env.IMAP_USER || process.env.SMTP_USER || '',
    pass: process.env.IMAP_PASS || process.env.SMTP_PASS || '',
  };
}

const BOUNCE_FROM = /(mailer-daemon|postmaster|mail delivery (system|subsystem)|no[-_]?reply.*bounce)/i;
const BOUNCE_SUBJ = /(undelivered mail|delivery status|returned to sender|mail delivery failed|failure notice|unzustellbar|nicht zugestellt|zurückgeschickt|zurueckgeschickt)/i;

const AUTOREPLY_SUBJ = /(out of office|out-of-office|abwesend|abwesenheit|automatic reply|automatische antwort|auto[- ]?reply|urlaub|vacation|ferien|autoresponder|automatische benachrichtigung|autoreply|verabschieden|nicht im büro|nicht im buero|urlaubsvertretung|weihnachts|feiertag|assenza|assente|fuori sede|risposta automatica|ausser haus|außer haus)/i;

const CONFIRM_SUBJ = /(please confirm|bitte bestätigen|bitte bestaetigen|opt[- ]?in|double[- ]?opt|verify your email|verifizierung|captcha|challenge|whitelist|whitelisting|bestätigen sie|bestaetigen sie|are you a human|sind sie ein mensch|are you human|confermare|confirma|einmalcode|verification code|\bverify\b|verifica (profilo|delle informazioni|del tuo profilo|dell'utente|dell utente)|profil.{0,10}verifizier|verificar (perfil|cuenta)|verify your profile|profile verification)/i;

const LIST_SUBJ = /(newsletter|unsubscribe|abmelden|marketing|sale|angebot|rabatt|deal|% off|jetzt kaufen|black friday|cyber monday)/i;

const SPAM_SUBJ = /(seo|backlink|traffic|ranking|guest post|link exchange|crypto|bitcoin|nft|investment opportunity|нigerian|prince|виgra|casino|winner|congratulations you|has been selected|selected as winner)/i;

// System noise from platforms we use (auth, welcome, security, test bookings that we produced ourselves)
const SYSTEM_FROM = /(^|@)(no[- ]?reply|noreply|welcome|account[- ]?alerts|security|team|hello)@(google\.com|accounts\.google\.com|gmail\.com|google-noreply\.com|gmail-noreply\.com|united-domains\.de|udag\.de|cal\.com|calendar\.google\.com|hetzner\.com|strato\.de|ionos\.de|1and1\.com|apple\.com|icloud\.com|microsoft\.com|office\.com|outlook\.com)$/i;
const SYSTEM_SUBJ = /(willkommen in ihrem .* postfach|gmail-bestätigung|sicherheitswarnung|security alert|datenschutzeinstellungen ihres google|e-mail-adresse bestätigen)/i;

// Free personal mailboxes we use for testing (populated at runtime from BLOCK_PERSONAL_SENDERS)
const PERSONAL_TEST_SENDERS = new Set(
  (process.env.BLOCK_PERSONAL_SENDERS || 'miladbayer11@gmail.com,miladofficial08@gmail.com')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
);

function classify(env, headers, body) {
  const fromAddr = (env.from && env.from[0]) || {};
  const fromEmail = (fromAddr.address || '').toLowerCase();
  const fromName = (fromAddr.name || '').toLowerCase();
  const subject = env.subject || '';
  const h = headers || '';
  const b = body || '';

  // Own outbound loops
  if (fromEmail && (fromEmail === OWN_USER || fromEmail.endsWith('@' + OWN_DOMAIN))) return 'own';

  // Personal test mailboxes (own gmail we use for testing)
  if (PERSONAL_TEST_SENDERS.has(fromEmail)) return 'personal';

  // Bounces
  if (BOUNCE_FROM.test(fromEmail) || BOUNCE_FROM.test(fromName) || BOUNCE_SUBJ.test(subject)) return 'bounce';

  // System noise (google auth, united-domains welcome, cal.com test bookings)
  if (SYSTEM_FROM.test(fromEmail) || SYSTEM_SUBJ.test(subject)) return 'system';

  // Auto-reply headers (RFC-standard)
  if (/^auto-submitted:\s*(auto-replied|auto-generated)/im.test(h)) return 'auto-reply';
  if (/^x-autoreply:\s*yes/im.test(h) || /^x-autorespond:/im.test(h) || /^precedence:\s*auto_reply/im.test(h)) return 'auto-reply';
  if (AUTOREPLY_SUBJ.test(subject)) return 'auto-reply';

  // Confirmations / opt-in / verify
  if (CONFIRM_SUBJ.test(subject)) return 'confirmation';

  // Newsletters / mailing lists
  if (/^list-unsubscribe:/im.test(h) || /^list-id:/im.test(h) || /^precedence:\s*bulk/im.test(h)) return 'list';
  if (LIST_SUBJ.test(subject)) return 'list';

  // Spam
  if (SPAM_SUBJ.test(subject)) return 'spam';

  return 'real';
}

async function main() {
  const c = cfg();
  if (!c.user || !c.pass) { console.error('IMAP creds missing'); process.exit(1); }

  const client = new ImapFlow({
    host: c.host, port: c.port, secure: c.secure,
    auth: { user: c.user, pass: c.pass },
    logger: false, tls: { rejectUnauthorized: false }, connectionTimeout: 15000,
  });

  console.log(`Connecting to ${c.host} as ${c.user}`);
  console.log(`Own domain: ${OWN_DOMAIN}`);
  await client.connect();
  const lock = await client.getMailboxLock('INBOX');

  const buckets = { bounce: [], 'auto-reply': [], confirmation: [], list: [], spam: [], system: [], personal: [], own: [], real: [] };
  const sampleByBucket = {};

  try {
    const st = await client.status('INBOX', { messages: true });
    console.log(`INBOX total: ${st.messages || 0}\n`);
    if (!st.messages) return;

    for await (const msg of client.fetch('1:*', {
      uid: true,
      envelope: true,
      headers: ['auto-submitted', 'x-autoreply', 'x-autorespond', 'precedence', 'list-unsubscribe', 'list-id'],
      bodyParts: ['1', 'TEXT'],
    })) {
      const env = msg.envelope || {};
      const headersBuf = msg.headers;
      const headers = headersBuf ? Buffer.from(headersBuf).toString('utf-8') : '';
      const bodyBuf = msg.bodyParts?.get('1') || msg.bodyParts?.get('TEXT');
      const body = bodyBuf ? Buffer.from(bodyBuf).toString('utf-8') : '';

      const cat = classify(env, headers, body);
      buckets[cat].push(msg.uid);
      if (!sampleByBucket[cat]) sampleByBucket[cat] = [];
      if (sampleByBucket[cat].length < 8) {
        const fromAddr = (env.from && env.from[0]) || {};
        sampleByBucket[cat].push({
          from: fromAddr.address || '',
          subj: (env.subject || '').slice(0, 80),
        });
      }
    }

    for (const [cat, uids] of Object.entries(buckets)) {
      console.log(`[${cat}] ${uids.length}`);
      (sampleByBucket[cat] || []).forEach(s => console.log(`   ${s.from}  |  ${s.subj}`));
    }

    // Show every "real" — user needs to verify none are noise
    if (buckets.real.length) {
      console.log(`\n--- ALL "real" (${buckets.real.length}) ---`);
      // Re-fetch just the real UIDs to print them all
      for await (const msg of client.fetch({ uid: buckets.real.join(',') }, { uid: true, envelope: true }, { uid: true })) {
        const env = msg.envelope || {};
        const fromAddr = (env.from && env.from[0]) || {};
        console.log(`   ${(fromAddr.address || '').padEnd(45)}  |  ${(env.subject || '').slice(0, 90)}`);
      }
    }

    const toDelete = [
      ...buckets.bounce,
      ...buckets['auto-reply'],
      ...buckets.confirmation,
      ...buckets.list,
      ...buckets.spam,
      ...buckets.system,
      ...buckets.personal,
      ...buckets.own,
    ];

    console.log(`\nWould delete: ${toDelete.length}. Keeping: ${buckets.real.length} real message(s).`);

    if (!APPLY) {
      console.log('DRY-RUN — re-run with --apply to actually delete.');
      return;
    }

    if (toDelete.length) {
      console.log('Deleting …');
      await client.messageDelete(toDelete, { uid: true });
      console.log('Done.');
    }
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
}

main().catch(e => { console.error('Error:', e && e.message ? e.message : e); process.exit(1); });
