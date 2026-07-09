import fs from 'fs';
import path from 'path';
import { getAllLeads, getContactPointsBatch, getOutreachEventsBatch } from '../db/leads-repo';
import { Lead } from '../types';

const EXPORT_DIR = path.join(process.cwd(), 'data', 'exports');

const COLUMNS: Array<{ key: keyof Lead; label: string }> = [
  { key: 'name', label: 'Firmenname' },
  { key: 'branche', label: 'Branche' },
  { key: 'stadt', label: 'Stadt' },
  { key: 'stadtbezirk', label: 'Stadtbezirk' },
  { key: 'adresse', label: 'Adresse' },
  { key: 'telefon', label: 'Telefon' },
  { key: 'website', label: 'Website' },
  { key: 'email', label: 'E-Mail' },
  { key: 'whatsapp', label: 'WhatsApp' },
  { key: 'kontaktformular_url', label: 'Kontaktformular' },
  { key: 'google_bewertung', label: 'Google Bewertung' },
  { key: 'google_anzahl_reviews', label: 'Anzahl Bewertungen' },
  { key: 'hat_website', label: 'Hat Website' },
  { key: 'hat_chatbot', label: 'Hat Chatbot' },
  { key: 'hat_online_buchung', label: 'Hat Online-Buchung' },
  { key: 'hat_whatsapp_link', label: 'WhatsApp-Link' },
  { key: 'hat_notdienst_hinweis', label: 'Notdienst' },
  { key: 'website_alt', label: 'Website veraltet' },
  { key: 'score_chatbot', label: 'Score Chatbot' },
  { key: 'score_telefon', label: 'Score KI-Telefon' },
  { key: 'score_website', label: 'Score Website' },
  { key: 'score_gesamt', label: 'Score Gesamt' },
  { key: 'prioritaet', label: 'Priorität' },
  { key: 'status', label: 'Status' },
  { key: 'bester_kanal', label: 'Bester Kanal' },
  { key: 'kontakt_hinweis', label: 'Kontakt Hinweis' },
  { key: 'score_gruende', label: 'Score Gruende' },
  { key: 'website_evidence', label: 'Website Evidence' },
  { key: 'duplicate_of', label: 'Duplikat von' },
  { key: 'duplicate_reason', label: 'Duplikat Grund' },
  { key: 'checked_at', label: 'Geprueft am' },
  { key: 'draft_created_at', label: 'Entwurf am' },
  { key: 'approved_at', label: 'Freigegeben am' },
  { key: 'contacted_at', label: 'Kontaktiert am' },
  { key: 'last_manual_call_at', label: 'Manueller Anruf am' },
  { key: 'manual_call_note', label: 'Call Notiz' },
  { key: 'source_url', label: 'Quelle URL' },
  { key: 'created_at', label: 'Gefunden am' },
];

const EXTRA_COLUMNS = ['Kontaktpunkte', 'Outreach History'];

export function exportToCsv(filter: Parameters<typeof getAllLeads>[0] = {}): string {
  fs.mkdirSync(EXPORT_DIR, { recursive: true });

  const leads = getAllLeads(filter);
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `leads-${ts}.csv`;
  const filepath = path.join(EXPORT_DIR, filename);

  const ids = leads.map(l => l.id);
  const contactPointsMap = getContactPointsBatch(ids);
  const outreachEventsMap = getOutreachEventsBatch(ids);

  const header = [...COLUMNS.map(c => `"${c.label}"`), ...EXTRA_COLUMNS.map(c => `"${c}"`)].join(';');
  const rows = leads.map(lead =>
    [
      ...COLUMNS.map(c => {
        const val = lead[c.key];
        if (val === undefined || val === null) return '""';
        if (typeof val === 'number') return String(val);
        return `"${String(val).replace(/"/g, '""')}"`;
      }),
      csvCell((contactPointsMap[lead.id] ?? []).map(p => `${p.type}:${p.value}`).join(' | ')),
      csvCell((outreachEventsMap[lead.id] ?? []).map(e => `${e.created_at}:${e.event_type}:${e.channel ?? ''}:${e.status ?? ''}`).join(' | ')),
    ].join(';')
  );

  // BOM für Excel-Kompatibilität
  fs.writeFileSync(filepath, '﻿' + [header, ...rows].join('\n'), 'utf-8');
  return filepath;
}

function csvCell(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}
