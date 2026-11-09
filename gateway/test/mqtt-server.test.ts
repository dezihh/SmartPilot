// Interner MQTT-MCP-Server: Topic-Normalisierung, Schreibfreigabe, Cache-
// Grenzen und JSON-RPC-Dispatch (ohne echten Broker - publish wird injiziert).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_SNAPSHOTS,
  MAX_TOPICS,
  MAX_VALUE_BYTES,
  LastValueCache,
  displayTopic,
  handleRequest,
  isWriteAllowed,
  normalizePrefix,
  normalizeTopic,
  parseSettings,
  truncateValue,
  type ServerDeps,
  type Settings,
} from '../src/mcp/mqtt-server.js';

function settings(overrides: Partial<Settings> = {}): Settings {
  return { url: 'mqtt://broker:1883', prefix: 'haus/', clientId: 'test', allowWrite: [], ...overrides };
}

function deps(overrides: Partial<ServerDeps> = {}): ServerDeps {
  return { cache: new LastValueCache(), settings: settings(), publish: async () => {}, ...overrides };
}

function text(res: { result?: unknown } | null): string {
  const result = res?.result as { content?: { text?: string }[] } | undefined;
  return result?.content?.[0]?.text ?? '';
}

// ---- Konfiguration ----

test('parseSettings: MQTT_URL ist Pflicht', () => {
  assert.throws(() => parseSettings({}), /MQTT_URL fehlt/);
  assert.throws(() => parseSettings({ MQTT_URL: '   ' }), /MQTT_URL fehlt/);
});

test('parseSettings: Defaults und Praefix-Normalisierung', () => {
  const s = parseSettings({ MQTT_URL: ' mqtt://broker:1883 ' });
  assert.equal(s.url, 'mqtt://broker:1883');
  assert.equal(s.prefix, '');
  assert.equal(s.clientId, 'smartpilot-mqtt');
  assert.equal(s.username, undefined);
  assert.equal(s.password, undefined);
  assert.deepEqual(s.allowWrite, []);
});

test('parseSettings: Praefix, Zugangsdaten und Freigabeliste', () => {
  const s = parseSettings({
    MQTT_URL: 'mqtts://broker:8883',
    MQTT_PREFIX: '/haus/keller',
    MQTT_USERNAME: ' smartpilot ',
    MQTT_PASSWORD: ' geheim mit leerzeichen ',
    MQTT_CLIENT_ID: 'gateway-1',
    MQTT_ALLOW_WRITE: ' haus/licht/kuche , haus/heizung/# ,, ',
  });
  assert.equal(s.prefix, 'haus/keller/');
  assert.equal(s.username, 'smartpilot');
  // Passwort bleibt verbatim (Leerzeichen koennen Teil des Secrets sein).
  assert.equal(s.password, ' geheim mit leerzeichen ');
  assert.equal(s.clientId, 'gateway-1');
  assert.deepEqual(s.allowWrite, ['haus/licht/kuche', 'haus/heizung/#']);
});

test('parseSettings: leeres Passwort gilt als nicht gesetzt', () => {
  assert.equal(parseSettings({ MQTT_URL: 'mqtt://b', MQTT_PASSWORD: '' }).password, undefined);
});

test('normalizePrefix: fuehrende und fehlende Slashes', () => {
  assert.equal(normalizePrefix(undefined), '');
  assert.equal(normalizePrefix('  '), '');
  assert.equal(normalizePrefix('haus'), 'haus/');
  assert.equal(normalizePrefix('/haus/'), 'haus/');
  assert.equal(normalizePrefix('//haus//keller/'), 'haus//keller/');
});

// Regression: "dwd/#" wurde zu "dwd/#/" und der Broker lehnte das Abo ab.
test('normalizePrefix: Wildcards und Trailing-Slash fallen weg', () => {
  assert.equal(normalizePrefix('dwd/#'), 'dwd/');
  assert.equal(normalizePrefix('dwd/*'), 'dwd/');
  assert.equal(normalizePrefix('/haus/#/'), 'haus/');
  assert.equal(normalizePrefix('haus/+/keller'), 'haus/');
  assert.equal(normalizePrefix('#'), '');
  assert.equal(normalizePrefix('*'), '');
});

// ---- Topics ----

test('normalizeTopic: Praefix ergaenzen, fuehrenden Slash entfernen', () => {
  assert.equal(normalizeTopic('keller/temperatur', 'haus/'), 'haus/keller/temperatur');
  assert.equal(normalizeTopic('/haus/keller/temperatur', 'haus/'), 'haus/keller/temperatur');
  assert.equal(normalizeTopic(' haus/a ', 'haus/'), 'haus/a');
  assert.equal(normalizeTopic('a/b', ''), 'a/b');
});

test('normalizeTopic: leere Topics und Wildcards werden abgelehnt', () => {
  assert.equal(normalizeTopic('', 'haus/'), null);
  assert.equal(normalizeTopic('   ', 'haus/'), null);
  assert.equal(normalizeTopic('haus/#', 'haus/'), null);
  assert.equal(normalizeTopic('haus/+/temp', 'haus/'), null);
});

test('displayTopic: Praefix abschneiden, sonst unveraendert', () => {
  assert.equal(displayTopic('haus/keller/temperatur', 'haus/'), 'keller/temperatur');
  assert.equal(displayTopic('fremd/topic', 'haus/'), 'fremd/topic');
  assert.equal(displayTopic('a/b', ''), 'a/b');
});

// ---- Schreibfreigabe ----

test('isWriteAllowed: exakter Treffer', () => {
  assert.equal(isWriteAllowed('haus/licht', ['haus/licht']), true);
  assert.equal(isWriteAllowed('haus/licht', ['/haus/licht']), true);
  assert.equal(isWriteAllowed('haus/licht', ['haus/licht2']), false);
});

test('isWriteAllowed: Praefix mit # und *', () => {
  assert.equal(isWriteAllowed('haus/heizung/soll', ['haus/heizung/#']), true);
  assert.equal(isWriteAllowed('haus/heizung', ['haus/heizung/#']), true);
  assert.equal(isWriteAllowed('haus/heizung2/soll', ['haus/heizung/#']), false);
  assert.equal(isWriteAllowed('haus/licht/kuche', ['haus/licht/*']), true);
  assert.equal(isWriteAllowed('haus/licht', ['haus/licht/*']), false);
});

test('isWriteAllowed: leere Liste sperrt alles', () => {
  assert.equal(isWriteAllowed('haus/licht', []), false);
  assert.equal(isWriteAllowed('haus/licht', ['', '   ']), false);
  assert.equal(isWriteAllowed('haus/licht', ['*']), false);
});

// ---- Werte ----

test('truncateValue: Grenze in Bytes, nicht in Zeichen', () => {
  const short = 'x'.repeat(MAX_VALUE_BYTES);
  assert.equal(truncateValue(short), short);
  const long = truncateValue('y'.repeat(MAX_VALUE_BYTES + 10));
  assert.ok(Buffer.byteLength(long) <= MAX_VALUE_BYTES);
  assert.ok(long.endsWith('...'));
  // Umlaute: 3 Bytes pro Zeichen, daher frueher gekappt.
  const umlaut = truncateValue('ä'.repeat(MAX_VALUE_BYTES));
  assert.ok(Buffer.byteLength(umlaut, 'utf8') <= MAX_VALUE_BYTES + 3);
});

// ---- Cache ----

test('LastValueCache: set/get und Ueberschreiben aktualisiert die Ordnung', () => {
  const cache = new LastValueCache();
  cache.set('a', '1');
  cache.set('b', '2');
  cache.get('a');
  assert.equal(cache.get('a'), '1');
  assert.equal(cache.get('fehlt'), undefined);
  assert.equal(cache.size(), 2);
});

test('LastValueCache: aeltester Eintrag faellt bei MAX_TOPICS heraus (FIFO)', () => {
  const cache = new LastValueCache();
  for (let i = 0; i < MAX_TOPICS + 5; i++) cache.set(`t/${i}`, String(i));
  assert.equal(cache.size(), MAX_TOPICS);
  assert.equal(cache.get('t/0'), undefined);
  assert.equal(cache.get('t/4'), undefined);
  assert.equal(cache.get('t/5'), '5');
  assert.equal(cache.get(`t/${MAX_TOPICS + 4}`), String(MAX_TOPICS + 4));
});

test('LastValueCache: Snapshot sortiert und begrenzt', () => {
  const cache = new LastValueCache();
  cache.set('b', '2');
  cache.set('a', '1');
  cache.set('c', '3');
  assert.deepEqual(cache.snapshot(), [
    ['a', '1'],
    ['b', '2'],
    ['c', '3'],
  ]);
  assert.deepEqual(cache.snapshot(2), [
    ['a', '1'],
    ['b', '2'],
  ]);
  // Obergrenze bleibt MAX_SNAPSHOTS, auch bei groesseren Wunschwerten.
  for (let i = 0; i < MAX_SNAPSHOTS + 10; i++) cache.set(`x/${String(i).padStart(3, '0')}`, 'v');
  assert.equal(cache.snapshot(999).length, MAX_SNAPSHOTS);
});

// ---- JSON-RPC ----

test('handleRequest: initialize meldet Server-Info', async () => {
  const res = await handleRequest({ id: 1, method: 'initialize' }, deps());
  const result = res?.result as { protocolVersion: string; serverInfo: { name: string } };
  assert.equal(res?.id, 1);
  assert.equal(result.serverInfo.name, 'smartpilot-mqtt');
  assert.ok(result.protocolVersion);
});

test('handleRequest: Notifications bekommen keine Antwort', async () => {
  assert.equal(await handleRequest({ method: 'notifications/initialized' }, deps()), null);
});

test('handleRequest: tools/list liefert die drei MQTT-Werkzeuge', async () => {
  const res = await handleRequest({ id: 2, method: 'tools/list' }, deps());
  const tools = (res?.result as { tools: { name: string }[] }).tools;
  assert.deepEqual(
    tools.map((t) => t.name),
    ['mqtt_get', 'mqtt_snapshot', 'mqtt_set']
  );
});

test('handleRequest: unbekannte Methode und unbekanntes Tool', async () => {
  const method = await handleRequest({ id: 3, method: 'resources/list' }, deps());
  assert.equal(method?.error?.code, -32601);
  const tool = await handleRequest(
    { id: 4, method: 'tools/call', params: { name: 'mqtt_delete', arguments: {} } },
    deps()
  );
  assert.match(text(tool), /unbekanntes Tool/);
});

test('handleRequest: mqtt_get mit und ohne Wert', async () => {
  const cache = new LastValueCache();
  cache.set('haus/keller/temperatur', '21.4');
  const known = await handleRequest(
    { id: 5, method: 'tools/call', params: { name: 'mqtt_get', arguments: { topic: 'keller/temperatur' } } },
    deps({ cache })
  );
  assert.equal(text(known), '[MQTT] keller/temperatur=21.4');

  const unknown = await handleRequest(
    { id: 6, method: 'tools/call', params: { name: 'mqtt_get', arguments: { topic: 'gibt/es/nicht' } } },
    deps({ cache })
  );
  assert.equal(text(unknown), '[MQTT] gibt/es/nicht=unbekannt');

  const invalid = await handleRequest(
    { id: 7, method: 'tools/call', params: { name: 'mqtt_get', arguments: { topic: 'haus/#' } } },
    deps({ cache })
  );
  assert.match(text(invalid), /ungueltiges Topic/);
  assert.equal((invalid?.result as { isError?: boolean }).isError, true);
});

test('handleRequest: mqtt_snapshot leer und gefuellt', async () => {
  const empty = await handleRequest(
    { id: 8, method: 'tools/call', params: { name: 'mqtt_snapshot', arguments: {} } },
    deps()
  );
  assert.equal(text(empty), '[MQTT] keine Werte');

  const cache = new LastValueCache();
  cache.set('haus/b', '2');
  cache.set('haus/a', '1');
  const filled = await handleRequest(
    { id: 9, method: 'tools/call', params: { name: 'mqtt_snapshot', arguments: { limit: 1 } } },
    deps({ cache })
  );
  assert.equal(text(filled), '[MQTT] a=1');
});

test('handleRequest: leerer Snapshot nennt das Settle-Fenster', async () => {
  const res = await handleRequest(
    { id: 14, method: 'tools/call', params: { name: 'mqtt_snapshot', arguments: {} } },
    deps({ settling: () => true })
  );
  assert.match(text(res), /keine Werte \(verbinde noch/);
});

// Regression: ein abgelehntes Abo (z. B. "dwd/#/" durch falsches Praefix)
// blieb unsichtbar, weil der stdio-Client stderr verwirft.
test('handleRequest: mqtt_snapshot meldet Verbindungs- und Abofehler', async () => {
  const failing = deps({ status: () => 'Invalid topic dwd/#/', settling: () => true });
  const empty = await handleRequest(
    { id: 20, method: 'tools/call', params: { name: 'mqtt_snapshot', arguments: {} } },
    failing
  );
  const emptyText = text(empty);
  assert.match(emptyText, /Verbindung\/Abonnement fehlgeschlagen: Invalid topic/);
  assert.match(emptyText, /keine Werte/);
  assert.doesNotMatch(emptyText, /verbinde noch/, 'Fehler statt Wartehinweis');
  assert.equal((empty?.result as { isError?: boolean }).isError, true);

  const cache = new LastValueCache();
  cache.set('netfreq/f', '50.0');
  const filled = await handleRequest(
    { id: 21, method: 'tools/call', params: { name: 'mqtt_snapshot', arguments: {} } },
    deps({ cache, status: () => 'Verbindung getrennt' })
  );
  assert.match(text(filled), /^\[MQTT\] Verbindung\/Abonnement fehlgeschlagen: Verbindung getrennt\n\[MQTT\] netfreq\/f=50\.0$/);
});

test('handleRequest: mqtt_set ohne Freigabe wird abgelehnt (kein Publish)', async () => {
  let published = 0;
  const res = await handleRequest(
    { id: 10, method: 'tools/call', params: { name: 'mqtt_set', arguments: { topic: 'licht', value: 'ON' } } },
    deps({ publish: async () => { published++; } })
  );
  assert.match(text(res), /nicht erlaubt: licht/);
  assert.equal((res?.result as { isError?: boolean }).isError, true);
  assert.equal(published, 0);
});

test('handleRequest: mqtt_set mit Freigabe publiziert und aktualisiert den Cache', async () => {
  const calls: [string, string][] = [];
  const cache = new LastValueCache();
  const d = deps({ cache, settings: settings({ allowWrite: ['haus/licht/*'] }), publish: async (t, v) => { calls.push([t, v]); } });
  const res = await handleRequest(
    { id: 11, method: 'tools/call', params: { name: 'mqtt_set', arguments: { topic: 'licht/kuche', value: 'ON' } } },
    d
  );
  assert.equal(text(res), '[MQTT] licht/kuche=ON');
  assert.deepEqual(calls, [['haus/licht/kuche', 'ON']]);
  assert.equal(cache.get('haus/licht/kuche'), 'ON');
});

test('handleRequest: mqtt_set meldet Publish-Fehler als isError', async () => {
  const res = await handleRequest(
    { id: 12, method: 'tools/call', params: { name: 'mqtt_set', arguments: { topic: 'licht', value: 'ON' } } },
    deps({
      settings: settings({ allowWrite: ['haus/licht'] }),
      publish: async () => {
        throw new Error('offline');
      },
    })
  );
  assert.match(text(res), /Publish fehlgeschlagen: offline/);
  assert.equal((res?.result as { isError?: boolean }).isError, true);
});

test('handleRequest: mqtt_set kappt zu grosse Werte', async () => {
  const res = await handleRequest(
    { id: 13, method: 'tools/call', params: { name: 'mqtt_set', arguments: { topic: 'licht', value: 'x'.repeat(MAX_VALUE_BYTES + 1) } } },
    deps({ settings: settings({ allowWrite: ['haus/licht'] }) })
  );
  assert.match(text(res), /Wert zu gross/);
});

// ---- Dispatch: mqtt_set und Restpfade ----

test('handleRequest: Notification ohne id bekommt keine Antwort', async () => {
  assert.equal(await handleRequest({ method: 'initialize' }, deps()), null);
});

test('handleRequest: unbekannte Methode liefert -32601', async () => {
  const res = await handleRequest({ id: 1, method: 'kaputt' }, deps());
  assert.equal((res as { error?: { code: number } }).error?.code, -32601);
});

test('handleRequest: mqtt_get mit ungueltigem und unbekanntem Topic', async () => {
  const invalid = await handleRequest(
    { id: 1, method: 'tools/call', params: { name: 'mqtt_get', arguments: { topic: '' } } },
    deps(),
  );
  assert.equal((invalid?.result as { isError?: boolean }).isError, true);
  const unknown = await handleRequest(
    { id: 2, method: 'tools/call', params: { name: 'mqtt_get', arguments: { topic: 'licht' } } },
    deps(),
  );
  assert.match(text(unknown), /=unbekannt/);
});

test('handleRequest: mqtt_set ohne Freigabe wird abgelehnt', async () => {
  const res = await handleRequest(
    { id: 1, method: 'tools/call', params: { name: 'mqtt_set', arguments: { topic: 'licht', value: 'ON' } } },
    deps(),
  );
  assert.match(text(res), /nicht erlaubt/);
});

test('handleRequest: mqtt_set publiziert erlaubte Topics', async () => {
  const published: [string, string][] = [];
  const d = deps({
    settings: settings({ allowWrite: ['haus/licht'] }),
    publish: async (topic, value) => {
      published.push([topic, value]);
    },
  });
  const res = await handleRequest(
    { id: 1, method: 'tools/call', params: { name: 'mqtt_set', arguments: { topic: 'licht', value: 'ON' } } },
    d,
  );
  assert.deepEqual(published, [['haus/licht', 'ON']]);
  assert.match(text(res), /=ON/);
});

test('handleRequest: mqtt_set meldet Publish-Fehler', async () => {
  const d = deps({
    settings: settings({ allowWrite: ['haus/licht'] }),
    publish: async () => {
      throw new Error('kaputt');
    },
  });
  const res = await handleRequest(
    { id: 1, method: 'tools/call', params: { name: 'mqtt_set', arguments: { topic: 'licht', value: 'ON' } } },
    d,
  );
  assert.match(text(res), /Publish fehlgeschlagen/);
});

test('handleRequest: leerer Snapshot nennt den Verbindungsaufbau', async () => {
  const res = await handleRequest(
    { id: 1, method: 'tools/call', params: { name: 'mqtt_snapshot', arguments: {} } },
    deps({ settling: () => true }),
  );
  assert.match(text(res), /verbinde noch/);
});
