// HTTP-Schnittstelle für den Routenplaner.
//
// Das Frontend liegt auf Netlify, dieses Backend auf Railway — deshalb CORS
// und ein gemeinsames Passwort statt Sitzungen/Cookies. Für zwei Leute im
// Auto ist das die richtige Größe: kein Login-Flow, aber auch nicht offen für
// jeden, der die URL errät.

import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from './config';
import { getDb, istStatus, STATUS_WERTE, type Status } from './db';
import { dauerText, meterText } from '../../shared/geo';
import {
  besuchSetzen,
  praxenLesen,
  praxisLesen,
  statistik,
  verlaufLesen,
  type BesuchAenderung,
} from './praxen-repo';
import { importFortschritt, importStarten } from './import-job';
import { anfragenSchaetzung, schluesselPruefen } from '../../shared/places';
import {
  googleSchluessel,
  googleSchluesselInfo,
  googleSchluesselLoeschen,
  googleSchluesselSetzen,
} from './google-key';
import {
  betriebssitzLesen,
  betriebssitzSetzen,
  betriebssitzSetzenManuell,
  tourBauen,
  tourLesen,
  weiterAbHier,
  type TourBauParams,
} from './routing/tour';
import { KATEGORIEN, STANDARD_KATEGORIEN, istKategorie } from '../../shared/typen';

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL || 'info' },
  bodyLimit: 2_000_000, // Bulk-Sync vom Handy kann einige hundert Einträge haben
});

void app.register(cors, {
  origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(','),
  methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Passwort', 'Authorization'],
});

// ── Authentifizierung ───────────────────────────────────────────────────────
// Ist kein Passwort gesetzt, bleibt alles offen; das erleichtert den ersten
// Deploy. Sobald APP_PASSWORT steht, braucht jeder Schreibzugriff es.
app.addHook('onRequest', async (req, reply) => {
  if (!config.passwort) return;
  const pfad = req.url.split('?')[0];
  if (pfad === '/health' || pfad === '/api/info' || req.method === 'OPTIONS') return;
  const kopf = req.headers['x-passwort'];
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const gegeben = (Array.isArray(kopf) ? kopf[0] : kopf) || bearer;
  if (gegeben !== config.passwort) {
    await reply.code(401).send({ fehler: 'Passwort fehlt oder ist falsch.' });
  }
});

function zahl(wert: unknown, standard: number, min: number, max: number): number {
  const n = Number(wert);
  if (!Number.isFinite(n)) return standard;
  return Math.min(max, Math.max(min, n));
}

// ── Status & Info ───────────────────────────────────────────────────────────

app.get('/health', async () => ({ ok: true, zeit: new Date().toISOString() }));

app.get('/api/info', async () => ({
  kategorien: Object.entries(KATEGORIEN).map(([id, k]) => ({
    id,
    label: k.label,
    standard: k.standard,
    hinweis: k.hinweis,
  })),
  status_werte: STATUS_WERTE,
  standard_kategorien: STANDARD_KATEGORIEN,
  radius_km_standard: config.radiusKmDefault,
  stopps_pro_tag_standard: config.stoppsProTagDefault,
  passwort_erforderlich: Boolean(config.passwort),
  google_verfuegbar: googleSchluesselInfo().gesetzt,
  datenbank_persistent: config.dbPersistent,
}));

app.get('/api/statistik', async () => {
  const s = statistik();
  const tour = tourLesen();
  return {
    ...s,
    start: betriebssitzLesen(),
    tour: tour
      ? {
          id: tour.id,
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
  };
});

// ── Startpunkt ──────────────────────────────────────────────────────────────

app.get('/api/start', async () => betriebssitzLesen());

app.post<{ Body: { adresse?: string; lat?: number; lon?: number } }>(
  '/api/start',
  async (req, reply) => {
    const { adresse, lat, lon } = req.body ?? {};
    if (typeof lat === 'number' && typeof lon === 'number') {
      // Von Hand gesetzte Koordinate hat Vorrang: wer die Position auf der
      // Karte antippt, weiß besser, wo die Einfahrt ist, als der Geocoder.
      return betriebssitzSetzenManuell(adresse || 'Manuell gesetzter Startpunkt', lat, lon);
    }
    if (!adresse) {
      return reply.code(400).send({ fehler: 'adresse oder lat/lon angeben.' });
    }
    try {
      return await betriebssitzSetzen(adresse);
    } catch (err) {
      return reply
        .code(502)
        .send({ fehler: err instanceof Error ? err.message : String(err) });
    }
  },
);

// ── Import ──────────────────────────────────────────────────────────────────

app.post<{
  Body: { radiusKm?: number; mitGoogle?: boolean; zellRadiusM?: number; startAdresse?: string };
}>('/api/import', async (req, reply) => {
  const body = req.body ?? {};
  if (importFortschritt().laeuft) {
    return reply.code(409).send({ fehler: 'Es läuft schon ein Import.', stand: importFortschritt() });
  }
  return importStarten({
    radiusKm: zahl(body.radiusKm, config.radiusKmDefault, 0.5, 30),
    mitGoogle: body.mitGoogle === true,
    zellRadiusM: zahl(body.zellRadiusM, 700, 200, 3000),
    startAdresse: body.startAdresse,
  });
});

app.get('/api/import/status', async () => importFortschritt());

app.get<{ Querystring: { radiusKm?: string; zellRadiusM?: string } }>(
  '/api/import/kosten',
  async req => {
    const radiusKm = zahl(req.query.radiusKm, config.radiusKmDefault, 0.5, 30);
    const zellRadiusM = zahl(req.query.zellRadiusM, 700, 200, 3000);
    const sitz = betriebssitzLesen();
    const anfragen = anfragenSchaetzung(sitz, radiusKm, zellRadiusM);
    return {
      radiusKm,
      zellRadiusM,
      google_anfragen: anfragen,
      // Preisschild bewusst als Spanne und mit Datum im Text: Google ändert
      // die Tarife, eine fest eingebaute Zahl wäre irgendwann eine Lüge.
      google_kosten_usd_schaetzung: {
        von: Number(((anfragen * 30) / 1000).toFixed(2)),
        bis: Number(((anfragen * 35) / 1000).toFixed(2)),
        hinweis:
          'Grobe Schätzung nach Listenpreis "Nearby Search (New)" (30–35 USD / 1.000 Anfragen). Monatliches Freiguthaben nicht eingerechnet. Vor dem Lauf im eigenen Google-Konto prüfen.',
      },
      openstreetmap_kosten: 0,
    };
  },
);

// ── Google-Schlüssel ────────────────────────────────────────────────────────
//
// Der Schlüssel lässt sich in der Oberfläche hinterlegen, weil der Weg über
// die Railway-Variablen nicht immer offen ist. Er wird nie wieder
// herausgegeben — die API sagt nur, ob einer da ist und worauf er endet.

app.get('/api/google-key', async () => googleSchluesselInfo());

app.post<{ Body: { key?: string | null } }>('/api/google-key', async (req, reply) => {
  const key = req.body?.key;
  if (key === null || key === '') {
    googleSchluesselLoeschen();
    return googleSchluesselInfo();
  }
  if (typeof key !== 'string' || key.trim().length < 20) {
    return reply
      .code(400)
      .send({ fehler: 'Das sieht nicht nach einem Google-API-Schlüssel aus (zu kurz).' });
  }
  googleSchluesselSetzen(key);
  // Direkt einmal anklopfen: lieber jetzt eine klare Fehlermeldung als
  // mitten in einem Lauf über hunderte Anfragen.
  const pruefung = await schluesselPruefen(betriebssitzLesen(), googleSchluessel());
  return { ...googleSchluesselInfo(), pruefung };
});

app.post('/api/google-key/pruefen', async () =>
  schluesselPruefen(betriebssitzLesen(), googleSchluessel()),
);

// ── Generieren: Import und Tourbau in einem Durchgang ───────────────────────

app.post<{
  Body: {
    startAdresse?: string;
    radiusKm?: number;
    mitGoogle?: boolean;
    zellRadiusM?: number;
    kategorien?: string[];
    stoppsProTag?: number;
    /**
     * Probelauf: kleiner Radius, grobes Raster. Kostet bei Google ein paar
     * Cent statt zweistelliger Beträge und zeigt trotzdem, ob die ganze
     * Kette funktioniert.
     */
    testlauf?: boolean;
  };
}>('/api/generieren', async (req, reply) => {
  const body = req.body ?? {};
  if (importFortschritt().laeuft) {
    return reply
      .code(409)
      .send({ fehler: 'Es läuft schon ein Durchgang.', stand: importFortschritt() });
  }
  const testlauf = body.testlauf === true;
  const radiusKm = testlauf ? 1.5 : zahl(body.radiusKm, config.radiusKmDefault, 0.5, 30);
  const kategorien = (body.kategorien ?? STANDARD_KATEGORIEN).filter(istKategorie);
  if (kategorien.length === 0) {
    return reply.code(400).send({ fehler: 'Mindestens eine Kategorie auswählen.' });
  }
  return importStarten({
    radiusKm,
    mitGoogle: body.mitGoogle === true,
    zellRadiusM: testlauf ? 1000 : zahl(body.zellRadiusM, 700, 200, 3000),
    startAdresse: body.startAdresse,
    tour: {
      kategorien,
      radiusKm,
      stoppsProTag: zahl(body.stoppsProTag, config.stoppsProTagDefault, 3, 60),
    },
  });
});

// ── Praxen & Besuche ────────────────────────────────────────────────────────

app.get<{ Querystring: { kategorien?: string; radiusKm?: string; status?: string } }>(
  '/api/praxen',
  async req => {
    const kategorien = (req.query.kategorien || '')
      .split(',')
      .map(s => s.trim())
      .filter(istKategorie);
    const status = (req.query.status || '')
      .split(',')
      .map(s => s.trim())
      .filter(istStatus) as Status[];
    const praxen = praxenLesen({
      kategorien: kategorien.length ? kategorien : undefined,
      maxEntfernungM: req.query.radiusKm
        ? Math.round(zahl(req.query.radiusKm, config.radiusKmDefault, 0.5, 30) * 1000)
        : undefined,
      status: status.length ? status : undefined,
    });
    return { anzahl: praxen.length, praxen };
  },
);

app.get<{ Params: { id: string } }>('/api/praxen/:id', async (req, reply) => {
  const praxis = praxisLesen(decodeURIComponent(req.params.id));
  if (!praxis) return reply.code(404).send({ fehler: 'Praxis nicht gefunden.' });
  return { ...praxis, verlauf: verlaufLesen(praxis.id) };
});

interface BesuchBody {
  status?: string;
  notiz?: string | null;
  ansprechpartner?: string | null;
  potenzial?: number | null;
  material_da?: boolean;
  wiedervorlage?: string | null;
  bearbeiter?: string | null;
}

function nachAenderung(body: BesuchBody): BesuchAenderung | { fehler: string } {
  const aenderung: BesuchAenderung = {};
  if (body.status !== undefined) {
    if (!istStatus(body.status)) {
      return { fehler: `status muss einer von ${STATUS_WERTE.join(', ')} sein.` };
    }
    aenderung.status = body.status;
  }
  if (body.notiz !== undefined) aenderung.notiz = body.notiz;
  if (body.ansprechpartner !== undefined) aenderung.ansprechpartner = body.ansprechpartner;
  if (body.potenzial !== undefined) {
    if (body.potenzial !== null && ![1, 2, 3].includes(Number(body.potenzial))) {
      return { fehler: 'potenzial muss 1, 2, 3 oder null sein.' };
    }
    aenderung.potenzial = body.potenzial === null ? null : Number(body.potenzial);
  }
  if (body.material_da !== undefined) aenderung.material_da = Boolean(body.material_da);
  if (body.wiedervorlage !== undefined) aenderung.wiedervorlage = body.wiedervorlage;
  if (body.bearbeiter !== undefined) aenderung.bearbeiter = body.bearbeiter;
  return aenderung;
}

app.patch<{ Params: { id: string }; Body: BesuchBody }>(
  '/api/besuche/:id',
  async (req, reply) => {
    const aenderung = nachAenderung(req.body ?? {});
    if ('fehler' in aenderung) return reply.code(400).send(aenderung);
    const id = decodeURIComponent(req.params.id);
    if (!besuchSetzen(id, aenderung)) {
      return reply.code(404).send({ fehler: 'Praxis nicht gefunden.' });
    }
    return praxisLesen(id);
  },
);

/**
 * Sammel-Endpunkt für die Offline-Warteschlange des Handys. Jede Änderung
 * wird einzeln bewertet, damit ein einziger veralteter Eintrag nicht den
 * ganzen Stapel verwirft.
 */
app.post<{ Body: { aenderungen?: Array<BesuchBody & { praxis_id?: string }> } }>(
  '/api/besuche/sammel',
  async (req, reply) => {
    const liste = req.body?.aenderungen;
    if (!Array.isArray(liste)) {
      return reply.code(400).send({ fehler: 'aenderungen muss eine Liste sein.' });
    }
    const ergebnis = liste.map(eintrag => {
      if (!eintrag.praxis_id) return { praxis_id: null, ok: false, fehler: 'praxis_id fehlt' };
      const aenderung = nachAenderung(eintrag);
      if ('fehler' in aenderung) {
        return { praxis_id: eintrag.praxis_id, ok: false, fehler: aenderung.fehler };
      }
      const ok = besuchSetzen(eintrag.praxis_id, aenderung);
      return {
        praxis_id: eintrag.praxis_id,
        ok,
        fehler: ok ? undefined : 'Praxis nicht gefunden',
      };
    });
    return {
      uebernommen: ergebnis.filter(e => e.ok).length,
      abgelehnt: ergebnis.filter(e => !e.ok),
    };
  },
);

// ── Tour ────────────────────────────────────────────────────────────────────

app.get('/api/tour', async () => tourLesen() ?? { leer: true });

app.post<{
  Body: {
    kategorien?: string[];
    radiusKm?: number;
    stoppsProTag?: number;
    maxStopps?: number;
    nurOffene?: boolean;
  };
}>('/api/tour/bauen', async (req, reply) => {
  const body = req.body ?? {};
  const kategorien = (body.kategorien ?? STANDARD_KATEGORIEN).filter(istKategorie);
  if (kategorien.length === 0) {
    return reply.code(400).send({ fehler: 'Mindestens eine Kategorie auswählen.' });
  }
  const params: TourBauParams = {
    kategorien,
    radiusKm: zahl(body.radiusKm, config.radiusKmDefault, 0.5, 30),
    stoppsProTag: zahl(body.stoppsProTag, config.stoppsProTagDefault, 3, 60),
    maxStopps: zahl(body.maxStopps, 0, 0, 5000),
    nurOffene: body.nurOffene === true,
  };
  try {
    return await tourBauen(params);
  } catch (err) {
    return reply
      .code(400)
      .send({ fehler: err instanceof Error ? err.message : String(err) });
  }
});

app.post<{ Body: { tag?: number; lat?: number; lon?: number } }>(
  '/api/tour/weiter',
  async (req, reply) => {
    const { tag, lat, lon } = req.body ?? {};
    if (typeof lat !== 'number' || typeof lon !== 'number') {
      return reply.code(400).send({ fehler: 'lat und lon des aktuellen Standorts angeben.' });
    }
    try {
      return await weiterAbHier(zahl(tag, 1, 1, 999), { lat, lon });
    } catch (err) {
      return reply
        .code(400)
        .send({ fehler: err instanceof Error ? err.message : String(err) });
    }
  },
);

// ── Export ──────────────────────────────────────────────────────────────────

app.get('/api/export.csv', async (req, reply) => {
  const tour = tourLesen();
  const zeilen: string[][] = [
    [
      'Tag',
      'Position',
      'Name',
      'Kategorie',
      'Fachrichtung',
      'Strasse',
      'PLZ',
      'Ort',
      'Telefon',
      'Website',
      'Status',
      'Ansprechpartner',
      'Potenzial',
      'Notiz',
      'Besucht am',
      'Bearbeiter',
      'Quelle',
    ],
  ];
  if (tour) {
    for (const tag of tour.tage) {
      for (const stopp of tag.stopps) {
        for (const p of stopp.praxen) {
          zeilen.push([
            String(tag.tag),
            String(stopp.position),
            p.name,
            p.kategorie,
            p.fachrichtung ?? '',
            [p.strasse, p.hausnummer].filter(Boolean).join(' '),
            p.plz ?? '',
            p.ort ?? '',
            p.telefon ?? '',
            p.website ?? '',
            p.status,
            p.ansprechpartner ?? '',
            p.potenzial ? String(p.potenzial) : '',
            p.notiz ?? '',
            p.besucht_am ?? '',
            p.bearbeiter ?? '',
            p.quelle,
          ]);
        }
      }
    }
  }
  const csv = zeilen
    .map(z => z.map(f => `"${String(f).replace(/"/g, '""')}"`).join(';'))
    .join('\r\n');
  void reply.header('Content-Type', 'text/csv; charset=utf-8');
  void reply.header('Content-Disposition', 'attachment; filename="routenplan.csv"');
  // BOM, damit Excel die Umlaute richtig liest.
  return '﻿' + csv;
});

// ── Start ───────────────────────────────────────────────────────────────────

async function start(): Promise<void> {
  getDb(); // Migration sofort, nicht beim ersten Request
  if (!config.dbPersistent) {
    app.log.warn(
      `Datenbank liegt unter ${config.dbPath} und damit im Container. ` +
        `Ohne Railway-Volume sind Besuchsprotokolle beim nächsten Deploy weg. ` +
        `Volume anlegen oder SQLITE_DB_PATH setzen.`,
    );
  }
  if (!config.passwort) {
    app.log.warn('APP_PASSWORT ist nicht gesetzt – die API ist für jeden offen, der die URL kennt.');
  }
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`Routenplaner-Backend läuft auf ${config.host}:${config.port}`);
}

if (require.main === module) {
  void start();
}

export { app, start };
