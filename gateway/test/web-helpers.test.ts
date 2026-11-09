// Verhaltenstests fuer die Frontend-Helfer aus `web/js/` (F-007).
// `web-modules.test.ts` prueft nur den Modulgraphen; hier geht es um das
// tatsaechliche Verhalten von `esc`, `cmpVersion` und `diffValue`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esc } from '../web/js/lib.js';

// `packages.js` verdrahtet beim Laden Event-Handler auf UI-Elemente. Fuer den
// Verhaltenstest genuegt ein minimaler DOM-Stub; die getesteten Helfer selbst
// sind reine Funktionen.
const stubElement = new Proxy(
  {},
  {
    get: () => () => {},
    set: () => true,
  }
);
Object.defineProperty(globalThis, 'document', {
  configurable: true,
  value: { getElementById: () => stubElement, body: { dataset: {} } },
});
const { cmpVersion, diffValue, updateChip, packageVersionLabel, paramForm } = await import('../web/js/packages.js');

test('esc maskiert alle HTML-Sonderzeichen', () => {
  assert.equal(esc(`<a href="x">&'`), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
});

test('esc behandelt null/undefined/numerische Werte', () => {
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
  assert.equal(esc(42), '42');
  assert.equal(esc(0), '0');
});

test('updateChip nennt installierte und Registry-Version', () => {
  assert.equal(updateChip('1.0.3', '1.0.4'), 'Update verfügbar: v1.0.3 → v1.0.4');
  assert.equal(updateChip('1.0.4', '1.0.4'), '', 'gleiche Version = kein Update');
  assert.equal(updateChip('1.0.5', '1.0.4'), '', 'installiert ist neuer');
});

test('packageVersionLabel zeigt installiert vor Registry', () => {
  assert.equal(packageVersionLabel('1.0.4', '1.0.3'), '1.0.3', 'installiert gewinnt');
  assert.equal(packageVersionLabel('1.0.4', undefined), '1.0.4', 'nicht installiert = Registry');
});

test('cmpVersion vergleicht Ziffernteile numerisch', () => {
  assert.equal(cmpVersion('1.2.3', '1.2.3'), 0);
  assert.ok(cmpVersion('1.2.3', '1.2.4') < 0);
  assert.ok(cmpVersion('1.2.4', '1.2.3') > 0);
  assert.ok(cmpVersion('1.10.0', '1.9.0') > 0, '10 ist groesser als 9, nicht alphabetisch');
});

test('cmpVersion ist robust gegen fehlende oder unsinnige Teile', () => {
  assert.equal(cmpVersion('1.2', '1.2.0'), 0);
  assert.equal(cmpVersion('1', '1.0.0.0'), 0);
  assert.equal(cmpVersion(undefined, '0.0.0'), 0);
  assert.equal(cmpVersion('1.x.3', '1.0.3'), 0, 'Nicht-Ziffern zaehlen als 0');
});

test('diffValue zeigt kurze Werte inline und maskiert HTML', () => {
  const html = diffValue('<b>alt</b>', '<i>neu</i>');
  assert.match(html, /<code>&lt;b&gt;alt&lt;\/b&gt;<\/code>/);
  assert.match(html, /→/);
  assert.equal(html.includes('<b>'), false, 'kein rohes HTML aus dem Wert');
});

test('diffValue klappt lange Werte und Zeilenumbrueche ein', () => {
  const long = 'x'.repeat(120);
  const html = diffValue(long, 'kurz');
  assert.match(html, /^<details>/);
  assert.match(html, /120\/4 Zeichen/);
  assert.match(diffValue('a\nb', 'c'), /^<details>/);
});

test('diffValue stellt leere Werte und Objekte lesbar dar', () => {
  assert.match(diffValue(null, ''), /\(leer\).*\(leer\)/);
  assert.match(diffValue({ a: 1 }, { a: 2 }), /&quot;a&quot;:1/);
});

// Regression: Label, Eingabe und Hilfe eines Parameters landeten als eigene
// Grid-Zellen nebeneinander, dadurch stand die Hilfe beim falschen Feld.
test('paramForm haelt Label, Eingabe und Hilfe je Parameter in einer Zelle', () => {
  const html = paramForm({
    params: [
      { key: 'mqtt_url', label: 'Broker-URL', required: true, placeholder: 'mqtt://host:1883', help: 'Port 1883 fuer MQTT.' },
      { key: 'mqtt_password', label: 'Passwort', type: 'password', secret: true, help: 'Nur bei Bedarf.' },
    ],
  });
  const cells = html.split('<div class="field">').slice(1);
  assert.equal(cells.length, 2, 'ein Feld je Parameter');
  const [urlCell = '', pwCell = ''] = cells;
  assert.match(urlCell, /^<div class="field-head"><label for="param-mqtt_url">Broker-URL \*<\/label><button type="button" class="help" data-help="Port 1883 fuer MQTT\."/);
  assert.match(urlCell, /<input id="param-mqtt_url" data-param="mqtt_url" type="text" placeholder="mqtt:\/\/host:1883"/);
  assert.doesNotMatch(urlCell, /class="field-help"/, 'Hilfe nicht mehr als lose Zeile');
  assert.match(pwCell, /data-help="Nur bei Bedarf\."/);
  assert.match(pwCell, /type="password"/);
});

test('paramForm setzt den Pflicht-Stern nicht bei schon gesetztem Passwort', () => {
  const html = paramForm(
    { params: [{ key: 'secret', label: 'Geheim', type: 'password', required: true }] },
    { secret: 'gesetzt' }
  );
  assert.match(html, /<label for="param-secret">Geheim<\/label>/);
  assert.match(html, /\(gesetzt – leer lassen zum Behalten\)/);
});
