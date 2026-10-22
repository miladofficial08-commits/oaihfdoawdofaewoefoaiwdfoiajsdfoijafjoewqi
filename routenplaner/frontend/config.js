/* Einmalige Einrichtung dieser Seite.
 *
 * Trage hier die Adresse deines Backends auf Railway ein. Danach fragt die
 * App nicht mehr danach — sie startet direkt mit der Tour.
 *
 * Nach dem Ändern: Datei speichern, committen, pushen. Netlify veröffentlicht
 * automatisch neu.
 */
window.PT_KONFIG = {
  /**
   * Adresse eines eigenen Backends, OHNE Schrägstrich am Ende.
   * Beispiel: 'https://routenplaner-production.up.railway.app'
   *
   * LEER LASSEN für die Netlify-Variante: dann spricht die Seite die API
   * unter /api auf derselben Adresse an, bedient von den Funktionen in
   * netlify/functions. Kein zweiter Dienst, kein CORS, keine Einrichtung.
   *
   * Nur ausfüllen, wenn das Backend woanders läuft (etwa auf Railway).
   */
  backendUrl: '',

  /**
   * Passwort, falls im Backend APP_PASSWORT gesetzt ist.
   *
   * Achtung: Was hier steht, steht öffentlich im Quelltext der Seite — jeder,
   * der die Netlify-Adresse kennt, kann es auslesen. Das ist vertretbar, wenn
   * die Netlify-Adresse selbst der Schutz ist (niemand errät sie). Wer es
   * ernster braucht, lässt das Feld leer: dann fragt die App einmalig danach
   * und legt es nur auf dem jeweiligen Handy ab.
   */
  passwort: '',

  /** Name, der an den Besuchen steht. Kann jeder auf seinem Handy ändern. */
  name: '',

  /**
   * Darf die Seite ohne Backend mit Beispieldaten starten?
   *
   * true  — ohne Backend läuft eine Vorschau mit erfundenen Praxen. Gut zum
   *         Anschauen, bevor Railway steht.
   * false — nur echte Daten. Ohne erreichbares Backend bleibt die Seite leer
   *         und sagt, dass keines verbunden ist. Das ist die richtige
   *         Einstellung, sobald ihr wirklich losfahrt: dann kann niemand
   *         versehentlich eine erfundene Praxis abklappern.
   *
   * Sobald backendUrl gesetzt ist, spielt das hier keine Rolle mehr — eine
   * konfigurierte Adresse schlägt die Vorschau immer.
   *
   * Steht hier bewusst auf false: auf der veröffentlichten Seite soll nie
   * eine erfundene Praxis auftauchen, die jemand für echt halten könnte.
   * Zum Anschauen ohne Backend kurz auf true stellen.
   */
  demoErlauben: false,
};
