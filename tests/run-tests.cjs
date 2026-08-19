const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const tests = [
  ['CLI module can be imported', () => {
    const cli = require('../dist/cli');
    assert.equal(typeof cli.main, 'function');
  }],
  ['package exposes leadgen presets script', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    assert.equal(pkg.scripts['leadgen:presets'], 'npm run build && node dist/cli.js presets');
  }],
  ['server module can be imported', () => {
    const server = require('../dist/server');
    assert.equal(typeof server.buildServer, 'function');
  }],
  ['scores phone-dependent trade lead as A priority', () => {
    const { scoreLead } = require('../dist/scorer/scoring');
    const result = scoreLead({
      name: 'Muster SHK',
      branche: 'SHK',
      stadt: 'Berlin',
      telefon: '030 123456',
      hat_website: 1,
      hat_chatbot: 0,
      hat_online_buchung: 0,
      hat_notdienst_hinweis: 1,
    });

    assert.equal(result.prioritaet, 'A');
    assert.ok(result.telefon >= 90);
  }],
  ['penalizes leads without any contact path', () => {
    const { scoreLead } = require('../dist/scorer/scoring');
    const result = scoreLead({
      name: 'Kontaktlos GmbH',
      branche: 'Kosmetikstudio',
      stadt: 'Berlin',
      hat_website: 0,
    });

    assert.equal(result.prioritaet, 'B');
    assert.ok(result.gesamt < 70);
  }],
  ['dashboard only shows approval for draft-ready leads with messages', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'approval', 'views', 'dashboard.html'), 'utf8');
    assert.match(html, /l\.status === 'draft_ready' && hasMsgs/);
    assert.doesNotMatch(html, /\['new','checked','draft_ready'\]\.includes\(l\.status\)/);
  }],
  ['AI personalizer exposes provider selection helpers', () => {
    const ai = require('../dist/ai/personalizer');
    assert.equal(typeof ai.getAiProvider, 'function');
    assert.equal(ai.getAiProvider({ AI_PROVIDER: 'openai' }), 'openai');
    assert.equal(ai.getAiProvider({ ANTHROPIC_API_KEY: 'x' }), 'anthropic');
  }],
  ['NRW vertical presets cover Tawano website offers', () => {
    const { verticalPresets, nrwRegions } = require('../dist/config/markets');
    assert.deepEqual(verticalPresets.map(v => v.id), ['shk', 'krankenbefoerderung', 'elektro', 'kaelte-klima']);
    assert.ok(nrwRegions.some(r => r.cities.includes('Duesseldorf')));
  }],
  ['dashboard has revenue and NRW campaign controls', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'approval', 'views', 'dashboard.html'), 'utf8');
    assert.match(html, /Pipeline/);
    assert.match(html, /NRW-Fokus/);
    assert.match(html, /runCampaign/);
  }],
  ['dashboard exposes evidence, reasons, draft preparation, and safe send marker', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'approval', 'views', 'dashboard.html'), 'utf8');
    assert.match(html, /Warum relevant/);
    assert.match(html, /Website-Evidence/);
    assert.match(html, /Entwurf erstellen/);
    assert.match(html, /Als gesendet markieren/);
    assert.match(html, /Kein Massenversand/);
  }],
  ['database schema contains explainability and manual contact fields', () => {
    const schema = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.ts'), 'utf8');
    assert.match(schema, /score_gruende/);
    assert.match(schema, /website_evidence/);
    assert.match(schema, /telefonstrategie_empfohlen/);
    assert.match(schema, /bester_kanal/);
  }],
  ['database schema contains Stage 1 identity, contact point, and history tables', () => {
    const schema = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.ts'), 'utf8');
    assert.match(schema, /website_domain/);
    assert.match(schema, /phone_normalized/);
    assert.match(schema, /email_normalized/);
    assert.match(schema, /normalized_name/);
    assert.match(schema, /duplicate_of/);
    assert.match(schema, /CREATE TABLE IF NOT EXISTS contact_points/);
    assert.match(schema, /CREATE TABLE IF NOT EXISTS outreach_events/);
  }],
  ['database path can target Railway persistent volume', () => {
    const { resolveDbPath } = require('../dist/db/schema');
    assert.equal(resolveDbPath({ SQLITE_DB_PATH: '/data/prod.db' }), path.resolve('/data/prod.db'));
    assert.equal(resolveDbPath({ RAILWAY_VOLUME_MOUNT_PATH: '/app/data', DATA_DIR: '/data' }), path.resolve('/app/data/leads.db'));
    assert.equal(resolveDbPath({ DATA_DIR: '/data' }), path.resolve('/data/leads.db'));
  }],
  ['identity helpers normalize duplicate keys without inventing data', () => {
    const identity = require('../dist/utils/identity');
    assert.equal(identity.extractDomain('https://www.example.de/kontakt'), 'example.de');
    assert.equal(identity.normalizeEmail(' INFO@Example.de '), 'info@example.de');
    assert.equal(identity.normalizePhone('+49 (211) 123-456'), '49211123456');
    assert.equal(identity.normalizeName('Muster GmbH & Co. KG'), 'muster');
    assert.equal(identity.extractDomain(undefined), undefined);
  }],
  ['duplicate detector finds an existing real lead by normalized identity keys', () => {
    const repo = require('../dist/db/leads-repo');
    const { getDb } = require('../dist/db/schema');
    const db = getDb();
    const lead = db.prepare(
      "SELECT * FROM leads WHERE website_domain IS NOT NULL OR phone_normalized IS NOT NULL OR email_normalized IS NOT NULL LIMIT 1"
    ).get();
    if (!lead) return;
    const candidate = repo.findDuplicateCandidate(lead);
    assert.ok(candidate);
    assert.equal(candidate.lead.id, lead.id);
    assert.match(candidate.reason, /Gleiche|Gleicher/);
  }],
  ['dashboard exposes Stage 1 sales pipeline areas and manual phone note flow', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'approval', 'views', 'dashboard.html'), 'utf8');
    for (const label of [
      'Neue Leads',
      'Gepruefte Leads',
      'Entwurf bereit',
      'Freigegeben',
      'Kontaktiert',
      'Antwort erhalten',
      'Demo gebucht',
      'Nicht geeignet',
      'Duplikate',
      'Fehlende Daten',
      'Manuell pruefen',
      'Do-not-contact',
    ]) {
      assert.match(html, new RegExp(label));
    }
    assert.match(html, /manualCall/);
    assert.match(html, /Manuellen Anruf notieren/);
    assert.match(html, /Kein automatischer Anruf/);
    assert.doesNotMatch(html, /\/api\/call/);
  }],
  ['website analyzer rejects asset-like fake emails and contact-form plugin assets', () => {
    const analyzer = require('../dist/analyzer/website-checker');
    assert.equal(analyzer.isLikelyBusinessEmail('info@firma.de'), true);
    assert.equal(analyzer.isLikelyBusinessEmail('BCArtboard-4-copy@2x-150x150.png'), false);
    assert.equal(analyzer.isLikelyContactHref('/kontakt'), true);
    assert.equal(analyzer.isLikelyContactHref('/wp-content/plugins/contact-form-7/includes/css/styles.css?ver=6.1.5'), false);
  }],
  ['website analyzer detects real forms and social links without inventing channels', () => {
    const analyzer = require('../dist/analyzer/website-checker');
    const result = analyzer.analyzeHtml(`
      <html><head><meta name="viewport" content="width=device-width"><title>Test</title></head>
      <body>
        <a href="mailto:info@betrieb.de">Mail</a>
        <a href="https://wa.me/49170123456">WhatsApp</a>
        <a href="https://www.instagram.com/betrieb/">Instagram</a>
        <a href="https://www.facebook.com/betrieb">Facebook</a>
        <a href="https://www.facebook.com/tr">Tracking</a>
        <form action="/kontakt"><input name="email"><input name="tel"><textarea name="message"></textarea><button type="submit">Anfrage senden</button></form>
      </body></html>
    `, 'https://betrieb.de/');

    assert.equal(result.email, 'info@betrieb.de');
    assert.equal(result.whatsapp, 'https://wa.me/49170123456');
    assert.equal(result.kontaktformular_url, 'https://betrieb.de/kontakt');
    assert.equal(result.social_links.instagram, 'https://www.instagram.com/betrieb/');
    assert.equal(result.social_links.facebook, 'https://www.facebook.com/betrieb');
    assert.ok(result.form_confidence >= 80);
    assert.ok(result.evidence.some(e => e.includes('HTML-Formular')));
    assert.equal(result.social_links.tiktok, undefined);
  }],
  ['website analyzer rejects generic social tracking and share URLs', () => {
    const analyzer = require('../dist/analyzer/website-checker');
    const result = analyzer.analyzeHtml(`
      <a href="https://www.facebook.com/tr"></a>
      <a href="https://www.facebook.com/sharer/sharer.php?u=x"></a>
      <a href="https://www.instagram.com/p/abc123/"></a>
      <a href="https://www.linkedin.com/shareArticle?mini=true"></a>
    `, 'https://betrieb.de/');

    assert.deepEqual(result.social_links, {});
  }],
  ['dashboard exposes manual channel selection after approval and copy workflow', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'approval', 'views', 'dashboard.html'), 'utf8');
    assert.match(html, /Kontaktkanäle/);
    assert.match(html, /buildManualOutreach/);
    assert.match(html, /copyText/);
    assert.match(html, /Als manuell per E-Mail kontaktiert markieren/);
    assert.match(html, /Als manuell per WhatsApp kontaktiert markieren/);
    assert.match(html, /Als manuell per Formular kontaktiert markieren/);
    assert.match(html, /Als manuell per Social Media kontaktiert markieren/);
    assert.match(html, /Als telefonisch manuell kontaktiert markieren/);
  }],
  ['archive keeps lead data but hides it from active lead queries', () => {
    const repo = require('../dist/db/leads-repo');
    const { getDb } = require('../dist/db/schema');
    const db = getDb();
    const id = 'test-archive-lead';
    db.prepare('DELETE FROM leads WHERE id = ?').run(id);
    db.prepare("INSERT INTO leads (id, name, branche, stadt, status, prioritaet, score_gesamt, hat_website) VALUES (?, 'Archiv Test', 'SHK', 'Teststadt', 'checked', 'B', 42, 1)").run(id);

    repo.archiveLead(id, 'test-user');

    const archived = db.prepare('SELECT status FROM leads WHERE id = ?').get(id);
    assert.equal(archived.status, 'archived');
    assert.equal(repo.getAllLeads({}).some(l => l.id === id), false);
    assert.equal(repo.getAllLeads({ includeArchived: '1' }).some(l => l.id === id), true);
    assert.ok(repo.getOutreachEvents(id).some(e => e.event_type === 'archived'));
    db.prepare('DELETE FROM leads WHERE id = ?').run(id);
  }],
  ['delete lead requires extra confirmation for contacted leads and cascades related rows', () => {
    const repo = require('../dist/db/leads-repo');
    const { getDb } = require('../dist/db/schema');
    const db = getDb();
    const id = 'test-delete-lead';
    db.prepare('DELETE FROM leads WHERE id = ?').run(id);
    db.prepare("INSERT INTO leads (id, name, branche, stadt, status, prioritaet, score_gesamt, hat_website) VALUES (?, 'Delete Test', 'SHK', 'Teststadt', 'contacted', 'A', 88, 1)").run(id);
    db.prepare("INSERT INTO contact_points (id, lead_id, type, value, confidence) VALUES ('test-delete-cp', ?, 'email', 'delete-test@example.com', 90)").run(id);
    db.prepare("INSERT INTO outreach_events (id, lead_id, event_type, status, note) VALUES ('test-delete-ev', ?, 'manual_contact', 'contacted', 'test')").run(id);

    assert.throws(() => repo.deleteLeadPermanently(id), /kontaktierte Leads/);
    repo.deleteLeadPermanently(id, { confirmContacted: true });

    assert.equal(db.prepare('SELECT COUNT(*) n FROM leads WHERE id = ?').get(id).n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM contact_points WHERE lead_id = ?').get(id).n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM outreach_events WHERE lead_id = ?').get(id).n, 0);
  }],
  ['delete lead still requires extra confirmation after contacted lead was archived', () => {
    const repo = require('../dist/db/leads-repo');
    const { getDb } = require('../dist/db/schema');
    const db = getDb();
    const id = 'test-delete-archived-contacted-lead';
    db.prepare('DELETE FROM leads WHERE id = ?').run(id);
    db.prepare("INSERT INTO leads (id, name, branche, stadt, status, prioritaet, score_gesamt, hat_website, gesendet_at) VALUES (?, 'Archived Contacted Test', 'SHK', 'Teststadt', 'archived', 'A', 88, 1, datetime('now'))").run(id);
    db.prepare("INSERT INTO outreach_events (id, lead_id, event_type, status, note) VALUES ('test-delete-archived-ev', ?, 'manual_contact', 'contacted', 'test')").run(id);

    assert.throws(() => repo.deleteLeadPermanently(id), /kontaktierte Leads/);
    repo.deleteLeadPermanently(id, { confirmContacted: true });
    assert.equal(db.prepare('SELECT COUNT(*) n FROM leads WHERE id = ?').get(id).n, 0);
  }],
  ['dashboard exposes archive, guarded delete, archived filter, and export controls', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'approval', 'views', 'dashboard.html'), 'utf8');
    assert.match(html, /Archiviert anzeigen/);
    assert.match(html, /archiveLead/);
    assert.match(html, /deleteLead/);
    assert.match(html, /Diesen Lead wirklich endgueltig loeschen/);
    assert.match(html, /exportLeads/);
  }],
  ['smtp email helpers require approval and do not accept unsafe leads', () => {
    const smtp = require('../dist/email/smtp');
    assert.deepEqual(smtp.getEmailStatus({}), { configured: false, host: undefined, port: undefined, from: undefined });
    assert.equal(smtp.getEmailStatus({
      SMTP_HOST: 'smtp.example.com',
      SMTP_USER: 'user',
      SMTP_PASS: 'pass',
      SMTP_FROM: 'Tawano <info@example.com>',
    }).configured, true);
    assert.throws(() => smtp.assertLeadCanBeEmailed({ status: 'checked', email: 'x@y.de', approved_nachricht: 'Hi', approved_kanal: 'email' }), /freigegeben/);
    assert.throws(() => smtp.assertLeadCanBeEmailed({ status: 'approved', approved_nachricht: 'Hi', approved_kanal: 'email' }), /E-Mail-Adresse/);
    assert.doesNotThrow(() => smtp.assertLeadCanBeEmailed({ status: 'approved', email: 'x@y.de', approved_nachricht: 'Hi', approved_kanal: 'email' }));
  }],
  ['smtp config can fall back to working imap mailbox settings', () => {
    const { getSmtpConfig } = require('../dist/email/smtp');
    const cfg = getSmtpConfig({
      IMAP_HOST: 'imap.udag.de',
      IMAP_USER: 'info@tawano.de',
      IMAP_PASS: 'secret',
    });
    assert.equal(cfg.host, 'smtps.udag.de');
    assert.equal(cfg.user, 'info@tawano.de');
    assert.equal(cfg.pass, 'secret');
    assert.equal(cfg.from, 'info@tawano.de');
  }],
  ['email open tracking separates real opens from technical pixel requests', () => {
    const tracking = require('../dist/email/tracking');
    assert.equal(tracking.classifyOpenEvent({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0) GoogleImageProxy',
      secondsSinceSent: 180,
    }), 'open_machine');
    assert.equal(tracking.classifyOpenEvent({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126 Safari/537.36',
      secondsSinceSent: 5,
    }), 'open_unverified');
    assert.equal(tracking.classifyOpenEvent({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126 Safari/537.36',
      secondsSinceSent: 90,
    }), 'open');
    assert.equal(tracking.isReliableOpen({
      event_type: 'open',
      user_agent: 'Mozilla/5.0 GoogleImageProxy',
      secondsSinceSent: 90,
    }), false);
  }],
  ['email click tracking excludes scanner/bot clicks and deduplicates repeats', () => {
    const tracking = require('../dist/email/tracking');
    const chrome = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126 Safari/537.36';
    // Echter Browser-Klick vs. Mailscanner
    assert.equal(tracking.classifyClickEvent(chrome), 'click');
    assert.equal(tracking.classifyClickEvent('Mimecast'), 'click_machine');
    assert.equal(tracking.classifyClickEvent(''), 'click_machine');
    // Alt-Daten: als 'click' gespeicherter Bot gilt NICHT als echter Klick
    assert.equal(tracking.isRealClick({ event_type: 'click', user_agent: 'Proofpoint' }), false);
    assert.equal(tracking.isRealClick({ event_type: 'click', user_agent: chrome }), true);
    assert.equal(tracking.isRealClick({ event_type: 'click_machine', user_agent: chrome }), false);
    // 3 schnelle Wiederholungen desselben Nutzers auf denselben Link = 1 Klick
    const base = Date.parse('2026-07-10T10:00:00Z');
    const iso = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
    const evs = [0, 2000, 5000].map(off => ({ url: 'https://tawano.de/x', signature: chrome + '|1.1.1.1', created_at: iso(base + off) }));
    assert.equal(tracking.countDistinctClicks(evs), 1);
  }],
  ['brevo api helpers expose key status and build tracked payload', () => {
    const mailer = require('../dist/email/mailer');
    assert.deepEqual(mailer.getBrevoStatus({}), { ok: false, configured: false, error: 'BREVO_API_KEY fehlt' });
    assert.equal(mailer.getBrevoStatus({ BREVO_API_KEY: 'x' }).ok, true);

    const payload = mailer.buildBrevoEmailPayload({
      to: 'lead@example.com',
      toName: 'Lead Name',
      subject: 'Hallo',
      body: 'Text https://example.com',
      trackingId: 'track-1',
    }, { BREVO_API_KEY: 'x', PUBLIC_BASE_URL: 'https://app.example.com', SMTP_FROM: 'Tawano <info@example.com>' });

    assert.deepEqual(payload.sender, { name: 'Tawano', email: 'info@tawano.de' });
    assert.deepEqual(payload.to, [{ email: 'lead@example.com', name: 'Lead Name' }]);
    assert.equal(payload.subject, 'Hallo');
    assert.equal(payload.textContent, 'Text https://example.com');
    assert.match(payload.htmlContent, /\/track\/click\/track-1/);
    assert.match(payload.htmlContent, /\/track\/open\/track-1\.gif/);
  }],
  ['email html renders markdown links with tracking and safe link text', () => {
    const mailer = require('../dist/email/mailer');
    const payload = mailer.buildBrevoEmailPayload({
      to: 'lead@example.com',
      subject: 'Hallo',
      body: 'Termin: [Hier 15 Minuten einplanen](https://tawano.de/voice-agents/demo-buchen)\nHTML: <a href="https://tawano.de/voice-agents/demo-buchen">Demo buchen</a>\nKontakt: [info@tawano.de](mailto:info@tawano.de)',
      trackingId: 'track-md',
    }, { BREVO_API_KEY: 'x', PUBLIC_BASE_URL: 'https://app.example.com', SMTP_FROM: 'Tawano <info@example.com>' });

    assert.match(payload.htmlContent, />Hier 15 Minuten einplanen<\/a>/);
    assert.match(payload.htmlContent, />Demo buchen<\/a>/);
    assert.match(payload.htmlContent, /\/track\/click\/track-md\?u=https%3A%2F%2Ftawano\.de%2Fvoice-agents%2Fdemo-buchen/);
    assert.match(payload.htmlContent, /href="mailto:info@tawano\.de"/);
    assert.doesNotMatch(payload.htmlContent, /\[Hier 15 Minuten einplanen\]/);
    assert.doesNotMatch(payload.htmlContent, /&lt;a href=/);
  }],
  ['tracking laeuft nur ueber die eigene Absender-Domain', () => {
    const mailer = require('../dist/email/mailer');
    const eingabe = {
      to: 'lead@example.com',
      subject: 'Hallo',
      body: 'Mehr dazu: https://tawano.de/demo',
      trackingId: 'track-x',
    };

    // Fremde Adresse (so lag es in Produktion: eine zufaellige Railway-Subdomain).
    // Ein Link darauf sieht fuer den Empfaenger aus wie Phishing – also nicht umleiten.
    const fremd = mailer.buildBrevoEmailPayload(eingabe, {
      BREVO_API_KEY: 'x',
      PUBLIC_BASE_URL: 'https://oaihfdoawdofa-production.up.railway.app',
      SMTP_FROM: 'Tawano <info@tawano.de>',
    });
    assert.doesNotMatch(fremd.htmlContent, /railway\.app/);
    assert.doesNotMatch(fremd.htmlContent, /\/track\/click\//);
    assert.doesNotMatch(fremd.htmlContent, /\/track\/open\//);
    assert.match(fremd.htmlContent, /href="https:\/\/tawano\.de\/demo"/);

    // Eigene Domain: Umleitung und Zaehlpixel sind erlaubt.
    const eigen = mailer.buildBrevoEmailPayload(eingabe, {
      BREVO_API_KEY: 'x',
      PUBLIC_BASE_URL: 'https://mail.tawano.de',
      SMTP_FROM: 'Tawano <info@tawano.de>',
    });
    assert.match(eigen.htmlContent, /mail\.tawano\.de\/track\/click\/track-x/);
  }],
  ['personalisierter Satz nur aus echten Daten, nie erfunden', () => {
    const { personalLine, applyPersonalLine } = require('../dist/email/personal-line');

    // Ohne belastbare Angaben darf KEIN Satz entstehen.
    assert.equal(personalLine({ id: '1', name: 'Ohne Daten' }), null);

    // Notdienst nur, wo er zur Branche passt – nicht beim Nagelstudio.
    const nagel = personalLine({ id: '2', name: 'Nagelstudio', branche: 'Nagelstudio', hat_notdienst_hinweis: 1 });
    assert.ok(!nagel || !/Notdienst/.test(nagel), 'Nagelstudio darf keinen Notdienst-Satz bekommen');
    const shk = personalLine({ id: '3', name: 'SHK Betrieb', branche: 'SHK Sanitär Heizung', hat_notdienst_hinweis: 1 });
    assert.match(String(shk), /Notdienst/);

    // Punycode-Domains gehoeren nicht in eine Mail.
    const puny = personalLine({ id: '4', name: 'Umlaut', branche: 'Elektriker', website: 'https://xn--sp-energie-3bc.de' });
    assert.ok(!puny || !puny.includes('xn--'), 'Punycode darf nicht im Text landen');

    // Einsetzen: Satz hinter die Anrede, Folgeabsatz wird gross geschrieben.
    const raus = applyPersonalLine('Guten Tag,\n\nich habe versucht Sie zu erreichen.', 'laut Google ist um 16:00 Uhr Schluss.');
    assert.match(raus, /Guten Tag,\n\nLaut Google ist um 16:00 Uhr Schluss\.\n\nIch habe versucht/);

    // Ohne Satz bleibt der Text unveraendert.
    assert.equal(applyPersonalLine('Guten Tag,\n\nText.', null), 'Guten Tag,\n\nText.');
  }],
  ['A/B-Test teilt stabil und laesst Gruppe B unveraendert', () => {
    const { abGruppe } = require('../dist/email/ab-test');
    const { renderTemplate } = require('../dist/email/template');

    // Dieselbe Firma muss IMMER in derselben Gruppe landen, sonst bekommt sie
    // Erstmail mit Satz und Follow-up ohne – dann misst der Test nichts mehr.
    const id = 'lead-abc-123';
    assert.equal(abGruppe(id), abGruppe(id));
    assert.equal(abGruppe(id), abGruppe(id));

    // Beide Gruppen kommen vor.
    const gruppen = new Set();
    for (let i = 0; i < 200; i++) gruppen.add(abGruppe('lead-' + i));
    assert.deepEqual([...gruppen].sort(), ['A', 'B']);

    // Kontrollgruppe: Vorlage geht Wort fuer Wort raus.
    const tpl = { id: 't', name: 't', subject: 'Betreff', body: 'Guten Tag,|ich melde mich kurz.'.split('|').join(String.fromCharCode(10, 10)), updated_at: '' };
    const bLead = ['lead-0','lead-1','lead-2','lead-3'].map(x => ({ id: x, name: 'X', branche: 'SHK', hat_notdienst_hinweis: 1 })).find(l => abGruppe(l.id) === 'B');
    assert.ok(bLead, 'kein B-Lead in der Stichprobe');
    const raus = renderTemplate(tpl, { name: 'X', lead: bLead }).body;
    assert.equal(raus, tpl.body, 'Gruppe B darf NICHT veraendert werden');
  }],
  ['dashboard template preview renders markdown links instead of literal syntax', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'approval', 'views', 'dashboard.html'), 'utf8');
    assert.match(html, /function renderPreviewBodyHtml/);
    assert.match(html, /pb\.innerHTML = renderPreviewBodyHtml\(r\.body\)/);
    assert.doesNotMatch(html, /tpl-prev-body'\); if \(pb\) pb\.textContent = r\.body/);
  }],
  ['routes expose brevo test endpoint without removing smtp test', () => {
    const routes = fs.readFileSync(path.join(__dirname, '..', 'src', 'approval', 'routes.ts'), 'utf8');
    assert.match(routes, /\/api\/brevo-test/);
    assert.match(routes, /\/api\/smtp-test/);
  }],
  ['dashboard exposes explicit one-by-one smtp send button after approval', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'approval', 'views', 'dashboard.html'), 'utf8');
    assert.match(html, /E-Mail jetzt senden/);
    assert.match(html, /sendEmail/);
    assert.match(html, /Diese eine freigegebene E-Mail wirklich ueber SMTP senden/);
  }],
  ['workflow blocks contacts that explicitly opted out', () => {
    const { detectOptOut } = require(path.join(__dirname, '..', 'dist', 'workflow', 'optout'));
    assert.strictEqual(detectOptOut('', 'Ich widerspreche der weiteren Kontaktaufnahme.').hard, true);
    assert.strictEqual(detectOptOut('', 'Bitte um Loeschung meiner Daten').hard, true);
    assert.strictEqual(detectOptOut('', 'Kein Interesse, danke').hard, false);
    assert.strictEqual(detectOptOut('Re: Angebot', 'Klingt gut, wann haetten Sie Zeit?'), null);
  }],
  ['workflow reads the return date from an out-of-office reply', () => {
    const { parseReturnDate } = require(path.join(__dirname, '..', 'dist', 'workflow', 'reactions'));
    const now = new Date('2026-08-18T10:00:00Z');
    const d = parseReturnDate('Bin im Urlaub, ab 25.09. wieder da.', now);
    assert.ok(d, 'Datum sollte erkannt werden');
    assert.strictEqual(d.getMonth(), 8);
    assert.strictEqual(d.getDate(), 25);
    assert.strictEqual(parseReturnDate('Vielen Dank fuer Ihre Nachricht', now), null);
  }],
  ['workflow graph sanitizer drops broken nodes and dangling edges', () => {
    const { sanitizeGraph, defaultGraph } = require(path.join(__dirname, '..', 'dist', 'workflow', 'schema'));
    const clean = sanitizeGraph({
      nodes: [{ id: 'a', type: 'email', title: 'A', x: 0, y: 0, config: {} }, { id: 'b', type: 'kaputt', title: 'B', x: 0, y: 0 }],
      edges: [{ from: 'a', port: 'out', to: 'b' }, { from: 'a', port: 'out', to: 'a' }],
    });
    assert.strictEqual(clean.nodes.length, 1);
    assert.strictEqual(clean.edges.length, 1, 'Kante auf einen entfernten Knoten muss verschwinden');
    const base = sanitizeGraph(defaultGraph());
    assert.ok(base.nodes.some(n => n.type === 'check'), 'Standard-Strategie braucht die Reaktions-Weiche');
    assert.ok(base.nodes.some(n => n.type === 'suppress'), 'Standard-Strategie braucht den Sperr-Knoten');
  }],
  ['dashboard script parses – kein Syntaxfehler im Frontend', () => {
    // Ein einziger kaputter String legt das GESAMTE Dashboard lahm: keine Daten,
    // kein Knopf funktioniert. Genau das ist am 19.08. passiert, weil ein
    // Bestaetigungstext einen echten Zeilenumbruch enthielt. Dieser Test prueft
    // deshalb bei jedem Lauf, ob das Inline-Skript ueberhaupt parsebar ist.
    const vm = require('vm');
    const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'approval', 'views', 'dashboard.html'), 'utf8');
    const start = html.lastIndexOf('<script>');
    const end = html.lastIndexOf('</script>');
    assert.ok(start > 0 && end > start, 'Skriptblock im Dashboard nicht gefunden');
    const code = html.slice(start + '<script>'.length, end);
    assert.ok(code.length > 1000, 'Skriptblock verdaechtig klein');
    try {
      new vm.Script(code, { filename: 'dashboard-inline.js' });
    } catch (err) {
      assert.fail('Syntaxfehler im Dashboard-Skript: ' + err.message);
    }
  }],
];

let failures = 0;

for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures++;
    console.error(`not ok - ${name}`);
    console.error(error);
  }
}

if (failures > 0) {
  process.exitCode = 1;
}
