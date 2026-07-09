import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { getAiProvider } from './personalizer';

export interface AdCopy {
  hook: string;
  body: string;
  cta: string;
}

export interface GoogleAdCopy {
  headline1: string;
  headline2: string;
  description: string;
}

export interface AdVariant {
  angle: 'problem' | 'curiosity' | 'result';
  angleLabel: string;
  angleDesc: string;
  instagram_facebook?: AdCopy;
  google?: GoogleAdCopy;
  linkedin?: AdCopy;
}

export interface IdeaCampaign {
  id: string;
  name: string;
  idea: string;
  landing_page?: string;
  platforms: string[];
  duration_days: number;
  status: 'active' | 'paused' | 'won' | 'stopped';
  variants?: AdVariant[];
  created_at: string;
  ends_at: string;
  results?: CampaignResult[];
}

export interface CampaignResult {
  id: string;
  campaign_id: string;
  variant_index: number;
  platform: string;
  impressions: number;
  clicks: number;
  signups: number;
  spend_eur: number;
  note?: string;
  logged_at: string;
}

const SYSTEM_PROMPT = `Du bist ein erfahrener Performance-Marketing-Experte der Startup-Ideen validiert.
Du schreibst Ad-Copy die echte Menschen anspricht, nicht generisch klingt und tatsächlich klicks bringt.

DEINE AUFGABE:
Erstelle 3 Werbe-Varianten für eine Produkt-Idee, die noch NICHT gebaut ist.
Ziel: Testen ob die Idee Markt-Relevanz hat, bevor man sie baut.
Das Produkt existiert noch nicht — die Ads leiten auf eine Warteliste / Coming-Soon-Page.

DIE 3 WINKEL:
1. SCHMERZ (Problem-first): Starte mit dem konkreten Schmerzpunkt. Wer den Schmerz kennt, liest weiter.
2. NEUGIER (Curiosity-gap): Etwas was die Zielgruppe noch nicht weiß — aber wissen will. Erzeugt Drang zu klicken.
3. ERGEBNIS (Transformation): Zeige das Leben NACH dem Produkt. Der After-State, nicht das Produkt.

QUALITÄTSREGELN für jede Ad:
- Hook: Erste Zeile entscheidet alles — muss in 2 Sekunden Aufmerksamkeit erzwingen
- Kein Fachjargon, keine leeren Buzzwords ("innovativ", "revolutionär", "einzigartig")
- Konkret statt abstrakt: "3 Stunden pro Woche" statt "viel Zeit"
- CTA: Weich und neugierig — "Kostenlos testen" / "Auf die Warteliste" / "Mehr erfahren" — nie "Jetzt kaufen" für unbekannte Produkte
- Instagram/Facebook: kurz, scrollstopping, als würde es von einem Freund kommen
- Google Search: jedes Wort zählt, max Zeichen einhalten
- LinkedIn: professioneller Ton, aber nicht steif

WICHTIG — Gib die Antwort EXAKT als JSON zurück, kein Markdown-Wrapper darum:
[
  {
    "angle": "problem",
    "angleLabel": "Schmerz-Ansatz",
    "angleDesc": "Startet mit dem Hauptproblem der Zielgruppe",
    "instagram_facebook": { "hook": "...", "body": "...", "cta": "..." },
    "google": { "headline1": "...(max 30 Zeichen)", "headline2": "...(max 30 Zeichen)", "description": "...(max 90 Zeichen)" },
    "linkedin": { "hook": "...", "body": "...", "cta": "..." }
  },
  { "angle": "curiosity", "angleLabel": "Neugier-Ansatz", "angleDesc": "...", ... },
  { "angle": "result", "angleLabel": "Ergebnis-Ansatz", "angleDesc": "...", ... }
]`;

export async function generateAdVariants(params: {
  idea: string;
  landingPage?: string;
  platforms: string[];
}): Promise<AdVariant[]> {
  const provider = getAiProvider();
  const platformList = params.platforms.join(', ');

  const userPrompt = `## Produkt-Idee
${params.idea}

## Landing Page
${params.landingPage || 'Noch keine Landing Page — Wartelisten-Seite geplant'}

## Gewünschte Plattformen
${platformList}

## Aufgabe
Erstelle 3 Ad-Varianten (Schmerz, Neugier, Ergebnis) mit konkretem, scrollstoppendem Text.
Für jede gewünschte Plattform eigene Copy erstellen.
Wenn eine Plattform nicht in der Liste ist, lass das Feld weg.

Antworte NUR mit dem JSON-Array, kein Text davor oder danach.`;

  let raw: string;

  if (provider === 'openai') {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const res = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 2000,
      temperature: 0.8,
      response_format: { type: 'json_object' },
    });
    raw = res.choices[0]?.message?.content ?? '[]';
  } else {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    });
    const block = msg.content.find(b => b.type === 'text');
    raw = block?.type === 'text' ? block.text : '[]';
  }

  // Parse — handle both array and {variants: [...]} formats
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : (parsed.variants ?? parsed.ads ?? []);
  } catch {
    // Try to extract JSON array from raw text
    const match = raw.match(/\[[\s\S]*\]/);
    if (match) return JSON.parse(match[0]);
    throw new Error('AI hat kein gültiges JSON zurückgegeben');
  }
}
