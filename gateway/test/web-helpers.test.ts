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
const { cmpVersion, diffValue, updateChip } = await import('../web/js/packages.js');

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
