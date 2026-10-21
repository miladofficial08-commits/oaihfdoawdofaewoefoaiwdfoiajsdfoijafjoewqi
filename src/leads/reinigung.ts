// Bestandsreinigung der Anrufliste.
//
// Läuft über alle Leads und schreibt auf, was an den Daten nicht stimmt, statt
// es zu verschweigen. Nichts wird gelöscht – ein Lead, der heute als Verband
// erkannt wird, bleibt mit Grund stehen, sonst kommt er beim nächsten Scrape
// zurück und niemand weiß mehr, warum er schon einmal weg war.
//
// Vier Dinge werden angefasst:
//   1. Stadt auf eine Schreibweise bringen (Düsseldorf ≠ Duesseldorf im Filter).
//   2. Verbände, Kammern, Großhändler und Behörden aus der Anrufliste nehmen.
//   3. Chef-Namen bewerten: belegt, halb belegt oder unsicher.
//   4. Telefonnummern auf Form prüfen und Widersprüche Zentrale↔Impressum
//      festhalten.
//
// Der Lauf ist wiederholbar: Zweimal hintereinander ergibt dasselbe Bild.

import { getDb } from '../db/schema';
import {
  bewerteGf, istKeinBetrieb, normalisiereStadt, stadtAusAdresse,
  telefonProblem, gleicheNummer,
} from './qualitaet';

export interface ReinigungsBericht {
  geprueft: number;
  stadt_korrigiert: number;
  kein_betrieb: number;
  gf_hoch: number;
  gf_mittel: number;
  gf_unsicher: number;
  gf_konflikte: number;
  tel_problem: number;
  tel_konflikt: number;
  /** Beispiele zum Nachsehen – nicht die ganze Liste. */
  beispiele: {
    stadt: Array<{ name: string; vorher: string; nachher: string }>;
    kein_betrieb: Array<{ name: string; grund: string }>;
    gf_konflikt: Array<{ name: string; gf: string; konflikt: string }>;
    tel: Array<{ name: string; telefon: string; problem: string }>;
  };
}

/**
 * Befunde der Impressum-Prüfung, die hier nicht verloren gehen dürfen: Sie sind
 * belastbarer als alles, was man ohne Netzzugriff feststellen kann.
 */
interface Zeile {
  id: string;
  name: string;
  stadt: string | null;
  adresse: string | null;
  telefon: string | null;
  telefon_direkt: string | null;
  geschaeftsfuehrer: string | null;
  gf_quelle: string | null;
}

/**
 * Prüft und korrigiert den Bestand.
 * @param nurBericht true = nichts schreiben, nur zählen (für einen Blick vorher).
 */
export function reinigeBestand(nurBericht = false): ReinigungsBericht {
  const db = getDb();
  const zeilen = db.prepare(
    `SELECT id, name, stadt, adresse, telefon, telefon_direkt, geschaeftsfuehrer, gf_quelle
     FROM leads`
  ).all() as Zeile[];
  // Von der Impressum-Prüfung gesetzte Nummern-Befunde übernehmen statt sie
  // durch die schwächere Regel unten zu ersetzen.
  const vorhandenerTelKonflikt = new Map(
    (db.prepare(
      `SELECT id, tel_konflikt FROM leads
       WHERE tel_konflikt IS NOT NULL AND tel_konflikt LIKE '%steht nicht auf der eigenen Website%'`
    ).all() as Array<{ id: string; tel_konflikt: string }>).map(r => [r.id, r.tel_konflikt])
  );

  const bericht: ReinigungsBericht = {
    geprueft: 0, stadt_korrigiert: 0, kein_betrieb: 0,
    gf_hoch: 0, gf_mittel: 0, gf_unsicher: 0, gf_konflikte: 0,
    tel_problem: 0, tel_konflikt: 0,
    beispiele: { stadt: [], kein_betrieb: [], gf_konflikt: [], tel: [] },
  };

  const update = db.prepare(
    `UPDATE leads SET
       stadt             = @stadt,
       kein_betrieb      = @kein_betrieb,
       kein_betrieb_grund = @kein_betrieb_grund,
       gf_vertrauen      = @gf_vertrauen,
       gf_konflikt       = @gf_konflikt,
       tel_problem       = @tel_problem,
       tel_konflikt      = @tel_konflikt,
       qualitaet_geprueft_at = datetime('now'),
       updated_at        = datetime('now')
     WHERE id = @id`
  );

  const lauf = db.transaction((rows: Zeile[]) => {
    for (const l of rows) {
      bericht.geprueft++;

      // 1) Stadt. „NRW" kommt aus dem regionsweiten OSM-Lauf und ist als Stadt
      //    unbrauchbar – dann aus der Adresse ziehen.
      let stadt = l.stadt;
      const ausAdresse = (!stadt || /^(nrw|nordrhein)/i.test(stadt))
        ? stadtAusAdresse(l.adresse) : undefined;
      const neueStadt = ausAdresse || normalisiereStadt(stadt) || stadt;
      if (neueStadt && neueStadt !== stadt) {
        bericht.stadt_korrigiert++;
        if (bericht.beispiele.stadt.length < 10) {
          bericht.beispiele.stadt.push({ name: l.name, vorher: String(stadt ?? '—'), nachher: neueStadt });
        }
        stadt = neueStadt;
      }

      // 2) Kein Betrieb?
      const grund = istKeinBetrieb(l.name);
      if (grund) {
        bericht.kein_betrieb++;
        if (bericht.beispiele.kein_betrieb.length < 20) {
          bericht.beispiele.kein_betrieb.push({ name: l.name, grund });
        }
      }

      // 3) Chef-Name bewerten.
      const gf = bewerteGf(l.geschaeftsfuehrer, l.name, l.gf_quelle);
      if (gf) {
        if (gf.vertrauen === 'hoch') bericht.gf_hoch++;
        else if (gf.vertrauen === 'mittel') bericht.gf_mittel++;
        else bericht.gf_unsicher++;
        if (gf.konflikt) {
          bericht.gf_konflikte++;
          if (bericht.beispiele.gf_konflikt.length < 20) {
            bericht.beispiele.gf_konflikt.push({
              name: l.name, gf: String(l.geschaeftsfuehrer), konflikt: gf.konflikt,
            });
          }
        }
      }

      // 4) Telefon. Geprüft wird die Nummer, mit der tatsächlich angerufen wird.
      const anrufNummer = l.telefon_direkt || l.telefon;
      const telProblem = anrufNummer ? telefonProblem(anrufNummer) : undefined;
      if (telProblem) {
        bericht.tel_problem++;
        if (bericht.beispiele.tel.length < 20) {
          bericht.beispiele.tel.push({ name: l.name, telefon: String(anrufNummer), problem: telProblem });
        }
      }
      // Nummernwiderspruch – aber nur, wo es wirklich einer ist.
      //
      // Erster Versuch war hier zu scharf: Jede Abweichung zwischen Maps-Nummer
      // und Impressum-Nummer galt als Konflikt. Dann waren 85 Leads „verdächtig",
      // und in fast allen Fällen war der Unterschied genau das, was man haben
      // will – Maps zeigt das Festnetz der Zentrale, das Impressum die Mobil-
      // nummer des Chefs. Eine Warnung, die bei 85 von 85 falsch ist, liest
      // nach dem dritten Mal niemand mehr.
      //
      // Echter Widerspruch ist nur: zwei verschiedene FESTNETZ-Nummern. Dann
      // ist eine der beiden veraltet. Den stärkeren Befund („Maps-Nummer steht
      // nirgends auf der eigenen Website") liefert die Impressum-Prüfung; der
      // wird hier nicht überschrieben.
      const istMobil = (n: string | null) => /^(\+?49\s?1[567]|01[567])/.test(String(n ?? '').replace(/[\s\/-]/g, ''));
      let telKonflikt: string | null = vorhandenerTelKonflikt.get(l.id) ?? null;
      if (!telKonflikt && l.telefon && l.telefon_direkt
          && !gleicheNummer(l.telefon, l.telefon_direkt)
          && !istMobil(l.telefon) && !istMobil(l.telefon_direkt)) {
        telKonflikt = `Zwei verschiedene Festnetznummern – Maps: ${l.telefon} · Impressum: ${l.telefon_direkt}`;
      }
      if (telKonflikt) bericht.tel_konflikt++;

      if (!nurBericht) {
        update.run({
          id: l.id,
          stadt,
          kein_betrieb: grund ? 1 : 0,
          kein_betrieb_grund: grund ?? null,
          gf_vertrauen: gf?.vertrauen ?? null,
          gf_konflikt: gf?.konflikt ?? null,
          tel_problem: telProblem ?? null,
          tel_konflikt: telKonflikt,
        });
      }
    }
  });

  lauf(zeilen);
  return bericht;
}

/**
 * Städte-Dubletten nach dem Lauf: welche Schreibweisen gab es, welche bleiben?
 * Dient der Kontrolle – eine Reinigung, die man nicht nachzählen kann, ist
 * keine Zusicherung wert.
 */
export function staedteUebersicht(): Array<{ stadt: string; n: number }> {
  return getDb().prepare(
    `SELECT stadt, COUNT(*) n FROM leads
     WHERE stadt IS NOT NULL AND stadt != '' AND COALESCE(duplicate_of,'') = ''
     GROUP BY stadt ORDER BY n DESC`
  ).all() as Array<{ stadt: string; n: number }>;
}
