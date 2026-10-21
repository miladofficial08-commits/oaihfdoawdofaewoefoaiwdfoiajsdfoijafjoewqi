// Datenqualität der Anrufliste – reine Regeln, keine Datenbank.
//
// Warum ein eigenes Modul: Am Telefon kostet ein falsches Datum sofort das
// Gespräch. Wer „Herr Reichert, bitte" sagt, und der Betrieb gehört seit zehn
// Jahren Herrn Schubert, ist nach zwei Sätzen durch. Deshalb werden Chef-Namen
// hier nicht mehr blind geglaubt, sondern bewertet – und was sich nicht belegen
// lässt, geht als „unsicher" in die Liste, nicht als Tatsache.
//
// Die Regeln sind absichtlich getrennt von der Extraktion (website-checker) und
// von der Anzeige (routes): So kann man sie einzeln testen und sie gelten für
// Alt-Bestand und Neu-Scrape gleich.

// ─── Chef-Name ───────────────────────────────────────────────────────────────

export type GfVertrauen = 'hoch' | 'mittel' | 'unsicher';

export interface GfBewertung {
  vertrauen: GfVertrauen;
  /** Kurz, für die Liste: warum traue ich dem Namen (nicht)? */
  grund: string;
  /** Ein im Firmennamen genannter Inhaber, der dem Namen widerspricht. */
  konflikt?: string;
}

const UMLAUT: Record<string, string> = { 'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'ß': 'ss' };

export const falte = (s: string): string =>
  (s || '').toLowerCase().replace(/[äöüß]/g, m => UMLAUT[m] || m);

/** Rechtsform- und Branchenwörter, die nie Teil eines Personennamens sind. */
const FIRMENWORT = new RegExp(
  '\\b(gmbh|mbh|kg|ohg|gbr|ug|ag|e\\.?\\s?k|e\\.?\\s?v|co|haustechnik|sanitaer|sanitar|' +
  'heizung\\w*|elektro\\w*|klima|kaelte|technik|service|energie|solar|bau|gruppe|holding)\\b',
  'i');

/**
 * Nennt der Firmenname selbst einen Inhaber? („… , Inh. Christoph Schubert e.K.")
 * Das ist der stärkste Beleg, den es gibt – und der häufigste Widerspruch zu
 * einem Namen, den der Scraper irgendwo auf der Startseite aufgesammelt hat.
 */
export function inhaberAusFirmenname(firmenname: string): string | undefined {
  const m = (firmenname || '').match(
    /\b(?:Inh(?:\.|aber(?:in)?)|Gesch[äa]ftsf[üu]hrer(?:in)?)\s*:?\s*((?:[A-ZÄÖÜ][a-zäöüß]+(?:[-'][A-ZÄÖÜ][a-zäöüß]+)?\s+){1,2}[A-ZÄÖÜ][a-zäöüß]+(?:[-'][A-ZÄÖÜ][a-zäöüß]+)?)/,
  );
  const name = m?.[1]?.trim();
  if (!name) return undefined;
  // "Inh. Sanitär Meier" wäre kein Personenname.
  return FIRMENWORT.test(name) ? undefined : name;
}

/** Namensteile, die als Nachname taugen (ohne Titel und Vornamen-Kürzel). */
function namensteile(name: string): string[] {
  return falte(name)
    .replace(/\b(herr|frau|dr|prof|dipl|ing|med|rer|nat|pol)\b\.?/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter(w => w.length > 2);
}

/** Initialen eines Personennamens: "Patrick Mertes" → "pm". */
function initialen(name: string): string {
  return namensteile(name).map(w => w[0]).join('');
}

/**
 * Wie sehr passt der Name zum Betrieb?
 *
 * Drei Belege, von stark nach schwach:
 *   1. Der Firmenname nennt den Inhaber selbst → entscheidet, auch gegen den Scraper.
 *   2. Ein Namensteil steckt im Firmennamen („Boschanski" in „Bad & Heizung Boschanski").
 *   3. Die Initialen stecken als Kürzel im Firmennamen („PM Haustechnik" ← Patrick Mertes).
 *
 * Ohne jeden Beleg bleibt der Name „unsicher". Er wird nicht gelöscht – er wird
 * nur nicht mehr als Tatsache behandelt.
 */
export function bewerteGf(
  gf: string | null | undefined,
  firmenname: string,
  quelle?: string | null,
): GfBewertung | undefined {
  const name = (gf || '').trim();
  if (!name) return undefined;

  const ausImpressum = quelle === 'impressum';
  const inhaber = inhaberAusFirmenname(firmenname);
  if (inhaber) {
    const gleich = namensteile(inhaber).some(w => namensteile(name).includes(w));
    if (!gleich) {
      return {
        vertrauen: 'unsicher',
        grund: `Firmenname nennt ${inhaber} als Inhaber – nicht ${name}`,
        konflikt: inhaber,
      };
    }
    return { vertrauen: 'hoch', grund: 'Inhaber steht im Firmennamen' };
  }

  // „Kohlhaas GmbH" und ein Chef namens Kohlhaas: Das ist für sich schon ein
  // Beleg, unabhängig davon, von welcher Seite der Name kam. Die Quelle
  // entscheidet erst dort, wo Name und Firma nichts miteinander zu tun haben.
  const firma = falte(firmenname);
  const teile = namensteile(name);
  if (teile.some(w => firma.includes(w))) {
    return {
      vertrauen: 'hoch',
      grund: ausImpressum
        ? 'Name im Impressum und im Firmennamen'
        : 'Name steckt im Firmennamen',
    };
  }

  const ini = initialen(name);
  if (ini.length >= 2 && new RegExp(`\\b${ini}\\b`).test(firma)) {
    return {
      vertrauen: ausImpressum ? 'hoch' : 'mittel',
      grund: `Initialen ${ini.toUpperCase()} stecken im Firmennamen`,
    };
  }

  if (ausImpressum) {
    return { vertrauen: 'mittel', grund: 'Aus dem Impressum, aber kein Bezug zum Firmennamen' };
  }
  return {
    vertrauen: 'unsicher',
    grund: 'Nicht aus dem Impressum belegt – vor dem Anruf prüfen',
  };
}

// ─── Kein Betrieb: Verbände, Kammern, Großhandel ────────────────────────────
//
// Die stehen in Google Maps unter derselben Branche wie die Betriebe, sind aber
// keine Kunden. „Handwerkskammer Düsseldorf" anzurufen und einen Telefon-
// assistenten anzubieten, verbrennt nur Zeit – und beim Fachverband auch Ruf.

const KEIN_BETRIEB = [
  'handwerkskammer', 'kammer', 'innung', 'fachverband', 'bundesverband',
  'zentralverband', 'landesverband', 'verband', 'berufszentrum', 'berufskolleg',
  'bildungszentrum', 'akademie', 'hochschule', 'universit', 'fachschule',
  'grosshandel', 'großhandel', 'fachgrosshandel', 'fachgroßhandel', 'fachcenter',
  'abhollager', 'baumarkt', 'genossenschaft', 'stadtwerke', 'jobcenter',
  'arbeitsagentur', 'finanzamt', 'stadtverwaltung', 'ordnungsamt',
];

const KEIN_BETRIEB_RE = /\be\.\s?v\.?\b/i;

/** Verband, Kammer, Großhandel, Behörde – alles, was kein anrufbarer Betrieb ist. */
export function istKeinBetrieb(name: string | null | undefined): string | undefined {
  const n = falte(String(name ?? ''));
  if (!n) return undefined;
  const treffer = KEIN_BETRIEB.find(w => n.includes(falte(w)));
  if (treffer) return treffer;
  if (KEIN_BETRIEB_RE.test(String(name))) return 'e.V.';
  return undefined;
}

// ─── Stadt ───────────────────────────────────────────────────────────────────
//
// Im Bestand steht dieselbe Stadt in zwei Schreibweisen ("Düsseldorf" und
// "Duesseldorf"), weil ein Teil über Google Maps und ein Teil über die eigenen
// Suchbegriffe kam. Für den Filter ist das fatal: Wer "Düsseldorf" wählt, sieht
// die Hälfte seiner Leads nicht – und hält den Rest für abgearbeitet.

const STAEDTE = [
  'Düsseldorf', 'Köln', 'Essen', 'Dortmund', 'Duisburg', 'Bochum', 'Wuppertal',
  'Bielefeld', 'Bonn', 'Münster', 'Mönchengladbach', 'Gelsenkirchen', 'Aachen',
  'Krefeld', 'Oberhausen', 'Hagen', 'Hamm', 'Mülheim an der Ruhr', 'Leverkusen',
  'Solingen', 'Herne', 'Neuss', 'Paderborn', 'Recklinghausen', 'Bottrop',
  'Remscheid', 'Moers', 'Siegen', 'Gütersloh', 'Witten', 'Iserlohn', 'Düren',
  'Ratingen', 'Lüdenscheid', 'Marl', 'Velbert', 'Minden', 'Viersen', 'Rheine',
  'Dorsten', 'Gladbeck', 'Detmold', 'Troisdorf', 'Castrop-Rauxel', 'Lünen',
  'Arnsberg', 'Herford', 'Dinslaken', 'Bergheim', 'Hilden', 'Meerbusch',
  'Dormagen', 'Grevenbroich', 'Langenfeld', 'Monheim am Rhein', 'Erkrath',
  'Haan', 'Hückeswagen', 'Mettmann', 'Wülfrath', 'Heiligenhaus', 'Kaarst',
  'Willich', 'Korschenbroich', 'Jüchen', 'Rommerskirchen', 'Pulheim', 'Frechen',
  'Hürth', 'Brühl', 'Wesseling', 'Bergisch Gladbach', 'Rösrath', 'Overath',
  'Bedburg', 'Elsdorf', 'Kerpen', 'Berlin', 'Hamburg', 'München', 'Frankfurt am Main',
];

const STADT_INDEX = new Map(STAEDTE.map(s => [falte(s), s]));

/**
 * Bringt eine Stadt auf eine Schreibweise. Entfernt dabei auch die Zusätze,
 * die Google Maps und OSM mitliefern ("Langenfeld (Rheinland)", "40210 Köln").
 * Unbekannte Städte werden nur aufgeräumt, nicht erfunden.
 */
export function normalisiereStadt(roh: string | null | undefined): string | undefined {
  let s = String(roh ?? '').trim();
  if (!s) return undefined;
  s = s.replace(/^\d{5}\s+/, '').replace(/\s*\([^)]*\)\s*$/, '').trim();
  if (!s) return undefined;
  const kanon = STADT_INDEX.get(falte(s));
  if (kanon) return kanon;
  // Ortsteil-Schreibweisen: "Essen-Frillendorf" → "Essen", aber nur wenn der
  // vordere Teil eine bekannte Stadt ist. Sonst bleibt der Wert wie er ist.
  const vorne = s.split(/[-\/,]/)[0]?.trim();
  if (vorne && vorne !== s) {
    const k2 = STADT_INDEX.get(falte(vorne));
    if (k2) return k2;
  }
  return s;
}

/** Stadt aus einer Adresszeile ziehen – für Leads, die nur „NRW" als Stadt haben. */
export function stadtAusAdresse(adresse: string | null | undefined): string | undefined {
  const a = String(adresse ?? '').trim();
  if (!a) return undefined;
  // "Kirchfeldstr. 12, 40215 Düsseldorf" → "Düsseldorf"
  const m = a.match(/\b\d{5}\s+([A-ZÄÖÜ][\wäöüß.\- ]+)$/);
  if (m?.[1]) return normalisiereStadt(m[1]);
  const letzte = a.split(',').pop()?.trim();
  return letzte ? normalisiereStadt(letzte) : undefined;
}

// ─── Telefon ─────────────────────────────────────────────────────────────────

/**
 * Taugt die Nummer zum Anrufen? Prüft Form, nicht Erreichbarkeit – das kann
 * nur der Anruf selbst. Sonderrufnummern (0800/0180/0900) führen in eine
 * Hotline statt zum Chef und sind für Kaltakquise wertlos.
 */
export function telefonProblem(roh: string | null | undefined): string | undefined {
  const s = String(roh ?? '').trim();
  if (!s) return 'keine Nummer';
  const ziffern = s.replace(/[^\d]/g, '');
  if (/[A-Za-z]/.test(s.replace(/^tel:?/i, ''))) return 'Buchstaben in der Nummer';
  if (ziffern.length < 9) return 'zu kurz für eine deutsche Festnetznummer';
  if (ziffern.length > 15) return 'zu lang – vermutlich zwei Nummern in einem Feld';
  if (/^(?:49)?(?:0?800|0?180\d?|0?900\d?|0?137)/.test(ziffern)) return 'Sonderrufnummer (Hotline, nicht der Chef)';
  return undefined;
}

/** Vergleicht zwei Nummern ziffernweise – Format und Ländervorwahl egal. */
export function gleicheNummer(a: string | null | undefined, b: string | null | undefined): boolean {
  const z = (x: string | null | undefined) =>
    String(x ?? '').replace(/[^\d]/g, '').replace(/^0049/, '49').replace(/^0/, '49');
  const za = z(a), zb = z(b);
  return !!za && !!zb && za === zb;
}
