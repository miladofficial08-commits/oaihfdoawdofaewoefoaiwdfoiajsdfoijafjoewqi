import { getDb } from '../db/schema';
import { getSetting, setSetting } from '../workflow/schema';
import { harvestEmails, harvestProgress, offeneWebsites } from './email-harvester';
import { scrapeHandwerkRegion, handwerkProgress } from './osm';
import { pruefeImpressen, prueferFortschritt, offenePruefungen } from '../leads/pruefer';

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
const PRUEF_CHUNK = 60;              // Impressen je Durchgang nachprüfen
const MIN_VORRAT = 400;              // darunter gilt der E-Mail-Vorrat als knapp
const SCRAPE_COOLDOWN_H = 24;        // höchstens einmal am Tag neu scrapen

// ── Telefon-Vorrat ───────────────────────────────────────────────────────────
//
// Das Tagesziel sind 100 Anrufe. Ein Vorrat, der genau 100 groß ist, ist keiner:
// Nach einem Tag steht die Akquise, und gemerkt wird es morgens um neun. Darum
// wird auf eine Woche Vorlauf aufgefüllt – und nachgelegt, sobald weniger als
// drei Tage übrig sind.
export const ANRUFE_PRO_TAG = 100;
const MIN_ANRUF_VORRAT = ANRUFE_PRO_TAG * 3;

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

/**
 * Anrufbarer Vorrat: Betriebe mit Nummer, die noch nie angerufen wurden.
 *
 * Bewusst dieselbe Bedingung wie die Anrufliste selbst – eine Kennzahl, die
 * etwas anderes zählt als die Liste zeigt, führt nur dazu, dass man ihr nicht
 * mehr glaubt.
 */
export function vorratAnrufbar(): number {
  return (getDb().prepare(
    `SELECT COUNT(*) n FROM leads
     WHERE COALESCE(telefon_direkt, telefon) IS NOT NULL
       AND length(TRIM(COALESCE(telefon_direkt, telefon))) > 5
       AND COALESCE(kein_betrieb, 0) = 0
       AND COALESCE(anruf_versuche, 0) = 0
       AND COALESCE(manual_call_done, 0) = 0
       AND status IN ('new','checked','draft_ready','approved','manual_review','contacted')`
  ).get() as { n: number }).n;
}

/** Wie viele Tage hält der Vorrat beim Tagesziel noch? */
export function anrufTageVorrat(): number {
  return Math.floor(vorratAnrufbar() / ANRUFE_PRO_TAG);
}

export interface SupplyStatus {
  automatik: boolean;
  vorrat: number;
  /** Anrufbarer Vorrat und wie viele Tage er beim Tagesziel reicht. */
  anruf_vorrat: number;
  anruf_tage: number;
  anruf_ziel: number;
  offene_pruefungen: number;
  offene_websites: number;
  letzter_scrape?: string;
  naechster_scrape_moeglich?: string;
}

export function supplyStatus(): SupplyStatus {
  const letzter = getSetting('supply_last_scrape', '');
  return {
    automatik: supplyAutoOn(),
    vorrat: vorratVersandfaehig(),
    anruf_vorrat: vorratAnrufbar(),
    anruf_tage: anrufTageVorrat(),
    anruf_ziel: ANRUFE_PRO_TAG,
    offene_pruefungen: offenePruefungen(),
    offene_websites: offeneWebsites(),
    letzter_scrape: letzter || undefined,
    naechster_scrape_moeglich: letzter
      ? new Date(new Date(letzter).getTime() + SCRAPE_COOLDOWN_H * 3_600_000).toISOString()
      : undefined,
  };
}

async function tick(): Promise<void> {
  if (!supplyAutoOn()) return;
  if (harvestProgress().laeuft || handwerkProgress().laeuft || prueferFortschritt().laeuft) return;

  // 1) Telefon-Vorrat zuerst. Angerufen wird jeden Tag; eine leere Anrufliste
  //    stoppt die Akquise sofort, während eine leere E-Mail-Liste nur einen
  //    Automaten pausiert. Also hat der Nachschub fürs Telefon Vorrang.
  const anrufVorrat = vorratAnrufbar();
  if (anrufVorrat < MIN_ANRUF_VORRAT) {
    const letzter = getSetting('supply_last_call_scrape', '');
    if (!letzter || Date.now() - new Date(letzter).getTime() >= SCRAPE_COOLDOWN_H * 3_600_000) {
      console.log(`[nachschub] Anruf-Vorrat bei ${anrufVorrat} (<${MIN_ANRUF_VORRAT}) – hole Betriebe MIT TELEFON aus OpenStreetMap`);
      setSetting('supply_last_call_scrape', new Date().toISOString());
      const r = await scrapeHandwerkRegion({ isoRegion: 'DE-NW', nurMitTelefon: true, mitNamenssuche: true });
      console.log(`[nachschub] ${r.gefunden} Betriebe gefunden, ${r.neu} neu, ${r.mitTelefon} mit Telefon`);
      return;
    }
  }

  // 2) Impressen nachprüfen: Chef-Namen belegen, Direktnummern holen, veraltete
  //    Maps-Nummern aufdecken. Das ist die Arbeit, die einen Anruf überhaupt
  //    persönlich macht – wichtiger als die nächste E-Mail-Adresse.
  if (offenePruefungen() > 0) {
    const r = await pruefeImpressen({ max: PRUEF_CHUNK });
    console.log(`[nachschub] Impressum-Prüfung: ${r.geprueft} Seiten, ${r.namen_belegt} Namen belegt, `
      + `${r.namen_korrigiert} korrigiert, ${r.direktnummern} Direktnummern, ${r.nummern_verdaechtig} verdächtige Nummern`);
    return;
  }

  // 3) E-Mails ernten – aus vorhandenen Websites Adressen zu machen ist billiger
  //    und schneller, als neue Betriebe zu suchen.
  if (offeneWebsites() > 0) {
    const r = await harvestEmails({ max: HARVEST_CHUNK });
    console.log(`[nachschub] Ernte: ${r.geprueft} Seiten, ${r.gefunden} E-Mails, ${r.chefs} Chef-Namen, ${r.direktnummern} Direktnummern`);
    return;
  }

  // 4) E-Mail-Vorrat knapp? Dann neue Betriebe holen – höchstens einmal am Tag.
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
