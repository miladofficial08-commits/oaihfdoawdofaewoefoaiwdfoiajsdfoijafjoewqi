// Gemeinsame Typen des Strategie-Workflows. Bewusst ohne DB-Zugriff, damit
// Graph-Definition (strategy.ts), Speicherung (schema.ts) und Ausführung
// (engine.ts) dieselben Begriffe teilen, ohne sich gegenseitig zu importieren.

export type NodeType =
  | 'trigger'   // Einstieg: neuer Lead oder Statuswechsel
  | 'email'     // Vorlage senden
  | 'wait'      // feste Wartezeit
  | 'check'     // Reaktions-Weiche (läuft dauerhaft mit, unterbricht das Warten)
  | 'stage'     // manuelle Stage: der Lead wartet hier auf eine Entscheidung
  | 'call'      // Anruf-Stage mit Ergebnisauswahl
  | 'snooze'    // Wiedervorlage bis zu einem Datum
  | 'task'      // Aufgabe für den Menschen anlegen
  | 'status'    // Lead-Status setzen
  | 'suppress'  // Adresse dauerhaft sperren
  | 'pause'     // Urlaub/Abwesenheit: bis Rückkehr anhalten
  | 'stop';     // Ende des Laufs

/** Farbsprache des Workflows – gilt für Knoten UND Ergebnis-Buttons. */
export type Tone = 'positive' | 'negative' | 'waiting' | 'active' | 'done';

export interface Outcome {
  key: string;
  label: string;
  tone: Tone;
}

// Reaktionen auf eine E-Mail. Diese Ports hat die Reaktions-Weiche.
export type CheckPort =
  | 'no_reply'        // keine Reaktion → nächste Stufe
  | 'interested'      // Interesse / JA
  | 'question'        // Rückfrage – ein Mensch hat geantwortet
  | 'not_interested'  // Absage / NEIN
  | 'auto_reply'      // Abwesenheit / Urlaub
  | 'sonderfall'      // Sammelausgang: später, falscher AP, Bounce
  | 'later'           // bittet um späteren Kontakt
  | 'wrong_contact'   // falscher Ansprechpartner
  | 'bounce'          // Adresse ungültig
  | 'clicked';        // Klick ohne Antwort

// Reihenfolge = Reihenfolge der Äste im Baum (links nach rechts). Dadurch laufen die
// Linien von der Weiche nach unten aus, ohne sich zu kreuzen.
// Standard-Ausgänge einer Weiche: bewusst wenige, damit der Baum lesbar bleibt.
// „Sonderfall" bündelt später/falscher Ansprechpartner/Bounce an einer Stelle.
export const CHECK_PORTS: CheckPort[] = ['no_reply', 'interested', 'not_interested', 'auto_reply', 'sonderfall'];

/** Alle technisch möglichen Ausgänge – für eigene Weichen mit feinerer Aufteilung. */
export const ALL_CHECK_PORTS: CheckPort[] = [
  'no_reply', 'interested', 'question', 'not_interested', 'auto_reply', 'sonderfall',
  'later', 'wrong_contact', 'bounce', 'clicked',
];

/** Wohin eine erkannte Reaktion ausweicht, wenn ihr eigener Ausgang nicht verdrahtet ist. */
export const PORT_FALLBACK: Partial<Record<CheckPort, CheckPort[]>> = {
  question: ['interested'],
  clicked: ['interested'],
  later: ['sonderfall', 'auto_reply'],
  wrong_contact: ['sonderfall'],
  bounce: ['sonderfall', 'not_interested'],
};

export const PORT_LABELS: Record<CheckPort, string> = {
  no_reply: 'Keine Antwort',
  sonderfall: 'Sonderfall',
  interested: 'Interesse',
  question: 'Rückfrage',
  not_interested: 'Kein Interesse',
  auto_reply: 'Urlaub',
  later: 'Später',
  wrong_contact: 'Falscher AP',
  bounce: 'Bounce',
  clicked: 'Klick',
};

export const PORT_TONES: Record<CheckPort, Tone> = {
  no_reply: 'waiting',
  sonderfall: 'waiting',
  interested: 'positive',
  question: 'positive',
  not_interested: 'negative',
  auto_reply: 'waiting',
  later: 'waiting',
  wrong_contact: 'waiting',
  bounce: 'negative',
  clicked: 'active',
};

export interface WorkflowNode {
  id: string;
  type: NodeType;
  title: string;
  x: number;
  y: number;
  config: Record<string, unknown>;
}

export interface WorkflowEdge {
  id: string;
  from: string;
  port: string; // 'out', ein CheckPort oder ein Outcome-Key
  to: string;
}

export interface WorkflowGraph {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

/** Ergebnis-Auswahl eines Knotens (Stage/Anruf) – leer bei allen anderen Typen. */
export function nodeOutcomes(node: WorkflowNode): Outcome[] {
  const raw = (node.config as { outcomes?: unknown }).outcomes;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((o): o is Outcome => Boolean(o) && typeof (o as Outcome).key === 'string')
    .map(o => ({ key: o.key, label: o.label || o.key, tone: o.tone || 'active' }));
}

/** Ausgänge eines Knotens: bestimmt, wohin Kanten gezogen werden können. */
export function nodePorts(node: WorkflowNode): Array<{ key: string; label: string; tone: Tone }> {
  if (node.type === 'stop') return [];
  if (node.type === 'check') {
    const cfg = (node.config as { ports?: string[] }).ports;
    const list = (Array.isArray(cfg) && cfg.length ? cfg : CHECK_PORTS) as CheckPort[];
    return list
      .filter(p => PORT_LABELS[p])
      .map(p => ({ key: p, label: PORT_LABELS[p], tone: PORT_TONES[p] }));
  }
  if (node.type === 'trigger' && (node.config as { route?: string }).route === 'kategorie') {
    return [
      { key: 'angeschrieben', label: 'Angeschrieben', tone: 'active' as Tone },
      { key: 'neu', label: 'Neue Leads', tone: 'active' as Tone },
      { key: 'angerufen', label: 'Angerufen', tone: 'active' as Tone },
      { key: 'kein_kontakt', label: 'Ohne Kontakt', tone: 'done' as Tone },
      { key: 'sonstige', label: 'Sonstige', tone: 'done' as Tone },
    ];
  }
  if (node.type === 'stage' || node.type === 'call') {
    const outs = nodeOutcomes(node);
    return outs.map(o => ({ key: o.key, label: o.label, tone: o.tone }));
  }
  return [{ key: 'out', label: '', tone: 'active' as Tone }];
}

/** Farbrolle eines Knotens für die Darstellung. */
export function nodeTone(node: WorkflowNode): Tone {
  const cfg = node.config as { tone?: Tone; status?: string };
  if (cfg.tone) return cfg.tone;
  switch (node.type) {
    case 'trigger': case 'email': case 'call': case 'task': return 'active';
    case 'wait': case 'snooze': case 'pause': case 'check': return 'waiting';
    case 'suppress': return 'negative';
    case 'stop': return 'done';
    case 'status':
      if (cfg.status === 'won') return 'positive';
      if (cfg.status === 'lost' || cfg.status === 'no_interest' || cfg.status === 'do_not_contact') return 'negative';
      return 'active';
    default: return 'active';
  }
}
