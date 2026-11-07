// Letzte Coverage (Audit F-001): Paket-Validierung und Gefahrensignatur.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { manifestDangerous, dangerSignature, validateManifest } from '../src/core/packages.js';

const BASE = { id: 'p', version: '1.0.0', name: 'P', summary: 'S', description: 'D' };

test('manifestDangerous: Vorgang mit shell() ist gefaehrlich', () => {
  const d = manifestDangerous({
    ...BASE,
    actions: [{ name: 'a', mode: 'deterministic', template: "{% set x = shell('ls') %}" }],
  } as never);
  assert.equal(d.dangerous, true);
});

test('manifestDangerous: Vorgang mit LAN-http() bleibt nur ein Hinweis', () => {
  const d = manifestDangerous({
    ...BASE,
    actions: [{ name: 'b', mode: 'deterministic', template: "{% set x = http('http://192.168.1.5/x') %}" }],
  } as never);
  assert.equal(d.dangerous, false);
  assert.ok(d.info.some((i) => i.includes('192.168.1.5')));
});

test('validateManifest: Feld- und Server-Randfaelle', () => {
  assert.equal(validateManifest({ ...BASE, language: 'deutsch' }).ok, false);
  assert.equal(validateManifest({ ...BASE, minGatewayVersion: '1.0' }).ok, false);
  assert.equal(validateManifest({ ...BASE, category: 'kaputt' }).ok, false);
  assert.equal(validateManifest({ ...BASE, servers: 'keine-liste' } as never).ok, false);
  assert.equal(validateManifest({ ...BASE, servers: [{ transport: 'http' }] } as never).ok, false);
  assert.equal(validateManifest({ ...BASE, functions: 'keine-liste' } as never).ok, false);
  assert.equal(validateManifest({ ...BASE, functions: [{ name: 'f' }] } as never).ok, false);
});

test('dangerSignature: haengt vom Inhalt ab, ist aber stabil', () => {
  const a = { ...BASE, servers: [{ name: 'S', transport: 'stdio', command: 'node' }] };
  assert.equal(dangerSignature(a as never), dangerSignature(a as never));
  assert.notEqual(
    dangerSignature(a as never),
    dangerSignature({ ...a, servers: [{ name: 'S', transport: 'stdio', command: 'python' }] } as never),
  );
});
