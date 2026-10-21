// Der Google-Schlüssel kann aus zwei Richtungen kommen:
//
//  • aus der Umgebung (GOOGLE_PLACES_KEY in Railway) — der saubere Weg, der
//    Schlüssel steht dann nirgends in der Datenbank;
//  • aus der Oberfläche — der bequeme Weg, wenn man an die Railway-Variablen
//    gerade nicht herankommt.
//
// Der eingegebene Schlüssel gewinnt, damit man ihn ohne Neustart wechseln
// kann. Er liegt dann im Klartext in der SQLite-Datei: wer Zugriff auf das
// Volume oder das App-Passwort hat, kann ihn benutzen. Deshalb gibt die API
// ihn nie wieder heraus — nur, ob einer da ist und worauf er endet.

import { leseEinstellung, setzeEinstellung, getDb } from './db';
import { config } from './config';

const SCHLUESSEL = 'google_places_key';

export function googleSchluessel(): string {
  return leseEinstellung(SCHLUESSEL) || config.googlePlacesKey || '';
}

export function googleSchluesselSetzen(wert: string): void {
  setzeEinstellung(SCHLUESSEL, wert.trim());
}

export function googleSchluesselLoeschen(): void {
  getDb().prepare(`DELETE FROM einstellungen WHERE schluessel = ?`).run(SCHLUESSEL);
}

export interface SchluesselInfo {
  gesetzt: boolean;
  quelle: 'eingabe' | 'umgebung' | 'keiner';
  /** Letzte vier Zeichen, damit man erkennt, welcher Schlüssel hinterlegt ist. */
  endet_auf: string | null;
}

export function googleSchluesselInfo(): SchluesselInfo {
  const eingegeben = leseEinstellung(SCHLUESSEL);
  const wert = eingegeben || config.googlePlacesKey || '';
  return {
    gesetzt: wert.length > 0,
    quelle: eingegeben ? 'eingabe' : config.googlePlacesKey ? 'umgebung' : 'keiner',
    endet_auf: wert ? wert.slice(-4) : null,
  };
}
