// Adresse → Koordinate über Nominatim (OpenStreetMap, kostenlos).
// Nutzungsregeln von Nominatim: max. 1 Anfrage pro Sekunde, aussagekräftiger
// User-Agent. Beides hält diese Datei ein; die Startadresse wird außerdem in
// den Einstellungen gecacht und nicht bei jedem Aufruf neu geschlagen.

import type { DienstKonfig } from './dienste';
import type { Punkt } from './geo';

export interface GeoTreffer extends Punkt {
  anzeigename: string;
}

export async function geokodieren(
  adresse: string,
  dienste: DienstKonfig,
): Promise<GeoTreffer | null> {
  const url =
    `${dienste.nominatimBase}/search?` +
    new URLSearchParams({
      q: adresse,
      format: 'jsonv2',
      addressdetails: '1',
      limit: '1',
      countrycodes: 'de',
    }).toString();

  const res = await fetch(url, {
    headers: { 'User-Agent': dienste.userAgent, Accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Nominatim ${res.status}`);
  const treffer = (await res.json()) as Array<{
    lat: string;
    lon: string;
    display_name: string;
  }>;
  if (!Array.isArray(treffer) || treffer.length === 0) return null;
  const t = treffer[0];
  const lat = Number(t.lat);
  const lon = Number(t.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon, anzeigename: t.display_name };
}
