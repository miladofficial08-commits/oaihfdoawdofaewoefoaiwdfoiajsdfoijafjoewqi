export type LeadStatus =
  | 'new'
  | 'checked'
  | 'missing_data'
  | 'not_suitable'
  | 'duplicate'
  | 'draft_ready'
  | 'approved'
  | 'contacted'
  | 'replied'
  | 'demo_booked'
  | 'proposal_sent'
  | 'won'
  | 'lost'
  | 'no_interest'
  | 'do_not_contact'
  | 'manual_review'
  | 'archived';
export type Prioritaet = 'A' | 'B' | 'C';
export type OutreachKanal = 'whatsapp' | 'email' | 'kontaktformular' | 'telefon';
export type SocialKanal = 'instagram' | 'facebook' | 'tiktok' | 'linkedin' | 'youtube';
export type ContactPointType = OutreachKanal | SocialKanal | 'website' | 'source';

export interface Lead {
  id: string;
  created_at: string;
  updated_at: string;

  name: string;
  branche: string;
  stadt: string;
  stadtbezirk?: string;

  adresse?: string;
  telefon?: string;
  website?: string;
  email?: string;
  whatsapp?: string;
  kontaktformular_url?: string;
  instagram_url?: string;
  facebook_url?: string;
  tiktok_url?: string;
  linkedin_url?: string;
  youtube_url?: string;

  source_url?: string;
  maps_place_id?: string;
  normalized_name?: string;
  website_domain?: string;
  phone_normalized?: string;
  email_normalized?: string;
  address_key?: string;
  duplicate_of?: string;
  duplicate_reason?: string;

  google_bewertung?: number;
  google_anzahl_reviews?: number;
  google_oeffnungszeiten?: string;
  google_foto_url?: string;

  hat_website: number;
  website_alt?: number;
  website_screenshot?: string;
  hat_chatbot?: number;
  hat_whatsapp_link?: number;
  hat_online_buchung?: number;
  hat_faq?: number;
  hat_notdienst_hinweis?: number;
  website_meta?: string;
  kontaktformular_typ?: string;
  kontaktformular_confidence?: number;
  website_quality_flags?: string;

  score_chatbot?: number;
  score_telefon?: number;
  score_website?: number;
  score_gesamt: number;
  prioritaet: Prioritaet;
  score_gruende?: string;
  website_evidence?: string;
  telefonstrategie_empfohlen?: number;
  bester_kanal?: OutreachKanal | 'manuell';
  kontakt_hinweis?: string;

  nachricht_chatbot?: string;
  nachricht_telefon?: string;
  nachricht_website?: string;
  ai_analysiert?: number;

  status: LeadStatus;
  approved_nachricht?: string;
  approved_kanal?: string;
  gesendet_at?: string;
  checked_at?: string;
  draft_created_at?: string;
  approved_at?: string;
  contacted_at?: string;
  last_manual_call_at?: string;
  manual_call_note?: string;
  manual_call_done?: number;
  notiz?: string;

  scrape_error?: string;
  analyze_error?: string;
}

export interface ContactPoint {
  id: string;
  lead_id: string;
  type: ContactPointType;
  value: string;
  source_url?: string;
  confidence: number;
  verified_at?: string;
  created_at: string;
}

export interface OutreachEvent {
  id: string;
  lead_id: string;
  event_type: 'draft_created' | 'message_edited' | 'approved' | 'sent_marked' | 'manual_contact' | 'manual_call' | 'status_changed' | 'archived' | 'email_sent';
  channel?: string;
  message?: string;
  status?: LeadStatus;
  user?: string;
  note?: string;
  created_at: string;
}

export interface ScrapeInput {
  stadt: string;
  branche: string;
  stadtbezirk?: string;
  maxResults?: number;
}

export interface ScoreResult {
  chatbot: number;
  telefon: number;
  website: number;
  gesamt: number;
  prioritaet: Prioritaet;
  gruende: string[];
  gruende_chatbot: string[];
  gruende_telefon: string[];
  gruende_website: string[];
}

export interface WebsiteAnalysis {
  accessible: boolean;
  hat_chatbot: boolean;
  hat_whatsapp_link: boolean;
  hat_online_buchung: boolean;
  hat_faq: boolean;
  hat_notdienst_hinweis: boolean;
  website_alt: boolean;
  email?: string;
  whatsapp?: string;
  kontaktformular_url?: string;
  kontaktformular_typ?: string;
  form_confidence?: number;
  social_links: Partial<Record<SocialKanal, string>>;
  quality_flags: string[];
  meta?: Record<string, string>;
  evidence?: string[];
  error?: string;
}
