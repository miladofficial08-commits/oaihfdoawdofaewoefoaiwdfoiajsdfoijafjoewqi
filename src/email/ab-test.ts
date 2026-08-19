import { getDb } from '../db/schema';

// ─────────────────────────────────────────────────────────────────────────────
// A/B-Test: Bringt der personalisierte Satz wirklich Antworten?
//
// Ausgangslage: 1823 zugestellte Mails, 451 Öffnungen, EINE Antwort (0,05 %).
// Die Vermutung ist, dass ein nachprüfbarer Satz über den eigenen Betrieb den
// Unterschied macht. Vermutung reicht hier nicht – dafür ist zu viel Arbeit und
// Absender-Reputation im Spiel. Also messen wir es.
//
//   Gruppe A: Vorlage + personalisierter Satz
//   Gruppe B: Vorlage exakt so, wie der Nutzer sie geschrieben hat
//
// Die Zuordnung hängt an der Lead-ID, nicht am Zufall pro Mail. Sonst bekäme
// dieselbe Firma die Erstmail mit Satz und das Follow-up ohne – dann misst man
// nichts mehr. Ein Betrieb bleibt sein Leben lang in derselben Gruppe.
//
// Abschalten: AB_TEST_PERSONALISIERUNG=off  → alle bekommen den Satz (Gruppe A).
// ─────────────────────────────────────────────────────────────────────────────

export type AbGruppe = 'A' | 'B';

export function abTestLaeuft(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.AB_TEST_PERSONALISIERUNG || 'on').trim().toLowerCase() !== 'off';
}

/** Stabile 50/50-Aufteilung über die Lead-ID. */
export function abGruppe(leadId: string | null | undefined, env: NodeJS.ProcessEnv = process.env): AbGruppe {
  if (!abTestLaeuft(env)) return 'A';
  const id = String(leadId || '');
  if (!id) return 'A';
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 2 === 0) ? 'A' : 'B';
}

export interface AbErgebnis {
  gruppe: AbGruppe;
  beschreibung: string;
  gesendet: number;
  zugestellt: number;
  geoeffnet: number;
  geantwortet: number;
  interessiert: number;
  abgemeldet: number;
  antwortquote: string;
}

export interface AbBericht {
  laeuft: boolean;
  seit: string | null;
  gruppen: AbErgebnis[];
  fazit: string;
}

const quote = (a: number, b: number): string => (b > 0 ? (a / b * 100).toFixed(2) + ' %' : '–');

/**
 * Ergebnis des Tests. Zählt nur Mails, die SEIT dem Einbau rausgingen –
 * alles davor hatte noch keine Gruppe und würde das Bild verfälschen.
 */
export function abBericht(): AbBericht {
  const db = getDb();
  const eins = (sql: string, ...a: unknown[]) => {
    try { return (db.prepare(sql).get(...a) as { n: number }).n; } catch { return 0; }
  };

  const seit = (() => {
    try {
      return (db.prepare(
        `SELECT MIN(sent_at) t FROM sent_emails WHERE ab_gruppe IS NOT NULL`
      ).get() as { t: string | null }).t;
    } catch { return null; }
  })();

  const gruppen = (['A', 'B'] as AbGruppe[]).map(g => {
    const gesendet = eins(`SELECT COUNT(*) n FROM sent_emails WHERE ab_gruppe = ? AND success = 1`, g);
    const zugestellt = eins(
      `SELECT COUNT(*) n FROM sent_emails WHERE ab_gruppe = ? AND success = 1
       AND COALESCE(delivery_status,'') NOT IN ('bounced','blocked','invalid')`, g);
    const geoeffnet = eins(
      `SELECT COUNT(DISTINCT lead_id) n FROM sent_emails WHERE ab_gruppe = ? AND success = 1
       AND brevo_opened_at IS NOT NULL`, g);
    // Antwort = ein Mensch hat geschrieben. Auto-Antworten zaehlen nicht.
    const geantwortet = eins(
      `SELECT COUNT(DISTINCT r.lead_id) n FROM inbound_replies r
       WHERE r.category != 'auto_reply' AND r.lead_id IS NOT NULL
         AND r.lead_id IN (SELECT lead_id FROM sent_emails WHERE ab_gruppe = ? AND success = 1)`, g);
    const interessiert = eins(
      `SELECT COUNT(DISTINCT r.lead_id) n FROM inbound_replies r
       WHERE r.category = 'interested' AND r.lead_id IS NOT NULL
         AND r.lead_id IN (SELECT lead_id FROM sent_emails WHERE ab_gruppe = ? AND success = 1)`, g);
    const abgemeldet = eins(
      `SELECT COUNT(DISTINCT l.id) n FROM leads l
       WHERE l.status IN ('no_interest','do_not_contact')
         AND l.id IN (SELECT lead_id FROM sent_emails WHERE ab_gruppe = ? AND success = 1)`, g);

    return {
      gruppe: g,
      beschreibung: g === 'A' ? 'Vorlage + personalisierter Satz' : 'Vorlage unveraendert (Kontrollgruppe)',
      gesendet, zugestellt, geoeffnet, geantwortet, interessiert, abgemeldet,
      antwortquote: quote(geantwortet, zugestellt),
    };
  });

  const [a, b] = gruppen;
  // Bewusst zurueckhaltend: Unter 100 Mails pro Gruppe ist jedes Ergebnis Zufall.
  const genug = a.zugestellt >= 100 && b.zugestellt >= 100;
  const fazit = !genug
    ? `Noch zu wenig Daten (A: ${a.zugestellt}, B: ${b.zugestellt} zugestellt). Ab 100 pro Gruppe wird es aussagekraeftig.`
    : a.geantwortet > b.geantwortet
      ? `Der personalisierte Satz wirkt: ${a.antwortquote} gegen ${b.antwortquote}.`
      : a.geantwortet < b.geantwortet
        ? `Der Satz hilft NICHT: ${a.antwortquote} gegen ${b.antwortquote} ohne ihn.`
        : `Kein Unterschied messbar (${a.antwortquote} zu ${b.antwortquote}).`;

  return { laeuft: abTestLaeuft(), seit, gruppen, fazit };
}
