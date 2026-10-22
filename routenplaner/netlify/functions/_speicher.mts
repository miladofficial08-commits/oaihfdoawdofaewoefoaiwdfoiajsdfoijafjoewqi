// Ablage auf Netlify: Key-Value statt Datenbank.
//
// Netlify Blobs kennt keine Tabellen, Abfragen oder Transaktionen — nur
// Schlüssel und Werte. Deshalb liegt der komplette Bestand als je eine
// JSON-Datei darin, und die ganze Logik steckt in reinen Funktionen im
// gemeinsamen Paket (shared/praxen-logik.ts), die hier nur aufgerufen werden.
//
// Größen: Blobs erlaubt 5 MB je Wert. Tausend Praxen als JSON liegen bei rund
// 600 KB — reichlich Luft. Sollte es je eng werden, müsste der Bestand auf
// mehrere Schlüssel aufgeteilt werden.

import { getStore, type Store } from '@netlify/blobs';
import type { BesuchsBuch, PraxisSatz } from '../../shared/praxen-logik';

export const SCHLUESSEL = {
  praxen: 'praxen',
  besuche: 'besuche',
  tour: 'tour',
  einstellungen: 'einstellungen',
  importStand: 'import-stand',
} as const;

export interface Einstellungen {
  start_adresse?: string;
  start_lat?: number;
  start_lon?: number;
  start_quelle?: 'geokodiert' | 'manuell' | 'fallback';
  google_key?: string;
}

export function speicher(): Store {
  return getStore({ name: 'routenplaner', consistency: 'strong' });
}

export async function lies<T>(store: Store, schluessel: string, standard: T): Promise<T> {
  const wert = await store.get(schluessel, { type: 'json' });
  return (wert as T | null) ?? standard;
}

export async function schreib(store: Store, schluessel: string, wert: unknown): Promise<void> {
  await store.setJSON(schluessel, wert);
}

/**
 * Lesen, ändern, zurückschreiben — und zwar so, dass zwei Handys sich nicht
 * gegenseitig überschreiben.
 *
 * Blobs kennt keine Transaktionen, aber bedingtes Schreiben: "nur wenn sich
 * der Wert seit dem Lesen nicht geändert hat". Hat ihn jemand anders
 * verändert, wird neu gelesen und noch einmal versucht. Ohne das verlöre man
 * genau dann Häkchen, wenn beide gleichzeitig unterwegs abhaken — also immer
 * dann, wenn es darauf ankommt.
 *
 * Unterstützt die Laufzeit das bedingte Schreiben nicht, bleibt das normale
 * Schreiben übrig; dann ist es nicht schlechter als ohne diese Funktion.
 */
export async function aendere<T>(
  store: Store,
  schluessel: string,
  standard: T,
  aenderung: (alt: T) => T,
  versuche = 5,
): Promise<T> {
  for (let i = 0; i < versuche; i++) {
    const { data, etag } = await store.getWithMetadata(schluessel, { type: 'json' })
      .then(r => ({ data: (r?.data as T | undefined) ?? standard, etag: r?.etag }))
      .catch(() => ({ data: standard, etag: undefined }));

    const neu = aenderung(data);
    try {
      // Der Typ kennt die Bedingungen je nach Fassung der Bibliothek nicht,
      // der Dienst versteht sie aber. Deshalb hier bewusst vorbei am Typ.
      const setzen = store.setJSON as unknown as (
        k: string, v: unknown, o?: Record<string, unknown>,
      ) => Promise<{ modified?: boolean } | void>;
      const ergebnis = await setzen(schluessel, neu,
        etag ? { onlyIfMatch: etag } : { onlyIfNew: true });
      // Ältere Fassungen liefern kein Ergebnisobjekt — dann wurde einfach
      // geschrieben und es gibt nichts zu wiederholen.
      if (!ergebnis || ergebnis.modified !== false) return neu;
    } catch {
      // Bedingtes Schreiben nicht verfügbar: unbedingt schreiben.
      await store.setJSON(schluessel, neu);
      return neu;
    }
    // Jemand war schneller — kurz warten und mit frischem Stand neu versuchen.
    await new Promise(r => setTimeout(r, 60 + i * 120));
  }
  throw new Error(
    'Änderung konnte nicht gespeichert werden: zu viele gleichzeitige Zugriffe.',
  );
}

export async function praxenLesen(store: Store): Promise<PraxisSatz[]> {
  return lies<PraxisSatz[]>(store, SCHLUESSEL.praxen, []);
}

export async function besucheLesen(store: Store): Promise<BesuchsBuch> {
  return lies<BesuchsBuch>(store, SCHLUESSEL.besuche, {});
}

export async function einstellungenLesen(store: Store): Promise<Einstellungen> {
  return lies<Einstellungen>(store, SCHLUESSEL.einstellungen, {});
}
