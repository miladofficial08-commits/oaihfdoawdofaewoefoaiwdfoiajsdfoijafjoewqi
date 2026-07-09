import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { Lead } from '../types';
import fs from 'fs';
import path from 'path';

const OPENAI_MODEL = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
export type AiProvider = 'openai' | 'anthropic';

export interface PersonalizedMessages {
  chatbot?: string;
  telefon?: string;
  website?: string;
}

export function getAiProvider(env: NodeJS.ProcessEnv = process.env): AiProvider {
  if (env.AI_PROVIDER === 'anthropic') return 'anthropic';
  if (env.AI_PROVIDER === 'openai') return 'openai';
  if (env.OPENAI_API_KEY) return 'openai';
  if (env.ANTHROPIC_API_KEY) return 'anthropic';
  return 'openai';
}

function loadTemplate(name: string): string {
  const srcPath = path.join(process.cwd(), 'src', 'templates', `${name}.md`);
  const distPath = path.join(__dirname, '..', 'templates', `${name}.md`);
  return fs.readFileSync(fs.existsSync(srcPath) ? srcPath : distPath, 'utf-8');
}

function loadGlobalRules(): string {
  const srcPath = path.join(process.cwd(), 'src', 'templates', 'global-rules.md');
  const distPath = path.join(__dirname, '..', 'templates', 'global-rules.md');
  if (!fs.existsSync(srcPath) && !fs.existsSync(distPath)) return '';
  return fs.readFileSync(fs.existsSync(srcPath) ? srcPath : distPath, 'utf-8');
}

const SYSTEM_PROMPT = `Du bist Outreach-Spezialist bei Tawano – einer deutschen Agentur die lokalen Betrieben konkrete KI-Lösungen baut: Chatbots, KI-Telefonassistenten, moderne Websites.
Deine Nachrichten bekommen Antworten, weil sie konkret, spezifisch und menschlich sind – nicht weil sie "gut klingen".

NACHRICHTENSTRUKTUR (in dieser Reihenfolge):
1. EINSTIEG: Eine konkrete Beobachtung über genau diesen Betrieb – direkt aus den Lead-Daten.
   NICHT: "Viele Betriebe haben kein..." → RICHTIG: "Ich sehe dass ihr in [STADT] noch keinen Chatbot auf der Website habt."
   Die erste Zeile entscheidet ob jemand weiterliest. Mach sie spezifisch und persönlich.

2. KONSEQUENZ: Was diese Lücke dem Betrieb kostet – Anfragen, Anrufe, Aufträge. Ein Satz, sachlich, kein Druck.
   NICHT: "Das kostet Sie viel Geld!" → RICHTIG: "Gerade abends und am Wochenende gehen Anfragen verloren, die sonst niemand aufnimmt."

3. LÖSUNG: Was Tawano konkret macht – ein Satz. Kein Fachjargon, keine Buzzwords.
   NICHT: "KI-gestützte Automatisierung für maximale Effizienz" → RICHTIG: "Ich baue das für lokale Betriebe – läuft dann selbst."

4. BEWEIS (optional, nur wenn es natürlich passt): Kurze Referenz zu einem ähnlichen Betrieb aus derselben Branche.
   Spezifisch aber kurz: "für ein SHK-Betrieb in Köln aufgebaut, läuft seit 4 Monaten ohne Wartung."
   NIEMALS erfinden – nur einbauen wenn glaubwürdig.

5. CTA: Eine einzige, offene, weiche Frage. Nicht drängen.
   GUT: "Kurzes Gespräch diese Woche?" / "Wäre das interessant?" / "Soll ich kurz zeigen was möglich wäre?"
   SCHLECHT: "Jetzt buchen!" / "Klicken Sie hier"

6. ABSCHLUSS: "Viele Grüße, Max von Tawano"

STRIKTE REGELN:
- Maximal 5-6 Sätze + Grußformel (WhatsApp/Formular: max. 4 Sätze)
- Nur Informationen aus den Lead-Daten – niemals etwas erfinden
- Ich-Sprache, kein "wir" außer bei echten Teamaussagen
- Kein Smalltalk, kein Druck, keine falschen Dringlichkeiten, kein Hype
- NUR EIN Produkt / eine Lösung pro Nachricht
- Natürlicher Fließtext – wie eine Nachricht von einem Kollegen, nicht von einem Sales-Bot
- Gib ausschließlich die fertige Nachricht aus – keine Überschriften, Kommentare oder Erklärungen davor/danach`;

export async function personalizeLead(lead: Lead): Promise<PersonalizedMessages> {
  const provider = getAiProvider();
  const context = buildContext(lead);
  const results: PersonalizedMessages = {};

  const tasks: Array<{ key: keyof PersonalizedMessages; relevant: boolean }> = [
    { key: 'chatbot', relevant: !!(lead.hat_website && !lead.hat_chatbot && (lead.score_chatbot ?? 0) >= 45) },
    { key: 'telefon', relevant: (lead.score_telefon ?? 0) >= 45 },
    { key: 'website', relevant: (lead.score_website ?? 0) >= 45 || !lead.hat_website },
  ];

  await Promise.all(
    tasks.filter(t => t.relevant).map(async t => {
      try {
        const template = `${loadGlobalRules()}\n\n---\n\n${loadTemplate(t.key)}`;
        results[t.key] = provider === 'openai'
          ? await callOpenAI(context, template, t.key)
          : await callHaiku(context, template, t.key);
      } catch (err) {
        console.error(`[AI] Fehler ${t.key} fuer ${lead.name}:`, err instanceof Error ? err.message : err);
      }
    })
  );

  return results;
}

async function callOpenAI(context: string, template: string, type: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY nicht gesetzt in .env');

  const client = new OpenAI({ apiKey });
  const response = await client.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: buildUserPrompt(context, template, type),
      },
    ],
    max_tokens: 400,
    temperature: 0.7,
  });

  const text = response.choices[0]?.message?.content?.trim();
  if (!text) throw new Error('Leere AI-Antwort');
  return text;
}

async function callHaiku(context: string, template: string, type: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY nicht gesetzt in .env');

  const client = new Anthropic({ apiKey });
  const msg = await client.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 400,
    system: SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: buildUserPrompt(context, template, type),
    }],
  });

  const block = msg.content.find(b => b.type === 'text');
  if (!block || block.type !== 'text') throw new Error('Kein Text in AI-Antwort');
  return block.text.trim();
}

function buildUserPrompt(context: string, template: string, type: string): string {
  const channelHint: Record<string, string> = {
    chatbot: 'Diese Nachricht wird per WhatsApp oder E-Mail verschickt.',
    telefon: 'Diese Nachricht wird per WhatsApp oder E-Mail verschickt. Das Produkt ist ein KI-Telefonassistent.',
    website: 'Diese Nachricht wird per E-Mail oder Kontaktformular verschickt. Das Produkt ist eine neue Website oder Landingpage.',
  };
  return `## Lead-Daten
${context}

## Kanal-Hinweis
${channelHint[type] ?? ''}

## Regeln und Vorlagen
${template}

## Aufgabe
Schreibe jetzt eine personalisierte Erstkontakt-Nachricht für diesen Lead.
Verwende NUR Informationen aus den Lead-Daten oben.
Gib ausschließlich die fertige Nachricht aus.`;
}

function buildContext(lead: Lead): string {
  // Parse JSON fields for cleaner output
  const evidence: string[] = (() => {
    try { return lead.website_evidence ? JSON.parse(lead.website_evidence) : []; }
    catch { return []; }
  })();

  const scoreGruende: Record<string, string[]> = (() => {
    try { return lead.score_gruende ? JSON.parse(lead.score_gruende) : {}; }
    catch { return {}; }
  })();

  const qualityFlags: string[] = (() => {
    try { return lead.website_quality_flags ? JSON.parse(lead.website_quality_flags) : []; }
    catch { return []; }
  })();

  const lines: (string | null)[] = [
    `=== FIRMA ===`,
    `Name: ${lead.name}`,
    `Branche: ${lead.branche}`,
    `Stadt: ${lead.stadt}${lead.stadtbezirk ? ' / ' + lead.stadtbezirk : ''}`,
    lead.adresse ? `Adresse: ${lead.adresse}` : null,

    ``,
    `=== KONTAKT ===`,
    lead.website ? `Website: ${lead.website}` : `Website: keine Website vorhanden`,
    lead.telefon ? `Telefon: ${lead.telefon}` : null,
    lead.email ? `E-Mail: ${lead.email}` : null,
    lead.whatsapp ? `WhatsApp: ${lead.whatsapp}` : null,
    lead.kontaktformular_url ? `Kontaktformular: ${lead.kontaktformular_url}` : null,

    ``,
    `=== WEBSITE-ANALYSE ===`,
    `Website vorhanden: ${lead.hat_website ? 'Ja' : 'Nein'}`,
    lead.hat_website ? `Website technisch veraltet: ${lead.website_alt ? 'JA — Alt-Signale erkannt' : 'Nein'}` : null,
    lead.hat_website ? `Chatbot vorhanden: ${lead.hat_chatbot ? 'Ja' : 'NEIN — Verkaufschance'}` : null,
    lead.hat_website ? `Online-Buchung vorhanden: ${lead.hat_online_buchung ? 'Ja' : 'NEIN — Verkaufschance'}` : null,
    lead.hat_website ? `WhatsApp-Link auf Website: ${lead.hat_whatsapp_link ? 'Ja' : 'Nein'}` : null,
    lead.hat_notdienst_hinweis ? `Notdienst-Hinweis auf Website: JA — 24/7-Erreichbarkeit wichtig` : null,
    lead.hat_faq ? `FAQ-Bereich: Ja` : null,
    qualityFlags.length ? `Website-Schwächen: ${qualityFlags.join(', ')}` : null,
    evidence.length ? `Website-Evidence:\n${evidence.slice(0, 8).map(e => `  - ${e}`).join('\n')}` : null,

    ``,
    `=== GOOGLE / BEWERTUNGEN ===`,
    lead.google_bewertung
      ? `Google: ${lead.google_bewertung} Sterne (${lead.google_anzahl_reviews} Bewertungen)`
      : `Google-Bewertung: nicht verfügbar`,
    lead.google_oeffnungszeiten ? `Öffnungszeiten (Google): ${lead.google_oeffnungszeiten}` : null,

    ``,
    `=== SCORES / EMPFEHLUNG ===`,
    `Score Chatbot: ${lead.score_chatbot ?? 0}/100`,
    `Score KI-Telefon: ${lead.score_telefon ?? 0}/100`,
    `Score Website-Relaunch: ${lead.score_website ?? 0}/100`,
    `Empfohlener Kanal: ${lead.bester_kanal ?? 'nicht definiert'}`,
    lead.kontakt_hinweis ? `Kontakt-Hinweis: ${lead.kontakt_hinweis}` : null,
    lead.telefonstrategie_empfohlen ? `Manuelle Telefonstrategie geeignet: Ja (kein automatischer Anruf)` : null,

    scoreGruende.chatbot?.length ? `Chatbot-Signale: ${scoreGruende.chatbot.join('; ')}` : null,
    scoreGruende.telefon?.length ? `Telefon-Signale: ${scoreGruende.telefon.join('; ')}` : null,
    scoreGruende.website?.length ? `Website-Signale: ${scoreGruende.website.join('; ')}` : null,

    lead.manual_call_note ? `\n=== MANUELLER ANRUF NOTIERT ===\nNotiz: ${lead.manual_call_note}` : null,
    lead.notiz ? `\n=== ZUSÄTZLICHE NOTIZ ===\n${lead.notiz}` : null,
  ];

  return lines.filter(Boolean).join('\n');
}
