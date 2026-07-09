import { scrapeGoogleMaps } from './scraper/google-maps';
import { analyzeWebsite } from './analyzer/website-checker';
import { scoreLead } from './scorer/scoring';
import { personalizeLead } from './ai/personalizer';
import { upsertLead, updateLeadStatus, finishScrapeRun, createScrapeRun } from './db/leads-repo';
import { ScrapeInput, Lead, WebsiteAnalysis } from './types';

export interface PipelineOptions {
  skipAi?: boolean;
  maxResults?: number;
  concurrency?: number;
}

export interface PipelineResult {
  total: number;
  inserted: number;
  updated: number;
  aiProcessed: number;
  errors: number;
  duration: number;
}

export async function runPipeline(input: ScrapeInput, opts: PipelineOptions = {}): Promise<PipelineResult> {
  const { skipAi = false, maxResults = 50, concurrency = 5 } = opts;
  const start = Date.now();
  const runId = createScrapeRun(input.stadt, input.branche, input.stadtbezirk);

  console.log(`\n[Pipeline] ${input.branche} in ${input.stadt}${input.stadtbezirk ? ' / ' + input.stadtbezirk : ''}`);
  console.log(`           max. ${maxResults} Ergebnisse | KI: ${skipAi ? 'nein' : 'ja'}`);

  let inserted = 0, updated = 0, aiProcessed = 0, errors = 0;
  const currentRunLeads: Lead[] = [];

  // ── Stufe 1: Scraping ────────────────────────────────────────────────────
  console.log('\n[1/3] Google Maps Scraping...');
  let rawLeads;
  try {
    rawLeads = await scrapeGoogleMaps({ ...input, maxResults });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    finishScrapeRun(runId, 0, 0, msg);
    throw err;
  }

  // ── Stufe 2: Website-Analyse + Scoring ───────────────────────────────────
  console.log(`\n[2/3] Website-Analyse + Scoring (${rawLeads.length} Einträge)...`);

  for (const batch of chunk(rawLeads, concurrency)) {
    await Promise.all(batch.map(async (raw) => {
      try {
        const analysis: WebsiteAnalysis = raw.website
          ? await analyzeWebsite(raw.website)
          : { accessible: false, hat_chatbot: false, hat_whatsapp_link: false, hat_online_buchung: false, hat_faq: false, hat_notdienst_hinweis: false, website_alt: false, social_links: {}, quality_flags: [], error: 'Keine Website' };

        const leadData = {
          ...raw,
          hat_website: analysis.accessible ? 1 : 0,
          website_alt: analysis.website_alt ? 1 : 0,
          hat_chatbot: analysis.hat_chatbot ? 1 : 0,
          hat_whatsapp_link: analysis.hat_whatsapp_link ? 1 : 0,
          hat_online_buchung: analysis.hat_online_buchung ? 1 : 0,
          hat_faq: analysis.hat_faq ? 1 : 0,
          hat_notdienst_hinweis: analysis.hat_notdienst_hinweis ? 1 : 0,
          email: analysis.email,
          whatsapp: raw.website ? (analysis.whatsapp ?? undefined) : undefined,
          kontaktformular_url: analysis.kontaktformular_url,
          kontaktformular_typ: analysis.kontaktformular_typ,
          kontaktformular_confidence: analysis.form_confidence,
          instagram_url: analysis.social_links.instagram,
          facebook_url: analysis.social_links.facebook,
          tiktok_url: analysis.social_links.tiktok,
          linkedin_url: analysis.social_links.linkedin,
          youtube_url: analysis.social_links.youtube,
          website_meta: analysis.meta ? JSON.stringify(analysis.meta) : undefined,
          website_evidence: analysis.evidence ? JSON.stringify(analysis.evidence) : undefined,
          website_quality_flags: analysis.quality_flags ? JSON.stringify(analysis.quality_flags) : undefined,
          analyze_error: analysis.error,
        };

        const score = scoreLead(leadData);
        const contact = deriveContactHandling(leadData, score.telefon);
        const nextStatus = deriveNextStatus(leadData, score.gesamt);
        const { inserted: wasNew, lead } = upsertLead({
          ...leadData,
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
          status: nextStatus,
        } as Parameters<typeof upsertLead>[0]);

        if (wasNew) inserted++; else updated++;
        if (lead.status !== 'duplicate' && ['checked', 'manual_review'].includes(lead.status)) {
          currentRunLeads.push(lead);
        }
        process.stdout.write(score.prioritaet === 'A' ? 'A' : score.prioritaet === 'B' ? 'b' : '.');
      } catch (err) {
        errors++;
        process.stdout.write('!');
      }
    }));
  }

  console.log(`\n     ${inserted} neu | ${updated} aktualisiert | ${errors} Fehler`);

  // ── Stufe 3: AI-Personalisierung (nur A+B) ───────────────────────────────
  if (!skipAi) {
    const goodLeads = currentRunLeads.filter(l => ['A', 'B'].includes(l.prioritaet) && !l.ai_analysiert);

    if (goodLeads.length > 0) {
      console.log(`\n[3/3] AI-Nachrichten für ${goodLeads.length} A/B Leads...`);

      for (const lead of goodLeads) {
        try {
          const msgs = await personalizeLead(lead);
          updateLeadStatus(lead.id, 'draft_ready', {
            nachricht_chatbot: msgs.chatbot,
            nachricht_telefon: msgs.telefon,
            nachricht_website: msgs.website,
            ai_analysiert: 1,
          } as Partial<Lead>);
          aiProcessed++;
          process.stdout.write('✓');
        } catch {
          errors++;
          process.stdout.write('✗');
        }
      }
      console.log('');
    } else {
      console.log('\n[3/3] Keine neuen A/B Leads für AI-Analyse');
    }
  } else {
    console.log('\n[3/3] AI übersprungen (--no-ai)');
  }

  finishScrapeRun(runId, rawLeads.length, inserted);
  return { total: rawLeads.length, inserted, updated, aiProcessed, errors, duration: Date.now() - start };
}

function deriveNextStatus(lead: Partial<Lead>, score: number): Lead['status'] {
  if (!lead.email && !lead.whatsapp && !lead.kontaktformular_url && !lead.telefon) return 'missing_data';
  if (score < 35) return 'not_suitable';
  if (!lead.email && !lead.whatsapp && !lead.kontaktformular_url && lead.telefon) return 'manual_review';
  return 'checked';
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
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
