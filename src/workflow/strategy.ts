import { WorkflowGraph, WorkflowNode, WorkflowEdge, NodeType, Outcome } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Die Standard-Strategie als Stammbaum.
//
//                                  Kunden
//        ┌───────────────┬────────────┴───────┬──────────────────┐
//   Angeschrieben     Neue Leads          Angerufen      Ohne Kontakt / Sonstige
//        │                │                   │
//   Mail → Warten → Weiche   (in jedem Ast gleich aufgebaut)
//        │
//   Nach JEDER Stufe dieselben fünf Ausgänge:
//   Keine Antwort · Interesse · Kein Interesse · Urlaub · Sonderfall
//
// Zwei Regeln halten das Bild sauber:
//   1. Die Weiche wird nach jeder Stufe WIEDERHOLT. Es gibt keine zentrale
//      Weiche mehr, an der alle Linien zusammenlaufen.
//   2. Kleine Endpunkte (Sperren, Urlaub, Sonderfall) stehen als Kopie in jedem
//      Ast, direkt daneben. Nur der große Interessenten-Baum existiert einmal.
// ─────────────────────────────────────────────────────────────────────────────

const COL_ALT = 40, COL_NEU = 620, COL_TEL = 1200, COL_INT = 1780, COL_REST = 2300;
const SIDE = 290;            // Abstand der kleinen Nebenknoten zur Hauptspur
const ROOT_X = 900, ROOT_Y = 40;
const TOP = 250, STEP = 130;

function node(id: string, type: NodeType, title: string, x: number, y: number, config: Record<string, unknown> = {}): WorkflowNode {
  return { id, type, title, x, y, config };
}

function edge(from: string, to: string, port = 'out'): WorkflowEdge {
  return { id: `${from}:${port}->${to}`, from, port, to };
}

function out(key: string, label: string, tone: Outcome['tone']): Outcome {
  return { key, label, tone };
}

/** Ergebnisse, die nach einem Anruf zur Auswahl stehen. */
export const CALL_OUTCOMES: Outcome[] = [
  out('weiterleitung', 'Weiterleitung / AP nicht da', 'active'),
  out('nicht_erreicht', 'Nicht erreicht', 'active'),
  out('ausserhalb', 'Außerhalb Geschäftszeiten', 'active'),
  out('interesse', 'Interesse', 'positive'),
  out('kein_interesse', 'Kein Interesse', 'negative'),
];

// Deine Vorlagen, über den NAMEN referenziert – nicht über interne IDs.
// So bleibt die Strategie an genau den Mails hängen, die du geschrieben hast.
export const VORLAGEN = {
  erstkontakt: ['Anruf um 17:40 Uhr', 'verpasster Anruf'],   // zwei Varianten im Wechsel
  followup1: 'Follow-up 1',
  followup2: 'Follow-up 2',
  letzterVersuch: 'letzter Versuch',
  terminmail: 'Antwort auf Interesse',
  telAusserhalb: 'Anruf außerhalb Ihrer Geschäftszeiten',
  telNichtErreicht: 'telefonisch leider nicht erreicht',
  telWeiterleitung: 'Vielen Dank für die Weiterleitung',
};

// Die Abwesenheitsnotiz ist nur bei der ERSTEN Mail zu erwarten – wer im Urlaub
// ist, hat sie da schon geschickt. Ab Follow-up 1 fällt der Ausgang deshalb weg,
// damit der Baum nicht mit Möglichkeiten zugestellt wird, die nie eintreten.
const CHECK_ERSTE = { ports: ['no_reply', 'interested', 'not_interested', 'auto_reply', 'sonderfall'] };
const CHECK_FOLGE = { ports: ['no_reply', 'interested', 'not_interested', 'sonderfall'] };

interface BranchSpec {
  prefix: string;
  x: number;
  endTitle: string;
  /** template = Name der Vorlage; mehrere = Zufallswechsel (A/B) */
  mails: Array<{ title: string; template: string | string[]; waitDays: number }>;
  /** Mehrere Einstiegsmails (Telefon: je Anrufergebnis eine eigene). */
  entries?: Array<{ id: string; title: string; template: string }>;
}

/**
 * Baut einen Ast: Mail → Warten → Weiche, beliebig oft, dazu die kleinen
 * Endpunkte des Astes. Dadurch sieht jede Stufe identisch aus – man muss den
 * Baum einmal verstehen und kennt dann jeden Ast.
 */
function branch(spec: BranchSpec): { nodes: WorkflowNode[]; edges: WorkflowEdge[]; entry: string } {
  const { prefix, x, mails, endTitle } = spec;
  const side = x + SIDE;
  const nodes: WorkflowNode[] = [];
  const edges: WorkflowEdge[] = [];
  let y = TOP;
  let prevCheck: string | null = null;

  mails.forEach((m, i) => {
    const mail = `${prefix}_mail${i + 1}`, wait = `${prefix}_wait${i + 1}`, check = `${prefix}_check${i + 1}`;
    const erste = i === 0;

    // Beim Telefon-Ast ersetzen drei Einstiegsmails die erste Stufe – für jedes
    // Anrufergebnis die passende Vorlage, danach läuft alles gleich weiter.
    if (erste && spec.entries?.length) {
      spec.entries.forEach((e, k) => {
        nodes.push(node(e.id, 'email', e.title, x + k * SIDE, y, { template_match: e.template }));
        edges.push(edge(e.id, wait));
      });
    } else {
      nodes.push(node(mail, 'email', m.title, x, y, { template_match: m.template }));
      if (prevCheck) edges.push(edge(prevCheck, mail, 'no_reply'));
      edges.push(edge(mail, wait));
    }

    nodes.push(node(wait, 'wait', `${m.waitDays} Tage warten`, x, y + STEP, { days: m.waitDays }));
    nodes.push(node(check, 'check', `Reaktion nach Stufe ${i + 1}`, x, y + 2 * STEP, erste ? CHECK_ERSTE : CHECK_FOLGE));
    edges.push(edge(wait, check));
    prevCheck = check;
    y += 3 * STEP;
  });

  const end = `${prefix}_ende`, task = `${prefix}_task`, stop = `${prefix}_stop`;
  nodes.push(node(end, 'stage', endTitle, x, y, {
    tone: 'waiting',
    outcomes: [out('anrufen', 'Jetzt anrufen', 'active'), out('ende', 'Abschließen', 'done')],
  }));
  nodes.push(node(task, 'task', 'Anrufen · Aufgabe', x, y + STEP,
    { kind: 'call', title: 'Anrufen: keine Antwort auf die Mails', due_hours: 24 }));
  nodes.push(node(stop, 'stop', 'Ast beendet', x, y + 2 * STEP, {}));
  if (prevCheck) edges.push(edge(prevCheck, end, 'no_reply'));
  edges.push(edge(end, task, 'anrufen'), edge(task, stop), edge(end, stop, 'ende'));

  // Kleine Nebenknoten – je Ast einmal, direkt daneben statt quer über den Baum.
  const sperren = `${prefix}_sperren`, kein = `${prefix}_kein`;
  const urlaub = `${prefix}_urlaub`, sonder = `${prefix}_sonder`, wv = `${prefix}_wv`;
  // Die Nebenknoten sitzen auf HALBER HÖHE des Astes. So sind die Wege von der
  // ersten wie von der letzten Weiche etwa gleich kurz, statt einmal quer nach oben.
  const mid = TOP + (mails.length * 3 * STEP) / 2;
  nodes.push(node(sperren, 'suppress', 'Sperren · keine Mails mehr', side, mid - 1.5 * STEP, {}));
  nodes.push(node(kein, 'stage', 'Kein Interesse', side, mid - 0.2 * STEP, { tone: 'negative', status: 'no_interest', outcomes: [] }));
  nodes.push(node(urlaub, 'pause', 'Urlaub · Pause bis Rückkehr', side, mid + 1.1 * STEP, { fallback_days: 7 }));
  nodes.push(node(sonder, 'stage', 'Sonderfall prüfen', side, mid + 2.4 * STEP, {
    tone: 'waiting',
    outcomes: [
      out('weiter', 'Geklärt · weitermachen', 'active'),
      out('spaeter', 'Später melden', 'waiting'),
      out('raus', 'Raus aus der Kampagne', 'negative'),
    ],
  }));
  nodes.push(node(wv, 'snooze', 'Wiedervorlage 30 Tage', side, mid + 3.7 * STEP, { days: 30 }));

  // Eigener Interesse-Einstieg je Ast. Von hier geht EINE Linie in den gemeinsamen
  // Interessenten-Baum – statt zehn Diagonalen quer über das ganze Bild.
  const interesse = `${prefix}_int`;
  nodes.push(node(interesse, 'stage', 'Interessiert', side, mid - 2.8 * STEP, {
    tone: 'positive', status: 'replied',
    outcomes: [out('weiter', 'Termin anbahnen', 'active'), out('doch_nicht', 'Doch kein Interesse', 'negative')],
  }));
  edges.push(edge(interesse, 'int_start', 'weiter'));
  edges.push(edge(interesse, kein, 'doch_nicht'));
  edges.push(edge(sperren, kein));
  edges.push(edge(sonder, spec.entries?.length ? spec.entries[0].id : `${prefix}_mail1`, 'weiter'));
  edges.push(edge(sonder, wv, 'spaeter'));
  edges.push(edge(sonder, kein, 'raus'));

  // Jede Weiche des Astes nutzt dieselben Nebenknoten – gleiche Logik auf jeder Stufe.
  for (let i = 1; i <= mails.length; i++) {
    const check = `${prefix}_check${i}`;
    edges.push(edge(check, interesse, 'interested'));
    edges.push(edge(check, sperren, 'not_interested'));
    edges.push(edge(check, sonder, 'sonderfall'));
    if (i === 1) edges.push(edge(check, urlaub, 'auto_reply'));   // nur nach der Erstmail
  }

  return { nodes, edges, entry: spec.entries?.length ? spec.entries[0].id : `${prefix}_mail1` };
}

export function defaultGraph(): WorkflowGraph {
  // Ast 1 – Bestand: hat die alte Kampagne schon bekommen, bekommt die neuen Texte.
  // Bestand: hat die Erstmail längst bekommen, steigt deshalb bei Follow-up 1 ein.
  const alt = branch({
    prefix: 'alt', x: COL_ALT, endTitle: 'Keine Antwort · Bestand',
    mails: [
      { title: 'Follow-up 1', template: VORLAGEN.followup1, waitDays: 4 },
      { title: 'Follow-up 2', template: VORLAGEN.followup2, waitDays: 6 },
      { title: 'Letzter Versuch', template: VORLAGEN.letzterVersuch, waitDays: 7 },
    ],
  });

  // Ast 2 – noch nie angeschrieben: Erstkontakt + drei Follow-ups.
  // Neue Leads: Erstkontakt in zwei Varianten im Wechsel, dann die drei Follow-ups.
  const neu = branch({
    prefix: 'neu', x: COL_NEU, endTitle: 'Keine Antwort · Neu',
    mails: [
      { title: 'Erstkontakt · 2 Varianten', template: VORLAGEN.erstkontakt, waitDays: 3 },
      { title: 'Follow-up 1', template: VORLAGEN.followup1, waitDays: 5 },
      { title: 'Follow-up 2', template: VORLAGEN.followup2, waitDays: 6 },
      { title: 'Letzter Versuch', template: VORLAGEN.letzterVersuch, waitDays: 7 },
    ],
  });

  // Ast 3 – Telefon: nach dem Anruf dieselbe Mail-Logik wie überall.
  // Telefon: Für jedes Anrufergebnis geht die passende Mail raus, danach läuft
  // dieselbe Follow-up-Logik wie überall.
  const tel = branch({
    prefix: 'tel', x: COL_TEL, endTitle: 'Keine Antwort · Telefon',
    entries: [
      { id: 'tel_ausserhalb', title: 'Außerhalb der Geschäftszeiten', template: VORLAGEN.telAusserhalb },
      { id: 'tel_nicht_erreicht', title: 'Nicht erreicht', template: VORLAGEN.telNichtErreicht },
      { id: 'tel_weiterleitung', title: 'Danke für die Weiterleitung', template: VORLAGEN.telWeiterleitung },
    ],
    mails: [
      { title: 'Mail nach Anruf', template: VORLAGEN.telNichtErreicht, waitDays: 3 },
      { title: 'Follow-up 1', template: VORLAGEN.followup1, waitDays: 6 },
      { title: 'Letzter Versuch', template: VORLAGEN.letzterVersuch, waitDays: 7 },
    ],
  });

  const nodes: WorkflowNode[] = [
    // ── Wurzel: alle Kunden ───────────────────────────────────────────────
    node('kunden', 'trigger', 'Kunden', ROOT_X, ROOT_Y,
      { source: 'new_lead', requires_email: 'any', route: 'kategorie', prioritaet: 'alle', branche: '' }),

    ...alt.nodes,
    ...neu.nodes,

    // Der Anruf steht über dem Telefon-Ast: erst anrufen, dann die Mail-Logik.
    node('anruf', 'call', 'Angerufen', COL_TEL, TOP - STEP, { outcomes: CALL_OUTCOMES }),
    node('anruf_wv', 'snooze', 'Wiedervorlage Anruf', COL_TEL + SIDE, TOP - STEP, { days: 2 }),
    ...tel.nodes,

    // ── Interessenten-Baum: einmal, für alle Äste ─────────────────────────
    node('int_start', 'stage', 'Interessiert', COL_INT, TOP, {
      tone: 'positive', status: 'replied',
      outcomes: [out('termin', 'Terminlink senden', 'active'), out('kein_kunde', 'Doch kein Interesse', 'negative')],
    }),
    node('int_mail', 'email', 'Terminlink senden', COL_INT, TOP + STEP, { template_match: VORLAGEN.terminmail, urgent: true }),
    node('int_wait', 'wait', '2 Tage warten', COL_INT, TOP + 2 * STEP, { days: 2 }),
    node('int_termin', 'stage', 'Termin gebucht?', COL_INT, TOP + 3 * STEP, {
      tone: 'waiting',
      outcomes: [
        out('gebucht', 'Termin gebucht', 'positive'),
        out('nachfassen', 'Wiedervorlage', 'waiting'),
        out('abgesagt', 'Kein Termin', 'negative'),
      ],
    }),
    node('int_wv', 'snooze', 'Wiedervorlage 2 Tage', COL_INT + SIDE, TOP + 3 * STEP, { days: 2 }),
    node('int_gespraech', 'stage', 'Gespräch', COL_INT, TOP + 4 * STEP, {
      tone: 'positive', status: 'demo_booked',
      outcomes: [out('angebot', 'Angebot senden', 'active'), out('kein_kunde', 'Kein Kunde', 'negative')],
    }),
    node('int_angebot', 'stage', 'Angebot', COL_INT, TOP + 5 * STEP, {
      tone: 'active', status: 'proposal_sent',
      outcomes: [out('kunde', 'Kunde gewonnen', 'positive'), out('kein_kunde', 'Kein Kunde', 'negative')],
    }),
    node('int_kunde', 'stage', 'Kunde', COL_INT, TOP + 6 * STEP, { tone: 'positive', status: 'won', outcomes: [] }),
    node('int_kein_kunde', 'stage', 'Kein Kunde', COL_INT + SIDE, TOP + 6 * STEP, { tone: 'negative', status: 'lost', outcomes: [] }),

    // ── Restkategorien ────────────────────────────────────────────────────
    node('ohne_kontakt', 'stage', 'Ohne Kontakt', COL_REST, TOP, {
      tone: 'done',
      outcomes: [out('kontakt_da', 'Kontakt nachgetragen', 'active'), out('raus', 'Aussortieren', 'negative')],
    }),
    node('sonstige', 'stage', 'Sonstige · aus der Kampagne', COL_REST, TOP + 2 * STEP, {
      tone: 'done', outcomes: [out('zurueck', 'Doch wieder aufnehmen', 'active')],
    }),
    node('rest_stop', 'stop', 'Beendet', COL_REST, TOP + 4 * STEP, {}),
  ];

  const edges: WorkflowEdge[] = [
    // Wurzel → die vier Kategorien
    edge('kunden', alt.entry, 'angeschrieben'),
    edge('kunden', neu.entry, 'neu'),
    edge('kunden', 'anruf', 'angerufen'),
    edge('kunden', 'ohne_kontakt', 'kein_kontakt'),
    edge('kunden', 'sonstige', 'sonstige'),

    ...alt.edges,
    ...neu.edges,
    ...tel.edges,

    // Anruf-Ergebnisse: drei führen in denselben Mail-Nachlauf
    edge('anruf', 'tel_weiterleitung', 'weiterleitung'),
    edge('anruf', 'tel_nicht_erreicht', 'nicht_erreicht'),
    edge('anruf', 'tel_ausserhalb', 'ausserhalb'),
    edge('anruf', 'int_start', 'interesse'),
    edge('anruf', 'tel_sperren', 'kein_interesse'),
    edge('anruf_wv', 'anruf'),

    // Interessenten-Baum
    edge('int_start', 'int_mail', 'termin'),
    edge('int_start', 'int_kein_kunde', 'kein_kunde'),
    edge('int_mail', 'int_wait'),
    edge('int_wait', 'int_termin'),
    edge('int_termin', 'int_gespraech', 'gebucht'),
    edge('int_termin', 'int_wv', 'nachfassen'),
    edge('int_termin', 'int_kein_kunde', 'abgesagt'),
    edge('int_wv', 'int_termin'),
    edge('int_gespraech', 'int_angebot', 'angebot'),
    edge('int_gespraech', 'int_kein_kunde', 'kein_kunde'),
    edge('int_angebot', 'int_kunde', 'kunde'),
    edge('int_angebot', 'int_kein_kunde', 'kein_kunde'),

    // Restkategorien
    edge('ohne_kontakt', 'anruf', 'kontakt_da'),
    edge('ohne_kontakt', 'rest_stop', 'raus'),
    edge('sonstige', neu.entry, 'zurueck'),
  ];

  return { nodes, edges };
}
