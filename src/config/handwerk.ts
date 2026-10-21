// Was zählt als Handwerk?
//
// Im Bestand steht die Branche so, wie sie gescraped wurde: „SHK Sanitär Heizung",
// „Kaelte Klima", „KFZ Werkstatt", „Elektriker". Für die Personalisierung ist das
// genau richtig – {branche} in der Mail soll konkret sein. Zum FILTERN ist es
// Kleinkram: wer die Anrufliste öffnet, will „alle Handwerksbetriebe", nicht fünf
// Häkchen setzen.
//
// Deshalb wird hier nur gruppiert, nie umgeschrieben. Die Branche am Lead bleibt
// unangetastet.
//
// Bewusst über Stichwörter statt über eine Liste der heute vorhandenen Werte:
// Beim nächsten Scrape kommen Dachdecker, Maler und Fliesenleger dazu, und die
// sollen von allein in der Gruppe landen, ohne dass jemand hier nachpflegt.

/** Sammel-Wert des Branchenfilters für alle Handwerksgewerke. */
export const HANDWERK_FILTER = '__handwerk__';

/** Beschriftung im Auswahlfeld. */
export const HANDWERK_LABEL = 'Handwerk (alle Gewerke)';

// ─── Gewerkegruppen ─────────────────────────────────────────────────────────
//
// „Handwerk" ist für die Anrufliste zu grob und das einzelne Gewerk zu fein.
// Am Telefon zählt der Gesprächsaufhänger, und der ist pro Gruppe derselbe:
// Beim Abbruchunternehmer geht es um Angebotsanfragen, beim SHK-Betrieb um den
// Notdienst, bei der Reinigung um Ausschreibungen. Deshalb gruppenweise filtern.
//
// Reihenfolge der Gruppen = Reihenfolge im Auswahlfeld.

export interface Gewerkegruppe {
  id: string;
  label: string;
  /** Stichwörter, die in der Branche vorkommen müssen (umlaut-gefaltet). */
  stichwoerter: string[];
}

export const GEWERKEGRUPPEN: Gewerkegruppe[] = [
  {
    id: 'gebaeudetechnik',
    label: 'Gebäudetechnik (SHK, Elektro, Klima)',
    stichwoerter: [
      'shk', 'sanitaer', 'heizung', 'klempner', 'installat', 'rohr', 'gas', 'wasser',
      'klima', 'kaelte', 'lueftung', 'elektr', 'solar', 'photovoltaik', 'waermepumpe',
      'haustechnik', 'gebaeudetechnik', 'schornsteinfeger', 'energie',
    ],
  },
  {
    id: 'bau',
    label: 'Bau & Rohbau (Maurer, Beton, Bauunternehmen)',
    stichwoerter: [
      'bauunternehm', 'hochbau', 'rohbau', 'maurer', 'beton', 'estrich', 'putz',
      'stuckateur', 'bauwerk', 'bausanierung', 'betonbau', 'tiefbau', 'brunnenbau',
    ],
  },
  {
    id: 'abbruch',
    label: 'Abbruch, Entkernung & Entsorgung',
    stichwoerter: [
      'abbruch', 'entkern', 'rueckbau', 'abriss', 'entsorg', 'containerdienst',
      'container', 'schuttt', 'schutt', 'recycling', 'entruempel', 'raeumung',
      'asbest', 'schadstoffsanierung', 'bodensanierung',
    ],
  },
  {
    id: 'ausbau',
    label: 'Innenausbau (Trockenbau, Maler, Fliesen, Boden)',
    stichwoerter: [
      'trockenbau', 'innenausbau', 'maler', 'lackier', 'anstrich', 'tapezier',
      'fliesenleg', 'fliesen', 'bodenleg', 'parkett', 'laminat', 'teppich',
      'raumausstatt', 'polster', 'daemmung', 'akustik', 'treppenbau',
    ],
  },
  {
    id: 'holz_metall',
    label: 'Holz & Metall (Zimmerei, Schreiner, Metallbau)',
    stichwoerter: [
      'zimmerei', 'zimmerer', 'holzbau', 'schreiner', 'tischler', 'moebel',
      'metallbau', 'schlosser', 'schweiss', 'stahlbau', 'schmied', 'glaser',
      'fensterbau', 'tuerenbau', 'rolladen', 'rollladen', 'markis', 'sonnenschutz',
      'garagentor', 'tore',
    ],
  },
  {
    id: 'dach_fassade',
    label: 'Dach, Fassade & Gerüst',
    stichwoerter: [
      'dachdeck', 'bedachung', 'dach', 'spengler', 'klempnerei', 'fassade',
      'geruestbau', 'geruest', 'steinmetz', 'natursteine', 'abdichtung', 'bauwerksabdichtung',
    ],
  },
  {
    id: 'garten',
    label: 'Garten, Landschaft & Außenanlagen',
    stichwoerter: [
      'garten', 'landschaftsbau', 'galabau', 'gruenanlage', 'baumpflege',
      'baumfaell', 'pflaster', 'zaunbau', 'zaun', 'winterdienst', 'teichbau',
    ],
  },
  {
    id: 'reinigung',
    label: 'Reinigung & Gebäudeservice',
    stichwoerter: [
      'reinig', 'gebaeudereinig', 'gebaeudeservice', 'facility', 'hausmeister',
      'glasreinig', 'teppichreinig', 'industriereinig', 'schaedlingsbekaempf',
      'desinfekt', 'rohrreinig', 'kanalreinig', 'waescherei', 'textilreinig',
    ],
  },
  {
    id: 'transport',
    label: 'Umzug & Transport',
    stichwoerter: [
      'umzug', 'umzuege', 'spedition', 'transport', 'moebeltransport', 'kurier',
      'lagerung', 'moebellift',
    ],
  },
  {
    id: 'fahrzeug',
    label: 'Fahrzeug (KFZ, Werkstatt, Autohaus)',
    stichwoerter: [
      // 'autohaeus' zusätzlich zu 'autohaus': Nach der Umlaut-Faltung wird
      // „Autohäuser" zu „autohaeuser", und das enthält „autohaus" nicht.
      'kfz', 'werkstatt', 'autohaus', 'autohaeus', 'autoservice', 'karosserie', 'lackiererei',
      'reifen', 'abschlepp', 'nutzfahrzeug', 'motorrad', 'fahrrad', 'zweirad',
    ],
  },
  {
    id: 'sonstiges_handwerk',
    label: 'Sonstiges Handwerk',
    stichwoerter: [
      'handwerk', 'schluesseldienst', 'schluessel', 'baecker', 'metzger', 'fleischer',
      'konditor', 'optiker', 'uhrmacher', 'goldschmied', 'schuhmacher', 'naeherei',
      'schneiderei', 'sattler', 'orthopaedietechnik', 'hoerakustik', 'aufzug',
      'kaelteanlagen', 'brandschutz', 'sicherheitstechnik', 'alarmanlagen',
    ],
  },
];

/** Prefix der Gruppen-Werte im Branchenfilter: „grp:bau". */
export const GRUPPE_PREFIX = 'grp:';

const norm = (s: string): string => (s || '').toLowerCase()
  .replace(/[äöüß]/g, m => ({ 'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'ß': 'ss' }[m] || m));

const ALLE_STICHWOERTER = GEWERKEGRUPPEN.flatMap(g => g.stichwoerter);

/** Gehört diese Branche zum Handwerk? */
export function istHandwerk(branche: string | null | undefined): boolean {
  const b = norm(String(branche ?? ''));
  if (!b) return false;
  return ALLE_STICHWOERTER.some(w => b.includes(w));
}

/** Welcher Gewerkegruppe gehört die Branche? Erste Gruppe gewinnt. */
export function gewerkegruppe(branche: string | null | undefined): Gewerkegruppe | undefined {
  const b = norm(String(branche ?? ''));
  if (!b) return undefined;
  return GEWERKEGRUPPEN.find(g => g.stichwoerter.some(w => b.includes(w)));
}

/** Alle Branchen einer Gruppe – zum Filtern in SQL. */
export function branchenDerGruppe(gruppenId: string, branchen: string[]): string[] {
  const gruppe = GEWERKEGRUPPEN.find(g => g.id === gruppenId);
  if (!gruppe) return [];
  return branchen.filter(b => {
    const n = norm(b);
    return gruppe.stichwoerter.some(w => n.includes(w));
  });
}

/**
 * Baut die Auswahlliste: „Handwerk (alle Gewerke)" zuerst, dann die Gruppen,
 * die im Bestand wirklich vorkommen, dann die einzelnen Nicht-Handwerk-Branchen.
 *
 * Gruppen statt einer Liste aller Gewerke, weil die Liste sonst mit jedem Scrape
 * länger wird: 20 Gewerke in einem Auswahlfeld sucht man länger durch als man
 * telefoniert.
 */
export function brancheOptionen(
  branchen: string[],
  /**
   * Betriebe je Branche. Ohne die Zahlen stand in der Auswahl die Anzahl der
   * BRANCHEN-Namen einer Gruppe – „Gebäudetechnik (4)" bei 650 Betrieben. Eine
   * Zahl, die etwas anderes zählt als man liest, ist schlimmer als keine.
   */
  mengen?: Record<string, number>,
): Array<{ value: string; label: string }> {
  const handwerk = branchen.filter(istHandwerk);
  const rest = branchen.filter(b => !istHandwerk(b)).sort((a, b) => a.localeCompare(b, 'de'));
  const zaehle = (bs: string[]) => mengen
    ? bs.reduce((n, b) => n + (mengen[b] ?? 0), 0)
    : undefined;
  const optionen: Array<{ value: string; label: string }> = [];
  if (handwerk.length) {
    const alle = zaehle(handwerk);
    optionen.push({
      value: HANDWERK_FILTER,
      label: alle != null ? `${HANDWERK_LABEL} – ${alle}` : HANDWERK_LABEL,
    });
    for (const gruppe of GEWERKEGRUPPEN) {
      const treffer = branchenDerGruppe(gruppe.id, handwerk);
      if (!treffer.length) continue;
      const n = zaehle(treffer);
      optionen.push({
        value: GRUPPE_PREFIX + gruppe.id,
        label: n != null ? `  ${gruppe.label} – ${n}` : `  ${gruppe.label}`,
      });
    }
  }
  for (const b of rest) {
    const n = mengen?.[b];
    optionen.push({ value: b, label: n != null ? `${b} – ${n}` : b });
  }
  return optionen;
}
