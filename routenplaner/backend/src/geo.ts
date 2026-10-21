// Geometrie auf der Kugel. Reine Funktionen, keine Abhängigkeiten — damit sie
// sich ohne Datenbank und ohne Netz testen lassen.

export interface Punkt {
  lat: number;
  lon: number;
}

const ERDRADIUS_M = 6_371_008.8;
const GRAD = Math.PI / 180;

/** Luftlinie in Metern. */
export function haversineM(a: Punkt, b: Punkt): number {
  const dLat = (b.lat - a.lat) * GRAD;
  const dLon = (b.lon - a.lon) * GRAD;
  const lat1 = a.lat * GRAD;
  const lat2 = b.lat * GRAD;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * ERDRADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Kompassrichtung von a nach b in Grad (0 = Norden, im Uhrzeigersinn).
 *
 * Danach werden die Tagestouren aufgeteilt: Praxen nach Richtung vom Betrieb
 * aus sortiert und in Blöcke geschnitten ergibt kompakte Tortenstücke statt
 * quer durch die Stadt verstreuter Tage.
 */
export function peilung(von: Punkt, nach: Punkt): number {
  const lat1 = von.lat * GRAD;
  const lat2 = nach.lat * GRAD;
  const dLon = (nach.lon - von.lon) * GRAD;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  const grad = (Math.atan2(y, x) * 180) / Math.PI;
  return (grad + 360) % 360;
}

/** Umschließendes Rechteck [sued, west, nord, ost] um einen Punkt. */
export function bbox(mitte: Punkt, radiusKm: number): [number, number, number, number] {
  const dLat = radiusKm / 111.32;
  const cos = Math.cos(mitte.lat * GRAD);
  // Nahe den Polen wird der Nenner winzig; in Deutschland unkritisch, aber der
  // Schutz kostet nichts und verhindert eine unendliche Bbox.
  const dLon = radiusKm / (111.32 * Math.max(0.01, cos));
  return [mitte.lat - dLat, mitte.lon - dLon, mitte.lat + dLat, mitte.lon + dLon];
}

/** Meter menschenlesbar: "480 m" bzw. "2,4 km". */
export function meterText(m: number): string {
  if (!Number.isFinite(m)) return '–';
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(1).replace('.', ',')} km`;
}

/** Sekunden menschenlesbar: "7 Min" bzw. "1 Std 12 Min". */
export function dauerText(s: number): string {
  if (!Number.isFinite(s)) return '–';
  const min = Math.round(s / 60);
  if (min < 60) return `${min} Min`;
  return `${Math.floor(min / 60)} Std ${min % 60} Min`;
}
