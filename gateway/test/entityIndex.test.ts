import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb, getDb } from '../src/db/schema.js';
import { setSetting, deleteSetting } from '../src/db/settings.js';
import {
  parseIndexResult,
  fmtEntry,
  scoreEntries,
  listIndexKeys,
  getIndexSnapshot,
  invalidateIndex,
  type IndexEntry,
} from '../src/core/entityIndex.js';
import { tmpDb } from './_tmpdb.js';

const DB_PATH = tmpDb('entityindex');

before(() => {
  closeDb(); // Import-seitige Runtime-Init (Container-DB) ersetzen
  initDb(DB_PATH);
  invalidateIndex();
});

function entry(overrides: Partial<IndexEntry>): IndexEntry {
  return { id: 'light.lampe', name: 'Lampe', state: 'on', unit: '', area: 'Wohnzimmer', attributes: {}, ...overrides };
}

test('parseIndexResult: HA-Envelope (result-String) -> Eintraege', () => {
  const r = parseIndexResult({
    content: [{ type: 'text', text: JSON.stringify({ success: true, result: 'light.1|Wohnzimmer|on||Deckenlicht|' }) }],
  });
  assert.equal(r.error, null);
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].id, 'light.1');
  assert.equal(r.entries[0].name, 'Deckenlicht');
});

test('parseIndexResult: success=false-Envelope -> Fehlermeldung', () => {
  const r = parseIndexResult({
    content: [{ type: 'text', text: JSON.stringify({ success: false, error: { message: 'template kaputt' } }) }],
  });
  assert.notEqual(r.error, null);
  assert.match(r.error ?? '', /template kaputt/);
  assert.equal(r.entries.length, 0);
});

test('parseIndexResult: Rohtext ohne Envelope -> Eintraege', () => {
  const r = parseIndexResult('light.1|Wohnzimmer|on||Deckenlicht|\nsensor.2|Kueche|21||Tempsensor|current_temperature=21.5');
  assert.equal(r.error, null);
  assert.equal(r.entries.length, 2);
  assert.equal(r.entries[1].attributes.current_temperature, '21.5');
});

test('parseIndexResult: Zeilen mit < 5 Feldern fallen weg, leere id verwerfen', () => {
  const r = parseIndexResult('zu|kurz|\n|Wohnzimmer|on||keine-id|\nlight.1|Wohnzimmer|on||Licht|');
  assert.equal(r.entries.length, 1);
});

test('parseIndexResult: area "None" wird leer, irrelevante Extras gefiltert', () => {
  const r = parseIndexResult('light.1|None|on||Licht|bogus=1;battery_level=55;unit_of_measurement=%');
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].area, '');
  assert.equal(r.entries[0].attributes.battery_level, '55');
  assert.equal('bogus' in r.entries[0].attributes, false);
});

test('parseIndexResult: transform rendert JSON in Pipe-Zeilen', () => {
  const transform = '{% for d in data %}{{ d.id }}|{{ d.area }}|{{ d.state }}|{{ d.unit }}|{{ d.name }}|\n{% endfor %}';
  const json = JSON.stringify([
    { id: 'player.anlage', area: 'Wohnzimmer', state: 'playing', unit: '', name: 'Anlage' },
  ]);
  const r = parseIndexResult(json, transform);
  assert.equal(r.error, null);
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].id, 'player.anlage');
  assert.equal(r.entries[0].name, 'Anlage');
});

test('parseIndexResult: transform ohne JSON -> Fehler statt Crash', () => {
  const r = parseIndexResult('kein json', '{% for d in data %}x{% endfor %}');
  assert.notEqual(r.error, null);
  assert.match(r.error ?? '', /transform erwartet JSON/);
});

test('fmtEntry: Einheit, Raum und Temperatur werden eingefuegt', () => {
  const line = fmtEntry(entry({ state: '21', unit: '°C', attributes: { current_temperature: '21.5' } }));
  assert.equal(line, 'light.lampe | Lampe: 21 °C [Wohnzimmer] (aktuell 21.5°C)');
});

test('scoreEntries: Alias draussen->aussen + Temperatur-Boost', () => {
  const entries = [
    entry({ id: 'sensor.aussen_temp', name: 'Aussen Temperatur', state: '21', unit: '°C', attributes: { current_temperature: '21.5' } }),
    entry({ id: 'light.lampe', name: 'Lampe', state: 'on' }),
    entry({ id: 'sensor.feuchte', name: 'Luftfeuchte', state: '40', unit: '%' }),
  ];
  const hits = scoreEntries(entries, 'wie ist die temperatur draussen', 8);
  assert.ok(hits.length > 0);
  assert.equal(hits[0].id, 'sensor.aussen_temp');
  // Lampe/Luftfeuchte haben keinen Themetreffer
  assert.equal(hits.find((h) => h.id === 'light.lampe'), undefined);
});

test('scoreEntries: Stopwords filtern, Ergebnis bleibt leersicher', () => {
  assert.deepEqual(scoreEntries([entry({})], 'wie ist es im', 8), []);
});

test('scoreEntries: maxResults begrenzt', () => {
  const many = Array.from({ length: 20 }, (_, i) => entry({ id: `light.lampe${i}`, name: `Lampe ${i}` }));
  assert.equal(scoreEntries(many, 'lampe', 8).length, 8);
});

test('listIndexKeys: benannte Index-Quellen werden entdeckt', () => {
  setSetting('entity_index_ma', '{"tool":"players_list_players"}');
  try {
    const keys = listIndexKeys();
    assert.ok(keys.includes(''));
    assert.ok(keys.includes('ma'));
  } finally {
    deleteSetting('entity_index_ma');
  }
});

test('getIndexSnapshot ohne konfigurierten Index -> leer, kein Fehler (generischer Default)', async () => {
  deleteSetting('entity_index');
  invalidateIndex();
  const entries = await getIndexSnapshot('');
  assert.deepEqual(entries, []);
});

test('getIndexSnapshot mit konfiguriertem Tool, aber ohne MCP-Server -> klarer Fehler', async () => {
  setSetting('entity_index', JSON.stringify({ tool: 'irgendein_index_tool' }));
  invalidateIndex();
  await assert.rejects(
    () => getIndexSnapshot(''),
    /Index-Tool .* nicht gefunden/
  );
  deleteSetting('entity_index');
  invalidateIndex();
});

test('db-Reststaende aufgeraeumt', () => {
  const db = getDb();
  db.exec("DELETE FROM settings WHERE key LIKE 'test_%' OR key = 'entity_index_ma'");
});
