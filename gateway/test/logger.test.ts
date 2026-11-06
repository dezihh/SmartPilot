// Logger: Level-Filter, Zeilenformat und Anfrage-Kennung aus dem Kontext.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  LOG_LEVELS,
  parseLogLevel,
  formatLine,
  levelEnabled,
  setLogLevel,
  getLogLevel,
  setLogSink,
  runWithRequestId,
  currentRequestId,
  log,
  logError,
  type LogLevel,
} from '../src/core/logger.js';

let lines: { line: string; level: LogLevel }[] = [];

beforeEach(() => {
  lines = [];
  setLogSink((line, level) => lines.push({ line, level }));
  setLogLevel('info');
});

afterEach(() => {
  setLogSink(undefined);
  setLogLevel('info');
});

test('parseLogLevel: erkennt Level unabhaengig von Gross-/Kleinschreibung', () => {
  assert.deepEqual(
    LOG_LEVELS.map((l) => parseLogLevel(l.toUpperCase())),
    [...LOG_LEVELS]
  );
  assert.equal(parseLogLevel('  WarN  '), 'warn');
});

test('parseLogLevel: ungueltig oder leer -> undefined (Konfiguration prueft)', () => {
  assert.equal(parseLogLevel(''), undefined);
  assert.equal(parseLogLevel(undefined), undefined);
  assert.equal(parseLogLevel('verbose'), undefined);
  assert.equal(parseLogLevel('debug1'), undefined);
});

test('levelEnabled: debug ist bei info stumm, warn/error nicht', () => {
  assert.equal(levelEnabled('debug'), false);
  assert.equal(levelEnabled('info'), true);
  assert.equal(levelEnabled('warn'), true);
  assert.equal(levelEnabled('error'), true);
  setLogLevel('debug');
  assert.equal(levelEnabled('debug'), true);
  setLogLevel('error');
  assert.equal(levelEnabled('info'), false);
});

test('formatLine: Zeitstempel, Level, Anfrage-ID und Felder', () => {
  const line = formatLine(
    'warn',
    'etwas passiert',
    { pfad: '/api/query', ms: 12, leer: undefined },
    'req-4711',
    new Date('2026-11-06T20:12:33.456Z')
  );
  assert.equal(line, '2026-11-06T20:12:33.456Z WARN  req=req-4711 etwas passiert pfad=/api/query ms=12');
});

test('formatLine: Sonderzeichen werden als JSON gequotet', () => {
  const line = formatLine('info', 'text', { grund: 'a b' }, undefined, new Date('2026-11-06T00:00:00.000Z'));
  assert.equal(line, '2026-11-06T00:00:00.000Z INFO  text grund="a b"');
});

test('formatLine: Fehlerobjekte werden zur Meldung, Objekte zu JSON', () => {
  const line = formatLine('debug', 'x', { fehler: new Error('kaputt'), daten: { a: 1 } }, undefined);
  assert.match(line, /fehler=kaputt/);
  assert.match(line, /daten=\{"a":1\}/);
});

test('log: Level-Filter wirkt auf die Ausgabe', () => {
  log.debug('unsichtbar');
  log.info('sichtbar');
  assert.deepEqual(
    lines.map((l) => l.level),
    ['info']
  );
  setLogLevel('debug');
  log.debug('jetzt sichtbar');
  assert.equal(lines.length, 2);
  assert.equal(getLogLevel(), 'debug');
});

test('logError: schreibt Level error plus Stack auf debug', () => {
  logError('MCP-Init fehlgeschlagen', new Error('timeout'), { server: 7 });
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.level, 'error');
  assert.match(lines[0]!.line, /MCP-Init fehlgeschlagen server=7 error=timeout/);
});

test('logError: Stack erscheint nur bei aktiviertem debug', () => {
  setLogLevel('debug');
  logError('Refresh', new Error('boom'));
  assert.equal(lines.length, 2);
  assert.equal(lines[1]!.level, 'debug');
  assert.match(lines[1]!.line, /Stack/);
});

test('runWithRequestId: Kennung landet automatisch in der Logzeile', () => {
  assert.equal(currentRequestId(), undefined);
  const result = runWithRequestId('abc-123-def', () => {
    assert.equal(currentRequestId(), 'abc-123-def');
    log.info('innerhalb');
    return 42;
  });
  assert.equal(result, 42);
  assert.equal(currentRequestId(), undefined);
  assert.match(lines[0]!.line, /req=abc-123-def/);
  log.info('ausserhalb');
  assert.doesNotMatch(lines[1]!.line, /req=/);
});
