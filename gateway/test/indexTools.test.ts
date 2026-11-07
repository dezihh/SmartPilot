// Unit-Tests fuer die Basis-Lesewerkzeuge (fn_find_entities/fn_get_entity).
// Die Pure-Fassungen bekommen den Snapshot direkt, die Async-Fassungen lesen
// ihn ueber getIndexSnapshot (ohne konfigurierten Index: leer).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb } from '../src/db/schema.js';
import { findInSnapshot, getFromSnapshot, findIndexEntries, getIndexEntry } from '../src/core/indexTools.js';
import type { IndexEntry } from '../src/core/entityIndex.js';
import { tmpDb } from './_tmpdb.js';

const DB_PATH = tmpDb('index-tools');

before(() => {
  closeDb();
  initDb(DB_PATH);
});

after(() => closeDb());

const lampe: IndexEntry = {
  id: 'light.test_lampe',
  name: 'Testlampe',
  state: 'on',
  unit: '',
  area: 'Wohnzimmer',
  attributes: {},
};

const temperatur: IndexEntry = {
  id: 'sensor.test_temperatur',
  name: 'Testtemperatur',
  state: '21.5',
  unit: '°C',
  area: 'Kueche',
  attributes: { current_temperature: '21.5' },
};

test('findInSnapshot: leerer Index meldet "nicht verfuegbar"', () => {
  assert.equal(findInSnapshot([], 'lampe'), 'Index nicht verfuegbar');
});

test('findInSnapshot: Treffer werden formatiert zurueckgegeben', () => {
  const out = findInSnapshot([lampe], 'testlampe');
  assert.equal(out, 'light.test_lampe | Testlampe: on [Wohnzimmer]');
});

test('findInSnapshot: ohne Treffer kommt "keine Treffer"', () => {
  assert.equal(findInSnapshot([lampe], 'gartenschlauch'), 'keine Treffer');
});

test('findInSnapshot: Einheit und Temperatur landen im Format', () => {
  const out = findInSnapshot([temperatur], 'testtemperatur');
  assert.match(out, /°C/);
  assert.match(out, /aktuell 21\.5°C/);
});

test('findInSnapshot: max begrenzt die Trefferzahl', () => {
  const entries: IndexEntry[] = Array.from({ length: 5 }, (_, i) => ({
    id: `light.lampe_${i}`,
    name: `Lampe ${i}`,
    state: 'off',
    unit: '',
    area: '',
    attributes: {},
  }));
  const out = findInSnapshot(entries, 'lampe', 2);
  assert.equal(out.split('\n').length, 2);
});

test('getFromSnapshot: leerer Index meldet "nicht verfuegbar"', () => {
  assert.equal(getFromSnapshot([], 'light.test_lampe'), 'Index nicht verfuegbar');
});

test('getFromSnapshot: bekannter Eintrag wird formatiert', () => {
  assert.equal(getFromSnapshot([lampe], 'light.test_lampe'), 'light.test_lampe | Testlampe: on [Wohnzimmer]');
});

test('getFromSnapshot: unbekannte ID nennt den Weg ueber fn_find_entities', () => {
  const out = getFromSnapshot([lampe], 'light.gibt_es_nicht');
  assert.match(out, /nicht im Index/);
  assert.match(out, /fn_find_entities/);
});

test('findIndexEntries/getIndexEntry: ohne konfigurierten Index "nicht verfuegbar"', async () => {
  assert.equal(await findIndexEntries('lampe'), 'Index nicht verfuegbar');
  assert.equal(await getIndexEntry('light.test_lampe'), 'Index nicht verfuegbar');
});
