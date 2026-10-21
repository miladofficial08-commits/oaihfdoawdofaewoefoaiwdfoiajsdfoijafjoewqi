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
   * Adresse des Backends, OHNE Schrägstrich am Ende.
   * Beispiel: 'https://routenplaner-production.up.railway.app'
   *
   * Bleibt das leer, startet die Seite in der Vorschau mit Beispieldaten.
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
};
