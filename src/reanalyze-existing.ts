import { analyzeWebsite } from './analyzer/website-checker';
import { getDb } from './db/schema';
import { refreshContactPoints } from './db/leads-repo';
import { scoreLead } from './scorer/scoring';
import { Lead, WebsiteAnalysis } from './types';
import { buildIdentity } from './utils/identity';

export interface ReanalyzeResult {
  total: number;
  analyzed: number;
  withoutWebsite: number;
  errors: number;
  newEmails: number;
  newWhatsApp: number;
  formsFound: number;
  newForms: number;
  socialProfilesFound: number;
  newSocialProfiles: number;
  improvedEvidence: number;
}

export async function reanalyzeExistingLeads(): Promise<ReanalyzeResult> {
  const db = getDb();
  const leads = db.prepare('SELECT * FROM leads ORDER BY created_at ASC').all() as Lead[];
  const before = new Map(leads.map(lead => [lead.id, summarizeLead(lead)]));

  let analyzed = 0;
  let withoutWebsite = 0;
  let errors = 0;

  const update = db.prepare(`
    UPDATE leads SET
      updated_at = @updated_at,
      hat_website = @hat_website,
      website_alt = @website_alt,
      hat_chatbot = @hat_chatbot,
      hat_whatsapp_link = @hat_whatsapp_link,
      hat_online_buchung = @hat_online_buchung,
      hat_faq = @hat_faq,
      hat_notdienst_hinweis = @hat_notdienst_hinweis,
      email = @email,
      whatsapp = @whatsapp,
      kontaktformular_url = @kontaktformular_url,
      kontaktformular_typ = @kontaktformular_typ,
      kontaktformular_confidence = @kontaktformular_confidence,
      instagram_url = @instagram_url,
      facebook_url = @facebook_url,
      tiktok_url = @tiktok_url,
      linkedin_url = @linkedin_url,
      youtube_url = @youtube_url,
      website_meta = @website_meta,
      website_evidence = @website_evidence,
      website_quality_flags = @website_quality_flags,
      analyze_error = @analyze_error,
      score_chatbot = @score_chatbot,
      score_telefon = @score_telefon,
      score_website = @score_website,
      score_gesamt = @score_gesamt,
      prioritaet = @prioritaet,
      score_gruende = @score_gruende,
      telefonstrategie_empfohlen = @telefonstrategie_empfohlen,
      bester_kanal = @bester_kanal,
      kontakt_hinweis = @kontakt_hinweis,
      normalized_name = @normalized_name,
      website_domain = @website_domain,
      phone_normalized = @phone_normalized,
      email_normalized = @email_normalized,
      address_key = @address_key
    WHERE id = @id
  `);

  for (const lead of leads) {
    const analysis = lead.website
      ? await analyzeWebsite(lead.website)
      : emptyAnalysis('Keine Website');

    if (lead.website) analyzed++; else withoutWebsite++;
    if (analysis.error) errors++;

    const next = buildUpdatedLead(lead, analysis);
    update.run(next);
    refreshContactPoints(next);
  }

  const after = (db.prepare('SELECT * FROM leads').all() as Lead[]).map(lead => ({
    lead,
    before: before.get(lead.id),
    after: summarizeLead(lead),
  }));

  return {
    total: leads.length,
    analyzed,
    withoutWebsite,
    errors,
    newEmails: after.filter(row => !row.before?.hasEmail && row.after.hasEmail).length,
    newWhatsApp: after.filter(row => !row.before?.hasWhatsApp && row.after.hasWhatsApp).length,
    formsFound: after.filter(row => row.after.hasForm).length,
    newForms: after.filter(row => !row.before?.hasForm && row.after.hasForm).length,
    socialProfilesFound: after.reduce((sum, row) => sum + row.after.socialCount, 0),
    newSocialProfiles: after.reduce((sum, row) => sum + Math.max(0, row.after.socialCount - (row.before?.socialCount ?? 0)), 0),
    improvedEvidence: after.filter(row => row.after.evidenceCount > (row.before?.evidenceCount ?? 0)).length,
  };
}

function buildUpdatedLead(lead: Lead, analysis: WebsiteAnalysis): Lead {
  const scoreInput = {
    ...lead,
    hat_website: analysis.accessible ? 1 : 0,
    website_alt: analysis.website_alt ? 1 : 0,
    hat_chatbot: analysis.hat_chatbot ? 1 : 0,
    hat_whatsapp_link: analysis.hat_whatsapp_link ? 1 : 0,
    hat_online_buchung: analysis.hat_online_buchung ? 1 : 0,
    hat_faq: analysis.hat_faq ? 1 : 0,
    hat_notdienst_hinweis: analysis.hat_notdienst_hinweis ? 1 : 0,
    email: analysis.email ?? undefined,
    whatsapp: analysis.whatsapp ?? undefined,
    kontaktformular_url: analysis.kontaktformular_url ?? undefined,
    kontaktformular_typ: analysis.kontaktformular_typ ?? null,
    kontaktformular_confidence: analysis.form_confidence ?? null,
    instagram_url: analysis.social_links.instagram ?? undefined,
    facebook_url: analysis.social_links.facebook ?? undefined,
    tiktok_url: analysis.social_links.tiktok ?? undefined,
    linkedin_url: analysis.social_links.linkedin ?? undefined,
    youtube_url: analysis.social_links.youtube ?? undefined,
    website_meta: analysis.meta ? JSON.stringify(analysis.meta) : null,
    website_evidence: analysis.evidence ? JSON.stringify(analysis.evidence) : null,
    website_quality_flags: analysis.quality_flags ? JSON.stringify(analysis.quality_flags) : null,
    analyze_error: analysis.error ?? null,
  } as Partial<Lead> & Lead;

  const score = scoreLead(scoreInput);
  const contact = deriveContactHandling(scoreInput, score.telefon);
  const identity = buildIdentity(scoreInput);

  return {
    ...scoreInput,
    ...identity,
    updated_at: new Date().toISOString(),
    score_chatbot: score.chatbot,
    score_telefon: score.telefon,
    score_website: score.website,
    score_gesamt: score.gesamt,
    prioritaet: score.prioritaet,
    score_gruende: JSON.stringify({
      chatbot: score.gruende_chatbot,
      telefon: score.gruende_telefon,
      website: score.gruende_website,
      gesamt: score.gruende,
    }),
    telefonstrategie_empfohlen: score.telefon >= 70 ? 1 : 0,
    bester_kanal: contact.bester_kanal,
    kontakt_hinweis: contact.kontakt_hinweis,
  } as Lead;
}

function summarizeLead(lead: Lead) {
  return {
    hasEmail: Boolean(lead.email),
    hasWhatsApp: Boolean(lead.whatsapp),
    hasForm: Boolean(lead.kontaktformular_url),
    socialCount: [lead.instagram_url, lead.facebook_url, lead.tiktok_url, lead.linkedin_url, lead.youtube_url].filter(Boolean).length,
    evidenceCount: safeJsonArray(lead.website_evidence).length,
  };
}

function safeJsonArray(value?: string) {
  try {
    const parsed = value ? JSON.parse(value) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function emptyAnalysis(error: string): WebsiteAnalysis {
  return {
    accessible: false,
    hat_chatbot: false,
    hat_whatsapp_link: false,
    hat_online_buchung: false,
    hat_faq: false,
    hat_notdienst_hinweis: false,
    website_alt: false,
    social_links: {},
    quality_flags: [],
    error,
  };
}

function deriveContactHandling(
  lead: Partial<Lead>,
  telefonScore: number
): Pick<Lead, 'bester_kanal' | 'kontakt_hinweis'> {
  if (lead.whatsapp) return { bester_kanal: 'whatsapp', kontakt_hinweis: 'WhatsApp ist oeffentlich auf der Website verlinkt' };
  if (lead.email) return { bester_kanal: 'email', kontakt_hinweis: 'Oeffentliche E-Mail gefunden' };
  if (lead.kontaktformular_url) return { bester_kanal: 'kontaktformular', kontakt_hinweis: 'Keine E-Mail gefunden; Kontaktformular verwenden' };
  if (lead.telefon && telefonScore >= 70) {
    return { bester_kanal: 'telefon', kontakt_hinweis: 'Stark telefonisch abhaengig; manuelle Telefonstrategie moeglich, kein automatischer Anruf' };
  }
  if (lead.telefon) return { bester_kanal: 'telefon', kontakt_hinweis: 'Nur Telefon gefunden; manuell kontaktieren' };
  return { bester_kanal: 'manuell', kontakt_hinweis: 'Kein sicherer digitaler Kontaktweg gefunden; manuelle Recherche erforderlich' };
}
