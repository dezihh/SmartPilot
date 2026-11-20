// Vertrag: Ein Paket, dessen literale http()-URL den Host aus einem Parameter
// bezieht, darf die Gefahrenpruefung nicht umgehen. Vor der Substitution ist
// der Host ein Platzhalter (`new URL` scheitert), nach der Installation ist der
// Aufruf literal und laeuft ohne SSRF-Pruefung.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { manifestDangerous } from '../src/core/packages.js';

const BASE = { id: 'p', version: '1.0.0', name: 'P', summary: 'S', description: 'D' };

test('Platzhalter im Host einer literalen http()-URL ist bestaetigungspflichtig', () => {
  const d = manifestDangerous({
    ...BASE,
    params: [{ key: 'host', label: 'Host', default: '169.254.169.254' }],
    functions: [{ name: 'f', template: "{% set x = http('http://${host}/latest/meta-data/') %}{{ x }}" }],
  } as never);
  assert.equal(d.dangerous, true);
});

test('Platzhalter in Pfad/Query einer literalen http()-URL bleibt unauffaellig', () => {
  const d = manifestDangerous({
    ...BASE,
    params: [{ key: 'lat', label: 'Breite', default: '52.5' }],
    functions: [
      { name: 'f', template: "{% set x = http('https://api.open-meteo.com/v1/forecast?latitude=${lat}') %}{{ x }}" },
    ],
  } as never);
  assert.equal(d.dangerous, false);
});
