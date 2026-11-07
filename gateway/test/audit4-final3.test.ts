// Restliche Coverage (Audit F-001): Logger-Randfälle und Manifest-Helfer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLogLevel, logError } from '../src/core/logger.js';
import {
  parseManifest,
  requiredParams,
  paramValues,
  manifestItems,
  deriveCategory,
} from '../src/core/packages.js';

test('parseLogLevel: ungueltiger Wert liefert undefined', () => {
  assert.equal(parseLogLevel('kaputt'), undefined);
});

test('parseLogLevel: gueltiger Wert wird uebernommen', () => {
  assert.equal(parseLogLevel('debug'), 'debug');
  assert.equal(parseLogLevel(''), undefined);
});

test('logError: akzeptiert Nicht-Error-Werte', () => {
  assert.doesNotThrow(() => logError('Testfehler', 'kein Error'));
});

test('parseManifest: ungueltiges JSON wird abgelehnt', () => {
  assert.equal(parseManifest('{kaputt').ok, false);
});

test('requiredParams und paramValues: Pflichtparameter', () => {
  const m = {
    id: 'p',
    version: '1.0.0',
    name: 'P',
    summary: 'S',
    description: 'D',
    params: [{ key: 'host', label: 'Host', required: true }],
    servers: [{ name: 'S', transport: 'http', url: 'http://${host}' }],
  };
  assert.deepEqual(requiredParams(m as never), ['host']);
  assert.throws(() => paramValues(m as never, {}), /Host/);
  assert.deepEqual(paramValues(m as never, { host: 'x' }), { host: 'x' });
});

test('manifestItems und deriveCategory', () => {
  const base = { id: 'p', version: '1.0.0', name: 'P', summary: 'S', description: 'D' };
  const mixed = { ...base, servers: [{ name: 'S', transport: 'http', url: 'http://x' }], functions: [{ name: 'f' }] };
  assert.ok(manifestItems(mixed as never).some((i) => i.kind === 'server'));
  assert.equal(deriveCategory(mixed as never), 'mixed');
  assert.equal(deriveCategory({ ...base, servers: mixed.servers } as never), 'driver');
  assert.equal(deriveCategory({ ...base, functions: mixed.functions } as never), 'function');
});
