import type { Status } from './db';

/** Kategorien, nach denen im Frontend gefiltert wird. */
export const KATEGORIEN = {
  hausarzt: {
    label: 'Hausarzt / Allgemeinmedizin',
    standard: true,
    hinweis: 'Hauptziel: verordnet Krankenfahrten am häufigsten.',
  },
  physio: {
    label: 'Physiotherapie',
    standard: true,
    hinweis: 'Zweitziel: kennt die Patienten, die regelmäßig gefahren werden.',
  },
  arzt_unklar: {
    label: 'Arztpraxis (Fachrichtung in OSM nicht hinterlegt)',
    standard: true,
    hinweis:
      'OpenStreetMap kennt bei vielen Praxen keine Fachrichtung. Darunter stecken sehr viele Hausärzte — deshalb standardmäßig an.',
  },
  aerztehaus: {
    label: 'Ärztehaus / MVZ / Klinik',
    standard: true,
    hinweis: 'Ein Halt, mehrere Praxen. Effizienteste Stopps der Tour.',
  },
  prio_facharzt: {
    label: 'Dialyse, Onkologie, Strahlentherapie, Nephrologie',
    standard: true,
    hinweis:
      'Nicht erfragt, aber mit Abstand die größten Dauerauftraggeber für Krankenfahrten: Patienten fahren dort 2–3× pro Woche hin.',
  },
  facharzt: {
    label: 'Sonstige Facharztpraxis',
    standard: false,
    hinweis: 'Zahnarzt, Augenarzt & Co. — selten Krankenfahrten, deshalb aus.',
  },
  pflege: {
    label: 'Pflegeheim / Pflegedienst',
    standard: false,
    hinweis:
      'Starke Auftragsquelle, aber ein anderes Gespräch als in der Arztpraxis. Zuschaltbar.',
  },
} as const;

export type Kategorie = keyof typeof KATEGORIEN;

export function istKategorie(wert: unknown): wert is Kategorie {
  return typeof wert === 'string' && Object.prototype.hasOwnProperty.call(KATEGORIEN, wert);
}

export const STANDARD_KATEGORIEN: Kategorie[] = (
  Object.keys(KATEGORIEN) as Kategorie[]
).filter(k => KATEGORIEN[k].standard);

/** Ein importierter Datensatz, bevor er in die Datenbank geht. */
export interface PraxisEingang {
  id: string;
  name: string;
  kategorie: Kategorie;
  fachrichtung?: string;
  strasse?: string;
  hausnummer?: string;
  plz?: string;
  ort?: string;
  stadtteil?: string;
  lat: number;
  lon: number;
  telefon?: string;
  website?: string;
  email?: string;
  oeffnungszeiten?: string;
  barrierefrei?: string;
  quelle: 'osm' | 'google' | 'manuell';
  source_url?: string;
}

/** Wie eine Praxis aus der Datenbank herauskommt, inklusive Besuchsstand. */
export interface PraxisAusgang extends Omit<PraxisEingang, 'kategorie'> {
  kategorie: string;
  adress_key: string;
  entfernung_m: number | null;
  status: Status;
  notiz: string | null;
  ansprechpartner: string | null;
  potenzial: number | null;
  material_da: number;
  wiedervorlage: string | null;
  bearbeiter: string | null;
  besucht_am: string | null;
}
