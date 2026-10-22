// Zentrale Konfiguration. Alles was sich pro Deployment unterscheidet, kommt
// aus Umgebungsvariablen — die App läuft ohne eine einzige davon.

import * as path from 'path';
import * as dotenv from 'dotenv';
import type { DienstKonfig } from '../../shared/dienste';

dotenv.config();

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Datenverzeichnis. Railway stellt bei gemounteten Volumes
 * RAILWAY_VOLUME_MOUNT_PATH bereit; ohne Volume landet die Datei im Container
 * und ist beim nächsten Deploy weg. Für die Besuchsprotokolle ist ein Volume
 * deshalb Pflicht — darauf weist der Server beim Start hin.
 */
function datenVerzeichnis(): string {
  if (process.env.SQLITE_DB_PATH) return path.dirname(process.env.SQLITE_DB_PATH);
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  if (process.env.RAILWAY_VOLUME_MOUNT_PATH) return process.env.RAILWAY_VOLUME_MOUNT_PATH;
  return path.join(process.cwd(), 'data');
}

export const config = {
  port: num('PORT', 4100),
  host: process.env.HOST || '0.0.0.0',

  dataDir: datenVerzeichnis(),
  dbPath: process.env.SQLITE_DB_PATH || path.join(datenVerzeichnis(), 'routen.db'),
  /** Liegt die Datenbank in einem persistenten Volume? Nur zur Warnung im Log. */
  dbPersistent: Boolean(
    process.env.SQLITE_DB_PATH || process.env.RAILWAY_VOLUME_MOUNT_PATH,
  ),

  /**
   * Gemeinsames Passwort. Leer = offen für jeden, der die URL kennt.
   * Für echte Kundendaten im Feld sollte das gesetzt sein.
   */
  passwort: process.env.APP_PASSWORT || process.env.APP_PASSWORD || '',

  /** Erlaubte Herkunft des Frontends. Leer/"*" = alle (für Netlify-Previews praktisch). */
  corsOrigin: process.env.CORS_ORIGIN || '*',

  // ── Startadresse (Betriebssitz) ────────────────────────────────────────────
  // Die Hausnummer stand in der Aufgabenstellung nicht eindeutig drin, deshalb
  // wird die Adresse beim Import geokodiert und ist in der App überschreibbar.
  startAdresse: process.env.START_ADRESSE || 'Dillenburger Weg 17, 40229 Düsseldorf',
  /**
   * Nur Rückfalloption, wenn das Geocoding nicht erreichbar ist: Mittelpunkt
   * von Düsseldorf-Eller, nicht die Hausnummer selbst. Die App zeigt an,
   * welche Koordinate tatsächlich benutzt wird.
   */
  startLatFallback: num('START_LAT', 51.2033),
  startLonFallback: num('START_LON', 6.8419),

  // ── Import-Vorgaben ───────────────────────────────────────────────────────
  radiusKmDefault: num('RADIUS_KM', 6),
  stoppsProTagDefault: num('STOPPS_PRO_TAG', 18),

  // ── Externe Dienste ──────────────────────────────────────────────────────
  overpassEndpoints: (process.env.OVERPASS_ENDPOINTS ||
    [
      'https://overpass-api.de/api/interpreter',
      'https://overpass.kumi.systems/api/interpreter',
      'https://overpass.private.coffee/api/interpreter',
    ].join(',')
  ).split(',').map(s => s.trim()).filter(Boolean),

  nominatimBase: process.env.NOMINATIM_BASE || 'https://nominatim.openstreetmap.org',
  osrmBase: process.env.OSRM_BASE || 'https://router.project-osrm.org',

  /**
   * Nominatim und der öffentliche OSRM-Server verlangen einen aussagekräftigen
   * User-Agent mit Kontaktmöglichkeit, sonst sperren sie.
   */
  userAgent: process.env.HTTP_USER_AGENT ||
    'praxis-routenplaner/1.0 (Krankenfahrten-Akquise; Kontakt via Betreiber)',

  /** Optional: schließt die Lücken, die OpenStreetMap bei Arztpraxen hat. */
  googlePlacesKey: process.env.GOOGLE_PLACES_KEY || '',
} as const;


/**
 * Dieselben Werte in der Form, die das gemeinsame Paket erwartet. Die Logik
 * dort kennt keine Umgebungsvariablen — sie bekommt alles übergeben.
 */
export const dienste: DienstKonfig = {
  overpassEndpoints: config.overpassEndpoints as unknown as string[],
  nominatimBase: config.nominatimBase,
  osrmBase: config.osrmBase,
  userAgent: config.userAgent,
  googlePlacesKey: config.googlePlacesKey || undefined,
};
