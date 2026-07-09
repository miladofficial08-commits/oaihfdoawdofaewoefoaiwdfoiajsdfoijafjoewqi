import { Lead } from '../types';

const COMPANY_SUFFIXES = [
  'gmbh',
  'ug',
  'ag',
  'kg',
  'ohg',
  'gbr',
  'mbh',
  'co',
  'e.k',
  'ek',
  'inh',
  'heizung',
  'sanitaer',
  'sanitär',
];

export function normalizeEmail(value?: string): string | undefined {
  const email = value?.trim().toLowerCase();
  return email && email.includes('@') ? email : undefined;
}

export function normalizePhone(value?: string): string | undefined {
  if (!value) return undefined;
  const digits = value.replace(/\D/g, '');
  return digits.length >= 6 ? digits : undefined;
}

export function extractDomain(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value.startsWith('http') ? value : `https://${value}`);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    return host || undefined;
  } catch {
    const cleaned = value.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
    return cleaned.includes('.') ? cleaned : undefined;
  }
}

export function normalizeName(value?: string): string | undefined {
  if (!value) return undefined;
  const words = value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' ')
    .replace(/[^a-z0-9äöüß\s.-]/gi, ' ')
    .split(/\s+/)
    .map(w => w.replace(/\.$/, ''))
    .filter(Boolean)
    .filter(w => !COMPANY_SUFFIXES.includes(w));

  return words.slice(0, 5).join(' ') || undefined;
}

export function normalizeAddressKey(adresse?: string, stadt?: string): string | undefined {
  const address = [adresse, stadt].filter(Boolean).join(' ');
  if (!address.trim()) return undefined;
  return address
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9äöüß\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildIdentity(data: Partial<Lead>) {
  return {
    normalized_name: normalizeName(data.name),
    website_domain: extractDomain(data.website),
    phone_normalized: normalizePhone(data.telefon),
    email_normalized: normalizeEmail(data.email),
    address_key: normalizeAddressKey(data.adresse, data.stadt),
  };
}
