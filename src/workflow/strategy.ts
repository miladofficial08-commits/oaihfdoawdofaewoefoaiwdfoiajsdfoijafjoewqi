import { WorkflowGraph, WorkflowNode, WorkflowEdge, NodeType, Outcome } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Die Standard-Strategie als Stammbaum.
//
// Eine Regel hält das Bild sauber: JEDE Weiche bekommt ihre EIGENEN
// Folgeknoten. Früher zeigten fünf Weichen auf denselben „Kein Interesse"-
// Knoten und alle Äste auf denselben Interessenten-Baum – dadurch liefen
// Linien quer über die ganze Karte und man sah nicht mehr, was wohin gehört.
//
// Jetzt gilt: keine Linie verlässt ihren Ast, und keine geht nach oben.
// Das kostet mehr Knoten, dafür ist jede Stufe für sich lesbar.
//
// Aufbau je Ast – vier Spalten nebeneinander:
//
//   Spalte 0            Spalte 1                Spalte 2          Spalte 3
//   Mailstrecke         Ausgänge DIESER Weiche  Terminstrecke     Nebenwege
//   ─────────────────────────────────────────────────────────────────────────
//   Mail 1
//   Warten                                      Terminlink senden
//   Weiche 1  ────────► Interessiert 1  ──────► Warten
//             ────────► Kein Interesse 1        Termin gebucht? ──► Wiedervorlage
//             ────────► Sonderfall 1            Gespräch
//   Mail 2                                      Angebot ──────────► Kein Kunde
//   Warten                                      Kunde
//   Weiche 2  ────────► Interessiert 2
//             ────────► Kein Interesse 2
//             ────────► Sonderfall 2
//   …
//   Keine Antwort · Ende
// ─────────────────────────────────────────────────────────────────────────────

const LANE = 300;      // Abstand der Spalten innerhalb eines Astes
const ROW = 150;       // Zeilenabstand
const BLOCK = 1400;    // Abstand zwischen den Ästen – bewusst großzügig
const ROOT_X = 1500, ROOT_Y = 40;
const TOP = 300;

function node(id: string, type: NodeType, title: string, x: number, y: number, config: Record<string, unknown> = {}): WorkflowNode {
  return { id, type, title, x, y, config };
}

function edge(from: string, to: string, port = 'out'): WorkflowEdge {
  return { id: from + ':' + port + '->' + to, from, port, to };
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
 * Baut einen kompletten Ast: Mailstrecke, je Weiche eigene Ausgänge und eine
 * eigene Terminstrecke. Der Ast ist in sich geschlossen – nichts davon teilt er
 * mit einem anderen Ast.
 */
function branch(spec: BranchSpec): { nodes: WorkflowNode[]; edges: WorkflowEdge[]; entry: string } {
  const { prefix: p, x, mails, endTitle } = spec;
  const L0 = x, L1 = x + LANE, L2 = x + 2 * LANE, L3 = x + 3 * LANE;
  const nodes: WorkflowNode[] = [];
  const edges: WorkflowEdge[] = [];
  const entry = spec.entries?.length ? spec.entries[0].id : p + '_mail1';

  let row = 0;
  let letzteWeicheRow = 0;
  let prevCheck: string | null = null;

  mails.forEach((m, i) => {
    const nr = i + 1;
    const mail = p + '_mail' + nr, wait = p + '_wait' + nr, check = p + '_check' + nr;
    const erste = i === 0;

    // Telefon-Ast: drei Einstiegsmails, je nach Anrufergebnis. Sie stehen
    // untereinander in derselben Spalte und laufen danach zusammen weiter.
    if (erste && spec.entries?.length) {
      spec.entries.forEach(e => {
        nodes.push(node(e.id, 'email', e.title, L0, TOP + row * ROW, { template_match: e.template }));
        edges.push(edge(e.id, wait));
        row++;
      });
    } else {
      nodes.push(node(mail, 'email', m.title, L0, TOP + row * ROW, { template_match: m.template }));
      if (prevCheck) edges.push(edge(prevCheck, mail, 'no_reply'));
      edges.push(edge(mail, wait));
      row++;
    }

    nodes.push(node(wait, 'wait', m.waitDays + ' Tage warten', L0, TOP + row * ROW, { days: m.waitDays }));
    row++;
    const checkRow = row;
    nodes.push(node(check, 'check', 'Reaktion nach Stufe ' + nr, L0, TOP + checkRow * ROW, erste ? CHECK_ERSTE : CHECK_FOLGE));
    edges.push(edge(wait, check));
    row++;

    letzteWeicheRow = checkRow;

    // ── Die drei eigenen Ausgänge DIESER Weiche, direkt daneben ──
    const int = p + '_int' + nr, kein = p + '_kein' + nr, pruef = p + '_pruef' + nr;

    nodes.push(node(int, 'stage', 'Interessiert · Stufe ' + nr, L1, TOP + checkRow * ROW, {
      tone: 'positive', status: 'replied',
      outcomes: [out('weiter', 'Termin anbahnen', 'active'), out('doch_nicht', 'Doch kein Interesse', 'negative')],
    }));
    // Sonderfall steht auf der Hoehe der naechsten Mail: dann laeuft
    // "Geklaert - weitermachen" waagerecht hinueber statt schraeg nach oben.
    nodes.push(node(pruef, 'stage', 'Sonderfall · Stufe ' + nr, L1, TOP + (checkRow + 1) * ROW, {
      tone: 'waiting',
      outcomes: [
        out('weiter', 'Geklärt · weitermachen', 'active'),
        out('spaeter', 'Später melden', 'waiting'),
        out('raus', 'Raus aus der Kampagne', 'negative'),
      ],
    }));
    nodes.push(node(kein, 'suppress', 'Kein Interesse · Stufe ' + nr, L1, TOP + (checkRow + 2) * ROW,
      { tone: 'negative', status: 'no_interest' }));

    edges.push(edge(check, int, 'interested'));
    edges.push(edge(check, kein, 'not_interested'));
    edges.push(edge(check, pruef, 'sonderfall'));
    edges.push(edge(int, p + '_termin_mail', 'weiter'));
    edges.push(edge(int, kein, 'doch_nicht'));
    edges.push(edge(pruef, kein, 'raus'));
    edges.push(edge(pruef, p + '_wv', 'spaeter'));
    // Geklaert heisst: weiter in der Strecke – nicht zurueck an den Anfang.
    // Bei der letzten Stufe gibt es keine naechste Mail mehr, dann ans Ende.
    edges.push(edge(pruef, nr < mails.length ? p + '_mail' + (nr + 1) : p + '_ende', 'weiter'));

    // Urlaub gibt es nur nach der ersten Mail – danach ist die Abwesenheit
    // längst gemeldet. Der Knoten steht neben dem Warten, nicht neben der Weiche.
    if (erste) {
      const urlaub = p + '_urlaub';
      nodes.push(node(urlaub, 'pause', 'Urlaub · Pause bis Rückkehr', L1, TOP + (checkRow - 1) * ROW, { fallback_days: 7 }));
      edges.push(edge(check, urlaub, 'auto_reply'));
      // Nach der Rueckkehr geht es mit der naechsten Mail weiter, nicht von vorn.
      if (mails.length > 1) edges.push(edge(urlaub, p + '_mail2'));
    }

    prevCheck = check;
  });

  // ── Ende der Mailstrecke ──
  const end = p + '_ende', task = p + '_task', stop = p + '_stop';
  nodes.push(node(end, 'stage', endTitle, L0, TOP + row * ROW, {
    tone: 'waiting',
    outcomes: [out('anrufen', 'Jetzt anrufen', 'active'), out('ende', 'Abschließen', 'done')],
  }));
  nodes.push(node(task, 'task', 'Anrufen · Aufgabe', L0, TOP + (row + 1) * ROW,
    { kind: 'call', title: 'Anrufen: keine Antwort auf die Mails', due_hours: 24 }));
  nodes.push(node(stop, 'stop', 'Ast beendet', L0, TOP + (row + 2) * ROW, {}));
  if (prevCheck) edges.push(edge(prevCheck, end, 'no_reply'));
  edges.push(edge(end, task, 'anrufen'), edge(task, stop), edge(end, stop, 'ende'));

  // Sammel-Wiedervorlage des Astes: steht UNTER allen Weichen, alle Linien
  // laufen also nach unten. Danach geht es von vorn los.
  const wv = p + '_wv';
  nodes.push(node(wv, 'snooze', 'Wiedervorlage 30 Tage', L1, TOP + (letzteWeicheRow + 3) * ROW, { days: 30 }));
  edges.push(edge(wv, entry));

  // ── Eigene Terminstrecke des Astes (Spalte 2 und 3) ──
  const t = (s: string) => p + '_' + s;
  // Die Terminstrecke beginnt UNTER der letzten Weiche. Nur so laufen die Linien
  // von jeder "Interessiert"-Stufe nach unten statt quer nach oben.
  const ty = (r: number) => TOP + (letzteWeicheRow + 3 + r) * ROW;

  nodes.push(node(t('termin_mail'), 'email', 'Terminlink senden', L2, ty(0),
    { template_match: VORLAGEN.terminmail, urgent: true }));
  nodes.push(node(t('termin_wait'), 'wait', '2 Tage warten', L2, ty(1), { days: 2 }));
  nodes.push(node(t('termin'), 'stage', 'Termin gebucht?', L2, ty(2), {
    tone: 'waiting',
    outcomes: [
      out('gebucht', 'Termin gebucht', 'positive'),
      out('nachfassen', 'Wiedervorlage', 'waiting'),
      out('abgesagt', 'Kein Termin', 'negative'),
    ],
  }));
  nodes.push(node(t('termin_wv'), 'snooze', 'Wiedervorlage 2 Tage', L3, ty(2), { days: 2 }));
  nodes.push(node(t('gespraech'), 'stage', 'Gespräch', L2, ty(3), {
    tone: 'positive', status: 'demo_booked',
    outcomes: [out('angebot', 'Angebot senden', 'active'), out('kein_kunde', 'Kein Kunde', 'negative')],
  }));
  nodes.push(node(t('angebot'), 'stage', 'Angebot', L2, ty(4), {
    tone: 'active', status: 'proposal_sent',
    outcomes: [out('kunde', 'Kunde gewonnen', 'positive'), out('kein_kunde', 'Kein Kunde', 'negative')],
  }));
  nodes.push(node(t('kunde'), 'stage', 'Kunde', L2, ty(5), { tone: 'positive', status: 'won', outcomes: [] }));
  nodes.push(node(t('kein_kunde'), 'stage', 'Kein Kunde', L3, ty(4), { tone: 'negative', status: 'lost', outcomes: [] }));

  edges.push(
    edge(t('termin_mail'), t('termin_wait')),
    edge(t('termin_wait'), t('termin')),
    edge(t('termin'), t('gespraech'), 'gebucht'),
    edge(t('termin'), t('termin_wv'), 'nachfassen'),
    edge(t('termin'), t('kein_kunde'), 'abgesagt'),
    edge(t('termin_wv'), t('termin')),
    edge(t('gespraech'), t('angebot'), 'angebot'),
    edge(t('gespraech'), t('kein_kunde'), 'kein_kunde'),
    edge(t('angebot'), t('kunde'), 'kunde'),
    edge(t('angebot'), t('kein_kunde'), 'kein_kunde'),
  );

  return { nodes, edges, entry };
}

export function defaultGraph(): WorkflowGraph {
  const COL_ALT = 40, COL_NEU = 40 + BLOCK, COL_TEL = 40 + 2 * BLOCK;
  // Die Restkategorien stehen direkt neben der Wurzel, nicht am aeusseren Rand.
  // Sonst zieht "Doch wieder aufnehmen" eine Linie ueber die halbe Karte.
  const COL_REST = ROOT_X + 500;

  // Ast 1 – Bestand: hat die Erstmail längst bekommen, steigt bei Follow-up 1 ein.
  const alt = branch({
    prefix: 'alt', x: COL_ALT, endTitle: 'Keine Antwort · Bestand',
    mails: [
      { title: 'Follow-up 1', template: VORLAGEN.followup1, waitDays: 4 },
      { title: 'Follow-up 2', template: VORLAGEN.followup2, waitDays: 6 },
      { title: 'Letzter Versuch', template: VORLAGEN.letzterVersuch, waitDays: 7 },
    ],
  });

  // Ast 2 – noch nie angeschrieben: Erstkontakt in zwei Varianten, dann Follow-ups.
  const neu = branch({
    prefix: 'neu', x: COL_NEU, endTitle: 'Keine Antwort · Neu',
    mails: [
      { title: 'Erstkontakt · 2 Varianten', template: VORLAGEN.erstkontakt, waitDays: 3 },
      { title: 'Follow-up 1', template: VORLAGEN.followup1, waitDays: 5 },
      { title: 'Follow-up 2', template: VORLAGEN.followup2, waitDays: 6 },
      { title: 'Letzter Versuch', template: VORLAGEN.letzterVersuch, waitDays: 7 },
    ],
  });

  // Ast 3 – Telefon: für jedes Anrufergebnis die passende Mail, dann wie überall.
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
    node('kunden', 'trigger', 'Kunden', ROOT_X, ROOT_Y,
      { source: 'new_lead', requires_email: 'any', route: 'kategorie', prioritaet: 'alle', branche: '' }),

    ...alt.nodes,
    ...neu.nodes,

    // Der Anruf steht über dem Telefon-Ast: erst anrufen, dann die Mail-Logik.
    node('anruf', 'call', 'Angerufen', COL_TEL, TOP - 2 * ROW, { outcomes: CALL_OUTCOMES }),
    node('anruf_wv', 'snooze', 'Wiedervorlage Anruf', COL_TEL + LANE, TOP - 2 * ROW, { days: 2 }),
    ...tel.nodes,

    // ── Restkategorien ────────────────────────────────────────────────────
    node('ohne_kontakt', 'stage', 'Ohne Kontakt', COL_REST, ROOT_Y, {
      tone: 'done',
      outcomes: [out('kontakt_da', 'Kontakt nachgetragen', 'active'), out('raus', 'Aussortieren', 'negative')],
    }),
    node('sonstige', 'stage', 'Sonstige · aus der Kampagne', COL_REST, ROOT_Y + 2 * ROW, {
      tone: 'done', outcomes: [out('zurueck', 'Doch wieder aufnehmen', 'active')],
    }),
    node('rest_stop', 'stop', 'Beendet', COL_REST + LANE, ROOT_Y + 2 * ROW, {}),
  ];

  const edges: WorkflowEdge[] = [
    edge('kunden', alt.entry, 'angeschrieben'),
    edge('kunden', neu.entry, 'neu'),
    edge('kunden', 'anruf', 'angerufen'),
    edge('kunden', 'ohne_kontakt', 'kein_kontakt'),
    edge('kunden', 'sonstige', 'sonstige'),

    ...alt.edges,
    ...neu.edges,
    ...tel.edges,

    // Anruf-Ergebnisse führen in den Telefon-Ast – jedes in seine eigene Mail.
    edge('anruf', 'tel_weiterleitung', 'weiterleitung'),
    edge('anruf', 'tel_nicht_erreicht', 'nicht_erreicht'),
    edge('anruf', 'tel_ausserhalb', 'ausserhalb'),
    edge('anruf', 'tel_termin_mail', 'interesse'),
    edge('anruf', 'tel_kein1', 'kein_interesse'),
    edge('anruf_wv', 'anruf'),

    edge('ohne_kontakt', 'anruf', 'kontakt_da'),
    edge('ohne_kontakt', 'rest_stop', 'raus'),
    edge('sonstige', neu.entry, 'zurueck'),
  ];

  return { nodes, edges };
}
