#!/usr/bin/env node
// Delete MAILER-DAEMON bounce emails from the INBOX so the user can see real replies.
// Usage:
//   node scripts/cleanup-bounces.cjs           # dry-run: only reports what it would delete
//   node scripts/cleanup-bounces.cjs --apply   # actually deletes

require('dotenv').config();
const { ImapFlow } = require('imapflow');

const APPLY = process.argv.includes('--apply');

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

const BOUNCE_FROM_RE = /(mailer-daemon|postmaster|mail delivery (system|subsystem)|no[-_]?reply.*bounce)/i;
const BOUNCE_SUBJECT_RE = /(undelivered mail|delivery status notification|returned to sender|mail delivery failed|failure notice|unzustellbar|nicht zugestellt|zurückgeschickt)/i;

async function main() {
  const c = cfg();
  if (!c.user || !c.pass) {
    console.error('IMAP_USER / IMAP_PASS missing in .env');
    process.exit(1);
  }
  const client = new ImapFlow({
    host: c.host, port: c.port, secure: c.secure,
    auth: { user: c.user, pass: c.pass },
    logger: false,
    tls: { rejectUnauthorized: false },
    connectionTimeout: 15000,
  });

  console.log(`Connecting to ${c.host}:${c.port} as ${c.user} …`);
  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  const bounceUids = [];
  const senders = new Map();
  const failedRecipients = new Map();

  try {
    const st = await client.status('INBOX', { messages: true });
    console.log(`INBOX total: ${st.messages || 0}`);

    for await (const msg of client.fetch('1:*', {
      uid: true,
      envelope: true,
      bodyParts: ['1', 'TEXT'],
    })) {
      const env = msg.envelope || {};
      const fromAddr = (env.from && env.from[0]) || {};
      const fromEmail = (fromAddr.address || '').toLowerCase();
      const fromName = fromAddr.name || '';
      const subject = env.subject || '';

      const looksBounce =
        BOUNCE_FROM_RE.test(fromEmail) ||
        BOUNCE_FROM_RE.test(fromName) ||
        BOUNCE_SUBJECT_RE.test(subject);

      if (!looksBounce) continue;

      bounceUids.push(msg.uid);
      senders.set(fromEmail, (senders.get(fromEmail) || 0) + 1);

      // Try to extract the failed recipient from the body
      const buf = msg.bodyParts?.get('1') || msg.bodyParts?.get('TEXT');
      const body = buf ? Buffer.from(buf).toString('utf-8') : '';
      const m =
        body.match(/RCPT TO:\s*<([^>]+)>/i) ||
        body.match(/final-recipient:\s*(?:rfc822;\s*)?([^\s\n\r]+)/i) ||
        body.match(/<([^>@\s]+@[^>\s]+)>[^\n]*(?:user unknown|does not exist|no such user|mailbox unavailable|550)/i);
      if (m) {
        const bad = m[1].toLowerCase().replace(/[<>]/g, '');
        failedRecipients.set(bad, (failedRecipients.get(bad) || 0) + 1);
      }
    }

    console.log(`\nFound ${bounceUids.length} bounce message(s).`);
    if (senders.size) {
      console.log('Top bounce senders:');
      [...senders.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
        .forEach(([k, v]) => console.log(`  ${v}\t${k}`));
    }
    if (failedRecipients.size) {
      console.log('Top failed recipients:');
      [...failedRecipients.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)
        .forEach(([k, v]) => console.log(`  ${v}\t${k}`));
    }

    if (!bounceUids.length) {
      console.log('Nothing to delete.');
      return;
    }

    if (!APPLY) {
      console.log('\nDRY-RUN — nothing deleted. Re-run with --apply to remove them.');
      return;
    }

    console.log(`\nDeleting ${bounceUids.length} bounce messages …`);
    // messageDelete moves to Trash if the server has one, else expunges
    await client.messageDelete(bounceUids, { uid: true });
    console.log('Done.');
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
}

main().catch(err => {
  console.error('Error:', err && err.message ? err.message : err);
  process.exit(1);
});
