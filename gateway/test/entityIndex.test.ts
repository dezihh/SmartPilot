import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb, getDb } from '../src/db/schema.js';
import { setSetting, deleteSetting } from '../src/db/settings.js';
import { createMcpServer } from '../src/db/mcpServers.js';
import { invalidateMcpCache } from '../src/mcp/registry.js';
import {
  parseIndexResult,
  fmtEntry,
  scoreEntries,
  listIndexKeys,
  getIndexSnapshot,
  invalidateIndex,
  staleFallbackLimitMs,
  type IndexEntry,
} from '../src/core/entityIndex.js';
import { tmpDb } from './_tmpdb.js';

const DB_PATH = tmpDb('entityindex');

const originalFetch = globalThis.fetch;

interface FakeResInit {
  status?: number;
  headers?: Record<string, string>;
  json?: unknown;
}

let handler: (url: string, body: Record<string, unknown>) => FakeResInit = () => ({});

function stubFetch(): void {
  globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    const h = handler(String(_url), body);
    const headers = new Map(Object.entries(h.headers ?? {}));
    return {
      ok: (h.status ?? 200) >= 200 && (h.status ?? 200) < 300,
      status: h.status ?? 200,
      text: async () => JSON.stringify(h.json ?? {}),
      json: async () => h.json ?? {},
      headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    } as unknown as Response;
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

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
  assert.equal(r.entries[0]!.id, 'light.1');
  assert.equal(r.entries[0]!.name, 'Deckenlicht');
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
  assert.equal(r.entries[1]!.attributes.current_temperature, '21.5');
});

test('parseIndexResult: Zeilen mit < 5 Feldern fallen weg, leere id verwerfen', () => {
  const r = parseIndexResult('zu|kurz|\n|Wohnzimmer|on||keine-id|\nlight.1|Wohnzimmer|on||Licht|');
  assert.equal(r.entries.length, 1);
});

test('parseIndexResult: area "None" wird leer, irrelevante Extras gefiltert', () => {
  const r = parseIndexResult('light.1|None|on||Licht|bogus=1;battery_level=55;unit_of_measurement=%');
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0]!.area, '');
  assert.equal(r.entries[0]!.attributes.battery_level, '55');
  assert.equal('bogus' in r.entries[0]!.attributes, false);
});

test('parseIndexResult: transform rendert JSON in Pipe-Zeilen', () => {
  const transform = '{% for d in data %}{{ d.id }}|{{ d.area }}|{{ d.state }}|{{ d.unit }}|{{ d.name }}|\n{% endfor %}';
  const json = JSON.stringify([
    { id: 'player.anlage', area: 'Wohnzimmer', state: 'playing', unit: '', name: 'Anlage' },
  ]);
  const r = parseIndexResult(json, transform);
  assert.equal(r.error, null);
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0]!.id, 'player.anlage');
  assert.equal(r.entries[0]!.name, 'Anlage');
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
  assert.equal(hits[0]!.id, 'sensor.aussen_temp');
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

// ---- F-38: Altersgrenze fuer Stale-while-error ----
// Dokumentiert die bewusste Entscheidung: 10x TTL, aber mindestens 5 Minuten.
test('staleFallbackLimitMs: 10x TTL, mindestens 5 Minuten (F-38)', () => {
  assert.equal(staleFallbackLimitMs(60_000), 600_000);
  assert.equal(staleFallbackLimitMs(1_000), 300_000);
});

// MCP-Antwort fuer den Tool-Katalog (tools/list).
function toolsList(name: string): FakeResInit {
  return { json: { jsonrpc: '2.0', id: 1, result: { tools: [{ name }] } } };
}

test('getIndexSnapshot: parallele Abrufe teilen sich einen Tool-Call (F-15)', async () => {
  stubFetch();
  let callCount = 0;
  handler = (_url, body) => {
    if (body.method === 'initialize') return { headers: { 'mcp-session-id': 's' }, json: { jsonrpc: '2.0', id: 1, result: {} } };
    if (body.method === 'tools/list') return toolsList('ha_index');
    if (body.method === 'tools/call') {
      callCount++;
      return { json: { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'light.1|Wohnzimmer|on||Licht|' }] } } };
    }
    return { status: 202 };
  };
  createMcpServer({
    name: 'audit-idx',
    url: 'https://mcp.example.org/rpc',
    auth_token: null,
    transport: 'http',
    command: null,
    args: null,
    env: null,
    inventory_prompt: null,
    enabled: 1,
  });
  setSetting('entity_index', JSON.stringify({ tool: 'ha_index' }));
  invalidateMcpCache();
  invalidateIndex();
  try {
    const [a, b] = await Promise.all([getIndexSnapshot('', true), getIndexSnapshot('', true)]);
    assert.equal(callCount, 1, 'nur ein Tool-Call trotz paralleler Abrufe');
    assert.equal(a.length, 1);
    assert.equal(b.length, 1);
  } finally {
    deleteSetting('entity_index');
    invalidateIndex();
    invalidateMcpCache();
    getDb().prepare("DELETE FROM mcp_servers WHERE name = 'audit-idx'").run();
  }
});

test('getIndexSnapshot: liefert bei Tool-Fehler den letzten Stand (Stale-while-error, F-15)', async () => {
  stubFetch();
  const okHandler = (_url: string, body: Record<string, unknown>): FakeResInit => {
    if (body.method === 'initialize') return { headers: { 'mcp-session-id': 's' }, json: { jsonrpc: '2.0', id: 1, result: {} } };
    if (body.method === 'tools/list') return toolsList('ha_index2');
    if (body.method === 'tools/call') {
      return { json: { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'light.1|Wohnzimmer|on||Licht|' }] } } };
    }
    return { status: 202 };
  };
  handler = okHandler;
  createMcpServer({
    name: 'audit-idx2',
    url: 'https://mcp.example.org/rpc',
    auth_token: null,
    transport: 'http',
    command: null,
    args: null,
    env: null,
    inventory_prompt: null,
    enabled: 1,
  });
  setSetting('entity_index_old', JSON.stringify({ tool: 'ha_index2' }));
  invalidateMcpCache();
  invalidateIndex();
  try {
    const first = await getIndexSnapshot('old', true);
    assert.equal(first.length, 1);
    // Tool-Call schlaegt jetzt fehl; der Client bleibt gecacht.
    handler = (_url, body) => {
      if (body.method === 'tools/call') return { json: { jsonrpc: '2.0', id: 1, error: { code: -1, message: 'kaputt' } } };
      return okHandler(_url, body);
    };
    const stale = await getIndexSnapshot('old', true);
    assert.equal(stale.length, 1, 'letzter bekannter Stand trotz Fehler');
    assert.equal(stale[0]!.id, 'light.1');
  } finally {
    deleteSetting('entity_index_old');
    invalidateIndex();
    invalidateMcpCache();
    getDb().prepare("DELETE FROM mcp_servers WHERE name = 'audit-idx2'").run();
  }
});

test('db-Reststaende aufgeraeumt', () => {
  const db = getDb();
  db.exec("DELETE FROM settings WHERE key LIKE 'test_%' OR key = 'entity_index_ma'");
});
