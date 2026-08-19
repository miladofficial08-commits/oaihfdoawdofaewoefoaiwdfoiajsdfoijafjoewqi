import { getDb } from '../db/schema';
import { analyzeWebsite, analyzeImpressum } from '../analyzer/website-checker';

// ─────────────────────────────────────────────────────────────────────────────
// E-Mail-Ernte: holt aus den Websites der Leads die Kontaktadresse.
//
// Warum ein eigener Worker und nicht der bestehende Reanalyze-Aufruf?
// Der läuft synchron in einem HTTP-Request. Bei 5.000 Websites × mehreren
// Sekunden sind das Stunden – der Railway-Proxy kappt die Verbindung nach ein
// paar Minuten, und der Lauf ist weg. Dieser Worker arbeitet stattdessen in
// kleinen Häppchen im Hintergrund weiter, überlebt Unterbrechungen und kann
// jederzeit angehalten werden.
//
// Er fasst nur Leads an, die eine Website, aber noch KEINE E-Mail haben, und
// überschreibt niemals vorhandene Daten.
// ─────────────────────────────────────────────────────────────────────────────

const BATCH = 5;              // wie viele Seiten gleichzeitig
const PAUSE_MS = 1500;        // Pause zwischen den Häppchen – höflich bleiben

export interface HarvestProgress {
  laeuft: boolean;
  geprueft: number;
  gefunden: number;
  /** Wie oft wir den Namen des Chefs gefunden haben – Türöffner am Telefon. */
  chefs: number;
  /** Direkt-/Mobilnummern: gehen am Vorzimmer vorbei. */
  direktnummern: number;
  offen: number;
  aktuell: string;
  fehler: number;
  gestartet?: string;
  fertig?: string;
}

const state: HarvestProgress = {
  laeuft: false, geprueft: 0, gefunden: 0, chefs: 0, direktnummern: 0, offen: 0, aktuell: '', fehler: 0,
};

let stopRequested = false;

/** Leads mit Website, aber ohne E-Mail – das sind die Kandidaten. */
export function offeneWebsites(track?: string): number {
  const where = track ? ` AND COALESCE(track,'voice_agent') = @track` : '';
  return (getDb().prepare(
    `SELECT COUNT(*) n FROM leads
     WHERE (email IS NULL OR email = '')
       AND website IS NOT NULL AND website != ''
       AND COALESCE(status,'') NOT IN ('duplicate','archived')${where}`
  ).get(track ? { track } : {}) as { n: number }).n;
}

export function harvestProgress(): HarvestProgress {
  return { ...state, offen: offeneWebsites() };
}

export function stopHarvest(): void {
  stopRequested = true;
}

interface Kandidat { id: string; name: string; website: string }

function naechste(limit: number, track?: string): Kandidat[] {
  const where = track ? ` AND COALESCE(track,'voice_agent') = @track` : '';
  return getDb().prepare(
    `SELECT id, name, website FROM leads
     WHERE (email IS NULL OR email = '')
       AND website IS NOT NULL AND website != ''
       AND COALESCE(status,'') NOT IN ('duplicate','archived')
       AND (checked_at IS NULL OR checked_at < datetime('now','-30 day'))${where}
     ORDER BY COALESCE(score_gesamt,0) DESC
     LIMIT @limit`
  ).all(track ? { limit, track } : { limit }) as Kandidat[];
}

/**
 * Erntet E-Mails, bis nichts mehr offen ist oder gestoppt wird.
 * Gibt sofort zurück, wenn bereits ein Lauf aktiv ist.
 */
export async function harvestEmails(opts: { track?: string; max?: number } = {}): Promise<HarvestProgress> {
  if (state.laeuft) return harvestProgress();
  stopRequested = false;
  Object.assign(state, {
    laeuft: true, geprueft: 0, gefunden: 0, chefs: 0, direktnummern: 0, aktuell: '', fehler: 0,
    gestartet: new Date().toISOString(), fertig: undefined,
  });

  const db = getDb();
  // Ein Durchlauf, drei Dinge: E-Mail, Name des Chefs und seine Direktnummer.
  // Der Name ist der Türöffner am Telefon („Guten Tag, Herr Meinert bitte"),
  // die Mobil-/Durchwahlnummer geht am Vorzimmer komplett vorbei.
  const update = db.prepare(
    `UPDATE leads SET email = COALESCE(NULLIF(email,''), @email),
                      email_normalized = COALESCE(NULLIF(email_normalized,''), LOWER(TRIM(@email))),
                      geschaeftsfuehrer = COALESCE(NULLIF(geschaeftsfuehrer,''), @gf),
                      kontaktformular_url = COALESCE(NULLIF(kontaktformular_url,''), @form),
                      telefon_direkt = COALESCE(NULLIF(telefon_direkt,''), @direkt),
                      telefon_direkt_typ = COALESCE(NULLIF(telefon_direkt_typ,''), @direkt_typ),
                      telefon_notdienst = COALESCE(NULLIF(telefon_notdienst,''), @notdienst),
                      impressum_url = COALESCE(NULLIF(impressum_url,''), @impressum),
                      impressum_checked_at = datetime('now'),
                      hat_website = 1,
                      checked_at = datetime('now'),
                      updated_at = datetime('now')
     WHERE id = @id`
  );
  const touch = db.prepare(`UPDATE leads SET checked_at = datetime('now') WHERE id = @id`);

  const max = opts.max ?? Number.MAX_SAFE_INTEGER;

  while (!stopRequested && state.geprueft < max) {
    const batch = naechste(BATCH, opts.track);
    if (!batch.length) break;

    await Promise.all(batch.map(async lead => {
      state.aktuell = lead.name;
      try {
        const a = await analyzeWebsite(lead.website);
        // Impressum zusätzlich lesen: dort stehen Chef-Name und Direktnummer.
        let imp: Awaited<ReturnType<typeof analyzeImpressum>> | null = null;
        try { imp = await analyzeImpressum(lead.website, undefined, lead.name); } catch { /* optional */ }
        state.geprueft++;

        const gf = a.geschaeftsfuehrer || imp?.geschaeftsfuehrer || null;
        const direkt = imp?.telefon_direkt || null;
        if (a.email || gf || direkt) {
          update.run({
            id: lead.id,
            email: a.email ?? null,
            gf,
            form: a.kontaktformular_url ?? null,
            direkt,
            direkt_typ: imp?.telefon_direkt_typ ?? null,
            notdienst: imp?.telefon_notdienst ?? null,
            impressum: imp?.impressum_url ?? null,
          });
          if (a.email) state.gefunden++;
          if (gf) state.chefs++;
          if (direkt) state.direktnummern++;
        } else {
          // Trotzdem als geprüft markieren, sonst läuft der Worker im Kreis.
          touch.run({ id: lead.id });
        }
      } catch {
        state.geprueft++;
        state.fehler++;
        touch.run({ id: lead.id });
      }
    }));

    await new Promise(r => setTimeout(r, PAUSE_MS));
  }

  state.laeuft = false;
  state.aktuell = '';
  state.fertig = new Date().toISOString();
  console.log(`[email-harvest] fertig: ${state.geprueft} Seiten, ${state.gefunden} E-Mails, ${state.chefs} Chef-Namen, ${state.direktnummern} Direktnummern`);
  return harvestProgress();
}
