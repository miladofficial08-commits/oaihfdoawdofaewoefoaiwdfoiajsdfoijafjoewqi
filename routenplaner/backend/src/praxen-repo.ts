// Schreib- und Lesezugriff auf die Praxen samt Besuchsstand.
//
// Kern dieser Datei ist die Zusammenführung: OpenStreetMap und Google liefern
// dieselbe Praxis unter verschiedenen IDs. Ohne Zusammenführung stünde sie
// zweimal in der Tour und man klingelt zweimal an derselben Tür.

import { getDb } from './db';
import { haversineM, type Punkt } from '../../shared/geo';
import { adressKey } from '../../shared/overpass';
import { gleichePraxis, kategorienVertraeglich } from '../../shared/dedup';
import { istStatus, type Status } from '../../shared/typen';
import type { PraxisAusgang, PraxisEingang } from '../../shared/typen';

export { gleichePraxis, kategorienVertraeglich, nameSchluessel } from '../../shared/dedup';

interface PraxisZeile {
  id: string;
  name: string;
  kategorie: string;
  telefon: string | null;
  website: string | null;
  quelle: string;
  fachrichtung: string | null;
  strasse: string | null;
  hausnummer: string | null;
  plz: string | null;
}

export interface ImportBilanz {
  neu: number;
  aktualisiert: number;
  zusammengefuehrt: number;
}

/**
 * Legt Praxen an oder ergänzt vorhandene.
 *
 * Reihenfolge der Entscheidung:
 *  1. Gleiche Quell-ID → Felder auffrischen.
 *  2. Gleiche Adresse + ähnlicher Name → als dieselbe Praxis behandeln und
 *     fehlende Felder (Telefon, Website, Fachrichtung) ergänzen.
 *  3. Sonst → neuer Datensatz.
 *
 * Der Besuchsstand hängt an der Praxis-ID und bleibt bei 1 und 2 erhalten:
 * ein erneuter Import darf niemals Häkchen löschen.
 */
export function praxenSpeichern(
  eingang: PraxisEingang[],
  betriebssitz: Punkt,
): ImportBilanz {
  const db = getDb();
  const jetzt = new Date().toISOString();
  const bilanz: ImportBilanz = { neu: 0, aktualisiert: 0, zusammengefuehrt: 0 };

  const nachId = db.prepare(`SELECT id FROM praxen WHERE id = ?`);
  const nachAdresse = db.prepare(
    `SELECT id, name, kategorie, telefon, website, quelle, fachrichtung,
            strasse, hausnummer, plz
       FROM praxen WHERE adress_key = ?`,
  );
  const einfuegen = db.prepare(`
    INSERT INTO praxen (
      id, name, kategorie, fachrichtung, strasse, hausnummer, plz, ort, stadtteil,
      lat, lon, telefon, website, email, oeffnungszeiten, barrierefrei,
      quelle, source_url, adress_key, entfernung_m, aktiv, angelegt_am, geaendert_am
    ) VALUES (
      @id, @name, @kategorie, @fachrichtung, @strasse, @hausnummer, @plz, @ort, @stadtteil,
      @lat, @lon, @telefon, @website, @email, @oeffnungszeiten, @barrierefrei,
      @quelle, @source_url, @adress_key, @entfernung_m, 1, @jetzt, @jetzt
    )
  `);
  const besuchAnlegen = db.prepare(
    `INSERT OR IGNORE INTO besuche (praxis_id, status, geaendert_am)
     VALUES (?, 'offen', ?)`,
  );
  // COALESCE in dieser Richtung: Bestehendes bleibt stehen, Lücken werden
  // gefüllt. Eine von Hand nachgetragene Telefonnummer überlebt den Import.
  const ergaenzen = db.prepare(`
    UPDATE praxen SET
      telefon        = COALESCE(telefon, @telefon),
      website        = COALESCE(website, @website),
      email          = COALESCE(email, @email),
      fachrichtung   = COALESCE(fachrichtung, @fachrichtung),
      strasse        = COALESCE(strasse, @strasse),
      hausnummer     = COALESCE(hausnummer, @hausnummer),
      plz            = COALESCE(plz, @plz),
      ort            = COALESCE(ort, @ort),
      stadtteil      = COALESCE(stadtteil, @stadtteil),
      oeffnungszeiten = COALESCE(oeffnungszeiten, @oeffnungszeiten),
      barrierefrei   = COALESCE(barrierefrei, @barrierefrei),
      quelle         = CASE WHEN quelle LIKE '%' || @quelle || '%' THEN quelle
                            ELSE quelle || '+' || @quelle END,
      geaendert_am   = @jetzt
    WHERE id = @id
  `);
  // Eine unklare Fachrichtung darf durch eine klare ersetzt werden, umgekehrt nicht.
  const kategorieSchaerfen = db.prepare(
    `UPDATE praxen SET kategorie = @kategorie, geaendert_am = @jetzt
      WHERE id = @id AND kategorie = 'arzt_unklar' AND @kategorie <> 'arzt_unklar'`,
  );

  const lauf = db.transaction((liste: PraxisEingang[]) => {
    for (const p of liste) {
      const key = adressKey(p);
      const entfernung = Math.round(haversineM(betriebssitz, p));
      const werte = {
        id: p.id,
        name: p.name,
        kategorie: p.kategorie,
        fachrichtung: p.fachrichtung ?? null,
        strasse: p.strasse ?? null,
        hausnummer: p.hausnummer ?? null,
        plz: p.plz ?? null,
        ort: p.ort ?? null,
        stadtteil: p.stadtteil ?? null,
        lat: p.lat,
        lon: p.lon,
        telefon: p.telefon ?? null,
        website: p.website ?? null,
        email: p.email ?? null,
        oeffnungszeiten: p.oeffnungszeiten ?? null,
        barrierefrei: p.barrierefrei ?? null,
        quelle: p.quelle,
        source_url: p.source_url ?? null,
        adress_key: key,
        entfernung_m: entfernung,
        jetzt,
      };

      if (nachId.get(p.id)) {
        ergaenzen.run(werte);
        kategorieSchaerfen.run({ id: p.id, kategorie: p.kategorie, jetzt });
        besuchAnlegen.run(p.id, jetzt);
        bilanz.aktualisiert++;
        continue;
      }

      const nachbarn = nachAdresse.all(key) as PraxisZeile[];
      const treffer = nachbarn.find(
        n => kategorienVertraeglich(n.kategorie, p.kategorie) && gleichePraxis(n.name, p.name),
      );
      if (treffer) {
        ergaenzen.run({ ...werte, id: treffer.id });
        kategorieSchaerfen.run({ id: treffer.id, kategorie: p.kategorie, jetzt });
        besuchAnlegen.run(treffer.id, jetzt);
        bilanz.zusammengefuehrt++;
        continue;
      }

      einfuegen.run(werte);
      besuchAnlegen.run(p.id, jetzt);
      bilanz.neu++;
    }
  });

  lauf(eingang);
  return bilanz;
}

const SPALTEN = `
  p.id, p.name, p.kategorie, p.fachrichtung, p.strasse, p.hausnummer, p.plz, p.ort,
  p.stadtteil, p.lat, p.lon, p.telefon, p.website, p.email, p.oeffnungszeiten,
  p.barrierefrei, p.quelle, p.source_url, p.adress_key, p.entfernung_m,
  COALESCE(b.status, 'offen') AS status, b.notiz, b.ansprechpartner, b.potenzial,
  COALESCE(b.material_da, 0) AS material_da, b.wiedervorlage, b.bearbeiter, b.besucht_am
`;

export function praxenLesen(filter: {
  kategorien?: string[];
  maxEntfernungM?: number;
  status?: Status[];
} = {}): PraxisAusgang[] {
  const where: string[] = ['p.aktiv = 1'];
  const params: unknown[] = [];
  if (filter.kategorien?.length) {
    where.push(`p.kategorie IN (${filter.kategorien.map(() => '?').join(',')})`);
    params.push(...filter.kategorien);
  }
  if (typeof filter.maxEntfernungM === 'number') {
    where.push('p.entfernung_m <= ?');
    params.push(filter.maxEntfernungM);
  }
  if (filter.status?.length) {
    where.push(
      `COALESCE(b.status, 'offen') IN (${filter.status.map(() => '?').join(',')})`,
    );
    params.push(...filter.status);
  }
  return getDb()
    .prepare(
      `SELECT ${SPALTEN}
         FROM praxen p LEFT JOIN besuche b ON b.praxis_id = p.id
        WHERE ${where.join(' AND ')}
        ORDER BY p.entfernung_m ASC`,
    )
    .all(...params) as PraxisAusgang[];
}

export function praxisLesen(id: string): PraxisAusgang | null {
  const row = getDb()
    .prepare(
      `SELECT ${SPALTEN}
         FROM praxen p LEFT JOIN besuche b ON b.praxis_id = p.id
        WHERE p.id = ?`,
    )
    .get(id) as PraxisAusgang | undefined;
  return row ?? null;
}

export interface BesuchAenderung {
  status?: Status;
  notiz?: string | null;
  ansprechpartner?: string | null;
  potenzial?: number | null;
  material_da?: boolean;
  wiedervorlage?: string | null;
  bearbeiter?: string | null;
}

/**
 * Besuchsstand setzen. Gibt false zurück, wenn die Praxis nicht existiert —
 * das passiert, wenn das Handy offline gesammelte Änderungen nachreicht,
 * nachdem ein Import die Praxis entfernt hat.
 */
export function besuchSetzen(praxisId: string, aenderung: BesuchAenderung): boolean {
  const db = getDb();
  const existiert = db.prepare(`SELECT 1 FROM praxen WHERE id = ?`).get(praxisId);
  if (!existiert) return false;

  const jetzt = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO besuche (praxis_id, status, geaendert_am) VALUES (?, 'offen', ?)`,
  ).run(praxisId, jetzt);

  const setzen: string[] = ['geaendert_am = @jetzt'];
  const werte: Record<string, unknown> = { praxisId, jetzt };

  if (aenderung.status !== undefined && istStatus(aenderung.status)) {
    setzen.push('status = @status');
    werte.status = aenderung.status;
    // Zeitstempel nur beim ersten echten Besuch setzen, nicht bei jeder
    // Notizänderung danach.
    if (aenderung.status !== 'offen') {
      setzen.push('besucht_am = COALESCE(besucht_am, @jetzt)');
    } else {
      setzen.push('besucht_am = NULL');
    }
  }
  if (aenderung.notiz !== undefined) {
    setzen.push('notiz = @notiz');
    werte.notiz = aenderung.notiz;
  }
  if (aenderung.ansprechpartner !== undefined) {
    setzen.push('ansprechpartner = @ansprechpartner');
    werte.ansprechpartner = aenderung.ansprechpartner;
  }
  if (aenderung.potenzial !== undefined) {
    setzen.push('potenzial = @potenzial');
    werte.potenzial = aenderung.potenzial;
  }
  if (aenderung.material_da !== undefined) {
    setzen.push('material_da = @material_da');
    werte.material_da = aenderung.material_da ? 1 : 0;
  }
  if (aenderung.wiedervorlage !== undefined) {
    setzen.push('wiedervorlage = @wiedervorlage');
    werte.wiedervorlage = aenderung.wiedervorlage;
  }
  if (aenderung.bearbeiter !== undefined) {
    setzen.push('bearbeiter = @bearbeiter');
    werte.bearbeiter = aenderung.bearbeiter;
  }

  db.prepare(
    `UPDATE besuche SET ${setzen.join(', ')} WHERE praxis_id = @praxisId`,
  ).run(werte);

  if (aenderung.status !== undefined || aenderung.notiz !== undefined) {
    db.prepare(
      `INSERT INTO besuch_verlauf (praxis_id, status, notiz, bearbeiter, zeitpunkt)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      praxisId,
      aenderung.status ?? 'notiz',
      aenderung.notiz ?? null,
      aenderung.bearbeiter ?? null,
      jetzt,
    );
  }
  return true;
}

export function verlaufLesen(praxisId: string): Array<{
  status: string;
  notiz: string | null;
  bearbeiter: string | null;
  zeitpunkt: string;
}> {
  return getDb()
    .prepare(
      `SELECT status, notiz, bearbeiter, zeitpunkt FROM besuch_verlauf
        WHERE praxis_id = ? ORDER BY id DESC LIMIT 50`,
    )
    .all(praxisId) as Array<{
    status: string;
    notiz: string | null;
    bearbeiter: string | null;
    zeitpunkt: string;
  }>;
}

export function statistik(): {
  gesamt: number;
  nachStatus: Record<string, number>;
  nachKategorie: Record<string, number>;
  nachQuelle: Record<string, number>;
  mitTelefon: number;
} {
  const db = getDb();
  const zaehle = (sql: string) =>
    Object.fromEntries(
      (db.prepare(sql).all() as Array<{ k: string; n: number }>).map(r => [r.k, r.n]),
    );
  const gesamt = (db.prepare(`SELECT COUNT(*) AS n FROM praxen WHERE aktiv = 1`).get() as {
    n: number;
  }).n;
  const mitTelefon = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM praxen WHERE aktiv = 1 AND telefon IS NOT NULL`)
      .get() as { n: number }
  ).n;
  return {
    gesamt,
    mitTelefon,
    nachStatus: zaehle(
      `SELECT COALESCE(b.status,'offen') AS k, COUNT(*) AS n
         FROM praxen p LEFT JOIN besuche b ON b.praxis_id = p.id
        WHERE p.aktiv = 1 GROUP BY k`,
    ),
    nachKategorie: zaehle(
      `SELECT kategorie AS k, COUNT(*) AS n FROM praxen WHERE aktiv = 1 GROUP BY k`,
    ),
    nachQuelle: zaehle(
      `SELECT quelle AS k, COUNT(*) AS n FROM praxen WHERE aktiv = 1 GROUP BY k`,
    ),
  };
}
