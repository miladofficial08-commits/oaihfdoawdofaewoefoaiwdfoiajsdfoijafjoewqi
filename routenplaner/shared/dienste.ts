// Zugangsdaten der externen Dienste, als Parameter statt als globale
// Konfiguration.
//
// Grund: Derselbe Code läuft an drei Stellen — im Fastify-Server auf Railway,
// in einer Netlify-Funktion und (für Tests) nackt in Node. Jede Umgebung holt
// ihre Werte anders; die Logik darf das nicht wissen müssen.

export interface DienstKonfig {
  overpassEndpoints: string[];
  nominatimBase: string;
  osrmBase: string;
  /**
   * Nominatim und der öffentliche OSRM-Server verlangen einen
   * aussagekräftigen User-Agent mit Kontaktmöglichkeit, sonst sperren sie.
   */
  userAgent: string;
  googlePlacesKey?: string;
}

export const STANDARD_DIENSTE: DienstKonfig = {
  overpassEndpoints: [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
  ],
  nominatimBase: 'https://nominatim.openstreetmap.org',
  osrmBase: 'https://router.project-osrm.org',
  userAgent: 'praxis-routenplaner/1.0 (Krankenfahrten-Akquise)',
};

/** Baut die Dienstkonfiguration aus Umgebungsvariablen, mit Standardwerten. */
export function diensteAusUmgebung(env: Record<string, string | undefined>): DienstKonfig {
  const liste = (env.OVERPASS_ENDPOINTS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  return {
    overpassEndpoints: liste.length ? liste : STANDARD_DIENSTE.overpassEndpoints,
    nominatimBase: env.NOMINATIM_BASE || STANDARD_DIENSTE.nominatimBase,
    osrmBase: env.OSRM_BASE || STANDARD_DIENSTE.osrmBase,
    userAgent: env.HTTP_USER_AGENT || STANDARD_DIENSTE.userAgent,
    googlePlacesKey: env.GOOGLE_PLACES_KEY || undefined,
  };
}
