// Vertrag: Die `*ForTests`-Hooks sind im ausgelieferten Prozess wirkungslos
// (Audit F-006). Ob sie greifen, entscheidet `TEST_HOOKS_ENABLED` beim
// Modul-Import aus `NODE_ENV`; im laufenden Testprozess laesst sich das nicht
// mehr umschalten. Deshalb prueft der Test echte Kinderprozesse mit und ohne
// `NODE_ENV=production`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const GATEWAY_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

interface Probe {
  blockedBefore: boolean;
  allowedAfterReset: boolean;
  cacheHitAfterReset: unknown;
}

// Limit ausschoepfen -> Reset versuchen -> erneut fragen. Mit aktiven Hooks
// beginnt der Schluessel danach ein leeres Fenster; mit inaktiven bleibt er
// gesperrt und der HTTP-Cache behaelt seinen Eintrag.
const PROBE = `
const { checkRateLimit, resetRateLimitsForTests } = await import('./src/rateLimit.ts');
const { httpCacheSet, httpCacheGet, resetHttpCacheForTests } = await import('./src/core/httpCache.ts');
checkRateLimit('probe', 1000, 60_000, 1);
const blockedBefore = checkRateLimit('probe', 1000, 60_000, 1);
resetRateLimitsForTests();
const allowedAfterReset = checkRateLimit('probe', 1000, 60_000, 1);
httpCacheSet('probe://url', 'wert', 60_000, 1000);
resetHttpCacheForTests();
const cacheHitAfterReset = httpCacheGet('probe://url', 1000);
console.log(JSON.stringify({ blockedBefore, allowedAfterReset, cacheHitAfterReset }));
`;

function runProbe(env: NodeJS.ProcessEnv): Probe {
  const res = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', PROBE], {
    cwd: GATEWAY_DIR,
    encoding: 'utf8',
    env,
    timeout: 30_000,
  });
  assert.equal(res.status, 0, `Probe fehlgeschlagen: ${res.stderr || res.error?.message || 'unbekannt'}`);
  return JSON.parse(res.stdout.trim()) as Probe;
}

test('Test-Hooks wirken ausserhalb von production (Reset leert den Zustand)', () => {
  const env = { ...process.env };
  delete env.NODE_ENV;
  const probe = runProbe(env);
  assert.equal(probe.blockedBefore, false, 'Limit greift vor dem Reset');
  assert.equal(probe.allowedAfterReset, true, 'Reset muss den Bucket leeren');
  assert.equal(probe.cacheHitAfterReset, null, 'Reset muss den HTTP-Cache leeren');
});

test('Test-Hooks sind mit NODE_ENV=production wirkungslos', () => {
  const probe = runProbe({ ...process.env, NODE_ENV: 'production' });
  assert.equal(probe.blockedBefore, false, 'Limit greift vor dem Reset');
  assert.equal(probe.allowedAfterReset, false, 'Reset darf den Bucket nicht leeren');
  assert.equal(probe.cacheHitAfterReset, 'wert', 'Reset darf den HTTP-Cache nicht leeren');
});
