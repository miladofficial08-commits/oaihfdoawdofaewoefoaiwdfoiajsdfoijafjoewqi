/* Praxis-Tour — Bedienoberfläche.
 *
 * Zwei Dinge bestimmen den Aufbau:
 *
 * 1. Das Ding läuft im Auto. Mobilfunk fällt in Tiefgaragen und Hinterhöfen
 *    aus. Deshalb: Tour wird lokal gespiegelt, jede Statusänderung geht
 *    zuerst in die lokale Ablage und wird dann gesendet. Was nicht durchgeht,
 *    bleibt in der Warteschlange und geht später raus. Abhaken funktioniert
 *    ohne Netz.
 *
 * 2. Es sind zwei Leute unterwegs. Deshalb ist der Server die Wahrheit, und
 *    die Oberfläche lädt nach jedem Senden neu — sonst sieht der eine nicht,
 *    was der andere schon abgehakt hat.
 */

'use strict';

const ABLAGE = {
  url: 'pt.backend-url',
  passwort: 'pt.passwort',
  name: 'pt.name',
  tour: 'pt.tour',
  warteschlange: 'pt.warteschlange',
  tag: 'pt.tag',
  erledigtAus: 'pt.erledigt-aus',
  demo: 'pt.demo',
};

const STATUS_TEXT = {
  offen: 'offen',
  besucht: 'besucht',
  nochmal: 'nochmal hin',
  kein_interesse: 'kein Interesse',
  geschlossen: 'war zu',
};

const KATEGORIE_KURZ = {
  hausarzt: 'Hausarzt',
  physio: 'Physio',
  arzt_unklar: 'Arztpraxis',
  prio_facharzt: 'Dialyse/Onko',
  aerztehaus: 'Ärztehaus',
  facharzt: 'Facharzt',
  pflege: 'Pflege',
};

/* ── Lokale Ablage: darf nie die App zum Absturz bringen ─────────────────
   localStorage wirft im privaten Modus mancher Browser beim Schreiben, und
   gibt nach "Websitedaten löschen" null zurück. Beides ist kein Fehlerfall,
   der den Nutzer interessiert — die App muss dann nur ohne Gedächtnis laufen. */

function hole(schluessel, standard = null) {
  try {
    const roh = localStorage.getItem(schluessel);
    return roh === null ? standard : JSON.parse(roh);
  } catch {
    return standard;
  }
}

function lege(schluessel, wert) {
  try {
    localStorage.setItem(schluessel, JSON.stringify(wert));
    return true;
  } catch {
    return false;
  }
}

/* Reihenfolge der Quellen: was auf dem Gerät eingetragen wurde, gewinnt über
   die Vorgabe aus config.js. So kann man die Seite fest verdrahten und auf
   einem einzelnen Handy trotzdem auf ein Testbackend umbiegen. */
const KONFIG = window.PT_KONFIG || {};

function konfigWert(schluessel, vorgabe) {
  const gespeichert = hole(schluessel, null);
  if (gespeichert !== null && gespeichert !== '') return gespeichert;
  return vorgabe || '';
}

const zustand = {
  url: konfigWert(ABLAGE.url, KONFIG.backendUrl),
  passwort: konfigWert(ABLAGE.passwort, KONFIG.passwort),
  name: konfigWert(ABLAGE.name, KONFIG.name),
  demo: hole(ABLAGE.demo, false),
  tour: hole(ABLAGE.tour, null),
  warteschlange: hole(ABLAGE.warteschlange, []),
  tag: hole(ABLAGE.tag, 1),
  erledigtAus: hole(ABLAGE.erledigtAus, false),
  info: null,
  standort: null,
  karte: null,
  kartenEbene: null,
  importLaeuft: false,
};

const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));

/* ── Netz ──────────────────────────────────────────────────────────────── */

/**
 * Wohin die Anfragen gehen.
 *
 * Leer bedeutet "gleiche Herkunft": auf Netlify liegt die API unter /api
 * neben der Seite, bedient von den Funktionen in netlify/functions. Dann
 * braucht es keine Adresse, kein CORS und keine Einrichtung — Seite
 * aufmachen reicht. Eine eingetragene Adresse zeigt dagegen auf einen
 * eigenen Server (etwa Railway) und gewinnt.
 */
function basisUrl() {
  return zustand.url ? zustand.url.replace(/\/+$/, '') : '';
}

async function api(pfad, optionen = {}) {
  // Der Demo-Modus hat kein Backend. Statt überall Sonderfälle zu verteilen,
  // werden die wenigen gebrauchten Pfade hier beantwortet.
  if (zustand.demo) return demoAntwort(pfad, optionen);
  const kopf = { ...(optionen.headers || {}) };
  if (zustand.passwort) kopf['X-Passwort'] = zustand.passwort;
  if (optionen.body) kopf['Content-Type'] = 'application/json';

  const antwort = await fetch(basisUrl() + pfad, {
    ...optionen,
    headers: kopf,
    body: optionen.body ? JSON.stringify(optionen.body) : undefined,
  });

  if (antwort.status === 401) {
    throw new Error('Passwort falsch oder fehlt.');
  }
  const typ = antwort.headers.get('content-type') || '';
  if (!typ.includes('application/json')) {
    const text = await antwort.text();
    if (!antwort.ok) throw new Error(`Server antwortete ${antwort.status}`);
    return text;
  }
  const daten = await antwort.json();
  if (!antwort.ok) throw new Error(daten.fehler || `Server antwortete ${antwort.status}`);
  return daten;
}

/* ── Demo-Modus ────────────────────────────────────────────────────────────
   Beantwortet dieselben Pfade wie das echte Backend, nur aus dem Speicher.
   Alles, was man hier abhakt, bleibt auf diesem Gerät und ist beim Beenden
   der Vorschau wieder weg. */

function demoTourHolen() {
  const gespeichert = hole(ABLAGE.tour, null);
  // Nur eine gespeicherte DEMO-Tour wiederverwenden, sonst würde eine echte
  // Tour aus einer früheren Sitzung in die Vorschau rutschen.
  if (gespeichert && gespeichert.demo) return gespeichert;
  const frisch = JSON.parse(JSON.stringify(window.PT_DEMO_TOUR || { leer: true }));
  frisch.demo = true;
  lege(ABLAGE.tour, frisch);
  return frisch;
}

function demoAntwort(pfad, optionen) {
  const weg = pfad.split('?')[0];
  const koerper = optionen.body || {};

  if (weg === '/api/tour') return demoTourHolen();

  if (weg === '/api/statistik') {
    const tour = demoTourHolen();
    const praxen = (tour.tage || []).flatMap(t => t.stopps.flatMap(s => s.praxen));
    const nachStatus = {};
    const nachKategorie = {};
    for (const p of praxen) {
      nachStatus[p.status] = (nachStatus[p.status] || 0) + 1;
      nachKategorie[p.kategorie] = (nachKategorie[p.kategorie] || 0) + 1;
    }
    return {
      gesamt: praxen.length,
      mitTelefon: praxen.filter(p => p.telefon).length,
      nachStatus,
      nachKategorie,
      nachQuelle: { beispiel: praxen.length },
      start: tour.start,
      tour: {
        id: 0,
        erstellt_am: tour.erstellt_am,
        tage: (tour.tage || []).length,
        stopps: (tour.tage || []).reduce((n, t) => n + t.stopps.length, 0),
        strecke_m: tour.strecke_m,
        strecke_text: meterText(tour.strecke_m),
        fahrzeit_s: tour.fahrzeit_s,
        fahrzeit_text: dauerText(tour.fahrzeit_s),
        matrix_quelle: tour.matrix_quelle,
      },
    };
  }

  if (weg === '/api/info') {
    return {
      kategorien: [
        { id: 'hausarzt', label: 'Hausarzt / Allgemeinmedizin', standard: true, hinweis: 'Hauptziel: verordnet Krankenfahrten am häufigsten.' },
        { id: 'physio', label: 'Physiotherapie', standard: true, hinweis: 'Zweitziel: kennt die Patienten, die regelmäßig gefahren werden.' },
        { id: 'arzt_unklar', label: 'Arztpraxis (Fachrichtung nicht hinterlegt)', standard: true, hinweis: 'Darunter stecken sehr viele Hausärzte — deshalb standardmäßig an.' },
        { id: 'aerztehaus', label: 'Ärztehaus / MVZ / Klinik', standard: true, hinweis: 'Ein Halt, mehrere Praxen.' },
        { id: 'prio_facharzt', label: 'Dialyse, Onkologie, Strahlentherapie', standard: true, hinweis: 'Die größten Dauerauftraggeber: 2–3 Fahrten pro Woche je Patient.' },
        { id: 'facharzt', label: 'Sonstige Facharztpraxis', standard: false, hinweis: 'Selten Krankenfahrten.' },
        { id: 'pflege', label: 'Pflegeheim / Pflegedienst', standard: false, hinweis: 'Starke Quelle, aber ein anderes Gespräch.' },
      ],
      status_werte: Object.keys(STATUS_TEXT),
      radius_km_standard: 6,
      stopps_pro_tag_standard: 18,
      passwort_erforderlich: false,
      google_verfuegbar: false,
      datenbank_persistent: false,
      demo: true,
    };
  }

  if (weg === '/api/google-key') return { gesetzt: false, quelle: 'keiner', endet_auf: null };
  if (weg === '/api/import/status') return { laeuft: false, phase: 'bereit', meldungen: [], gefunden: 0, neu: 0, aktualisiert: 0, zusammengefuehrt: 0, google_anfragen: 0, fehler: [], tour: null };
  if (weg === '/api/start') return demoTourHolen().start;

  // Schreibzugriffe: lokal anwenden, damit Abhaken sich echt anfühlt.
  if (weg === '/api/besuche/sammel') {
    for (const a of koerper.aenderungen || []) demoBesuchSetzen(a.praxis_id, a);
    return { uebernommen: (koerper.aenderungen || []).length, abgelehnt: [] };
  }
  if (weg.startsWith('/api/besuche/')) {
    const id = decodeURIComponent(weg.slice('/api/besuche/'.length));
    demoBesuchSetzen(id, koerper);
    return {};
  }

  if (weg === '/api/export.csv') return demoCsv();

  // Alles, was in der Vorschau nichts Sinnvolles tun kann.
  throw new Error('In der Vorschau nicht verfügbar — dafür braucht es das Backend auf Railway.');
}

function demoBesuchSetzen(praxisId, aenderung) {
  const tour = demoTourHolen();
  for (const tag of tour.tage || []) {
    for (const stopp of tag.stopps) {
      for (const praxis of stopp.praxen) {
        if (praxis.id !== praxisId) continue;
        Object.assign(praxis, aenderung);
        delete praxis.praxis_id;
        if (aenderung.status && aenderung.status !== 'offen' && !praxis.besucht_am) {
          praxis.besucht_am = new Date().toISOString();
        }
        if (aenderung.status === 'offen') praxis.besucht_am = null;
      }
    }
  }
  lege(ABLAGE.tour, tour);
}

function demoCsv() {
  const tour = demoTourHolen();
  const zeilen = [['Tag', 'Position', 'Name', 'Kategorie', 'Strasse', 'Telefon', 'Status', 'Notiz']];
  for (const tag of tour.tage || []) {
    for (const stopp of tag.stopps) {
      for (const p of stopp.praxen) {
        zeilen.push([tag.tag, stopp.position, p.name, p.kategorie,
          [p.strasse, p.hausnummer].filter(Boolean).join(' '), p.telefon || '', p.status, p.notiz || '']);
      }
    }
  }
  return '\uFEFF' + zeilen.map(z => z.map(f => `"${String(f).replace(/"/g, '""')}"`).join(';')).join('\r\n');
}

function demoStarten() {
  zustand.demo = true;
  zustand.url = '';
  lege(ABLAGE.demo, true);
  // Eine eventuell vorhandene echte Tour nicht überschreiben lassen:
  // demoTourHolen() erkennt sie am fehlenden demo-Merkmal und legt frisch an.
  $('#setup').hidden = true;
  $('#demo-banner').hidden = false;
  starten();
}

/**
 * Vorschau verlassen. Die Beispieldaten und alles, was darin abgehakt wurde,
 * fliegen weg — sonst vermischten sie sich mit den echten Praxen.
 */
function demoVerlassen() {
  zustand.demo = false;
  zustand.tour = null;
  zustand.warteschlange = [];
  lege(ABLAGE.demo, false);
  lege(ABLAGE.tour, null);
  lege(ABLAGE.warteschlange, []);
  $('#demo-banner').hidden = true;
}

/**
 * Antwortet eine API? Geprüft wird /api/info, weil der Pfad ohne Passwort
 * auskommt — sonst sähe ein gesetztes Passwort wie ein fehlendes Backend aus.
 */
let letzteApiDiagnose = '';

async function apiErreichbar() {
  const ziel = (basisUrl() || location.origin) + '/api/info';
  try {
    const antwort = await fetch(basisUrl() + '/api/info', {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    const typ = antwort.headers.get('content-type') || '';
    if (!antwort.ok) {
      letzteApiDiagnose = `${ziel} antwortete mit ${antwort.status}.`;
      return false;
    }
    // Netlify liefert bei fehlender Funktion die index.html aus. Ohne diese
    // Prüfung hielte die Seite ihre eigene HTML-Seite für eine API-Antwort.
    if (!typ.includes('application/json')) {
      letzteApiDiagnose =
        `${ziel} lieferte "${typ || 'keinen Typ'}" statt JSON — das ist die ` +
        `Seite selbst, nicht die API. Die Funktionen wurden nicht ausgeliefert.`;
      return false;
    }
    letzteApiDiagnose = '';
    return true;
  } catch (err) {
    letzteApiDiagnose = `${ziel} war nicht erreichbar (${err.name || 'Fehler'}).`;
    return false;
  }
}

/**
 * Zustand ohne Backend und ohne Vorschau. Lieber eine klare Ansage als eine
 * leere Seite, bei der man rätselt, ob etwas kaputt ist.
 */
function zeichneKeinBackend() {
  $('#tour-leer').hidden = false;
  $('#tour-kopf').hidden = true;
  $('#stopp-liste').innerHTML = '';
  $('#tour-leer').innerHTML =
    '<h2>Kein Backend verbunden</h2>' +
    '<p>Diese Seite zeigt nur echte Daten, und die kommen aus der API. ' +
    'Gerade antwortet keine.</p>' +
    (letzteApiDiagnose ? '<p class="klein">' + escape(letzteApiDiagnose) + '</p>' : '') +
    '<p class="hinweis">Häufigste Ursache auf Netlify: <strong>Base directory</strong> ' +
    'steht auf <code>routenplaner/frontend</code> statt auf <code>routenplaner</code>. ' +
    'Dann sucht Netlify die Funktionen im falschen Ordner und findet keine.</p>' +
    '<p class="klein">Läuft die API woanders, etwa auf Railway, hier die ' +
    'Adresse eintragen:</p>' +
    '<button type="button" class="knopf gross" id="knopf-kein-backend">Backend verbinden</button>';
  const knopf = $('#knopf-kein-backend');
  if (knopf) knopf.addEventListener('click', einrichtungZeigen);
  $('#kopf-zusatz').textContent = 'kein Backend verbunden';
}

/* ── Meldungen ─────────────────────────────────────────────────────────── */

let toastZeit = null;

function melde(text, schlecht = false) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.toggle('schlecht', schlecht);
  el.hidden = false;
  clearTimeout(toastZeit);
  toastZeit = setTimeout(() => { el.hidden = true; }, schlecht ? 5000 : 2600);
}

/* ── Warteschlange ─────────────────────────────────────────────────────── */

function warteschlangeAnzeigen() {
  const marke = $('#warteschlange-marke');
  const anzahl = zustand.warteschlange.length;
  marke.hidden = anzahl === 0;
  marke.textContent = anzahl === 1 ? '1 wartet' : `${anzahl} warten`;
  $('#offline-marke').hidden = navigator.onLine;
}

function inWarteschlange(praxisId, aenderung) {
  // Mehrere Änderungen an derselben Praxis werden verschmolzen: beim Senden
  // zählt der letzte Stand, nicht jeder Zwischenschritt.
  const vorhanden = zustand.warteschlange.find(e => e.praxis_id === praxisId);
  if (vorhanden) Object.assign(vorhanden, aenderung);
  else zustand.warteschlange.push({ praxis_id: praxisId, ...aenderung });
  lege(ABLAGE.warteschlange, zustand.warteschlange);
  warteschlangeAnzeigen();
}

async function warteschlangeSenden({ still = false } = {}) {
  if (zustand.warteschlange.length === 0) {
    if (!still) melde('Nichts zu senden.');
    return true;
  }
  if (!navigator.onLine) {
    if (!still) melde('Kein Netz — bleibt gespeichert.', true);
    return false;
  }
  const stapel = [...zustand.warteschlange];
  try {
    const ergebnis = await api('/api/besuche/sammel', {
      method: 'POST',
      body: { aenderungen: stapel },
    });
    // Abgelehnte Einträge nicht endlos wiederholen: sie betreffen Praxen, die
    // es nicht mehr gibt. Sie fliegen raus, werden aber gemeldet.
    zustand.warteschlange = zustand.warteschlange.filter(
      e => !stapel.some(s => s.praxis_id === e.praxis_id),
    );
    lege(ABLAGE.warteschlange, zustand.warteschlange);
    warteschlangeAnzeigen();
    const abgelehnt = (ergebnis.abgelehnt || []).length;
    if (!still) {
      melde(
        abgelehnt
          ? `${ergebnis.uebernommen} gesendet, ${abgelehnt} abgelehnt.`
          : `${ergebnis.uebernommen} gesendet.`,
        abgelehnt > 0,
      );
    }
    return true;
  } catch (err) {
    if (!still) melde(`Senden fehlgeschlagen: ${err.message}`, true);
    return false;
  }
}

/* ── Status setzen ─────────────────────────────────────────────────────── */

/**
 * Sofort lokal übernehmen, dann senden. Die Oberfläche darf nicht auf das
 * Netz warten — im Hinterhof einer Praxis dauert das sonst ewig.
 */
async function statusSetzen(praxisId, aenderung) {
  if (zustand.name && aenderung.bearbeiter === undefined) {
    aenderung.bearbeiter = zustand.name;
  }
  lokalAendern(praxisId, aenderung);
  inWarteschlange(praxisId, aenderung);
  zeichneTour();
  zeichneKarte();
  const ok = await warteschlangeSenden({ still: true });
  if (ok) await tourLaden({ still: true });
  else warteschlangeAnzeigen();
}

/** Spiegelt die Änderung in der lokal gehaltenen Tour. */
function lokalAendern(praxisId, aenderung) {
  if (!zustand.tour) return;
  for (const tag of zustand.tour.tage) {
    for (const stopp of tag.stopps) {
      for (const praxis of stopp.praxen) {
        if (praxis.id !== praxisId) continue;
        Object.assign(praxis, aenderung);
        if (aenderung.status && aenderung.status !== 'offen' && !praxis.besucht_am) {
          praxis.besucht_am = new Date().toISOString();
        }
        if (aenderung.status === 'offen') praxis.besucht_am = null;
      }
    }
  }
  lege(ABLAGE.tour, zustand.tour);
}

/* ── Laden ─────────────────────────────────────────────────────────────── */

async function tourLaden({ still = false } = {}) {
  try {
    const tour = await api('/api/tour');
    if (tour && !tour.leer) {
      zustand.tour = tour;
      lege(ABLAGE.tour, tour);
    } else {
      zustand.tour = null;
    }
  } catch (err) {
    if (!still) melde(`Tour nicht geladen: ${err.message}`, true);
    // Offline bleibt die gespiegelte Tour stehen — genau dafür ist sie da.
  }
  zeichneTour();
  zeichneKarte();
}

async function infoLaden() {
  try {
    zustand.info = await api('/api/info');
    zeichneKategorien();
  } catch {
    /* Kategorienliste ist Komfort, kein Muss. */
  }
}

async function statistikLaden() {
  try {
    const s = await api('/api/statistik');
    const nach = s.nachStatus || {};
    $('#statistik').innerHTML = [
      kennzahl(s.gesamt, 'Praxen gesamt'),
      kennzahl(nach.offen || 0, 'offen'),
      kennzahl(nach.besucht || 0, 'besucht'),
      kennzahl(nach.nochmal || 0, 'nochmal hin'),
      kennzahl(nach.kein_interesse || 0, 'kein Interesse'),
      kennzahl(s.mitTelefon || 0, 'mit Telefon'),
    ].join('');
    if (s.start) {
      $('#start-anzeige').textContent =
        `${s.start.adresse} (${s.start.lat.toFixed(5)}, ${s.start.lon.toFixed(5)}) — ` +
        (s.start.quelle === 'fallback'
          ? 'noch nicht bestätigt, Mittelpunkt Eller'
          : `Quelle: ${s.start.quelle}`);
      if (!$('#start-adresse').value) $('#start-adresse').value = s.start.adresse;
      if (!$('#gen-adresse').value) {
        // Bei noch unbestätigtem Startpunkt die Vorgabe aus der Konfiguration
        // stehen lassen, statt den Eller-Mittelpunkt als Adresse auszugeben.
        $('#gen-adresse').value = s.start.quelle === 'fallback' ? '' : s.start.adresse;
      }
    }
    const zusatz = s.tour
      ? `${s.tour.tage} Tage · ${s.tour.stopps} Stopps · ${s.tour.strecke_text}`
      : `${s.gesamt} Praxen geladen`;
    $('#kopf-zusatz').textContent = zusatz;
    if (s.tour && s.tour.matrix_quelle && s.tour.matrix_quelle.includes('luftlinie')) {
      $('#kopf-zusatz').textContent = zusatz + ' · Luftlinie';
    }
  } catch {
    /* Beim ersten Start ohne Verbindung einfach leer lassen. */
  }
}

function kennzahl(wert, bezeichnung) {
  return `<div class="kennzahl"><b>${wert}</b><span>${escape(bezeichnung)}</span></div>`;
}

/* ── Darstellung: Tour ─────────────────────────────────────────────────── */

function escape(text) {
  return String(text ?? '').replace(/[&<>"']/g, z =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[z]),
  );
}

function meterText(m) {
  if (m === null || m === undefined || !isFinite(m)) return '–';
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1).replace('.', ',')} km`;
}

function dauerText(s) {
  if (s === null || s === undefined || !isFinite(s)) return '–';
  const min = Math.round(s / 60);
  return min < 60 ? `${min} Min` : `${Math.floor(min / 60)} Std ${min % 60} Min`;
}

/** Ein Stopp ist erledigt, wenn dort nichts mehr aussteht. */
function stoppErledigt(stopp) {
  return stopp.praxen.every(p => p.status !== 'offen' && p.status !== 'nochmal');
}

function aktuellerTag() {
  if (!zustand.tour) return null;
  return zustand.tour.tage.find(t => t.tag === zustand.tag) || zustand.tour.tage[0] || null;
}

function zeichneTour() {
  const leer = !zustand.tour || zustand.tour.tage.length === 0;
  $('#tour-leer').hidden = !leer;
  $('#tour-kopf').hidden = leer;
  $('#stopp-liste').innerHTML = '';
  if (leer) return;

  // Tagwähler
  $('#tag-waehler').innerHTML = zustand.tour.tage
    .map(t => {
      const offen = t.stopps.filter(s => !stoppErledigt(s)).length;
      return `<button type="button" class="tag-knopf ${t.tag === zustand.tag ? 'aktiv' : ''}" data-tag="${t.tag}">
          Tag ${t.tag}<small>${offen} von ${t.stopps.length} offen</small>
        </button>`;
    })
    .join('');

  const tag = aktuellerTag();
  if (!tag) return;
  zustand.tag = tag.tag;

  const praxen = tag.stopps.flatMap(s => s.praxen);
  $('#tag-kennzahlen').innerHTML = [
    kennzahl(tag.stopps.length, 'Stopps'),
    kennzahl(praxen.length, 'Praxen'),
    kennzahl(meterText(tag.strecke_m), 'Fahrstrecke'),
    kennzahl(dauerText(tag.fahrzeit_s), 'reine Fahrzeit'),
  ].join('');

  const sichtbar = zustand.erledigtAus
    ? tag.stopps.filter(s => !stoppErledigt(s))
    : tag.stopps;

  // Der nächste offene Stopp wird hervorgehoben — im Auto die einzige Frage,
  // die zählt: wo müssen wir als Nächstes hin?
  const naechster = tag.stopps.find(s => !stoppErledigt(s));

  // Der Rückweg zum Betrieb steht als letzte Zeile mit drin. Ohne ihn sieht
  // die Liste aus, als wäre man nach dem letzten Stopp fertig — der Ring
  // schließt sich aber erst zu Hause, und die Strecke zählt mit.
  const rueckweg =
    tag.rueckweg_m !== null && tag.rueckweg_m !== undefined && zustand.tour.start
      ? `<li class="stopp">
          <span class="stopp-nummer">⌂</span>
          <div class="stopp-haupt">
            <div class="stopp-adresse">Zurück zum Betrieb</div>
            <div class="stopp-weg">
              ${meterText(tag.rueckweg_m)} · ${dauerText(tag.rueckweg_s)} ab letztem Stopp<br>
              ${escape(zustand.tour.start.adresse)}
            </div>
            <div class="stopp-aktionen">
              <button type="button" class="knopf leise"
                data-navi="${zustand.tour.start.lat},${zustand.tour.start.lon}">Navigation</button>
            </div>
          </div>
        </li>`
      : '';

  $('#stopp-liste').innerHTML =
    sichtbar.map(stopp => zeichneStopp(stopp, stopp === naechster)).join('') + rueckweg;
}

function zeichneStopp(stopp, istNaechster) {
  const erledigt = stoppErledigt(stopp);
  // Der Rand zeigt den Status der wichtigsten noch offenen Praxis, sonst der
  // ersten – damit man von außen sieht, was an dieser Tür los ist.
  const leitStatus = (stopp.praxen.find(p => p.status === 'offen' || p.status === 'nochmal')
    || stopp.praxen[0]).status;

  const entfernung = zustand.standort
    ? ` · ${meterText(luftlinie(zustand.standort, stopp))} Luftlinie von dir`
    : '';

  const praxen = stopp.praxen
    .map(
      p => `<li class="praxis">
        <i class="punkt ${escape(p.status)}" title="${escape(STATUS_TEXT[p.status] || p.status)}"></i>
        <span class="stopp-haupt">
          <span class="praxis-name">${escape(p.name)}</span>
          <span class="praxis-fach">${escape(KATEGORIE_KURZ[p.kategorie] || p.kategorie)}${
            p.fachrichtung ? ' · ' + escape(p.fachrichtung) : ''
          }${p.telefon ? ' · ' + escape(p.telefon) : ''}</span>
        </span>
        <button type="button" class="knopf leise" data-detail="${escape(p.id)}">öffnen</button>
      </li>`,
    )
    .join('');

  return `<li class="stopp status-${escape(leitStatus)} ${erledigt ? 'erledigt' : ''} ${
    istNaechster ? 'naechster' : ''
  }">
    <span class="stopp-nummer">${stopp.position}</span>
    <div class="stopp-haupt">
      <div class="stopp-adresse">${escape(stopp.adresse)}</div>
      <div class="stopp-weg">
        ${meterText(stopp.strecke_m)} · ${dauerText(stopp.fahrzeit_s)} ab vorherigem Stopp${entfernung}
      </div>
      <ul class="praxis-liste">${praxen}</ul>
      <div class="stopp-aktionen">
        <button type="button" class="knopf" data-navi="${stopp.lat},${stopp.lon}">Navigation</button>
        <button type="button" class="knopf leise" data-stopp-besucht="${escape(stopp.adress_key)}">
          Stopp komplett erledigt
        </button>
      </div>
    </div>
  </li>`;
}

function zeichneKategorien() {
  if (!zustand.info) return;
  const feld = $('#kategorie-liste');
  feld.innerHTML =
    '<legend>Wen besuchen wir?</legend>' +
    zustand.info.kategorien
      .map(
        k => `<label class="schalter">
          <input type="checkbox" value="${escape(k.id)}" ${k.standard ? 'checked' : ''}>
          <span>${escape(k.label)}<br><span class="klein">${escape(k.hinweis)}</span></span>
        </label>`,
      )
      .join('');
}

/* ── Geo ───────────────────────────────────────────────────────────────── */

function luftlinie(a, b) {
  const R = 6371008.8;
  const g = Math.PI / 180;
  const dLat = (b.lat - a.lat) * g;
  const dLon = (b.lon - a.lon) * g;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * g) * Math.cos(b.lat * g) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function standortHolen() {
  return new Promise((erfuellen, ablehnen) => {
    if (!navigator.geolocation) {
      ablehnen(new Error('Dieses Gerät gibt keinen Standort her.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      pos => erfuellen({ lat: pos.coords.latitude, lon: pos.coords.longitude, genauigkeit: pos.coords.accuracy }),
      fehler => {
        const texte = {
          1: 'Standortfreigabe verweigert. In den Browsereinstellungen erlauben.',
          2: 'Standort nicht ermittelbar (kein GPS-Empfang?).',
          3: 'Standortabfrage hat zu lange gedauert.',
        };
        ablehnen(new Error(texte[fehler.code] || fehler.message));
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 20000 },
    );
  });
}

/* ── Karte ─────────────────────────────────────────────────────────────── */

/** Encoded Polyline (Google-Algorithmus, Präzision 5) → Koordinatenliste. */
function polylineEntschluesseln(text) {
  const punkte = [];
  let index = 0, lat = 0, lon = 0;
  while (index < text.length) {
    let ergebnis = 0, verschiebung = 0, byte;
    do {
      byte = text.charCodeAt(index++) - 63;
      ergebnis |= (byte & 0x1f) << verschiebung;
      verschiebung += 5;
    } while (byte >= 0x20);
    lat += ergebnis & 1 ? ~(ergebnis >> 1) : ergebnis >> 1;
    ergebnis = 0;
    verschiebung = 0;
    do {
      byte = text.charCodeAt(index++) - 63;
      ergebnis |= (byte & 0x1f) << verschiebung;
      verschiebung += 5;
    } while (byte >= 0x20);
    lon += ergebnis & 1 ? ~(ergebnis >> 1) : ergebnis >> 1;
    punkte.push([lat / 1e5, lon / 1e5]);
  }
  return punkte;
}

function kartenSymbol(klasse, beschriftung) {
  return L.divIcon({
    className: '',
    html: `<div class="karten-nummer ${klasse}">${beschriftung}</div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });
}

/**
 * Steht Leaflet bereit? Das Skript kommt von einem CDN, und genau dann, wenn
 * man es braucht — unterwegs, bei schlechtem Netz — kann es fehlen. Ohne
 * diese Abfrage reißt ein fehlendes "L" die ganze Oberfläche mit, und dann
 * ist auch die Stoppliste weg. Die Liste ist aber das Wichtigere.
 */
function leafletDa() {
  return typeof L !== 'undefined' && leafletStilDa();
}

/**
 * Ist auch Leaflets Stylesheet angekommen?
 *
 * Das Skript und das Stylesheet kommen getrennt vom CDN, und manche
 * Umgebungen lassen nur eines davon durch (strenge Content-Security-Policy,
 * Werbeblocker, abgebrochener Download). Ohne die Stile stapelt Leaflet die
 * Kacheln übereinander statt sie zu kacheln — das sieht aus wie ein Fehler
 * im Programm, ist aber nur eine fehlende Datei. Lieber ehrlich sagen, was
 * los ist, als eine zerfallene Karte zeigen.
 *
 * Geprüft wird an einer Regel, die nur aus Leaflets Stylesheet kommt:
 * .leaflet-pane ist dort absolut positioniert.
 */
let stilGeprueft = null;

function leafletStilDa() {
  if (stilGeprueft !== null) return stilGeprueft;
  try {
    const probe = document.createElement('div');
    probe.className = 'leaflet-pane';
    probe.style.cssText = 'visibility:hidden;pointer-events:none';
    document.body.appendChild(probe);
    stilGeprueft = getComputedStyle(probe).position === 'absolute';
    probe.remove();
  } catch {
    stilGeprueft = false;
  }
  return stilGeprueft;
}

function zeichneKarte() {
  const tag = aktuellerTag();
  if (!leafletDa() || !zustand.karte || !tag) return;

  if (zustand.kartenEbene) zustand.karte.removeLayer(zustand.kartenEbene);
  const ebene = L.layerGroup().addTo(zustand.karte);
  zustand.kartenEbene = ebene;

  const start = zustand.tour.start;
  const grenzen = [];

  if (start) {
    L.marker([start.lat, start.lon], { icon: kartenSymbol('start', '⌂') })
      .bindPopup(`<strong>Betrieb</strong><br>${escape(start.adresse)}`)
      .addTo(ebene);
    grenzen.push([start.lat, start.lon]);
  }

  if (tag.geometrie) {
    L.polyline(polylineEntschluesseln(tag.geometrie), {
      color: '#2563eb',
      weight: 4,
      opacity: 0.75,
    }).addTo(ebene);
  } else {
    // Ohne OSRM-Geometrie wenigstens die Verbindungslinien zeigen, damit die
    // Reihenfolge erkennbar bleibt. Gestrichelt, weil es keine Straße ist.
    const folge = [
      ...(start ? [[start.lat, start.lon]] : []),
      ...tag.stopps.map(s => [s.lat, s.lon]),
      ...(start ? [[start.lat, start.lon]] : []),
    ];
    L.polyline(folge, { color: '#2563eb', weight: 3, opacity: 0.5, dashArray: '6 6' }).addTo(ebene);
  }

  for (const stopp of tag.stopps) {
    const leit = (stopp.praxen.find(p => p.status === 'offen' || p.status === 'nochmal')
      || stopp.praxen[0]).status;
    const liste = stopp.praxen
      .map(p => `${escape(p.name)} <span style="opacity:.7">(${escape(STATUS_TEXT[p.status])})</span>`)
      .join('<br>');
    L.marker([stopp.lat, stopp.lon], { icon: kartenSymbol(leit, stopp.position) })
      .bindPopup(
        `<strong>${stopp.position}. ${escape(stopp.adresse)}</strong><br>${liste}` +
          `<br><a href="${naviLink(stopp.lat, stopp.lon)}" target="_blank" rel="noopener">Navigation starten</a>`,
      )
      .addTo(ebene);
    grenzen.push([stopp.lat, stopp.lon]);
  }

  if (zustand.standort) {
    L.circleMarker([zustand.standort.lat, zustand.standort.lon], {
      radius: 8,
      color: '#fff',
      weight: 2,
      fillColor: '#ef4444',
      fillOpacity: 1,
    })
      .bindPopup('Dein Standort')
      .addTo(ebene);
    grenzen.push([zustand.standort.lat, zustand.standort.lon]);
  }

  if (grenzen.length > 1) {
    zustand.karte.fitBounds(L.latLngBounds(grenzen), { padding: [30, 30] });
  }
}

function karteVorbereiten() {
  if (!leafletDa()) {
    $('#karte').innerHTML =
      '<div style="padding:20px">' +
      '<p><strong>Die Karte lässt sich hier nicht laden.</strong></p>' +
      '<p>Die Kartenbibliothek kommt von einem fremden Server, und der ist in ' +
      'dieser Umgebung gesperrt — oder es ist gerade kein Netz da.</p>' +
      '<p>Alles Übrige funktioniert: die Tagesliste unter <strong>Tour</strong>, ' +
      'das Abhaken, die Notizen und die Navigationsknöpfe.</p>' +
      '</div>';
    return;
  }
  if (zustand.karte) {
    zustand.karte.invalidateSize();
    return;
  }
  zustand.karte = L.map('karte', { zoomControl: true }).setView([51.2033, 6.8419], 13);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap-Mitwirkende',
  }).addTo(zustand.karte);
  zeichneKarte();
}

/* ── Navigation ────────────────────────────────────────────────────────── */

function naviLink(lat, lon) {
  // google.com/maps/dir/ funktioniert auf Android, iOS und am Rechner und
  // öffnet, wo vorhanden, die installierte Maps-App.
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}&travelmode=driving`;
}

function tagInMaps() {
  const tag = aktuellerTag();
  if (!tag || !zustand.tour.start) return;
  const start = zustand.tour.start;
  const offen = tag.stopps.filter(s => !stoppErledigt(s));
  if (offen.length === 0) {
    melde('Für heute ist alles abgehakt.');
    return;
  }
  // Google Maps nimmt im dir-Link begrenzt viele Zwischenziele. Mehr als
  // neun werden stillschweigend verschluckt — deshalb hier abschneiden und
  // es auch sagen, statt den Rest heimlich zu verlieren.
  const grenze = 9;
  const genommen = offen.slice(0, grenze);
  const ziel = genommen[genommen.length - 1];
  const zwischen = genommen.slice(0, -1).map(s => `${s.lat},${s.lon}`).join('|');
  const url =
    `https://www.google.com/maps/dir/?api=1&origin=${start.lat},${start.lon}` +
    `&destination=${ziel.lat},${ziel.lon}&travelmode=driving` +
    (zwischen ? `&waypoints=${encodeURIComponent(zwischen)}` : '');
  if (offen.length > grenze) {
    melde(`Google Maps nimmt nur ${grenze} Stopps auf einmal — Rest danach erneut öffnen.`);
  }
  window.open(url, '_blank', 'noopener');
}

/* ── Detailansicht ─────────────────────────────────────────────────────── */

function praxisFinden(id) {
  if (!zustand.tour) return null;
  for (const tag of zustand.tour.tage) {
    for (const stopp of tag.stopps) {
      const treffer = stopp.praxen.find(p => p.id === id);
      if (treffer) return { praxis: treffer, stopp };
    }
  }
  return null;
}

function detailOeffnen(id) {
  const gefunden = praxisFinden(id);
  if (!gefunden) return;
  const { praxis, stopp } = gefunden;

  const statusKnoepfe = Object.entries(STATUS_TEXT)
    .map(
      ([wert, text]) =>
        `<button type="button" class="knopf ${praxis.status === wert ? '' : 'leise'}"
           aria-pressed="${praxis.status === wert}" data-status="${wert}">${escape(text)}</button>`,
    )
    .join('');

  $('#detail-inhalt').innerHTML = `
    <div class="detail-kopf">
      <h2>${escape(praxis.name)}</h2>
      <p class="klein">
        ${escape(KATEGORIE_KURZ[praxis.kategorie] || praxis.kategorie)}${
          praxis.fachrichtung ? ' · ' + escape(praxis.fachrichtung) : ''
        }<br>${escape(stopp.adresse)}
        ${praxis.oeffnungszeiten ? '<br>Öffnungszeiten (laut Karte): ' + escape(praxis.oeffnungszeiten) : ''}
      </p>
    </div>

    <div class="knopf-reihe">
      ${praxis.telefon ? `<a class="knopf" href="tel:${escape(praxis.telefon.replace(/\s/g, ''))}">${escape(praxis.telefon)}</a>` : ''}
      <a class="knopf leise" href="${naviLink(stopp.lat, stopp.lon)}" target="_blank" rel="noopener">Navigation</a>
      ${praxis.website ? `<a class="knopf leise" href="${escape(praxis.website)}" target="_blank" rel="noopener">Website</a>` : ''}
    </div>

    <h3>Status</h3>
    <div class="status-wahl">${statusKnoepfe}</div>

    <label>Ansprechpartner
      <input type="text" id="detail-partner" value="${escape(praxis.ansprechpartner || '')}"
             placeholder="z. B. Frau Yilmaz, MFA">
    </label>

    <label>Potenzial
      <select id="detail-potenzial">
        <option value="">– nicht bewertet –</option>
        <option value="3" ${praxis.potenzial === 3 ? 'selected' : ''}>hoch – fahren viele Patienten</option>
        <option value="2" ${praxis.potenzial === 2 ? 'selected' : ''}>mittel</option>
        <option value="1" ${praxis.potenzial === 1 ? 'selected' : ''}>gering</option>
      </select>
    </label>

    <label class="schalter">
      <input type="checkbox" id="detail-material" ${praxis.material_da ? 'checked' : ''}>
      <span>Flyer / Visitenkarte dagelassen</span>
    </label>

    <label>Wiedervorlage
      <input type="date" id="detail-wiedervorlage" value="${escape((praxis.wiedervorlage || '').slice(0, 10))}">
    </label>

    <label>Notiz
      <textarea id="detail-notiz" placeholder="Was wurde besprochen? Wer entscheidet? Wann wiederkommen?">${escape(praxis.notiz || '')}</textarea>
    </label>

    <button type="button" class="knopf gross" id="detail-speichern">Speichern</button>
    <p class="klein">
      ${praxis.besucht_am ? 'Zuletzt: ' + new Date(praxis.besucht_am).toLocaleString('de-DE') : 'Noch nicht besucht'}
      ${praxis.bearbeiter ? ' · ' + escape(praxis.bearbeiter) : ''}
      <br>Quelle: ${escape(praxis.quelle)}
    </p>
  `;

  $('#detail').hidden = false;

  $$('#detail-inhalt [data-status]').forEach(knopf => {
    knopf.addEventListener('click', () => {
      $$('#detail-inhalt [data-status]').forEach(k => {
        k.setAttribute('aria-pressed', 'false');
        k.classList.add('leise');
      });
      knopf.setAttribute('aria-pressed', 'true');
      knopf.classList.remove('leise');
    });
  });

  $('#detail-speichern').addEventListener('click', async () => {
    const gewaehlt = $$('#detail-inhalt [data-status]').find(
      k => k.getAttribute('aria-pressed') === 'true',
    );
    const potenzialRoh = $('#detail-potenzial').value;
    await statusSetzen(praxis.id, {
      status: gewaehlt ? gewaehlt.dataset.status : praxis.status,
      notiz: $('#detail-notiz').value || null,
      ansprechpartner: $('#detail-partner').value || null,
      potenzial: potenzialRoh ? Number(potenzialRoh) : null,
      material_da: $('#detail-material').checked,
      wiedervorlage: $('#detail-wiedervorlage').value || null,
    });
    $('#detail').hidden = true;
    melde('Gespeichert.');
  });
}

/* ── Generieren: ein Knopf für alles ───────────────────────────────────── */

async function schluesselStandLaden() {
  try {
    const info = await api('/api/google-key');
    const el = $('#key-status');
    if (!info.gesetzt) {
      el.textContent =
        'Kein Schlüssel hinterlegt. Ohne ihn läuft alles über OpenStreetMap — kostenlos, ' +
        'aber nicht vollständig.';
      return;
    }
    el.textContent =
      info.quelle === 'umgebung'
        ? `Schlüssel kommt aus den Railway-Variablen (endet auf …${info.endet_auf}).`
        : `Schlüssel hinterlegt (endet auf …${info.endet_auf}).`;
  } catch {
    $('#key-status').textContent = 'Schlüsselstand nicht abrufbar.';
  }
}

async function schluesselSpeichern() {
  const feld = $('#gen-key');
  const knopf = $('#knopf-key-speichern');
  if (!feld.value.trim()) {
    melde('Erst den Schlüssel einfügen.', true);
    return;
  }
  knopf.disabled = true;
  $('#key-status').textContent = 'Wird bei Google geprüft …';
  try {
    const antwort = await api('/api/google-key', {
      method: 'POST',
      body: { key: feld.value.trim() },
    });
    // Das Feld sofort leeren: der Schlüssel liegt jetzt im Backend, im
    // Browser muss er nicht noch einmal herumstehen.
    feld.value = '';
    const p = antwort.pruefung || {};
    $('#key-status').textContent = p.ok
      ? `${p.meldung}${p.beispiele && p.beispiele.length ? ' Beispiel: ' + p.beispiele[0] : ''}`
      : `Schlüssel gespeichert, aber die Probeanfrage schlug fehl: ${p.meldung || 'unbekannt'}`;
    melde(p.ok ? 'Schlüssel funktioniert.' : 'Schlüssel gespeichert, aber ungeprüft.', !p.ok);
    kostenSchaetzenGen();
  } catch (err) {
    $('#key-status').textContent = `Nicht gespeichert: ${err.message}`;
    melde(err.message, true);
  } finally {
    knopf.disabled = false;
  }
}

async function schluesselLoeschen() {
  try {
    await api('/api/google-key', { method: 'POST', body: { key: null } });
    melde('Schlüssel entfernt.');
    schluesselStandLaden();
  } catch (err) {
    melde(err.message, true);
  }
}

async function kostenSchaetzenGen() {
  const el = $('#gen-kosten');
  const testlauf = $('#gen-testlauf').checked;
  const radius = testlauf ? 1.5 : Number($('#gen-radius').value);
  const zelle = testlauf ? 1000 : 700;
  let mitGoogle = false;
  try {
    mitGoogle = (await api('/api/google-key')).gesetzt;
  } catch {
    /* dann eben ohne Angabe */
  }
  if (!mitGoogle) {
    el.textContent =
      'Läuft nur über OpenStreetMap — kostenlos. Für Vollständigkeit oben einen Google-Schlüssel hinterlegen.';
    return;
  }
  try {
    const s = await api(`/api/import/kosten?radiusKm=${radius}&zellRadiusM=${zelle}`);
    const k = s.google_kosten_usd_schaetzung;
    el.textContent =
      `${testlauf ? 'Testlauf: ' : ''}etwa ${s.google_anfragen} Google-Anfragen, grob ` +
      `${k.von}–${k.bis} USD. ${k.hinweis}`;
  } catch {
    el.textContent = 'Kosten konnten nicht geschätzt werden.';
  }
}

async function generieren() {
  const knopf = $('#knopf-generieren');
  const testlauf = $('#gen-testlauf').checked;
  let mitGoogle = false;
  try {
    mitGoogle = (await api('/api/google-key')).gesetzt;
  } catch {
    /* ohne Schlüsselstand einfach nur OSM */
  }

  // Beim großen Lauf mit Google einmal nachfragen: das kostet echtes Geld,
  // und ein versehentlicher Klick auf 12 km wäre teuer.
  if (mitGoogle && !testlauf) {
    const text = $('#gen-kosten').textContent;
    if (!window.confirm(`Jetzt mit Google-Abfrage starten?\n\n${text}`)) return;
  }

  knopf.disabled = true;
  knopf.textContent = 'Läuft …';
  $('#gen-log').hidden = false;
  $('#gen-log').textContent = 'Startet …';
  try {
    await api('/api/generieren', {
      method: 'POST',
      body: {
        startAdresse: $('#gen-adresse').value || undefined,
        radiusKm: Number($('#gen-radius').value),
        mitGoogle,
        stoppsProTag: Number($('#gen-pro-tag').value),
        kategorien: $$('#kategorie-liste input:checked').map(i => i.value),
        testlauf,
      },
    });
    generierenVerfolgen();
  } catch (err) {
    melde(`Nicht gestartet: ${err.message}`, true);
    $('#gen-log').textContent = err.message;
    knopf.disabled = false;
    knopf.textContent = 'Generieren';
  }
}

let genUhr = null;

/** "1:23" — damit sichtbar ist, dass es vorangeht und wie lange schon. */
function laufzeitText(seit) {
  if (!seit) return '';
  const sekunden = Math.max(0, Math.round((Date.now() - new Date(seit).getTime()) / 1000));
  return `${Math.floor(sekunden / 60)}:${String(sekunden % 60).padStart(2, '0')}`;
}

function generierenVerfolgen() {
  clearInterval(genUhr);
  genUhr = setInterval(async () => {
    try {
      const stand = await api('/api/import/status');
      const laufzeit = laufzeitText(stand.gestartet);
      if (stand.laeuft && laufzeit) {
        $('#knopf-generieren').textContent = `Läuft … ${laufzeit}`;
      }
      $('#gen-log').textContent = [
        ...stand.meldungen,
        '',
        `Gefunden: ${stand.gefunden} · neu: ${stand.neu} · aufgefrischt: ${stand.aktualisiert} · zusammengeführt: ${stand.zusammengefuehrt}`,
        ...(stand.google_anfragen ? [`Google-Anfragen: ${stand.google_anfragen}`] : []),
        ...(stand.laeuft
          ? [
              '',
              `Läuft seit ${laufzeit}. OpenStreetMap antwortet mal in Sekunden, mal erst`,
              'nach einer Minute — der Dienst ist gratis und wird geteilt. Rechne mit',
              '2 bis 5 Minuten, danach kommt noch der Tourbau. Das Fenster darf zu.',
            ]
          : []),
        ...(stand.fehler.length ? ['', 'Hinweise und Fehler:', ...stand.fehler] : []),
      ].join('\n');
      $('#gen-log').scrollTop = $('#gen-log').scrollHeight;
      if (stand.laeuft) return;

      clearInterval(genUhr);
      $('#knopf-generieren').disabled = false;
      $('#knopf-generieren').textContent = 'Generieren';
      await tourLaden({ still: true });
      await statistikLaden();
      if (stand.tour) {
        melde(
          `Fertig: ${stand.tour.tage} Tage, ${stand.tour.stopps} Stopps, ${meterText(stand.tour.strecke_m)}.`,
        );
        ansichtWechseln('tour');
      } else {
        melde('Durchgang beendet — es kam keine Tour heraus, siehe Protokoll.', true);
      }
    } catch {
      clearInterval(genUhr);
      $('#knopf-generieren').disabled = false;
      $('#knopf-generieren').textContent = 'Generieren';
    }
  }, 2000);
}

/* ── Import und Tourbau ────────────────────────────────────────────────── */

let importUhr = null;

async function importStarten() {
  const knopf = $('#knopf-import');
  knopf.disabled = true;
  $('#import-log').hidden = false;
  try {
    await api('/api/import', {
      method: 'POST',
      body: {
        radiusKm: Number($('#import-radius').value),
        mitGoogle: $('#import-google').checked,
        zellRadiusM: Number($('#import-zelle').value),
        startAdresse: $('#start-adresse').value || undefined,
      },
    });
    melde('Import läuft. Das Fenster darf zu.');
    importVerfolgen();
  } catch (err) {
    melde(`Import nicht gestartet: ${err.message}`, true);
    knopf.disabled = false;
  }
}

function importVerfolgen() {
  clearInterval(importUhr);
  importUhr = setInterval(async () => {
    try {
      const stand = await api('/api/import/status');
      $('#import-log').textContent = [
        ...stand.meldungen,
        '',
        `Gefunden: ${stand.gefunden} · neu: ${stand.neu} · aufgefrischt: ${stand.aktualisiert} · zusammengeführt: ${stand.zusammengefuehrt}`,
        ...(stand.fehler.length ? ['', 'Fehler:', ...stand.fehler] : []),
      ].join('\n');
      $('#import-log').scrollTop = $('#import-log').scrollHeight;
      if (!stand.laeuft) {
        clearInterval(importUhr);
        $('#knopf-import').disabled = false;
        melde(`Import fertig: ${stand.neu} neu, ${stand.aktualisiert} aufgefrischt.`);
        statistikLaden();
      }
    } catch {
      clearInterval(importUhr);
      $('#knopf-import').disabled = false;
    }
  }, 2000);
}

async function tourBauen() {
  const kategorien = $$('#kategorie-liste input:checked').map(i => i.value);
  if (kategorien.length === 0) {
    melde('Mindestens eine Kategorie auswählen.', true);
    return;
  }
  const knopf = $('#knopf-tour-bauen');
  knopf.disabled = true;
  knopf.textContent = 'Wird gebaut …';
  try {
    const tour = await api('/api/tour/bauen', {
      method: 'POST',
      body: {
        kategorien,
        radiusKm: Number($('#import-radius').value),
        stoppsProTag: Number($('#tour-pro-tag').value),
        nurOffene: $('#tour-nur-offene').checked,
      },
    });
    zustand.tour = tour;
    zustand.tag = 1;
    lege(ABLAGE.tour, tour);
    lege(ABLAGE.tag, 1);
    const hinweise = $('#tour-hinweise');
    hinweise.hidden = !tour.hinweise || tour.hinweise.length === 0;
    hinweise.textContent = (tour.hinweise || []).join(' ');
    zeichneTour();
    zeichneKarte();
    statistikLaden();
    ansichtWechseln('tour');
    const stopps = tour.tage.reduce((n, t) => n + t.stopps.length, 0);
    melde(`${tour.tage.length} Tage, ${stopps} Stopps, ${meterText(tour.strecke_m)}.`);
  } catch (err) {
    melde(`Tour nicht gebaut: ${err.message}`, true);
  } finally {
    knopf.disabled = false;
    knopf.textContent = 'Tour bauen';
  }
}

async function abHierNeuSortieren() {
  const knopf = $('#knopf-weiter');
  knopf.disabled = true;
  const beschriftung = knopf.textContent;
  try {
    // Den Standort selbst holen, statt ihn vorauszusetzen. Vorher waren das
    // zwei Knöpfe, und der erste sah aus, als täte er nichts: er holte nur
    // die Position und schaltete den zweiten frei.
    if (!zustand.standort) {
      knopf.textContent = 'Standort …';
      zustand.standort = await standortHolen();
      standortAnzeigen();
    }
    knopf.textContent = 'Sortiert neu …';
    // Erst die Warteschlange leeren: sonst sortiert der Server nach einem
    // Stand, in dem die gerade abgehakten Praxen noch offen sind.
    await warteschlangeSenden({ still: true });
    const ergebnis = await api('/api/tour/weiter', {
      method: 'POST',
      body: { tag: zustand.tag, lat: zustand.standort.lat, lon: zustand.standort.lon },
    });
    await tourLaden({ still: true });
    if (ergebnis.stopps.length === 0) {
      melde('Keine offenen Stopps mehr an diesem Tag.');
    } else {
      melde(
        `${ergebnis.stopps.length} Stopps neu sortiert · ${meterText(ergebnis.strecke_m)} bis nach Hause.`,
      );
    }
  } catch (err) {
    melde(err.message, true);
  } finally {
    knopf.disabled = false;
    knopf.textContent = beschluss(beschriftung);
  }
}

/** Fällt auf die ursprüngliche Beschriftung zurück, falls sie leer war. */
function beschluss(text) {
  return text && text.trim() ? text : 'Ab meinem Standort neu sortieren';
}

/** Standortzeile und Karte auffrischen, nachdem die Position da ist. */
function standortAnzeigen() {
  $('#standort-info').hidden = false;
  $('#standort-info').textContent =
    `Standort auf ${Math.round(zustand.standort.genauigkeit)} m genau. ` +
    `An jedem Stopp steht jetzt die Luftlinie von dir aus.`;
  zeichneTour();
  zeichneKarte();
}

/* ── Ansichten ─────────────────────────────────────────────────────────── */

function ansichtWechseln(name) {
  $$('.reiter-knopf').forEach(k => k.classList.toggle('aktiv', k.dataset.ansicht === name));
  $$('.ansicht').forEach(a => { a.hidden = a.id !== `ansicht-${name}`; });
  if (name === 'karte') karteVorbereiten();
  if (name === 'daten') statistikLaden();
}

/* ── Einrichtung ───────────────────────────────────────────────────────── */

function einrichtungZeigen() {
  $('#setup').hidden = false;
  $('#setup-url').value = zustand.url || KONFIG.backendUrl || '';
  $('#setup-passwort').value = zustand.passwort;
  $('#setup-name').value = zustand.name;
  // Ist in config.js schon ein Passwort hinterlegt, muss niemand danach suchen.
  if (zustand.passwort) $('#setup-passwort-block').open = true;
}

/**
 * Macht aus dem, was jemand eintippt, eine brauchbare Adresse: Leerzeichen
 * weg, fehlendes https:// ergänzen, Schrägstrich am Ende abschneiden.
 * "xyz.up.railway.app" soll funktionieren, ohne dass man darüber nachdenkt.
 */
function adresseAufraeumen(roh) {
  let wert = String(roh || '').trim().replace(/\/+$/, '');
  if (!wert) return '';
  if (!/^https?:\/\//i.test(wert)) wert = 'https://' + wert;
  return wert;
}

/**
 * Sagt, was an einer Adresse nicht stimmt — oder null, wenn sie taugt.
 *
 * Nötig, weil adresseAufraeumen() ein fehlendes https:// ergänzt: aus einem
 * Dateipfad wird dadurch eine formal gültige URL, die der Browser anstandslos
 * schluckt und die dann in einer nichtssagenden Verbindungsmeldung endet.
 */
function adresseBeanstanden(url) {
  let zerlegt;
  try {
    zerlegt = new URL(url);
  } catch {
    return 'Das ist keine gültige Internetadresse.';
  }
  const dateiEndung = /\.(js|mjs|html?|json|css|ts|md)$/i;
  // Ein Dateiname steht hier mit Abstand am häufigsten drin, wenn es schiefgeht
  // — mal als Pfad, mal ganz allein. "config.js" wird durch das ergänzte
  // https:// sonst zu einem formal gültigen Hostnamen.
  if (dateiEndung.test(zerlegt.hostname) || dateiEndung.test(zerlegt.pathname)) {
    return (
      'Das ist ein Dateiname, keine Server-Adresse. config.js bearbeitest du ' +
      'im Repository; hier gehört die Railway-Adresse hin, z. B. xyz.up.railway.app.'
    );
  }
  // localhost hat keinen Punkt, ist aber beim lokalen Entwickeln richtig.
  if (!zerlegt.hostname.includes('.') && zerlegt.hostname !== 'localhost') {
    return (
      'Da fehlt die Domain. Gemeint ist die Adresse, unter der dein Backend ' +
      'im Browser erreichbar ist — z. B. xyz.up.railway.app.'
    );
  }
  return null;
}

async function einrichtungSpeichern(ereignis) {
  ereignis.preventDefault();
  const url = adresseAufraeumen($('#setup-url').value);
  const passwort = $('#setup-passwort').value;
  const name = $('#setup-name').value.trim();
  const fehlerFeld = $('#setup-fehler');
  fehlerFeld.hidden = true;

  if (!url) {
    fehlerFeld.textContent =
      'Hier gehört die Internetadresse deines Backends hin, z. B. ' +
      'xyz.up.railway.app. Abbrechen geht oben rechts.';
    fehlerFeld.hidden = false;
    return;
  }
  const beanstandung = adresseBeanstanden(url);
  if (beanstandung) {
    fehlerFeld.textContent = beanstandung;
    fehlerFeld.hidden = false;
    return;
  }

  const vorher = { ...zustand };
  zustand.url = url;
  zustand.passwort = passwort;
  try {
    await api('/api/statistik');
  } catch (err) {
    zustand.url = vorher.url;
    zustand.passwort = vorher.passwort;
    fehlerFeld.textContent = `Verbindung fehlgeschlagen: ${err.message}`;
    fehlerFeld.hidden = false;
    // Beim Passwortfehler den weggeklappten Block aufmachen — sonst sucht man
    // das Feld, das man gerade braucht.
    if (/Passwort/i.test(err.message)) {
      $('#setup-passwort-block').open = true;
    }
    return;
  }
  zustand.name = name;
  lege(ABLAGE.url, url);
  lege(ABLAGE.passwort, passwort);
  lege(ABLAGE.name, name);
  // Die Verbindung steht — ab jetzt echte Daten statt Beispiele.
  demoVerlassen();
  $('#setup').hidden = true;
  await starten();
}

/* ── Ereignisse ────────────────────────────────────────────────────────── */

function ereignisseBinden() {
  $('#setup-form').addEventListener('submit', einrichtungSpeichern);
  $('#setup-zu').addEventListener('click', () => {
    $('#setup').hidden = true;
    // Dialog weggeklickt und es gibt kein Backend: dann eben weiter in der
    // Vorschau, statt den Nutzer vor einer leeren Seite stehen zu lassen.
    if (!zustand.url && !zustand.demo) demoStarten();
  });
  $('#knopf-demo-verbinden').addEventListener('click', () => {
    einrichtungZeigen();
  });
  $('#knopf-einstellungen').addEventListener('click', () => ansichtWechseln('daten'));

  $$('.reiter-knopf').forEach(k =>
    k.addEventListener('click', () => ansichtWechseln(k.dataset.ansicht)),
  );

  $('#tag-waehler').addEventListener('click', ereignis => {
    const knopf = ereignis.target.closest('[data-tag]');
    if (!knopf) return;
    zustand.tag = Number(knopf.dataset.tag);
    lege(ABLAGE.tag, zustand.tag);
    zeichneTour();
    zeichneKarte();
  });

  $('#filter-erledigt').checked = zustand.erledigtAus;
  $('#filter-erledigt').addEventListener('change', ereignis => {
    zustand.erledigtAus = ereignis.target.checked;
    lege(ABLAGE.erledigtAus, zustand.erledigtAus);
    zeichneTour();
  });

  $('#stopp-liste').addEventListener('click', async ereignis => {
    const detail = ereignis.target.closest('[data-detail]');
    if (detail) {
      detailOeffnen(detail.dataset.detail);
      return;
    }
    const navi = ereignis.target.closest('[data-navi]');
    if (navi) {
      const [lat, lon] = navi.dataset.navi.split(',');
      window.open(naviLink(lat, lon), '_blank', 'noopener');
      return;
    }
    const fertig = ereignis.target.closest('[data-stopp-besucht]');
    if (fertig) {
      const key = fertig.dataset.stoppBesucht;
      const tag = aktuellerTag();
      const stopp = tag && tag.stopps.find(s => s.adress_key === key);
      if (!stopp) return;
      const offene = stopp.praxen.filter(p => p.status === 'offen' || p.status === 'nochmal');
      for (const praxis of offene) {
        lokalAendern(praxis.id, { status: 'besucht', bearbeiter: zustand.name || undefined });
        inWarteschlange(praxis.id, { status: 'besucht', bearbeiter: zustand.name || undefined });
      }
      zeichneTour();
      zeichneKarte();
      if (await warteschlangeSenden({ still: true })) await tourLaden({ still: true });
      melde(`${offene.length} Praxen abgehakt.`);
    }
  });

  $('#detail-zu').addEventListener('click', () => { $('#detail').hidden = true; });
  $('#detail').addEventListener('click', ereignis => {
    if (ereignis.target.id === 'detail') $('#detail').hidden = true;
  });

  $('#knopf-standort').addEventListener('click', async () => {
    const knopf = $('#knopf-standort');
    knopf.disabled = true;
    try {
      zustand.standort = await standortHolen();
      standortAnzeigen();
      melde('Standort übernommen.');
    } catch (err) {
      melde(err.message, true);
    } finally {
      knopf.disabled = false;
    }
  });

  $('#knopf-weiter').addEventListener('click', abHierNeuSortieren);
  $('#knopf-maps-tag').addEventListener('click', tagInMaps);

  $('#import-google').addEventListener('change', ereignis => {
    $('#google-block').hidden = !ereignis.target.checked;
    if (ereignis.target.checked) kostenSchaetzen();
  });
  $('#import-radius').addEventListener('change', kostenSchaetzen);
  $('#import-zelle').addEventListener('change', kostenSchaetzen);

  $('#knopf-generieren').addEventListener('click', generieren);
  $('#knopf-key-speichern').addEventListener('click', schluesselSpeichern);
  $('#knopf-key-loeschen').addEventListener('click', schluesselLoeschen);
  $('#gen-radius').addEventListener('change', kostenSchaetzenGen);
  $('#gen-testlauf').addEventListener('change', kostenSchaetzenGen);

  $('#knopf-import').addEventListener('click', importStarten);
  $('#knopf-tour-bauen').addEventListener('click', tourBauen);

  $('#knopf-start-speichern').addEventListener('click', async () => {
    try {
      const sitz = await api('/api/start', {
        method: 'POST',
        body: { adresse: $('#start-adresse').value },
      });
      melde(`Startpunkt: ${sitz.adresse}`);
      statistikLaden();
    } catch (err) {
      melde(`Adresse nicht gefunden: ${err.message}`, true);
    }
  });

  $('#knopf-start-hier').addEventListener('click', async () => {
    try {
      const pos = await standortHolen();
      const sitz = await api('/api/start', {
        method: 'POST',
        body: { adresse: $('#start-adresse').value || 'Betrieb (per GPS gesetzt)', lat: pos.lat, lon: pos.lon },
      });
      melde(`Startpunkt auf deinen Standort gesetzt (${sitz.lat.toFixed(5)}, ${sitz.lon.toFixed(5)}).`);
      statistikLaden();
    } catch (err) {
      melde(err.message, true);
    }
  });

  $('#knopf-csv').addEventListener('click', async () => {
    try {
      const csv = await api('/api/export.csv');
      const datei = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const verweis = document.createElement('a');
      verweis.href = URL.createObjectURL(datei);
      verweis.download = 'routenplan.csv';
      verweis.click();
      URL.revokeObjectURL(verweis.href);
    } catch (err) {
      melde(`Export fehlgeschlagen: ${err.message}`, true);
    }
  });

  $('#knopf-neu-laden').addEventListener('click', async () => {
    await warteschlangeSenden({ still: true });
    await tourLaden();
    await statistikLaden();
    melde('Aktualisiert.');
  });

  $('#knopf-warteschlange').addEventListener('click', () => warteschlangeSenden());

  $('#knopf-einst-speichern').addEventListener('click', async () => {
    const neueUrl = adresseAufraeumen($('#einst-url').value);
    if (neueUrl && zustand.demo) demoVerlassen();
    zustand.url = neueUrl;
    zustand.passwort = $('#einst-passwort').value;
    zustand.name = $('#einst-name').value.trim();
    lege(ABLAGE.url, zustand.url);
    lege(ABLAGE.passwort, zustand.passwort);
    lege(ABLAGE.name, zustand.name);
    melde('Gespeichert.');
    await starten();
  });

  window.addEventListener('online', async () => {
    warteschlangeAnzeigen();
    if (zustand.demo) return;
    if (await warteschlangeSenden({ still: true })) await tourLaden({ still: true });
  });
  window.addEventListener('offline', warteschlangeAnzeigen);

  // Beim Zurückkehren auf den Tab: Stand vom anderen Handy nachziehen.
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && zustand.url && !zustand.demo) {
      await warteschlangeSenden({ still: true });
      await tourLaden({ still: true });
      statistikLaden();
    }
  });
}

async function kostenSchaetzen() {
  if (!$('#import-google').checked) return;
  try {
    const schaetzung = await api(
      `/api/import/kosten?radiusKm=${$('#import-radius').value}&zellRadiusM=${$('#import-zelle').value}`,
    );
    const k = schaetzung.google_kosten_usd_schaetzung;
    $('#kosten-anzeige').textContent =
      `Etwa ${schaetzung.google_anfragen} Google-Anfragen, grob ${k.von}–${k.bis} USD. ${k.hinweis}`;
  } catch {
    $('#kosten-anzeige').textContent = 'Kosten konnten nicht geschätzt werden.';
  }
}

/* ── Start ─────────────────────────────────────────────────────────────── */

async function starten() {
  $('#einst-url').value = zustand.url;
  $('#einst-passwort').value = zustand.passwort;
  $('#einst-name').value = zustand.name;
  $('#einst-info').textContent = zustand.name
    ? `Besuche werden auf "${zustand.name}" gebucht.`
    : 'Ohne Namen steht an den Besuchen kein Bearbeiter.';

  warteschlangeAnzeigen();

  // Eine eingetragene Backend-Adresse schlägt die Vorschau — immer und ohne
  // Nachfrage. Ohne diese Zeile bliebe ein Gerät, das einmal in der Vorschau
  // war, auch nach dem Einrichten des Backends bei den Beispieldaten hängen:
  // das Merkmal steht im Speicher des Geräts und überlebt jeden Aufruf.
  if (zustand.url && zustand.demo) demoVerlassen();

  // Verbietet die Konfiguration die Vorschau, zählt das mehr als ein
  // Merkmal im Gerätespeicher. Ohne diese Zeile zeigte ein Handy, das die
  // Vorschau einmal gesehen hat, weiter Beispieldaten an — auch wenn die
  // Seite längst auf "nur echte Daten" steht. Genau das ist passiert.
  if (KONFIG.demoErlauben === false && zustand.demo) demoVerlassen();

  // Ist gar keine Vorschau im Gang, zuerst prüfen, ob eine API antwortet —
  // auf Netlify liegt sie unter /api neben der Seite, ganz ohne Einrichtung.
  if (!zustand.demo) {
    const erreichbar = await apiErreichbar();
    if (!erreichbar) {
      if (KONFIG.demoErlauben === false) {
        $('#demo-banner').hidden = true;
        zeichneKeinBackend();
        return;
      }
      // Nichts erreichbar und Vorschau erlaubt: lieber etwas zeigen als eine
      // leere Seite.
      zustand.demo = true;
      lege(ABLAGE.demo, true);
    }
  }

  $('#demo-banner').hidden = !zustand.demo;

  if (zustand.demo) {
    // In der Vorschau gibt es nichts zu senden und nichts nachzuladen.
    zustand.tour = demoTourHolen();
    await infoLaden();
    zeichneTour();
    zeichneKarte();
    await statistikLaden();
    $('#kopf-zusatz').textContent = 'Vorschau · Beispieldaten';
    return;
  }

  zeichneTour();

  // Kein Dialog mehr an dieser Stelle: eine leere Adresse ist seit der
  // Netlify-Variante kein Mangel, sondern bedeutet "API unter /api auf
  // dieser Seite". Dass dort wirklich etwas antwortet, wurde oben geprüft.
  await infoLaden();
  await schluesselStandLaden();
  await kostenSchaetzenGen();
  await warteschlangeSenden({ still: true });
  await tourLaden({ still: true });
  await statistikLaden();
  // Läuft beim Öffnen gerade ein Import, direkt weiterverfolgen.
  try {
    const stand = await api('/api/import/status');
    if (stand.laeuft) {
      // Beides anzeigen: man weiß von außen nicht, über welchen der beiden
      // Knöpfe der Lauf gestartet wurde.
      $('#import-log').hidden = false;
      $('#gen-log').hidden = false;
      $('#knopf-import').disabled = true;
      $('#knopf-generieren').disabled = true;
      $('#knopf-generieren').textContent = 'Läuft …';
      importVerfolgen();
      generierenVerfolgen();
    }
  } catch {
    /* egal */
  }
}

ereignisseBinden();
starten();
