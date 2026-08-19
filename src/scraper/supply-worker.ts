import { getDb } from '../db/schema';
import { getSetting, setSetting } from '../workflow/schema';
import { harvestEmails, harvestProgress, offeneWebsites } from './email-harvester';
import { scrapeHandwerkRegion, handwerkProgress } from './osm';

// ─────────────────────────────────────────────────────────────────────────────
// Nachschub-Automatik: hält die Lead-Liste von allein gefüllt.
//
// Die Kampagne ist nur so gut wie ihr Futter. Wenn der Vorrat leerläuft, steht
// die ganze Maschine – und das merkt niemand, der gerade telefoniert. Deshalb
// arbeitet dieser Worker im Hintergrund zwei Aufgaben ab:
//
//   1. E-Mails ernten, solange es Websites ohne Adresse gibt.
//   2. Neue Betriebe holen, wenn der Vorrat an versandfähigen Leads knapp wird.
//
// Beides kostet nichts (OpenStreetMap + die Websites der Betriebe selbst) und
// verschickt nichts. Abschaltbar über die Einstellung 'supply_auto'.
// ─────────────────────────────────────────────────────────────────────────────

const TICK_MS = 30 * 60 * 1000;      // alle 30 Minuten nachsehen
const HARVEST_CHUNK = 120;           // Seiten je Durchgang – dann wieder Luft holen
const MIN_VORRAT = 400;              // darunter gilt der Vorrat als knapp
const SCRAPE_COOLDOWN_H = 24;        // höchstens einmal am Tag neu scrapen

export function supplyAutoOn(): boolean {
  return getSetting('supply_auto', '1') !== '0';
}

export function setSupplyAuto(on: boolean): void {
  setSetting('supply_auto', on ? '1' : '0');
}

/** Versandfähige Leads: haben E-Mail und wurden noch nie angeschrieben. */
export function vorratVersandfaehig(): number {
  return (getDb().prepare(
    `SELECT COUNT(*) n FROM leads
     WHERE email IS NOT NULL AND email != ''
       AND status IN ('new','checked','draft_ready','approved','manual_review')
       AND LOWER(TRIM(email)) NOT IN (
         SELECT LOWER(TRIM(to_email)) FROM sent_emails WHERE success = 1 AND to_email IS NOT NULL AND to_email != ''
         UNION
         SELECT email_normalized FROM email_suppression WHERE email_normalized IS NOT NULL AND email_normalized != ''
       )`
  ).get() as { n: number }).n;
}

export interface SupplyStatus {
  automatik: boolean;
  vorrat: number;
  offene_websites: number;
  letzter_scrape?: string;
  naechster_scrape_moeglich?: string;
}

export function supplyStatus(): SupplyStatus {
  const letzter = getSetting('supply_last_scrape', '');
  return {
    automatik: supplyAutoOn(),
    vorrat: vorratVersandfaehig(),
    offene_websites: offeneWebsites(),
    letzter_scrape: letzter || undefined,
    naechster_scrape_moeglich: letzter
      ? new Date(new Date(letzter).getTime() + SCRAPE_COOLDOWN_H * 3_600_000).toISOString()
      : undefined,
  };
}

async function tick(): Promise<void> {
  if (!supplyAutoOn()) return;
  if (harvestProgress().laeuft || handwerkProgress().laeuft) return;

  // 1) Erst ernten – aus vorhandenen Websites Adressen zu machen ist billiger
  //    und schneller, als neue Betriebe zu suchen.
  if (offeneWebsites() > 0) {
    const r = await harvestEmails({ max: HARVEST_CHUNK });
    console.log(`[nachschub] Ernte: ${r.geprueft} Seiten, ${r.gefunden} E-Mails, ${r.chefs} Chef-Namen, ${r.direktnummern} Direktnummern`);
    return;
  }

  // 2) Vorrat knapp? Dann neue Betriebe holen – höchstens einmal am Tag.
  const vorrat = vorratVersandfaehig();
  if (vorrat >= MIN_VORRAT) return;

  const letzter = getSetting('supply_last_scrape', '');
  if (letzter && Date.now() - new Date(letzter).getTime() < SCRAPE_COOLDOWN_H * 3_600_000) return;

  console.log(`[nachschub] Vorrat bei ${vorrat} – hole neue Betriebe aus OpenStreetMap`);
  setSetting('supply_last_scrape', new Date().toISOString());
  const r = await scrapeHandwerkRegion({ isoRegion: 'DE-NW', onlyWithWebsite: true });
  console.log(`[nachschub] ${r.gefunden} Betriebe gefunden, ${r.neu} neu`);
}

let timer: ReturnType<typeof setInterval> | null = null;
let busy = false;

export function startSupplyWorker(): void {
  if (timer) return;
  const run = async () => {
    if (busy) return;
    busy = true;
    try { await tick(); }
    catch (err) { console.error('[nachschub] Fehler:', err instanceof Error ? err.message : err); }
    finally { busy = false; }
  };
  // Erster Lauf erst nach ein paar Minuten – der Serverstart soll frei bleiben.
  setTimeout(() => { run().catch(() => {}); }, 5 * 60 * 1000);
  timer = setInterval(run, TICK_MS);
  console.log('[nachschub] Automatik aktiv (Tick 30 Min) – hält Leads und E-Mails von allein nach');
}
