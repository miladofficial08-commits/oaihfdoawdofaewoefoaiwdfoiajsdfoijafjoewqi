// Nachprüfung am Impressum – der einzige Weg, Namen und Nummern wirklich zu belegen.
//
// Hintergrund: Die Chef-Namen im Bestand kamen zum Teil von Startseiten, wo
// „Geschäftsführer" auch in Referenzen und Pressetexten steht. Ergebnis waren
// Namen, die zum Betrieb nicht passen – und ein Kaltanruf mit falschem Namen ist
// nach zwei Sätzen vorbei. Genauso bei Nummern: Die Google-Maps-Nummer kann
// Jahre alt sein, und ob sie noch stimmt, sieht man nur im Vergleich mit dem,
// was der Betrieb selbst auf seiner Seite angibt.
//
// Dieser Worker liest darum für jeden Lead mit Website das Impressum und die
// Kontaktseiten und schreibt drei Dinge fest:
//
//   • Name aus dem Impressum – schlägt jeden Startseiten-Treffer, auch einen
//     bereits gespeicherten. Ein unbelegter Name wird ersetzt, nicht ergänzt.
//   • Direktnummer (Mobil/Durchwahl), mit der man am Vorzimmer vorbeikommt.
//   • Nummernabgleich: Steht die Maps-Nummer NIRGENDS auf der eigenen Website,
//     ist sie mit hoher Wahrscheinlichkeit veraltet. Das wird vermerkt, nicht
//     stillschweigend weitergegeben.
//
// Läuft in Häppchen im Hintergrund, verschickt nichts, kostet nichts.

import { getDb } from '../db/schema';
import { analyzeImpressum } from '../analyzer/website-checker';
import { bewerteGf, gleicheNummer, telefonProblem } from './qualitaet';

const BATCH = 5;
const PAUSE_MS = 1500;

export interface PrueferFortschritt {
  laeuft: boolean;
  geprueft: number;
  /** Namen, die jetzt aus dem Impressum belegt sind. */
  namen_belegt: number;
  /** Namen, die der Impressum-Lauf korrigiert hat (vorher stand ein anderer da). */
  namen_korrigiert: number;
  /** Namen, die sich nicht belegen ließen – bleiben als „unsicher" markiert. */
  namen_unbelegt: number;
  direktnummern: number;
  /** Maps-Nummer steht nicht auf der eigenen Website → verdächtig. */
  nummern_verdaechtig: number;
  offen: number;
  aktuell: string;
  fehler: number;
  gestartet?: string;
  fertig?: string;
}

const state: PrueferFortschritt = {
  laeuft: false, geprueft: 0, namen_belegt: 0, namen_korrigiert: 0, namen_unbelegt: 0,
  direktnummern: 0, nummern_verdaechtig: 0, offen: 0, aktuell: '', fehler: 0,
};

let stopp = false;

/** Noch nicht nachgeprüfte Leads mit Website. */
export function offenePruefungen(): number {
  return (getDb().prepare(
    `SELECT COUNT(*) n FROM leads
     WHERE website IS NOT NULL AND website != ''
       AND COALESCE(kein_betrieb,0) = 0
       AND COALESCE(status,'') NOT IN ('duplicate','archived')
       AND (gf_quelle IS NULL OR gf_quelle != 'impressum'
            OR impressum_checked_at IS NULL
            OR impressum_checked_at < datetime('now','-90 day'))`
  ).get() as { n: number }).n;
}

export function prueferFortschritt(): PrueferFortschritt {
  return { ...state, offen: offenePruefungen() };
}

export function stoppPruefer(): void { stopp = true; }

interface Kandidat {
  id: string; name: string; website: string;
  telefon: string | null; geschaeftsfuehrer: string | null; gf_quelle: string | null;
}

/**
 * Reihenfolge der Prüfung: zuerst die Leads, bei denen ein falscher Name real
 * Schaden anrichtet – die mit Widerspruch im Firmennamen, dann die unsicheren,
 * dann die ohne Namen. Wer heute schon einen belegten Namen hat, kommt zuletzt.
 */
function naechste(limit: number): Kandidat[] {
  return getDb().prepare(
    `SELECT id, name, website, telefon, geschaeftsfuehrer, gf_quelle FROM leads
     WHERE website IS NOT NULL AND website != ''
       AND COALESCE(kein_betrieb,0) = 0
       AND COALESCE(status,'') NOT IN ('duplicate','archived')
       AND (gf_quelle IS NULL OR gf_quelle != 'impressum'
            OR impressum_checked_at IS NULL
            OR impressum_checked_at < datetime('now','-90 day'))
     ORDER BY
       CASE WHEN gf_konflikt IS NOT NULL THEN 0
            WHEN gf_vertrauen = 'unsicher' THEN 1
            WHEN geschaeftsfuehrer IS NULL OR TRIM(geschaeftsfuehrer) = '' THEN 2
            ELSE 3 END,
       CASE prioritaet WHEN 'A' THEN 0 WHEN 'B' THEN 1 ELSE 2 END,
       COALESCE(score_telefon,0) DESC
     LIMIT @limit`
  ).all({ limit }) as Kandidat[];
}

export async function pruefeImpressen(opts: { max?: number } = {}): Promise<PrueferFortschritt> {
  if (state.laeuft) return prueferFortschritt();
  stopp = false;
  Object.assign(state, {
    laeuft: true, geprueft: 0, namen_belegt: 0, namen_korrigiert: 0, namen_unbelegt: 0,
    direktnummern: 0, nummern_verdaechtig: 0, aktuell: '', fehler: 0,
    gestartet: new Date().toISOString(), fertig: undefined,
  });

  const db = getDb();
  const update = db.prepare(
    `UPDATE leads SET
       geschaeftsfuehrer = @gf,
       gf_quelle         = @gf_quelle,
       gf_vertrauen      = @gf_vertrauen,
       gf_konflikt       = @gf_konflikt,
       telefon_direkt    = COALESCE(@direkt, telefon_direkt),
       telefon_direkt_typ = COALESCE(@direkt_typ, telefon_direkt_typ),
       telefon_notdienst = COALESCE(NULLIF(telefon_notdienst,''), @notdienst),
       impressum_url     = COALESCE(@impressum, impressum_url),
       impressum_checked_at = datetime('now'),
       tel_problem       = @tel_problem,
       tel_konflikt      = @tel_konflikt,
       qualitaet_geprueft_at = datetime('now'),
       updated_at        = datetime('now')
     WHERE id = @id`
  );
  const nurStempel = db.prepare(
    `UPDATE leads SET impressum_checked_at = datetime('now'), updated_at = datetime('now') WHERE id = @id`
  );

  const max = opts.max ?? Number.MAX_SAFE_INTEGER;

  while (!stopp && state.geprueft < max) {
    const batch = naechste(BATCH);
    if (!batch.length) break;

    await Promise.all(batch.map(async lead => {
      state.aktuell = lead.name;
      try {
        const imp = await analyzeImpressum(lead.website, lead.telefon ?? undefined, lead.name);
        state.geprueft++;
        if (imp.error && !imp.geschaeftsfuehrer && !imp.alle_nummern.length) {
          // Seite nicht erreichbar – nur stempeln, damit der Worker nicht kreist.
          nurStempel.run({ id: lead.id });
          state.fehler++;
          return;
        }

        // ── Name ──
        // Ein Impressum-Treffer ersetzt auch einen bereits gespeicherten Namen.
        // Genau dafür ist der Lauf da: Der alte Name kam womöglich von einer
        // Startseite und war falsch.
        const belegt = imp.gf_quelle === 'impressum' ? imp.geschaeftsfuehrer : undefined;
        let gf = belegt ?? lead.geschaeftsfuehrer ?? null;
        let quelle: string | null = belegt ? 'impressum' : (lead.gf_quelle ?? (lead.geschaeftsfuehrer ? 'startseite' : null));
        if (belegt) {
          state.namen_belegt++;
          const vorher = (lead.geschaeftsfuehrer || '').trim();
          if (vorher && vorher.toLowerCase() !== belegt.toLowerCase()) state.namen_korrigiert++;
        } else if (gf) {
          state.namen_unbelegt++;
        }
        const bewertung = bewerteGf(gf, lead.name, quelle);
        // Widerspruch zum Firmennamen und kein Impressum-Beleg: Mit diesem Namen
        // darf man nicht anrufen. Er bleibt sichtbar, aber als Konflikt markiert.
        if (bewertung?.konflikt && !belegt) {
          gf = null;
          quelle = null;
        }

        // ── Nummern ──
        const direkt = imp.telefon_direkt ?? null;
        if (direkt) state.direktnummern++;
        const anrufNummer = direkt || lead.telefon;
        const telProblem = anrufNummer ? telefonProblem(anrufNummer) ?? null : 'keine Nummer';

        // Steht die Maps-Nummer irgendwo auf der eigenen Website? Wenn die Seite
        // überhaupt Nummern zeigt und keine davon passt, ist die Maps-Nummer alt.
        let telKonflikt: string | null = null;
        if (lead.telefon && imp.alle_nummern.length) {
          const gefunden = imp.alle_nummern.some(p => gleicheNummer(p.nummer, lead.telefon));
          if (!gefunden) {
            telKonflikt = `Maps-Nummer ${lead.telefon} steht nicht auf der eigenen Website `
              + `(dort: ${imp.alle_nummern.slice(0, 3).map(p => p.nummer).join(', ')})`;
            state.nummern_verdaechtig++;
          }
        }

        update.run({
          id: lead.id,
          gf,
          gf_quelle: quelle,
          gf_vertrauen: bewertung && gf ? bewertung.vertrauen : null,
          gf_konflikt: bewertung?.konflikt ?? null,
          direkt,
          direkt_typ: imp.telefon_direkt_typ ?? null,
          notdienst: imp.telefon_notdienst ?? null,
          impressum: imp.impressum_url ?? null,
          tel_problem: telProblem,
          tel_konflikt: telKonflikt,
        });
      } catch {
        state.geprueft++;
        state.fehler++;
        nurStempel.run({ id: lead.id });
      }
    }));

    await new Promise(r => setTimeout(r, PAUSE_MS));
  }

  state.laeuft = false;
  state.aktuell = '';
  state.fertig = new Date().toISOString();
  console.log(
    `[impressum-pruefung] fertig: ${state.geprueft} Seiten, ${state.namen_belegt} Namen belegt `
    + `(${state.namen_korrigiert} korrigiert), ${state.direktnummern} Direktnummern, `
    + `${state.nummern_verdaechtig} verdächtige Nummern`
  );
  return prueferFortschritt();
}
