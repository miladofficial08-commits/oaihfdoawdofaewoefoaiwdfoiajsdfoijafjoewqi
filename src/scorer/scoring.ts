import { Lead, ScoreResult, Prioritaet } from '../types';

const TELEFON_ABHAENGIG: Record<string, number> = {
  'handwerker': 90, 'shk': 90, 'sanitär': 88, 'heizung': 88,
  'elektro': 85, 'schlüsseldienst': 95, 'schluessel': 95,
  'krankenbeförderung': 90, 'krankenbefoerderung': 90, 'krankentransport': 90,
  'pflegedienst': 85, 'pflege': 80, 'taxi': 90, 'umzug': 80,
  'fahrschule': 70, 'restaurant': 60, 'arzt': 75, 'zahnarzt': 75,
  'physiotherapie': 70, 'nagelstudio': 50, 'kosmetik': 50, 'friseur': 55,
  'reinigung': 65, 'gebäudereinigung': 70,
};

const CHATBOT_GEEIGNET: Record<string, number> = {
  'nagelstudio': 85, 'kosmetik': 85, 'friseur': 80, 'restaurant': 75,
  'fahrschule': 80, 'physiotherapie': 75, 'arzt': 70, 'zahnarzt': 70,
  'reinigung': 65, 'handwerker': 60, 'pflegedienst': 65,
  'krankenbeförderung': 60, 'krankenbefoerderung': 60,
};

const WEBSITE_RELAUNCH: Record<string, number> = {
  'handwerker': 80, 'shk': 75, 'sanitär': 75, 'elektro': 75,
  'pflegedienst': 70, 'fahrschule': 65, 'restaurant': 60,
  'krankenbeförderung': 70, 'nagelstudio': 55, 'kosmetik': 55,
};

function matchBranche(map: Record<string, number>, branche: string, def = 50): number {
  const b = branche.toLowerCase();
  for (const [key, val] of Object.entries(map)) {
    if (b.includes(key)) return val;
  }
  return def;
}

export function scoreLead(lead: Partial<Lead> & { branche: string }): ScoreResult {
  const gruende: string[] = [];
  const gruende_chatbot: string[] = [];
  const gruende_telefon: string[] = [];
  const gruende_website: string[] = [];
  let chatbot = matchBranche(CHATBOT_GEEIGNET, lead.branche, 40);
  let telefon = matchBranche(TELEFON_ABHAENGIG, lead.branche, 40);
  let website = 0;

  // ── Chatbot ──────────────────────────────────────────────────────────────
  if (lead.hat_website && !lead.hat_chatbot) {
    chatbot += 20;
    gruende.push('Hat Website, aber keinen Chatbot');
    gruende_chatbot.push('Website vorhanden, aber kein Chatbot erkannt');
  }
  if (!lead.hat_online_buchung && lead.hat_website) {
    chatbot += 10;
    gruende.push('Keine Online-Buchung — Chatbot könnte helfen');
    gruende_chatbot.push('Keine Online-Buchung erkannt');
  }
  if (lead.hat_whatsapp_link) chatbot -= 10;
  if (!lead.hat_website) chatbot -= 30;

  // ── KI-Telefon ────────────────────────────────────────────────────────────
  if (lead.hat_notdienst_hinweis) {
    telefon += 15;
    gruende.push('Notdienst-Hinweis — telefonische Erreichbarkeit kritisch');
    gruende_telefon.push('Notdienst-/24h-Hinweis macht Erreichbarkeit kritisch');
  }
  if (!lead.hat_online_buchung) {
    telefon += 10;
    gruende.push('Keine Online-Buchung — viele Telefonanfragen wahrscheinlich');
    gruende_telefon.push('Keine Online-Buchung: Telefon wird wahrscheinlich stärker genutzt');
  }
  if (lead.google_bewertung && lead.google_bewertung < 4.0 && (lead.google_anzahl_reviews ?? 0) > 5) {
    telefon += 8;
    gruende.push(`Bewertung ${lead.google_bewertung} < 4.0 — oft Erreichbarkeitsproblem`);
    gruende_telefon.push(`Google-Bewertung ${lead.google_bewertung} kann auf Service-/Erreichbarkeitsthema hindeuten`);
  }

  // ── Website ────────────────────────────────────────────────────────────────
  if (!lead.hat_website) {
    website = matchBranche(WEBSITE_RELAUNCH, lead.branche, 30) + 40;
    gruende.push('Keine Website — Landingpage wäre starkes Upgrade');
    gruende_website.push('Keine Website vorhanden');
  } else if (lead.website_alt) {
    website = matchBranche(WEBSITE_RELAUNCH, lead.branche, 30) + 25;
    gruende.push('Website alt/veraltet erkannt');
    gruende_website.push('Technische Alt-Signale auf Website erkannt');
  } else {
    website = 10;
  }

  // ── Kontaktierbarkeit ──────────────────────────────────────────────────────
  const hatKontakt = lead.email || lead.whatsapp || lead.kontaktformular_url || lead.telefon;
  if (!hatKontakt) {
    chatbot = Math.max(0, chatbot - 20);
    telefon = Math.max(0, telefon - 20);
    website = Math.max(0, website - 20);
    gruende.push('Kein Kontaktweg gefunden');
  }

  chatbot = clamp(chatbot);
  telefon = clamp(telefon);
  website = clamp(website);

  const gesamt = Math.round(
    Math.max(chatbot, telefon, website) * 0.6 +
    ((chatbot + telefon + website) / 3) * 0.4
  );

  const prioritaet: Prioritaet = gesamt >= 70 ? 'A' : gesamt >= 45 ? 'B' : 'C';

  if (gruende_chatbot.length === 0) gruende_chatbot.push('Kein starkes Chatbot-Signal ueber Regeln erkannt');
  if (gruende_telefon.length === 0) gruende_telefon.push('Telefon-Fit basiert hauptsaechlich auf Branche');
  if (gruende_website.length === 0) gruende_website.push('Kein starkes Relaunch-Signal erkannt');

  return { chatbot, telefon, website, gesamt, prioritaet, gruende, gruende_chatbot, gruende_telefon, gruende_website };
}

function clamp(n: number): number {
  return Math.min(100, Math.max(0, Math.round(n)));
}
