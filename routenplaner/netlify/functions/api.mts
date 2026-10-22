// Die API als Netlify-Funktion. Dieselben Pfade wie der Server auf Railway,
// damit das Frontend nicht wissen muss, wogegen es spricht.
//
// Was hier NICHT passiert: der Import. Der dauert Minuten und läuft deshalb
// in import-background.mts — synchrone Funktionen haben 60 Sekunden.

import type { Context } from '@netlify/functions';
import { diensteAusUmgebung } from '../../shared/dienste';
import { dauerText, meterText, type Punkt } from '../../shared/geo';
import { geokodieren } from '../../shared/nominatim';
import { anfragenSchaetzung, schluesselPruefen } from '../../shared/places';
import {
  besuchAnwenden,
  entfernungenNeu,
  statistikAus,
  zusammenstellen,
  type BesuchAenderung,
  type BesuchsBuch,
} from '../../shared/praxen-logik';
import { gruppiereStopps } from '../../shared/optimize';
import { tourBauenAus, weiterAbPosition, type TourErgebnis } from '../../shared/tour-bauen';
import { istStatus, KATEGORIEN, STANDARD_KATEGORIEN, istKategorie, STATUS_WERTE } from '../../shared/typen';
import {
  aendere,
  besucheLesen,
  einstellungenLesen,
  praxenLesen,
  schreib,
  speicher,
  SCHLUESSEL,
  type Einstellungen,
} from './_speicher.mjs';

const dienste = diensteAusUmgebung(process.env);

const STANDARD_START = {
  adresse: process.env.START_ADRESSE || 'Dillenburger Weg 17, 40229 Düsseldorf',
  // Nur Rückfall, wenn nichts geokodiert wurde: Mittelpunkt von Eller,
  // nicht die Hausnummer selbst. Die Oberfläche weist darauf hin.
  lat: Number(process.env.START_LAT || 51.2033),
  lon: Number(process.env.START_LON || 6.8419),
  quelle: 'fallback' as const,
};

function betriebssitz(einst: Einstellungen) {
  if (einst.start_adresse && typeof einst.start_lat === 'number' && typeof einst.start_lon === 'number') {
    return {
      adresse: einst.start_adresse,
      lat: einst.start_lat,
      lon: einst.start_lon,
      quelle: einst.start_quelle || 'manuell',
    };
  }
  return STANDARD_START;
}

function antwort(wert: unknown, status = 200): Response {
  return new Response(JSON.stringify(wert), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function fehler(text: string, status = 400): Response {
  return antwort({ fehler: text }, status);
}

function zahl(wert: unknown, standard: number, min: number, max: number): number {
  const n = Number(wert);
  if (!Number.isFinite(n)) return standard;
  return Math.min(max, Math.max(min, n));
}

/** Passwortschutz, falls APP_PASSWORT gesetzt ist. */
function darfRein(req: Request): boolean {
  const erwartet = process.env.APP_PASSWORT || process.env.APP_PASSWORD || '';
  if (!erwartet) return true;
  const kopf = req.headers.get('x-passwort') ||
    (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  return kopf === erwartet;
}

function googleSchluessel(einst: Einstellungen): string {
  return einst.google_key || process.env.GOOGLE_PLACES_KEY || '';
}

function aenderungAus(körper: Record<string, unknown>): BesuchAenderung | { fehler: string } {
  const a: BesuchAenderung = {};
  if (körper.status !== undefined) {
    if (!istStatus(körper.status)) {
      return { fehler: `status muss einer von ${STATUS_WERTE.join(', ')} sein.` };
    }
    a.status = körper.status;
  }
  if (körper.notiz !== undefined) a.notiz = körper.notiz as string | null;
  if (körper.ansprechpartner !== undefined) a.ansprechpartner = körper.ansprechpartner as string | null;
  if (körper.potenzial !== undefined) {
    if (körper.potenzial !== null && ![1, 2, 3].includes(Number(körper.potenzial))) {
      return { fehler: 'potenzial muss 1, 2, 3 oder null sein.' };
    }
    a.potenzial = körper.potenzial === null ? null : Number(körper.potenzial);
  }
  if (körper.material_da !== undefined) a.material_da = Boolean(körper.material_da);
  if (körper.wiedervorlage !== undefined) a.wiedervorlage = körper.wiedervorlage as string | null;
  if (körper.bearbeiter !== undefined) a.bearbeiter = körper.bearbeiter as string | null;
  return a;
}

export default async (req: Request, _context: Context): Promise<Response> => {
  const url = new URL(req.url);
  // Netlify leitet /api/* hierher; der Funktionsname kann im Pfad stehen.
  const pfad = url.pathname
    .replace(/^\/\.netlify\/functions\/api/, '')
    .replace(/^\/api/, '') || '/';

  if (req.method === 'OPTIONS') return new Response(null, { status: 204 });

  const öffentlich = pfad === '/info' || pfad === '/health';
  if (!öffentlich && !darfRein(req)) {
    return fehler('Passwort fehlt oder ist falsch.', 401);
  }

  const store = speicher();
  const körper: Record<string, unknown> =
    req.method === 'POST' || req.method === 'PATCH'
      ? await req.json().catch(() => ({}))
      : {};

  try {
    // ── Allgemeines ────────────────────────────────────────────────────────
    if (pfad === '/health' || pfad === '/') {
      return antwort({ ok: true, zeit: new Date().toISOString(), laufzeit: 'netlify' });
    }

    if (pfad === '/info') {
      const einst = await einstellungenLesen(store);
      return antwort({
        kategorien: Object.entries(KATEGORIEN).map(([id, k]) => ({
          id, label: k.label, standard: k.standard, hinweis: k.hinweis,
        })),
        status_werte: STATUS_WERTE,
        standard_kategorien: STANDARD_KATEGORIEN,
        radius_km_standard: zahl(process.env.RADIUS_KM, 6, 0.5, 30),
        stopps_pro_tag_standard: zahl(process.env.STOPPS_PRO_TAG, 18, 3, 60),
        passwort_erforderlich: Boolean(process.env.APP_PASSWORT || process.env.APP_PASSWORD),
        google_verfuegbar: Boolean(googleSchluessel(einst)),
        datenbank_persistent: true,
        laufzeit: 'netlify',
      });
    }

    if (pfad === '/statistik') {
      const [praxen, besuche, einst, tour] = await Promise.all([
        praxenLesen(store),
        besucheLesen(store),
        einstellungenLesen(store),
        store.get(SCHLUESSEL.tour, { type: 'json' }) as Promise<TourGespeichert | null>,
      ]);
      return antwort({
        ...statistikAus(praxen, besuche),
        start: betriebssitz(einst),
        tour: tour
          ? {
              id: 1,
              erstellt_am: tour.erstellt_am,
              tage: tour.tage.length,
              stopps: tour.tage.reduce((n, t) => n + t.stopps.length, 0),
              strecke_m: tour.strecke_m,
              strecke_text: meterText(tour.strecke_m),
              fahrzeit_s: tour.fahrzeit_s,
              fahrzeit_text: dauerText(tour.fahrzeit_s),
              matrix_quelle: tour.matrix_quelle,
            }
          : null,
      });
    }

    // ── Startpunkt ─────────────────────────────────────────────────────────
    if (pfad === '/start') {
      if (req.method === 'GET') return antwort(betriebssitz(await einstellungenLesen(store)));
      // Nach jeder Änderung des Sitzes müssen die Entfernungen neu gerechnet
      // werden, sonst filtert der Radius gegen den alten Punkt.
      const nachSitzwechsel = async (sitz: Punkt) => {
        const bestand = await praxenLesen(store);
        if (bestand.length > 0) await schreib(store, SCHLUESSEL.praxen, entfernungenNeu(bestand, sitz));
      };
      const { adresse, lat, lon } = körper as { adresse?: string; lat?: number; lon?: number };
      if (typeof lat === 'number' && typeof lon === 'number') {
        const neu = await aendere<Einstellungen>(store, SCHLUESSEL.einstellungen, {}, alt => ({
          ...alt,
          start_adresse: adresse || 'Manuell gesetzter Startpunkt',
          start_lat: lat,
          start_lon: lon,
          start_quelle: 'manuell',
        }));
        await nachSitzwechsel({ lat, lon });
        return antwort(betriebssitz(neu));
      }
      if (!adresse) return fehler('adresse oder lat/lon angeben.');
      const treffer = await geokodieren(adresse, dienste);
      if (!treffer) return fehler(`Adresse nicht gefunden: ${adresse}`, 502);
      const neu = await aendere<Einstellungen>(store, SCHLUESSEL.einstellungen, {}, alt => ({
        ...alt,
        start_adresse: treffer.anzeigename,
        start_lat: treffer.lat,
        start_lon: treffer.lon,
        start_quelle: 'geokodiert',
      }));
      await nachSitzwechsel({ lat: treffer.lat, lon: treffer.lon });
      return antwort(betriebssitz(neu));
    }

    // ── Google-Schlüssel ───────────────────────────────────────────────────
    if (pfad === '/google-key') {
      const einst = await einstellungenLesen(store);
      if (req.method === 'GET') {
        const wert = googleSchluessel(einst);
        return antwort({
          gesetzt: Boolean(wert),
          quelle: einst.google_key ? 'eingabe' : process.env.GOOGLE_PLACES_KEY ? 'umgebung' : 'keiner',
          endet_auf: wert ? wert.slice(-4) : null,
        });
      }
      const key = körper.key as string | null | undefined;
      if (key === null || key === '') {
        const neu = await aendere<Einstellungen>(store, SCHLUESSEL.einstellungen, {}, alt => {
          const { google_key: _weg, ...rest } = alt;
          return rest;
        });
        return antwort({
          gesetzt: Boolean(process.env.GOOGLE_PLACES_KEY),
          quelle: process.env.GOOGLE_PLACES_KEY ? 'umgebung' : 'keiner',
          endet_auf: null,
          ...(neu ? {} : {}),
        });
      }
      if (typeof key !== 'string' || key.trim().length < 20) {
        return fehler('Das sieht nicht nach einem Google-API-Schlüssel aus (zu kurz).');
      }
      await aendere<Einstellungen>(store, SCHLUESSEL.einstellungen, {}, alt => ({
        ...alt,
        google_key: key.trim(),
      }));
      // Einmal anklopfen, damit ein Tippfehler sofort auffällt und nicht erst
      // mitten in einem Lauf über hunderte bezahlte Anfragen.
      const pruefung = await schluesselPruefen(betriebssitz(einst), key.trim());
      return antwort({ gesetzt: true, quelle: 'eingabe', endet_auf: key.trim().slice(-4), pruefung });
    }

    if (pfad === '/google-key/pruefen') {
      const einst = await einstellungenLesen(store);
      return antwort(await schluesselPruefen(betriebssitz(einst), googleSchluessel(einst)));
    }

    // ── Kostenschätzung ────────────────────────────────────────────────────
    if (pfad === '/import/kosten') {
      const einst = await einstellungenLesen(store);
      const radiusKm = zahl(url.searchParams.get('radiusKm'), 6, 0.5, 30);
      const zellRadiusM = zahl(url.searchParams.get('zellRadiusM'), 700, 200, 3000);
      const anfragen = anfragenSchaetzung(betriebssitz(einst), radiusKm, zellRadiusM);
      return antwort({
        radiusKm,
        zellRadiusM,
        google_anfragen: anfragen,
        google_kosten_usd_schaetzung: {
          von: Number(((anfragen * 30) / 1000).toFixed(2)),
          bis: Number(((anfragen * 35) / 1000).toFixed(2)),
          hinweis:
            'Grobe Schätzung nach Listenpreis "Nearby Search (New)" (30–35 USD / 1.000 Anfragen). ' +
            'Monatliches Freiguthaben nicht eingerechnet. Vor dem Lauf im eigenen Google-Konto prüfen.',
        },
        openstreetmap_kosten: 0,
      });
    }

    if (pfad === '/import/status') {
      return antwort(
        await store.get(SCHLUESSEL.importStand, { type: 'json' }) ?? {
          laeuft: false, phase: 'bereit', meldungen: [], gefunden: 0, neu: 0,
          aktualisiert: 0, zusammengefuehrt: 0, google_anfragen: 0, fehler: [], tour: null,
        },
      );
    }

    // ── Praxen und Besuche ─────────────────────────────────────────────────
    if (pfad === '/praxen') {
      const [praxen, besuche] = await Promise.all([praxenLesen(store), besucheLesen(store)]);
      const kategorien = (url.searchParams.get('kategorien') || '')
        .split(',').map(s => s.trim()).filter(istKategorie);
      const status = (url.searchParams.get('status') || '')
        .split(',').map(s => s.trim()).filter(istStatus);
      const radius = url.searchParams.get('radiusKm');
      const liste = zusammenstellen(praxen, besuche, {
        kategorien: kategorien.length ? kategorien : undefined,
        status: status.length ? status : undefined,
        maxEntfernungM: radius ? Math.round(zahl(radius, 6, 0.5, 30) * 1000) : undefined,
      });
      return antwort({ anzahl: liste.length, praxen: liste });
    }

    if (pfad.startsWith('/besuche/') && pfad !== '/besuche/sammel') {
      const id = decodeURIComponent(pfad.slice('/besuche/'.length));
      const praxen = await praxenLesen(store);
      if (!praxen.some(p => p.id === id)) return fehler('Praxis nicht gefunden.', 404);
      const aenderung = aenderungAus(körper);
      if ('fehler' in aenderung) return fehler(aenderung.fehler);
      const besuche = await aendere<BesuchsBuch>(store, SCHLUESSEL.besuche, {}, alt =>
        besuchAnwenden(alt, id, aenderung),
      );
      return antwort(zusammenstellen(praxen, besuche).find(p => p.id === id) ?? {});
    }

    if (pfad === '/besuche/sammel') {
      const liste = körper.aenderungen as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(liste)) return fehler('aenderungen muss eine Liste sein.');
      const praxen = await praxenLesen(store);
      const bekannt = new Set(praxen.map(p => p.id));
      const abgelehnt: Array<{ praxis_id: unknown; ok: false; fehler: string }> = [];
      // Alle Änderungen in EINEM Schreibvorgang: sonst konkurrieren die
      // Einträge eines Stapels untereinander um denselben Schlüssel.
      await aendere<BesuchsBuch>(store, SCHLUESSEL.besuche, {}, alt => {
        let buch = alt;
        for (const eintrag of liste) {
          const id = eintrag.praxis_id as string | undefined;
          if (!id) { abgelehnt.push({ praxis_id: null, ok: false, fehler: 'praxis_id fehlt' }); continue; }
          if (!bekannt.has(id)) { abgelehnt.push({ praxis_id: id, ok: false, fehler: 'Praxis nicht gefunden' }); continue; }
          const aenderung = aenderungAus(eintrag);
          if ('fehler' in aenderung) { abgelehnt.push({ praxis_id: id, ok: false, fehler: aenderung.fehler }); continue; }
          buch = besuchAnwenden(buch, id, aenderung);
        }
        return buch;
      });
      return antwort({ uebernommen: liste.length - abgelehnt.length, abgelehnt });
    }

    // ── Tour ───────────────────────────────────────────────────────────────
    if (pfad === '/tour' && req.method === 'GET') {
      const [tour, praxen, besuche] = await Promise.all([
        store.get(SCHLUESSEL.tour, { type: 'json' }) as Promise<TourGespeichert | null>,
        praxenLesen(store),
        besucheLesen(store),
      ]);
      if (!tour) return antwort({ leer: true });
      return antwort(tourMitStand(tour, praxen, besuche));
    }

    if (pfad === '/tour/bauen') {
      const einst = await einstellungenLesen(store);
      const sitz = betriebssitz(einst);
      const kategorien = ((körper.kategorien as string[]) ?? STANDARD_KATEGORIEN).filter(istKategorie);
      if (kategorien.length === 0) return fehler('Mindestens eine Kategorie auswählen.');
      const params = {
        kategorien,
        radiusKm: zahl(körper.radiusKm, 6, 0.5, 30),
        stoppsProTag: zahl(körper.stoppsProTag, 18, 3, 60),
        maxStopps: zahl(körper.maxStopps, 0, 0, 5000),
        nurOffene: körper.nurOffene === true,
      };
      const [praxen, besuche] = await Promise.all([praxenLesen(store), besucheLesen(store)]);
      const gefiltert = zusammenstellen(praxen, besuche, {
        kategorien: params.kategorien,
        maxEntfernungM: Math.round(params.radiusKm * 1000),
        status: params.nurOffene ? ['offen', 'nochmal'] : undefined,
      });
      const ergebnis = await tourBauenAus(gefiltert, sitz, params, dienste);
      const gespeichert = tourSpeicherform(ergebnis, sitz, params);
      await schreib(store, SCHLUESSEL.tour, gespeichert);
      return antwort(tourMitStand(gespeichert, praxen, besuche));
    }

    if (pfad === '/tour/weiter') {
      const { tag, lat, lon } = körper as { tag?: number; lat?: number; lon?: number };
      if (typeof lat !== 'number' || typeof lon !== 'number') {
        return fehler('lat und lon des aktuellen Standorts angeben.');
      }
      const [tour, praxen, besuche, einst] = await Promise.all([
        store.get(SCHLUESSEL.tour, { type: 'json' }) as Promise<TourGespeichert | null>,
        praxenLesen(store), besucheLesen(store), einstellungenLesen(store),
      ]);
      if (!tour) return fehler('Es ist noch keine Tour gebaut.');
      const tagNr = zahl(tag, 1, 1, 999);
      const vollstaendig = tourMitStand(tour, praxen, besuche);
      const tagDaten = vollstaendig.tage.find(t => t.tag === tagNr);
      if (!tagDaten) return fehler(`Tag ${tagNr} gibt es in dieser Tour nicht.`);

      const offen = tagDaten.stopps.filter(s =>
        s.praxen.some(p => p.status === 'offen' || p.status === 'nochmal'),
      );
      const uebersprungen = tagDaten.stopps.length - offen.length;
      if (offen.length === 0) {
        return antwort({ tag: tagNr, stopps: [], strecke_m: 0, fahrzeit_s: 0, uebersprungen, quelle: 'keine' });
      }
      const heim = betriebssitz(einst);
      const neu = await weiterAbPosition(offen, { lat, lon }, heim, dienste);

      // Erledigte vorne behalten, dahinter die neue Reihenfolge — die
      // Tagesliste bleibt vollständig und zeigt, was geschafft ist.
      const offenKeys = new Set(neu.stopps.map(s => s.adress_key));
      const erledigt = tagDaten.stopps.filter(s => !offenKeys.has(s.adress_key));
      const neueTage = tour.tage.map(t =>
        t.tag !== tagNr
          ? t
          : {
              ...t,
              strecke_m: neu.strecke_m,
              fahrzeit_s: neu.fahrzeit_s,
              geometrie: neu.geometrie,
              stopps: [...erledigt, ...neu.stopps].map((s, i) => ({
                adress_key: s.adress_key, lat: s.lat, lon: s.lon,
                position: i + 1, strecke_m: s.strecke_m, fahrzeit_s: s.fahrzeit_s,
              })),
            },
      );
      await schreib(store, SCHLUESSEL.tour, { ...tour, tage: neueTage });
      return antwort({ tag: tagNr, ...neu, uebersprungen });
    }

    // ── Export ─────────────────────────────────────────────────────────────
    if (pfad === '/export.csv') {
      const [tour, praxen, besuche] = await Promise.all([
        store.get(SCHLUESSEL.tour, { type: 'json' }) as Promise<TourGespeichert | null>,
        praxenLesen(store), besucheLesen(store),
      ]);
      const zeilen: string[][] = [[
        'Tag', 'Position', 'Name', 'Kategorie', 'Fachrichtung', 'Strasse', 'PLZ', 'Ort',
        'Telefon', 'Website', 'Status', 'Ansprechpartner', 'Potenzial', 'Notiz',
        'Besucht am', 'Bearbeiter', 'Quelle',
      ]];
      if (tour) {
        for (const tag of tourMitStand(tour, praxen, besuche).tage) {
          for (const stopp of tag.stopps) {
            for (const p of stopp.praxen) {
              zeilen.push([
                String(tag.tag), String(stopp.position), p.name, p.kategorie, p.fachrichtung ?? '',
                [p.strasse, p.hausnummer].filter(Boolean).join(' '), p.plz ?? '', p.ort ?? '',
                p.telefon ?? '', p.website ?? '', p.status, p.ansprechpartner ?? '',
                p.potenzial ? String(p.potenzial) : '', p.notiz ?? '', p.besucht_am ?? '',
                p.bearbeiter ?? '', p.quelle,
              ]);
            }
          }
        }
      }
      const csv = zeilen.map(z => z.map(f => `"${String(f).replace(/"/g, '""')}"`).join(';')).join('\r\n');
      return new Response('﻿' + csv, {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="routenplan.csv"',
        },
      });
    }

    return fehler(`Unbekannter Pfad: ${pfad}`, 404);
  } catch (err) {
    return fehler(err instanceof Error ? err.message : String(err), 500);
  }
};

// ── Tour: Speicherform und Anreicherung ──────────────────────────────────────
//
// Gespeichert werden nur Adressschlüssel und Fahrwerte. Die Praxen kommen beim
// Lesen frisch dazu — sonst zeigte die Tour den Besuchsstand von gestern.

interface TourGespeichert {
  erstellt_am: string;
  start: { adresse: string; lat: number; lon: number; quelle: string };
  params: Record<string, unknown>;
  strecke_m: number;
  fahrzeit_s: number;
  matrix_quelle: string;
  hinweise: string[];
  tage: Array<{
    tag: number;
    strecke_m: number;
    fahrzeit_s: number;
    rueckweg_m: number | null;
    rueckweg_s: number | null;
    geometrie?: string;
    stopps: Array<{
      adress_key: string; lat: number; lon: number;
      position: number; strecke_m: number | null; fahrzeit_s: number | null;
    }>;
  }>;
}

function tourSpeicherform(
  ergebnis: TourErgebnis,
  sitz: { adresse: string; lat: number; lon: number; quelle: string },
  params: Record<string, unknown>,
): TourGespeichert {
  return {
    erstellt_am: new Date().toISOString(),
    start: sitz,
    params,
    strecke_m: ergebnis.strecke_m,
    fahrzeit_s: ergebnis.fahrzeit_s,
    matrix_quelle: ergebnis.matrix_quelle,
    hinweise: ergebnis.hinweise,
    tage: ergebnis.tage.map(t => ({
      tag: t.tag,
      strecke_m: t.strecke_m,
      fahrzeit_s: t.fahrzeit_s,
      rueckweg_m: t.rueckweg_m,
      rueckweg_s: t.rueckweg_s,
      geometrie: t.geometrie,
      stopps: t.stopps.map(s => ({
        adress_key: s.adress_key, lat: s.lat, lon: s.lon,
        position: s.position, strecke_m: s.strecke_m, fahrzeit_s: s.fahrzeit_s,
      })),
    })),
  };
}

function tourMitStand(
  tour: TourGespeichert,
  praxen: Awaited<ReturnType<typeof praxenLesen>>,
  besuche: BesuchsBuch,
) {
  const alle = zusammenstellen(praxen, besuche);
  const nachKey = new Map<string, typeof alle>();
  for (const p of alle) {
    const liste = nachKey.get(p.adress_key);
    if (liste) liste.push(p);
    else nachKey.set(p.adress_key, [p]);
  }
  return {
    id: 1,
    erstellt_am: tour.erstellt_am,
    start: tour.start,
    params: tour.params,
    strecke_m: tour.strecke_m,
    fahrzeit_s: tour.fahrzeit_s,
    matrix_quelle: tour.matrix_quelle,
    hinweise: tour.hinweise ?? [],
    tage: tour.tage.map(t => ({
      ...t,
      stopps: t.stopps
        .map(s => {
          const praxenHier = nachKey.get(s.adress_key) ?? [];
          // Stopp, dessen Praxen ein Import entfernt hat: überspringen statt
          // einen leeren Halt anzuzeigen.
          if (praxenHier.length === 0) return null;
          const gruppe = gruppiereStopps(praxenHier)[0];
          return { ...gruppe, lat: s.lat, lon: s.lon, position: s.position,
                   strecke_m: s.strecke_m, fahrzeit_s: s.fahrzeit_s };
        })
        .filter((s): s is NonNullable<typeof s> => s !== null),
    })),
  };
}
