// Testlauf ohne Framework: ein kleiner Läufer, damit die Tests ohne weitere
// Abhängigkeit in Docker und in CI laufen. Aufruf: npm test
//
// Bewusst nicht getestet: die Netzaufrufe zu Overpass, Nominatim und OSRM.
// Die würden gegen fremde, gedrosselte Dienste laufen und wären damit kein
// Test, sondern eine Wettervorhersage. Getestet ist alles, was ohne Netz
// entscheidbar ist — und das ist der Teil, der die Route falsch machen könnte.

import Database from 'better-sqlite3';
import * as assert from 'assert';
import { haversineM, peilung, bbox, meterText, dauerText } from '../../shared/geo';
import { adressKey, einordnen, fachrichtungText } from '../../shared/overpass';
import { einordnenGoogle, zellen } from '../../shared/places';
import {
  gruppiereStopps,
  optimiere,
  sweepTage,
  folgeKosten,
  type Stopp,
} from '../../shared/optimize';
import { setTestDb } from '../src/db';
import {
  gleichePraxis,
  kategorienVertraeglich,
  nameSchluessel,
  praxenSpeichern,
  praxenLesen,
  besuchSetzen,
  praxisLesen,
} from '../src/praxen-repo';
import type { PraxisAusgang, PraxisEingang } from '../../shared/typen';
import {
  besuchAnwenden,
  statistikAus,
  zusammenfuehren,
  zusammenstellen,
  type BesuchsBuch,
  type PraxisSatz,
} from '../../shared/praxen-logik';
import {
  betriebssitzSetzenManuell,
  tourBauen,
  tourLesen,
  weiterAbHier,
} from '../src/routing/tour';

let bestanden = 0;
const fehlgeschlagen: string[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    bestanden++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    fehlgeschlagen.push(name);
    console.log(`  FAIL ${name}`);
    console.log(`       ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function testAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    bestanden++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    fehlgeschlagen.push(name);
    console.log(`  FAIL ${name}`);
    console.log(`       ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Geo ─────────────────────────────────────────────────────────────────────

console.log('\nGeometrie');

test('Haversine trifft eine bekannte Strecke', () => {
  // Düsseldorf Hbf → Flughafen, Luftlinie laut Kartenmessung rund 7,4 km.
  const m = haversineM({ lat: 51.2199, lon: 6.7944 }, { lat: 51.2895, lon: 6.7668 });
  assert.ok(m > 7000 && m < 8200, `erwartet 7–8 km, war ${Math.round(m)} m`);
});

test('Haversine ist 0 für denselben Punkt', () => {
  assert.strictEqual(haversineM({ lat: 51.2, lon: 6.8 }, { lat: 51.2, lon: 6.8 }), 0);
});

test('Peilung zeigt nach Norden und Osten richtig', () => {
  const nord = peilung({ lat: 51.2, lon: 6.8 }, { lat: 51.3, lon: 6.8 });
  const ost = peilung({ lat: 51.2, lon: 6.8 }, { lat: 51.2, lon: 6.9 });
  assert.ok(nord < 1 || nord > 359, `Norden sollte ~0° sein, war ${nord}`);
  assert.ok(Math.abs(ost - 90) < 1, `Osten sollte ~90° sein, war ${ost}`);
});

test('Bbox umschließt den Radius', () => {
  const [sued, west, nord, ost] = bbox({ lat: 51.2, lon: 6.8 }, 5);
  assert.ok(sued < 51.2 && nord > 51.2 && west < 6.8 && ost > 6.8);
  const hoehe = haversineM({ lat: sued, lon: 6.8 }, { lat: nord, lon: 6.8 });
  assert.ok(hoehe > 9000 && hoehe < 11000, `erwartet ~10 km Höhe, war ${Math.round(hoehe)}`);
});

test('Texte sind deutsch formatiert', () => {
  assert.strictEqual(meterText(480), '480 m');
  assert.strictEqual(meterText(2400), '2,4 km');
  assert.strictEqual(dauerText(420), '7 Min');
  assert.strictEqual(dauerText(4320), '1 Std 12 Min');
});

// ── Einordnung der OSM-Tags ─────────────────────────────────────────────────

console.log('\nEinordnung OpenStreetMap');

test('Hausarzt über die Fachrichtung', () => {
  assert.strictEqual(
    einordnen({ amenity: 'doctors', 'healthcare:speciality': 'general', name: 'Dr. Meier' }),
    'hausarzt',
  );
});

test('Hausarzt über den Namen, wenn die Fachrichtung fehlt', () => {
  assert.strictEqual(
    einordnen({ amenity: 'doctors', name: 'Hausarztpraxis am Eller Markt' }),
    'hausarzt',
  );
});

test('Arztpraxis ohne Fachrichtung landet in arzt_unklar statt im Müll', () => {
  assert.strictEqual(einordnen({ amenity: 'doctors', name: 'Praxis Schmidt' }), 'arzt_unklar');
});

test('Internist gilt als hausärztlich', () => {
  assert.strictEqual(
    einordnen({ healthcare: 'doctor', 'healthcare:speciality': 'internal', name: 'Dr. Weber' }),
    'hausarzt',
  );
});

test('Physiotherapie wird erkannt', () => {
  assert.strictEqual(
    einordnen({ healthcare: 'physiotherapist', name: 'Physio Eller' }),
    'physio',
  );
  assert.strictEqual(
    einordnen({ amenity: 'physiotherapist', name: 'Krankengymnastik Vennhausen' }),
    'physio',
  );
});

test('Dialyse und Onkologie werden als Dauerauftraggeber markiert', () => {
  assert.strictEqual(einordnen({ healthcare: 'dialysis', name: 'KfH Nierenzentrum' }), 'prio_facharzt');
  assert.strictEqual(
    einordnen({ amenity: 'clinic', name: 'Praxis für Strahlentherapie' }),
    'prio_facharzt',
  );
  assert.strictEqual(
    einordnen({ amenity: 'doctors', 'healthcare:speciality': 'oncology', name: 'Onkologie Benrath' }),
    'prio_facharzt',
  );
});

test('Zahnarzt wird als sonstiger Facharzt eingeordnet, nicht als Hausarzt', () => {
  assert.strictEqual(
    einordnen({ amenity: 'doctors', 'healthcare:speciality': 'dentist', name: 'Zahnarzt Dr. Klein' }),
    'facharzt',
  );
});

test('Ärztehaus und Pflegeheim werden unterschieden', () => {
  assert.strictEqual(einordnen({ healthcare: 'centre', name: 'MVZ Gerresheim' }), 'aerztehaus');
  assert.strictEqual(
    einordnen({ amenity: 'nursing_home', name: 'Seniorenresidenz Eller' }),
    'pflege',
  );
  assert.strictEqual(
    einordnen({ healthcare: 'centre', name: 'Seniorenzentrum St. Josef' }),
    'pflege',
  );
});

test('Irrelevante Objekte werden verworfen', () => {
  assert.strictEqual(einordnen({ shop: 'bakery', name: 'Bäckerei Schmitz' }), null);
  assert.strictEqual(einordnen({ amenity: 'pharmacy', name: 'Eller Apotheke' }), null);
});

test('Fachrichtung wird ins Deutsche übersetzt', () => {
  assert.strictEqual(
    fachrichtungText({ 'healthcare:speciality': 'general;nephrology' }),
    'Allgemeinmedizin, Nephrologie / Dialyse',
  );
  assert.strictEqual(fachrichtungText({}), undefined);
});

// ── Einordnung Google ───────────────────────────────────────────────────────

console.log('\nEinordnung Google Places');

test('Hausarzt am Namen erkannt', () => {
  assert.strictEqual(
    einordnenGoogle('Praxis für Allgemeinmedizin Dr. Özdemir', ['doctor'], 'arzt_unklar'),
    'hausarzt',
  );
});

test('Zahnarzt kommt nicht als Hausarzt durch', () => {
  assert.strictEqual(einordnenGoogle('Zahnarztpraxis Lang', ['doctor'], 'arzt_unklar'), 'facharzt');
});

test('Tierarzt wird ganz verworfen', () => {
  assert.strictEqual(einordnenGoogle('Tierarztpraxis Eller', ['doctor'], 'arzt_unklar'), null);
});

test('Unklare Praxis bleibt in der Liste', () => {
  assert.strictEqual(einordnenGoogle('Praxis Dr. Berger', ['doctor'], 'arzt_unklar'), 'arzt_unklar');
});

test('Google-Zellen decken den Kreis ohne Löcher ab', () => {
  const mitte = { lat: 51.2, lon: 6.84 };
  const liste = zellen(mitte, 3, 700);
  assert.ok(liste.length > 10, `zu wenige Zellen: ${liste.length}`);
  // Stichprobe: zufällige Punkte im Kreis müssen in mindestens einer Zelle liegen.
  for (let i = 0; i < 300; i++) {
    const winkel = (i / 300) * 2 * Math.PI;
    const r = 2900 * Math.sqrt((i % 17) / 17);
    const p = {
      lat: mitte.lat + (r * Math.cos(winkel)) / 111_320,
      lon: mitte.lon + (r * Math.sin(winkel)) / (111_320 * Math.cos((mitte.lat * Math.PI) / 180)),
    };
    const gedeckt = liste.some(z => haversineM(z, p) <= 700);
    assert.ok(gedeckt, `Punkt ${i} wird von keiner Zelle abgedeckt`);
  }
});

// ── Adressgruppierung ───────────────────────────────────────────────────────

console.log('\nAdressen und Dubletten');

test('Gleiche Adresse ergibt gleichen Schlüssel, auch mit "Str." vs "Straße"', () => {
  const a = adressKey({ strasse: 'Gumbertstraße', hausnummer: '100', plz: '40229', lat: 51.2, lon: 6.86 });
  const b = adressKey({ strasse: 'Gumbertstr.', hausnummer: '100', plz: '40229', lat: 51.2001, lon: 6.8601 });
  assert.strictEqual(a, b);
});

test('Verschiedene Hausnummern bleiben verschiedene Stopps', () => {
  const a = adressKey({ strasse: 'Gumbertstraße', hausnummer: '100', plz: '40229', lat: 51.2, lon: 6.86 });
  const b = adressKey({ strasse: 'Gumbertstraße', hausnummer: '102', plz: '40229', lat: 51.2, lon: 6.86 });
  assert.notStrictEqual(a, b);
});

test('Ohne Adresse greift die Koordinate', () => {
  const k = adressKey({ lat: 51.20123456, lon: 6.86123456 });
  assert.strictEqual(k, 'g:51.2012,6.8612');
});

test('Dieselbe Praxis in zwei Quellen wird erkannt', () => {
  assert.ok(gleichePraxis('Hausarztpraxis Dr. med. Meier', 'Praxis Dr. Meier'));
  assert.ok(gleichePraxis('MVZ Gesundheitszentrum Eller', 'Gesundheitszentrum Eller'));
});

test('Zwei Praxen im selben Haus werden nicht verschmolzen', () => {
  assert.ok(!gleichePraxis('Praxis Dr. Meier', 'Praxis Dr. Schulz'));
  assert.ok(!gleichePraxis('Zahnarzt Lang', 'Physiotherapie Bauer'));
});

test('Namensschlüssel wirft Titel und Rechtsform weg', () => {
  assert.strictEqual(nameSchluessel('Dr. med. Max Mustermann GmbH'), 'max mustermann');
});

test('OSM-Kurzname und Google-Langname derselben Praxis passen zusammen', () => {
  assert.ok(gleichePraxis('Hausarzt Meier', 'Hausarztpraxis Dr. med. Meier'));
  assert.ok(gleichePraxis('Praxis Özdemir', 'Hausarztpraxis Dr. Özdemir GbR'));
});

test('Kategorien schützen vor falschem Zusammenführen im selben Haus', () => {
  // Beide Namen schrumpfen auf "eller" – ohne Kategorieprüfung würden sie
  // zu einem Datensatz verschmelzen und ein Stopp fiele weg.
  assert.ok(gleichePraxis('Hausarztpraxis Eller', 'Physiotherapie Eller'));
  assert.ok(!kategorienVertraeglich('hausarzt', 'physio'));
  assert.ok(!kategorienVertraeglich('pflege', 'hausarzt'));
  // Unbekannte Fachrichtung darf mit jeder Arztkategorie zusammengehen.
  assert.ok(kategorienVertraeglich('arzt_unklar', 'hausarzt'));
  assert.ok(kategorienVertraeglich('arzt_unklar', 'prio_facharzt'));
});

// ── Stopps gruppieren ───────────────────────────────────────────────────────

console.log('\nStopps');

function praxis(teil: Partial<PraxisAusgang>): PraxisAusgang {
  return {
    id: teil.id || 'x',
    name: teil.name || 'Praxis',
    kategorie: teil.kategorie || 'hausarzt',
    lat: teil.lat ?? 51.2,
    lon: teil.lon ?? 6.86,
    adress_key: teil.adress_key || 'a:test-1-40229',
    entfernung_m: teil.entfernung_m ?? 100,
    status: teil.status || 'offen',
    notiz: null,
    ansprechpartner: null,
    potenzial: null,
    material_da: 0,
    wiedervorlage: null,
    bearbeiter: null,
    besucht_am: null,
    quelle: teil.quelle || 'osm',
    strasse: teil.strasse,
    hausnummer: teil.hausnummer,
    plz: teil.plz,
    ort: teil.ort,
    stadtteil: teil.stadtteil ?? null,
    ...teil,
  } as PraxisAusgang;
}

test('Drei Praxen im Ärztehaus werden ein Stopp', () => {
  const stopps = gruppiereStopps([
    praxis({ id: '1', name: 'Dr. A', adress_key: 'a:gumbert-100-40229', strasse: 'Gumbertstraße', hausnummer: '100' }),
    praxis({ id: '2', name: 'Dr. B', adress_key: 'a:gumbert-100-40229', strasse: 'Gumbertstraße', hausnummer: '100' }),
    praxis({ id: '3', name: 'Physio C', kategorie: 'physio', adress_key: 'a:gumbert-100-40229', strasse: 'Gumbertstraße', hausnummer: '100' }),
  ]);
  assert.strictEqual(stopps.length, 1);
  assert.strictEqual(stopps[0].praxen.length, 3);
  assert.ok(stopps[0].adresse.includes('Gumbertstraße 100'));
});

test('Im Stopp stehen die wichtigsten Praxen oben', () => {
  const stopps = gruppiereStopps([
    praxis({ id: '1', name: 'Physio', kategorie: 'physio' }),
    praxis({ id: '2', name: 'Dialyse', kategorie: 'prio_facharzt' }),
    praxis({ id: '3', name: 'Hausarzt', kategorie: 'hausarzt' }),
  ]);
  assert.deepStrictEqual(
    stopps[0].praxen.map(p => p.kategorie),
    ['prio_facharzt', 'hausarzt', 'physio'],
  );
});

// ── Tagesaufteilung ─────────────────────────────────────────────────────────

console.log('\nTagesaufteilung');

function stopp(lat: number, lon: number, key = `${lat},${lon}`): Stopp {
  return { adress_key: key, lat, lon, adresse: key, stadtteil: null, praxen: [] };
}

test('Weniger Stopps als Tagesmaß ergeben einen Tag', () => {
  const tage = sweepTage({ lat: 51.2, lon: 6.86 }, [stopp(51.21, 6.86), stopp(51.22, 6.87)], 18);
  assert.strictEqual(tage.length, 1);
});

test('Tage werden gleichmäßig gefüllt, kein Resttag mit zwei Stopps', () => {
  const start = { lat: 51.2, lon: 6.86 };
  const liste: Stopp[] = [];
  for (let i = 0; i < 22; i++) {
    const w = (i / 22) * 2 * Math.PI;
    liste.push(stopp(51.2 + 0.02 * Math.cos(w), 6.86 + 0.03 * Math.sin(w), `s${i}`));
  }
  const tage = sweepTage(start, liste, 18);
  assert.strictEqual(tage.length, 2);
  assert.strictEqual(tage[0].length + tage[1].length, 22);
  assert.ok(Math.abs(tage[0].length - tage[1].length) <= 1, `ungleich: ${tage.map(t => t.length)}`);
});

test('Jeder Stopp kommt genau einmal vor', () => {
  const start = { lat: 51.2, lon: 6.86 };
  const liste: Stopp[] = [];
  for (let i = 0; i < 47; i++) {
    liste.push(stopp(51.19 + (i % 7) * 0.004, 6.84 + Math.floor(i / 7) * 0.006, `s${i}`));
  }
  const tage = sweepTage(start, liste, 12);
  const keys = tage.flat().map(s => s.adress_key);
  assert.strictEqual(keys.length, 47);
  assert.strictEqual(new Set(keys).size, 47);
});

test('Ein Tag ist räumlich kompakt, nicht quer durch die Stadt', () => {
  // Zwei klar getrennte Gruppen: Nordosten und Südwesten. Ein brauchbarer
  // Schnitt legt sie auf verschiedene Tage.
  const start = { lat: 51.2, lon: 6.86 };
  const liste: Stopp[] = [];
  for (let i = 0; i < 8; i++) liste.push(stopp(51.23 + i * 0.001, 6.9 + i * 0.001, `no${i}`));
  for (let i = 0; i < 8; i++) liste.push(stopp(51.17 + i * 0.001, 6.82 + i * 0.001, `sw${i}`));
  const tage = sweepTage(start, liste, 8);
  assert.strictEqual(tage.length, 2);
  for (const tag of tage) {
    const praefixe = new Set(tag.map(s => s.adress_key.slice(0, 2)));
    assert.strictEqual(praefixe.size, 1, `Tag mischt Gruppen: ${[...praefixe]}`);
  }
});

// ── Optimierung ─────────────────────────────────────────────────────────────

console.log('\nReihenfolge');

/** Kostenmatrix aus Punkten – reicht für die Prüfung der Reihenfolge. */
function matrix(punkte: Array<{ lat: number; lon: number }>): number[][] {
  return punkte.map(a => punkte.map(b => haversineM(a, b)));
}

test('Rundtour beginnt und endet am Start', () => {
  const punkte = [
    { lat: 51.2, lon: 6.86 },
    { lat: 51.21, lon: 6.87 },
    { lat: 51.22, lon: 6.88 },
    { lat: 51.205, lon: 6.9 },
  ];
  const { folge } = optimiere(matrix(punkte), 0, 0, [1, 2, 3]);
  assert.strictEqual(folge[0], 0);
  assert.strictEqual(folge[folge.length - 1], 0);
  assert.deepStrictEqual([...folge.slice(1, -1)].sort(), [1, 2, 3]);
});

test('Jeder Stopp wird genau einmal angefahren', () => {
  const punkte = [{ lat: 51.2, lon: 6.86 }];
  for (let i = 0; i < 20; i++) {
    punkte.push({ lat: 51.19 + (i % 5) * 0.006, lon: 6.84 + Math.floor(i / 5) * 0.008 });
  }
  const mitte = punkte.slice(1).map((_, i) => i + 1);
  const { folge } = optimiere(matrix(punkte), 0, 0, mitte);
  const besucht = folge.slice(1, -1);
  assert.strictEqual(besucht.length, 20);
  assert.strictEqual(new Set(besucht).size, 20);
});

test('Die Reihenfolge ist nicht schlechter als die Eingabereihenfolge', () => {
  // Punkte auf einem Kreis, absichtlich in Zickzack-Folge übergeben.
  const punkte = [{ lat: 51.2, lon: 6.86 }];
  const kreis: Array<{ lat: number; lon: number }> = [];
  for (let i = 0; i < 12; i++) {
    const w = (i / 12) * 2 * Math.PI;
    kreis.push({ lat: 51.2 + 0.02 * Math.cos(w), lon: 6.86 + 0.03 * Math.sin(w) });
  }
  // Zickzack: 0, 6, 1, 7, 2, 8 … – der schlechteste Fall, den man bekommt.
  const reihe: Array<{ lat: number; lon: number }> = [];
  for (let i = 0; i < 6; i++) {
    reihe.push(kreis[i], kreis[i + 6]);
  }
  punkte.push(...reihe);
  const k = matrix(punkte);
  const mitte = reihe.map((_, i) => i + 1);
  const naiv = [0, ...mitte, 0];
  const { folge, kosten } = optimiere(k, 0, 0, mitte);
  const naivKosten = folgeKosten(naiv, k);
  assert.ok(
    kosten < naivKosten,
    `Optimierung hat nichts gebracht: ${Math.round(kosten)} vs ${Math.round(naivKosten)}`,
  );
  // Auf einem Kreis ist die optimale Tour der Umlauf; mit 2-opt sollte man
  // klar unter dem Zickzack landen, nicht nur ein Prozent.
  assert.ok(
    kosten < naivKosten * 0.7,
    `erwartet deutlich besser, war ${Math.round(kosten)} vs ${Math.round(naivKosten)}`,
  );
});

test('Die Rundtour kreuzt sich am Ende nicht mehr', () => {
  // Vier Punkte im Quadrat, in kreuzender Reihenfolge eingegeben.
  const punkte = [
    { lat: 51.2, lon: 6.86 }, // Start
    { lat: 51.21, lon: 6.86 },
    { lat: 51.21, lon: 6.88 },
    { lat: 51.2, lon: 6.88 },
  ];
  const k = matrix(punkte);
  const { kosten } = optimiere(k, 0, 0, [2, 1, 3]);
  const umfang = folgeKosten([0, 1, 2, 3, 0], k);
  assert.ok(
    Math.abs(kosten - umfang) < 1,
    `erwartet den Quadratumfang ${Math.round(umfang)}, war ${Math.round(kosten)}`,
  );
});

test('Weiterfahrt ab Standort endet am festen Ziel', () => {
  const punkte = [
    { lat: 51.25, lon: 6.9 }, // aktueller Standort
    { lat: 51.22, lon: 6.88 },
    { lat: 51.21, lon: 6.87 },
    { lat: 51.2, lon: 6.86 }, // Betrieb als Ziel
  ];
  const { folge } = optimiere(matrix(punkte), 0, 3, [1, 2]);
  assert.strictEqual(folge[0], 0);
  assert.strictEqual(folge[folge.length - 1], 3);
  assert.deepStrictEqual(folge, [0, 1, 2, 3]);
});

test('Ohne Zwischenstopps bleibt nur Start und Ziel', () => {
  const k = matrix([{ lat: 51.2, lon: 6.86 }, { lat: 51.21, lon: 6.87 }]);
  assert.deepStrictEqual(optimiere(k, 0, 0, []).folge, [0]);
  assert.deepStrictEqual(optimiere(k, 0, 1, []).folge, [0, 1]);
});

// ── Datenbank: Speichern, Zusammenführen, Besuche ───────────────────────────

console.log('\nDatenbank');

setTestDb(new Database(':memory:'));
const sitz = { lat: 51.2033, lon: 6.8419 };

function eingang(teil: Partial<PraxisEingang> & { id: string; name: string }): PraxisEingang {
  return {
    kategorie: 'hausarzt',
    lat: 51.21,
    lon: 6.86,
    quelle: 'osm',
    ...teil,
  } as PraxisEingang;
}

test('Praxen werden angelegt und wieder gelesen', () => {
  const bilanz = praxenSpeichern(
    [
      eingang({ id: 'osm:node/1', name: 'Hausarzt Meier', strasse: 'Gumbertstraße', hausnummer: '100', plz: '40229' }),
      eingang({ id: 'osm:node/2', name: 'Physio Bauer', kategorie: 'physio', strasse: 'Gumbertstraße', hausnummer: '100', plz: '40229' }),
    ],
    sitz,
  );
  assert.strictEqual(bilanz.neu, 2);
  const praxen = praxenLesen();
  assert.strictEqual(praxen.length, 2);
  assert.strictEqual(praxen[0].status, 'offen');
  assert.strictEqual(praxen[0].adress_key, praxen[1].adress_key, 'gleiche Adresse, gleicher Stopp');
});

test('Entfernung zum Betrieb wird mitgeschrieben', () => {
  const p = praxisLesen('osm:node/1');
  assert.ok(p && p.entfernung_m !== null && p.entfernung_m > 500,
    `Entfernung fehlt oder ist unplausibel: ${p?.entfernung_m}`);
});

test('Erneuter Import legt keine Dubletten an', () => {
  const bilanz = praxenSpeichern(
    [eingang({ id: 'osm:node/1', name: 'Hausarzt Meier', strasse: 'Gumbertstraße', hausnummer: '100', plz: '40229' })],
    sitz,
  );
  assert.strictEqual(bilanz.neu, 0);
  assert.strictEqual(bilanz.aktualisiert, 1);
  assert.strictEqual(praxenLesen().length, 2);
});

test('Google-Treffer wird mit dem OSM-Eintrag zusammengeführt und ergänzt ihn', () => {
  const bilanz = praxenSpeichern(
    [
      eingang({
        id: 'google:abc',
        name: 'Hausarztpraxis Dr. med. Meier',
        strasse: 'Gumbertstraße',
        hausnummer: '100',
        plz: '40229',
        telefon: '0211 123456',
        quelle: 'google',
      }),
    ],
    sitz,
  );
  assert.strictEqual(bilanz.zusammengefuehrt, 1);
  assert.strictEqual(bilanz.neu, 0);
  const p = praxisLesen('osm:node/1');
  assert.strictEqual(p?.telefon, '0211 123456', 'Telefonnummer von Google sollte ergänzt sein');
  assert.ok(p?.quelle.includes('google'), `Quelle sollte beide nennen, war ${p?.quelle}`);
});

test('Physio im selben Haus wird nicht in den Hausarzt hineingezogen', () => {
  const bilanz = praxenSpeichern(
    [
      eingang({
        id: 'google:physio-eller',
        name: 'Physiotherapie Meier',
        kategorie: 'physio',
        strasse: 'Gumbertstraße',
        hausnummer: '100',
        plz: '40229',
        quelle: 'google',
      }),
    ],
    sitz,
  );
  // Darf mit dem Physio-Eintrag (osm:node/2, "Physio Bauer") nicht verschmelzen
  // und schon gar nicht mit dem Hausarzt – also ein neuer Datensatz.
  assert.strictEqual(bilanz.neu, 1, 'anderer Physio im Haus ist ein eigener Eintrag');
  const hausarzt = praxisLesen('osm:node/1');
  assert.strictEqual(hausarzt?.kategorie, 'hausarzt', 'Kategorie darf nicht überschrieben werden');
});

test('Besuch abhaken speichert Status, Notiz und Zeitpunkt', () => {
  assert.ok(
    besuchSetzen('osm:node/1', {
      status: 'besucht',
      notiz: 'Flyer bei der MFA abgegeben, Chefin Dienstag da',
      ansprechpartner: 'Frau Yilmaz',
      potenzial: 3,
      material_da: true,
      bearbeiter: 'Milad',
    }),
  );
  const p = praxisLesen('osm:node/1');
  assert.strictEqual(p?.status, 'besucht');
  assert.strictEqual(p?.potenzial, 3);
  assert.strictEqual(p?.material_da, 1);
  assert.ok(p?.besucht_am, 'besucht_am sollte gesetzt sein');
});

test('Ein Import danach löscht das Häkchen nicht', () => {
  praxenSpeichern(
    [eingang({ id: 'osm:node/1', name: 'Hausarzt Meier', strasse: 'Gumbertstraße', hausnummer: '100', plz: '40229' })],
    sitz,
  );
  const p = praxisLesen('osm:node/1');
  assert.strictEqual(p?.status, 'besucht', 'Besuchsstand muss den Import überleben');
  assert.strictEqual(p?.notiz, 'Flyer bei der MFA abgegeben, Chefin Dienstag da');
});

test('Status-Filter trennt besuchte von offenen Praxen', () => {
  const offen = praxenLesen({ status: ['offen'] });
  const besucht = praxenLesen({ status: ['besucht'] });
  assert.ok(
    !offen.some(p => p.id === 'osm:node/1'),
    'die besuchte Praxis darf nicht als offen gelten',
  );
  assert.deepStrictEqual(besucht.map(p => p.id), ['osm:node/1']);
  assert.strictEqual(offen.length + besucht.length, praxenLesen().length);
});

test('Unbekannte Praxis-ID wird abgelehnt statt stillschweigend angelegt', () => {
  assert.strictEqual(besuchSetzen('osm:node/999', { status: 'besucht' }), false);
});

test('Nicht übergebene Felder bleiben unverändert', () => {
  besuchSetzen('osm:node/1', { notiz: 'Zweiter Besuch vereinbart' });
  const p = praxisLesen('osm:node/1');
  assert.strictEqual(p?.status, 'besucht', 'Status darf von einer Notiz nicht zurückgesetzt werden');
  assert.strictEqual(p?.ansprechpartner, 'Frau Yilmaz');
  assert.strictEqual(p?.potenzial, 3);
});

test('Zurück auf offen räumt den Besuchszeitpunkt weg', () => {
  besuchSetzen('osm:node/1', { status: 'offen' });
  const p = praxisLesen('osm:node/1');
  assert.strictEqual(p?.status, 'offen');
  assert.strictEqual(p?.besucht_am, null);
});

// ── Dieselben Regeln ohne Datenbank (Netlify-Variante) ──────────────────────
//
// Auf Netlify gibt es keine Datenbank, sondern JSON im Key-Value-Speicher.
// Diese Tests spiegeln die SQL-Tests oben: Wenn beide Fassungen bei
// denselben Eingaben auseinanderlaufen, zeigt das hier es sofort.

console.log('\nPraxenlogik ohne Datenbank');

const SITZ = { lat: 51.2033, lon: 6.8419 };

function eingangRein(teil: Partial<PraxisEingang> & { id: string; name: string }): PraxisEingang {
  return { kategorie: 'hausarzt', lat: 51.21, lon: 6.86, quelle: 'osm', ...teil } as PraxisEingang;
}

test('Praxen werden angelegt und bekommen Adressschlüssel und Entfernung', () => {
  const { bestand, bilanz } = zusammenfuehren(
    [],
    [
      eingangRein({ id: 'osm:node/1', name: 'Hausarzt Meier', strasse: 'Gumbertstraße', hausnummer: '100', plz: '40229' }),
      eingangRein({ id: 'osm:node/2', name: 'Physio Bauer', kategorie: 'physio', strasse: 'Gumbertstraße', hausnummer: '100', plz: '40229' }),
    ],
    SITZ,
  );
  assert.strictEqual(bilanz.neu, 2);
  assert.strictEqual(bestand.length, 2);
  assert.strictEqual(bestand[0].adress_key, bestand[1].adress_key, 'gleiche Adresse, gleicher Stopp');
  assert.ok(bestand[0].entfernung_m > 500, `Entfernung unplausibel: ${bestand[0].entfernung_m}`);
});

test('Erneuter Import legt keine Dubletten an', () => {
  const erst = zusammenfuehren([], [eingangRein({ id: 'osm:node/1', name: 'Hausarzt Meier' })], SITZ);
  const zweit = zusammenfuehren(erst.bestand, [eingangRein({ id: 'osm:node/1', name: 'Hausarzt Meier' })], SITZ);
  assert.strictEqual(zweit.bilanz.neu, 0);
  assert.strictEqual(zweit.bilanz.aktualisiert, 1);
  assert.strictEqual(zweit.bestand.length, 1);
});

test('Google ergänzt den OSM-Eintrag, statt ihn zu verdoppeln', () => {
  const erst = zusammenfuehren(
    [],
    [eingangRein({ id: 'osm:node/1', name: 'Hausarzt Meier', strasse: 'Gumbertstraße', hausnummer: '100', plz: '40229' })],
    SITZ,
  );
  const zweit = zusammenfuehren(
    erst.bestand,
    [eingangRein({
      id: 'google:abc', name: 'Hausarztpraxis Dr. med. Meier', quelle: 'google',
      strasse: 'Gumbertstraße', hausnummer: '100', plz: '40229', telefon: '0211 123456',
    })],
    SITZ,
  );
  assert.strictEqual(zweit.bilanz.zusammengefuehrt, 1);
  assert.strictEqual(zweit.bestand.length, 1);
  assert.strictEqual(zweit.bestand[0].telefon, '0211 123456');
  assert.ok(zweit.bestand[0].quelle.includes('google'), `Quelle: ${zweit.bestand[0].quelle}`);
});

test('Physio im selben Haus bleibt ein eigener Eintrag', () => {
  const erst = zusammenfuehren(
    [],
    [eingangRein({ id: 'osm:node/1', name: 'Praxis Eller', strasse: 'Gumbertstraße', hausnummer: '100', plz: '40229' })],
    SITZ,
  );
  const zweit = zusammenfuehren(
    erst.bestand,
    [eingangRein({
      id: 'google:xyz', name: 'Physiotherapie Eller', kategorie: 'physio', quelle: 'google',
      strasse: 'Gumbertstraße', hausnummer: '100', plz: '40229',
    })],
    SITZ,
  );
  assert.strictEqual(zweit.bilanz.neu, 1, 'Physio und Arzt sind zwei Stopps');
  assert.strictEqual(zweit.bestand.length, 2);
});

test('Unklare Fachrichtung wird durch eine klare ersetzt, nicht umgekehrt', () => {
  const erst = zusammenfuehren(
    [],
    [eingangRein({ id: 'osm:node/1', name: 'Praxis Meier', kategorie: 'arzt_unklar', strasse: 'A', hausnummer: '1' })],
    SITZ,
  );
  const zweit = zusammenfuehren(
    erst.bestand,
    [eingangRein({ id: 'google:a', name: 'Hausarztpraxis Meier', kategorie: 'hausarzt', quelle: 'google', strasse: 'A', hausnummer: '1' })],
    SITZ,
  );
  assert.strictEqual(zweit.bestand[0].kategorie, 'hausarzt');
  const dritt = zusammenfuehren(
    zweit.bestand,
    [eingangRein({ id: 'osm:node/9', name: 'Hausarztpraxis Meier', kategorie: 'arzt_unklar', strasse: 'A', hausnummer: '1' })],
    SITZ,
  );
  assert.strictEqual(dritt.bestand[0].kategorie, 'hausarzt', 'eine klare Kategorie darf nicht verwässert werden');
});

test('Besuch abhaken setzt Status und Zeitpunkt', () => {
  let buch: BesuchsBuch = {};
  buch = besuchAnwenden(buch, 'osm:node/1', {
    status: 'besucht', notiz: 'Flyer da', ansprechpartner: 'Frau Yilmaz',
    potenzial: 3, material_da: true, bearbeiter: 'Milad',
  });
  assert.strictEqual(buch['osm:node/1'].status, 'besucht');
  assert.strictEqual(buch['osm:node/1'].potenzial, 3);
  assert.ok(buch['osm:node/1'].besucht_am);
});

test('Eine Notiz setzt den Status nicht zurück', () => {
  let buch: BesuchsBuch = besuchAnwenden({}, 'x', { status: 'besucht', potenzial: 2, bearbeiter: 'Milad' });
  buch = besuchAnwenden(buch, 'x', { notiz: 'Nachtrag' });
  assert.strictEqual(buch['x'].status, 'besucht');
  assert.strictEqual(buch['x'].potenzial, 2);
  assert.strictEqual(buch['x'].bearbeiter, 'Milad');
  assert.strictEqual(buch['x'].notiz, 'Nachtrag');
});

test('Zurück auf offen räumt den Besuchszeitpunkt weg', () => {
  let buch = besuchAnwenden({}, 'x', { status: 'besucht' });
  buch = besuchAnwenden(buch, 'x', { status: 'offen' });
  assert.strictEqual(buch['x'].besucht_am, null);
});

test('Import überschreibt keinen Besuchsstand', () => {
  const erst = zusammenfuehren([], [eingangRein({ id: 'osm:node/1', name: 'Hausarzt Meier' })], SITZ);
  const buch = besuchAnwenden({}, 'osm:node/1', { status: 'besucht', notiz: 'war da' });
  const zweit = zusammenfuehren(erst.bestand, [eingangRein({ id: 'osm:node/1', name: 'Hausarzt Meier' })], SITZ);
  const zeilen = zusammenstellen(zweit.bestand, buch);
  assert.strictEqual(zeilen[0].status, 'besucht');
  assert.strictEqual(zeilen[0].notiz, 'war da');
});

test('Filter nach Kategorie, Entfernung und Status', () => {
  const { bestand } = zusammenfuehren(
    [],
    [
      eingangRein({ id: 'a', name: 'Hausarzt A', lat: 51.205, lon: 6.845 }),
      eingangRein({ id: 'b', name: 'Physio B', kategorie: 'physio', lat: 51.30, lon: 6.95 }),
    ],
    SITZ,
  );
  const buch = besuchAnwenden({}, 'a', { status: 'besucht' });
  assert.deepStrictEqual(zusammenstellen(bestand, buch, { kategorien: ['physio'] }).map(p => p.id), ['b']);
  assert.deepStrictEqual(zusammenstellen(bestand, buch, { status: ['offen'] }).map(p => p.id), ['b']);
  assert.deepStrictEqual(zusammenstellen(bestand, buch, { maxEntfernungM: 2000 }).map(p => p.id), ['a']);
});

test('Statistik zählt richtig', () => {
  const { bestand } = zusammenfuehren(
    [],
    [
      eingangRein({ id: 'a', name: 'A', telefon: '0211 1' }),
      eingangRein({ id: 'b', name: 'B', kategorie: 'physio' }),
    ],
    SITZ,
  );
  const s = statistikAus(bestand, besuchAnwenden({}, 'a', { status: 'besucht' }));
  assert.strictEqual(s.gesamt, 2);
  assert.strictEqual(s.mitTelefon, 1);
  assert.strictEqual(s.nachStatus.besucht, 1);
  assert.strictEqual(s.nachStatus.offen, 1);
  assert.strictEqual(s.nachKategorie.physio, 1);
});

// ── Durchlauf: aus Praxen eine fahrbare Tour machen ─────────────────────────
//
// Dieser Abschnitt läuft gegen die echte Tour-Erzeugung. OSRM ist im Testlauf
// nicht erreichbar, deshalb prüft er zugleich den Rückfall auf Luftlinie —
// genau den Pfad, der im Feld greift, wenn der Gratis-Router gerade weg ist.

async function durchlauf(): Promise<void> {
  console.log('\nDurchlauf: Tour bauen');

  setTestDb(new Database(':memory:'));
  const betrieb = betriebssitzSetzenManuell('Dillenburger Weg 1, 40229 Düsseldorf', 51.2033, 6.8419);

  // 24 Praxen rund um den Betrieb, in alle Richtungen verteilt.
  const liste: PraxisEingang[] = [];
  for (let i = 0; i < 24; i++) {
    const winkel = (i / 24) * 2 * Math.PI;
    const radius = 800 + (i % 4) * 700; // 0,8–2,9 km
    liste.push({
      id: `osm:node/${100 + i}`,
      name: `Praxis Nr ${i}`,
      kategorie: i % 5 === 0 ? 'physio' : 'hausarzt',
      lat: betrieb.lat + (radius * Math.cos(winkel)) / 111_320,
      lon:
        betrieb.lon +
        (radius * Math.sin(winkel)) / (111_320 * Math.cos((betrieb.lat * Math.PI) / 180)),
      strasse: `Teststraße ${i}`,
      hausnummer: '1',
      plz: '40229',
      quelle: 'osm',
    });
  }
  praxenSpeichern(liste, betrieb);

  await testAsync('Tour wird in Tagestouren gebaut', async () => {
    const tour = await tourBauen({
      kategorien: ['hausarzt', 'physio'],
      radiusKm: 6,
      stoppsProTag: 10,
    });
    assert.strictEqual(tour.tage.length, 3, `erwartet 3 Tage, waren ${tour.tage.length}`);
    const stoppZahl = tour.tage.reduce((n, t) => n + t.stopps.length, 0);
    assert.strictEqual(stoppZahl, 24);
    assert.ok(tour.strecke_m > 0, 'Strecke sollte größer null sein');
    assert.ok(tour.fahrzeit_s > 0, 'Fahrzeit sollte größer null sein');
  });

  await testAsync('Keine Praxis fällt raus, keine wird doppelt angefahren', async () => {
    const tour = tourLesen();
    assert.ok(tour);
    const keys = tour.tage.flatMap(t => t.stopps.map(s => s.adress_key));
    assert.strictEqual(keys.length, 24);
    assert.strictEqual(new Set(keys).size, 24);
    const ids = tour.tage.flatMap(t => t.stopps.flatMap(s => s.praxen.map(p => p.id)));
    assert.strictEqual(new Set(ids).size, 24, 'jede Praxis genau einmal in der Tour');
  });

  await testAsync('Positionen sind je Tag lückenlos von 1 an numeriert', async () => {
    const tour = tourLesen();
    assert.ok(tour);
    for (const tag of tour.tage) {
      const positionen = tag.stopps.map(s => s.position);
      assert.deepStrictEqual(
        positionen,
        positionen.map((_, i) => i + 1),
        `Tag ${tag.tag} hat Lücken: ${positionen.join(',')}`,
      );
    }
  });

  await testAsync('Die Tagesstrecke enthält den Rückweg zum Betrieb', async () => {
    const tour = tourLesen();
    assert.ok(tour);
    for (const tag of tour.tage) {
      assert.ok(
        tag.rueckweg_m !== null && tag.rueckweg_m > 0,
        `Tag ${tag.tag} hat keinen Rückweg hinterlegt`,
      );
      const etappen = tag.stopps.reduce((n, s) => n + (s.strecke_m ?? 0), 0);
      assert.ok(
        tag.strecke_m > etappen,
        `Tag ${tag.tag}: Gesamtstrecke ${tag.strecke_m} müsste über der Summe der Etappen ` +
          `${etappen} liegen, weil der Rückweg dazukommt`,
      );
      assert.ok(
        Math.abs(tag.strecke_m - (etappen + tag.rueckweg_m)) <= 2,
        `Tag ${tag.tag}: Etappen + Rückweg ergeben nicht die Gesamtstrecke`,
      );
    }
  });

  await testAsync('Ohne OSRM wird mit Luftlinie gerechnet und das steht auch dran', async () => {
    const tour = tourLesen();
    assert.ok(tour);
    assert.ok(
      tour.matrix_quelle.includes('luftlinie') || tour.matrix_quelle.includes('osrm'),
      `unerwartete Quelle: ${tour.matrix_quelle}`,
    );
  });

  await testAsync('Weiterfahrt ab Standort lässt Besuchtes liegen', async () => {
    const tour = tourLesen();
    assert.ok(tour);
    const tag1 = tour.tage[0];
    // Die ersten drei Stopps des Tages als erledigt markieren.
    const erledigt = tag1.stopps.slice(0, 3);
    for (const s of erledigt) {
      for (const p of s.praxen) besuchSetzen(p.id, { status: 'besucht', bearbeiter: 'Test' });
    }
    const weiter = await weiterAbHier(tag1.tag, { lat: 51.215, lon: 6.86 });
    assert.strictEqual(weiter.uebersprungen, 3, 'die drei besuchten müssen übersprungen sein');
    assert.strictEqual(weiter.stopps.length, tag1.stopps.length - 3);
    const offenKeys = new Set(weiter.stopps.map(s => s.adress_key));
    for (const s of erledigt) {
      assert.ok(!offenKeys.has(s.adress_key), `${s.adress_key} sollte nicht mehr anstehen`);
    }
  });

  await testAsync('Die neue Reihenfolge ist gespeichert, nicht nur zurückgegeben', async () => {
    const tour = tourLesen();
    assert.ok(tour);
    const tag1 = tour.tage[0];
    // Kein Stopp darf beim Umsortieren verloren gehen: 24 Stopps auf 3 Tage
    // sind 8 pro Tag, davon 3 erledigt und 5 noch offen.
    assert.strictEqual(tag1.stopps.length, 8, `Tag 1 hat ${tag1.stopps.length} Stopps`);
    const erledigtVorne = tag1.stopps
      .slice(0, 3)
      .every(s => s.praxen.every(p => p.status === 'besucht'));
    assert.ok(erledigtVorne, 'erledigte Stopps sollten am Anfang des Tages stehen');
    const offenHinten = tag1.stopps
      .slice(3)
      .every(s => s.praxen.every(p => p.status === 'offen'));
    assert.ok(offenHinten, 'die offenen Stopps sollten dahinter stehen');
    assert.deepStrictEqual(
      tag1.stopps.map(s => s.position),
      [1, 2, 3, 4, 5, 6, 7, 8],
      'Positionen müssen nach dem Umsortieren wieder lückenlos sein',
    );
  });

  await testAsync('Zweite Runde nimmt nur noch offene Praxen', async () => {
    const tour = await tourBauen({
      kategorien: ['hausarzt', 'physio'],
      radiusKm: 6,
      stoppsProTag: 10,
      nurOffene: true,
    });
    const stoppZahl = tour.tage.reduce((n, t) => n + t.stopps.length, 0);
    assert.strictEqual(stoppZahl, 21, `erwartet 21 offene Stopps, waren ${stoppZahl}`);
  });
}

// ── Ergebnis ────────────────────────────────────────────────────────────────

void durchlauf().then(() => {
  console.log(`\n${bestanden} Tests bestanden, ${fehlgeschlagen.length} fehlgeschlagen`);
  if (fehlgeschlagen.length > 0) {
    console.log('Fehlgeschlagen:');
    for (const name of fehlgeschlagen) console.log(`  - ${name}`);
    process.exit(1);
  }
});
