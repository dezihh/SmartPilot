import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, similarity, routeAction } from '../src/core/router.js';
import type { ParsedAction } from '../src/types.js';

function action(overrides: Partial<ParsedAction>): ParsedAction {
  return {
    id: 1,
    name: 'test',
    mode: 'deterministic',
    trigger_phrases: null,
    fuzzy_threshold: null,
    system_prompt: null,
    template: null,
    function_ref: null,
    function_args: null,
    tools: null,
    enabled: 1,
    triggers: [],
    toolList: [],
    functionArgs: null,
    ...overrides,
  };
}

test('normalize: Kleinschreibung, Satzzeichen weg, Leerzeichen kollabiert', () => {
  assert.equal(normalize('  Wie IST der Hausstatus?  '), 'wie ist der hausstatus');
  // Bindestrich bleibt ( Teil des Wortes): 'depot-status bitte'
  assert.equal(normalize('Depot-Status, bitte!'), 'depot-status bitte');
});

test('similarity: identisch=1, fremd=0, teilweise dazwischen', () => {
  assert.equal(similarity('hausstatus', 'hausstatus'), 1);
  assert.equal(similarity('xyz', 'abc'), 0);
  const s = similarity('status', 'depot status');
  assert.ok(s > 0.5 && s < 1, `similarity=${s}`);
});

test('routeAction: exakter Trigger -> Score 1', () => {
  const a = action({ triggers: ['hausstatus'] });
  const m = routeAction('Hausstatus', [a], false);
  assert.ok(m);
  assert.equal(m.score, 1);
  assert.equal(m.action.name, 'test');
});

test('routeAction: Query enthaelt Trigger -> Score >= 0.95', () => {
  const a = action({ triggers: ['hausstatus'] });
  const m = routeAction('wie ist der hausstatus', [a], false);
  assert.ok(m);
  assert.ok(m.score >= 0.95);
});

test('routeAction: unterhalb Threshold -> null', () => {
  const a = action({ triggers: ['depot status'], fuzzy_threshold: 0.75 });
  // similarity("status", "depot status") = 0.7 < 0.75 -> kein Match
  const m = routeAction('status', [a], true);
  assert.equal(m, null);
});

test('routeAction: ueber per-Action-Threshold -> Match (Alter Bug-Zustand dokumentiert)', () => {
  const a = action({ triggers: ['depot status'], fuzzy_threshold: 0.6 });
  const m = routeAction('status', [a], true);
  assert.ok(m, 'similarity 0.7 >= 0.6 muss matchen');
});

test('routeAction: kombinierte Anfrage geht komplett an den Agent (auch nicht llm/hybrid)', () => {
  const det = action({ id: 1, name: 'hausstatus', mode: 'deterministic', triggers: ['hausstatus'] });
  const llm = action({ id: 2, name: 'agent', mode: 'llm', triggers: ['hausstatus'] });
  const hybrid = action({ id: 3, name: 'hyb', mode: 'hybrid', triggers: ['hausstatus'] });
  const m = routeAction('hausstatus und benzinpreis', [det, llm, hybrid], false);
  assert.equal(m, null);
});

test('routeAction: Trigger matcht nur als ganzes Wort (kein "haus" in "hausstatus")', () => {
  const a = action({ triggers: ['haus'] });
  assert.equal(routeAction('hausstatus', [a], false), null);
});

test('routeAction: Gleichstand -> laengste (spezifischste) Phrase gewinnt', () => {
  const short = action({ id: 1, name: 'short', triggers: ['licht'] });
  const long = action({ id: 2, name: 'long', triggers: ['licht wohnzimmer'] });
  const m = routeAction('bitte licht wohnzimmer', [short, long], false);
  assert.ok(m);
  assert.equal(m.action.name, 'long');
});

test('routeAction: Verneinung ueberspringt Vorgang mit Seiteneffekt', () => {
  const write = action({ name: 'licht', mode: 'llm', triggers: ['licht'], toolList: ['ha_call_service'] });
  assert.equal(routeAction('schalte licht nicht ein', [write], false), null);
});

test('routeAction: Verneinung blockiert lesenden Vorgang nicht', () => {
  const read = action({ name: 'hausstatus', mode: 'deterministic', triggers: ['hausstatus'] });
  const m = routeAction('hausstatus ist nicht gut', [read], false);
  assert.ok(m);
  assert.equal(m.action.name, 'hausstatus');
});

test('routeAction: kombinierte Anfrage ohne llm-Action -> null', () => {
  const det = action({ triggers: ['hausstatus'] });
  const m = routeAction('hausstatus und benzinpreis', [det], false);
  assert.equal(m, null);
});

test('routeAction: Komma gilt als Kombination', () => {
  const det = action({ triggers: ['hausstatus'] });
  const m = routeAction('hausstatus, benzinpreis', [det], false);
  assert.equal(m, null);
});

test('routeAction: hoehste Score gewinnt', () => {
  const a = action({ id: 1, name: 'a', triggers: ['hausstatus'], fuzzy_threshold: 0.85 });
  const b = action({ id: 2, name: 'b', triggers: ['wie ist der hausstatus'] });
  const m = routeAction('wie ist der hausstatus', [a, b], true);
  assert.ok(m);
  assert.equal(m.action.name, 'b');
  assert.equal(m.score, 1);
});

test('routeAction: leere/leere Triggers -> null', () => {
  assert.equal(routeAction('irgendwas', [], false), null);
  assert.equal(routeAction('irgendwas', [action({ triggers: [] })], false), null);
});

test('routeAction: Aufruf-Konjunktion "sowie" ist kombiniert', () => {
  const det = action({ triggers: ['wetter'] });
  const m = routeAction('wetter sowie nachrichten', [det], false);
  assert.equal(m, null);
});
