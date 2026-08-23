import { getDb } from '../db/schema';
import { versandGestoppt } from './mailer';

// ─────────────────────────────────────────────────────────────────────────────
// Der Stopp muss überall gleichzeitig gelten – und man muss ihn sehen.
//
// Nach dem Vorfall vom 20.–22.08. reicht „die Variable ist gesetzt" nicht. Im
// Dashboard stand der Auto-Versand weiter auf aktiv, und man kann einer Anzeige
// nicht vertrauen, die etwas anderes behauptet als das System tut.
//
// Deshalb zieht der Not-Aus bei jedem Start alle Schalter mit:
//   • jede aktive Strategie wird deaktiviert
//   • laufende Auto-Kampagnen werden gestoppt
//   • der Follow-up-Worker wird abgeschaltet
//   • eingeplante Mails werden abgeräumt
//
// Nichts davon wird gelöscht. Strategien, Leads, Stages und Vorlagen bleiben
// vollständig erhalten – sie stehen nur still. Zurückdrehen heisst: Variable
// entfernen und wieder einschalten.
// ─────────────────────────────────────────────────────────────────────────────

export interface StoppErgebnis {
  aktiv: boolean;
  strategien: string[];
  kampagnen: number;
  followup: boolean;
  geplante: number;
}

export function erzwingeVersandStopp(): StoppErgebnis {
  const raus: StoppErgebnis = { aktiv: versandGestoppt(), strategien: [], kampagnen: 0, followup: false, geplante: 0 };
  if (!raus.aktiv) return raus;

  const db = getDb();
  const still = <T>(fn: () => T, fallback: T): T => { try { return fn(); } catch { return fallback; } };

  raus.strategien = still(() => {
    const offen = db.prepare(`SELECT id, name FROM workflows WHERE enabled = 1`).all() as Array<{ id: string; name: string }>;
    if (offen.length) db.prepare(`UPDATE workflows SET enabled = 0, updated_at = datetime('now') WHERE enabled = 1`).run();
    return offen.map(o => o.name);
  }, []);

  raus.kampagnen = still(() => db.prepare(
    `UPDATE send_jobs SET status = 'stopped', note = 'Not-Aus: Versand gestoppt' WHERE status = 'running'`
  ).run().changes, 0);

  raus.followup = still(() => db.prepare(
    `UPDATE followup_config SET enabled = 0, updated_at = datetime('now') WHERE id = 1 AND enabled = 1`
  ).run().changes > 0, false);

  raus.geplante = still(() => db.prepare(
    `UPDATE scheduled_emails SET status = 'cancelled', error = 'Not-Aus: Versand gestoppt', updated_at = datetime('now')
     WHERE status IN ('scheduled','processing')`
  ).run().changes, 0);

  console.warn('[NOT-AUS] Versand ist gestoppt. Es geht keine E-Mail raus.');
  if (raus.strategien.length) console.warn('[NOT-AUS]   Strategien deaktiviert: ' + raus.strategien.join(', '));
  if (raus.kampagnen) console.warn('[NOT-AUS]   Auto-Kampagnen gestoppt: ' + raus.kampagnen);
  if (raus.followup) console.warn('[NOT-AUS]   Follow-up-Worker abgeschaltet');
  if (raus.geplante) console.warn('[NOT-AUS]   eingeplante Mails abgeraeumt: ' + raus.geplante);
  console.warn('[NOT-AUS]   Nichts wurde geloescht – Strategien und Leads bleiben vollstaendig erhalten.');
  return raus;
}

/** Für die Anzeige im Dashboard: Läuft der Not-Aus, und was heisst das? */
export function stoppStatus(): { gestoppt: boolean; text: string } {
  if (!versandGestoppt()) return { gestoppt: false, text: 'Versand ist freigegeben.' };
  return {
    gestoppt: true,
    text: 'NOT-AUS AKTIV – es wird keine einzige E-Mail versendet. '
      + 'Strategien, Leads und Vorlagen bleiben erhalten, sie stehen nur still. '
      + 'Zum Aufheben: Variable VERSAND_STOPP in Railway entfernen.',
  };
}
