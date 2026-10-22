// Erkennen, ob zwei Datensätze dieselbe Praxis meinen.
//
// Gebraucht wird das beim Zusammenführen von OpenStreetMap und Google: beide
// kennen dieselbe Praxis unter eigener ID und in eigener Schreibweise. Ohne
// Zusammenführung stünde sie zweimal in der Tour und man klingelte zweimal an
// derselben Tür.
//
// Reine Funktionen, keine Datenbank — damit sie überall laufen, wo
// zusammengeführt wird.

/**
 * Füllwörter, die über den eigentlichen Namen nichts aussagen: Titel,
 * Rechtsform, Gattungsbezeichnung. Sie müssen weg, weil dieselbe Praxis bei
 * OSM "Hausarzt Meier" und bei Google "Hausarztpraxis Dr. med. Meier" heißt.
 *
 * Nach dem Streichen bleibt meist nur der Nachname oder der Ortsteil übrig —
 * das allein wäre zum Zusammenführen zu dünn. Deshalb prüft der Aufrufer
 * zusätzlich, ob die Kategorien zueinander passen: Physio und Hausarzt im
 * selben Haus sind zwei Stopps, auch wenn beide "Eller" heißen.
 */
const FUELLWOERTER =
  /\b(dr|drs|prof|med|dent|dipl|univ|facharzt|facharztin|fachaerztin|hausarzt|hausarzte|hausarztpraxis|arzt|arztin|arztpraxis|praxis|praxen|gemeinschaftspraxis|berufsausubungsgemeinschaft|bag|mvz|medizinisches|versorgungszentrum|physiotherapie|physiotherapeut|physio|krankengymnastik|allgemeinmedizin|allgemeinarzt|innere|medizin|fur|und|am|an|der|die|das|im|in|von|zum|zur|gbr|mbb|gmbh|ggmbh|ug|kg|ohg|partg|ev)\b/g;

/**
 * Namen für den Vergleich normalisieren. Umlaute zuerst, damit die
 * Füllwortliste ohne Umlautvarianten auskommt.
 */
export function nameSchluessel(name: string): string {
  return name
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/ä/g, 'a')
    .replace(/ö/g, 'o')
    .replace(/ü/g, 'u')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(FUELLWOERTER, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Kategorien, die dieselbe Einrichtung bezeichnen können. "arzt_unklar" ist
 * mit jeder Arztkategorie verträglich — genau dafür ist sie da: OSM kennt die
 * Fachrichtung nicht, Google schon.
 */
const ARZT_KATEGORIEN = new Set([
  'hausarzt',
  'arzt_unklar',
  'facharzt',
  'prio_facharzt',
  'aerztehaus',
]);

export function kategorienVertraeglich(a: string, b: string): boolean {
  if (a === b) return true;
  return ARZT_KATEGORIEN.has(a) && ARZT_KATEGORIEN.has(b);
}

/** Zwei Namen an derselben Adresse: dieselbe Praxis oder zwei Nachbarn? */
export function gleichePraxis(a: string, b: string): boolean {
  const x = nameSchluessel(a);
  const y = nameSchluessel(b);
  if (!x || !y) return false;
  if (x === y) return true;
  // Teilmengen zählen nur ab einer Länge, bei der sie etwas bedeuten –
  // "zentrum" steckt sonst in jedem zweiten Namen.
  if (x.length >= 8 && y.includes(x)) return true;
  if (y.length >= 8 && x.includes(y)) return true;
  // Sonst mindestens zwei gemeinsame Wörter mit Substanz (zwei Nachnamen
  // einer Gemeinschaftspraxis, Nachname plus Ortsteil).
  const wa = new Set(x.split(' ').filter(w => w.length >= 4));
  const wb = new Set(y.split(' ').filter(w => w.length >= 4));
  let treffer = 0;
  for (const w of wa) if (wb.has(w)) treffer++;
  return treffer >= 2;
}
