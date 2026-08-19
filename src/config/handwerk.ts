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

const STICHWORTE = [
  'handwerk',
  // Gebäudetechnik
  'shk', 'sanitaer', 'heizung', 'klima', 'kaelte', 'lueftung', 'installat', 'rohr',
  'elektr', 'solar', 'photovoltaik', 'waermepumpe',
  // Bau und Ausbau
  'dachdeck', 'maler', 'lackier', 'zimmerei', 'schreiner', 'tischler', 'fliesenleg',
  'stuckateur', 'metallbau', 'glaser', 'fensterbau', 'steinmetz', 'geruestbau',
  'bodenleg', 'daemmung', 'holzbau', 'trockenbau', 'estrich', 'bauunternehm',
  // Übriges Handwerk
  'kfz', 'werkstatt', 'schluesseldienst', 'schornsteinfeger', 'garten', 'landschaftsbau',
  'baecker', 'metzger', 'fleischer', 'polster', 'raumausstatt',
];

const norm = (s: string): string => (s || '').toLowerCase()
  .replace(/[äöüß]/g, m => ({ 'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'ß': 'ss' }[m] || m));

/** Gehört diese Branche zum Handwerk? */
export function istHandwerk(branche: string | null | undefined): boolean {
  const b = norm(String(branche ?? ''));
  if (!b) return false;
  return STICHWORTE.some(w => b.includes(w));
}

/**
 * Baut die Auswahlliste: alle Handwerksgewerke zu einem Eintrag zusammengefasst,
 * alles andere bleibt einzeln stehen.
 */
export function brancheOptionen(branchen: string[]): Array<{ value: string; label: string }> {
  const handwerk = branchen.filter(istHandwerk);
  const rest = branchen.filter(b => !istHandwerk(b)).sort((a, b) => a.localeCompare(b, 'de'));
  const optionen: Array<{ value: string; label: string }> = [];
  if (handwerk.length) optionen.push({ value: HANDWERK_FILTER, label: HANDWERK_LABEL });
  for (const b of rest) optionen.push({ value: b, label: b });
  return optionen;
}
