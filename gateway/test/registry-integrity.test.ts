// Registry-Integritaet: index.json fuehrt Version und SHA-256 je Manifest.
// Reine Pruefungen plus die Ableitung des Hashes, damit ein getauschtes
// Manifest oder eine halb aktualisierte Registry auffaellt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sha256Hex, verifyManifestIntegrity } from '../src/core/packages.js';

const MANIFEST = '{"id":"demo","version":"1.2.3"}';
const HASH = createHash('sha256').update(MANIFEST, 'utf8').digest('hex');

test('sha256Hex entspricht dem Datei-Hash', () => {
  assert.equal(sha256Hex(MANIFEST), HASH);
  assert.match(HASH, /^[0-9a-f]{64}$/);
});

test('verifyManifestIntegrity: passender Eintrag ist ok', () => {
  assert.equal(verifyManifestIntegrity({ id: 'demo', version: '1.2.3', sha256: HASH }, MANIFEST, '1.2.3'), null);
});

test('verifyManifestIntegrity: getauschtes Manifest faellt auf', () => {
  const problem = verifyManifestIntegrity({ id: 'demo', version: '1.2.3', sha256: HASH }, MANIFEST + ' ', '1.2.3');
  assert.match(String(problem), /Hash in index\.json/);
});

test('verifyManifestIntegrity: abweichende Version faellt auf', () => {
  const problem = verifyManifestIntegrity({ id: 'demo', version: '1.2.3', sha256: HASH }, MANIFEST, '1.2.4');
  assert.match(String(problem), /Version 1\.2\.3, Manifest 1\.2\.4/);
});

test('verifyManifestIntegrity: unbekanntes Paket wird abgelehnt', () => {
  assert.match(String(verifyManifestIntegrity(undefined, MANIFEST, '1.2.3')), /fehlt im Registry-Index/);
});

test('verifyManifestIntegrity: alter Index ohne Hash bleibt nutzbar', () => {
  assert.equal(verifyManifestIntegrity({ id: 'demo', version: '1.2.3' }, 'egal', '1.2.3'), null);
});
