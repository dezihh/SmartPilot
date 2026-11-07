import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRateLimit, resetRateLimitsForTests } from '../src/rateLimit.js';

test('Rate-Limit: bis max erlaubt, danach abgelehnt', () => {
  resetRateLimitsForTests();
  const now = 1_000_000;
  for (let i = 0; i < 10; i++) {
    assert.equal(checkRateLimit('ip1', now), true, `Versuch ${i + 1} erlaubt`);
  }
  assert.equal(checkRateLimit('ip1', now), false);
});

test('Rate-Limit: unabhaengige Schluessel', () => {
  resetRateLimitsForTests();
  const now = 2_000_000;
  for (let i = 0; i < 10; i++) checkRateLimit('ip1', now);
  assert.equal(checkRateLimit('ip1', now), false);
  assert.equal(checkRateLimit('ip2', now), true);
});

test('Rate-Limit: Fensterablauf gibt wieder frei (injizierte Zeit)', () => {
  resetRateLimitsForTests();
  const start = 3_000_000;
  for (let i = 0; i < 10; i++) checkRateLimit('ip1', start);
  assert.equal(checkRateLimit('ip1', start), false);
  assert.equal(checkRateLimit('ip1', start + 60_000), true);
});

test('Rate-Limit: alte Versuche innerhalb des Fensters zaehlen nicht mehr', () => {
  resetRateLimitsForTests();
  const start = 4_000_000;
  for (let i = 0; i < 10; i++) checkRateLimit('ip1', start - i * 1000);
  assert.equal(checkRateLimit('ip1', start), false);
  // Alle Versuche sind > 60s alt -> frischer Bucket
  assert.equal(checkRateLimit('ip1', start + 61_000), true);
});

test('Rate-Limit: Map waechst ungebunden nicht (Prune bei Ueberlauf)', () => {
  resetRateLimitsForTests();
  const now = 5_000_000;
  for (let i = 0; i < 1500; i++) checkRateLimit(`ip${i}`, now);
  // Danach sind alte Schluessel geprunt, neuer Schluessel funktioniert weiter
  assert.equal(checkRateLimit('neu', now), true);
});

test('F-015: Ueberlauf verdraengt auch frische Schluessel (harte Obergrenze)', () => {
  resetRateLimitsForTests();
  const now = 6_000_000;
  // 'alt' ist ausgeschoepft und wuerde ohne Verdraengung dauerhaft sperren.
  for (let i = 0; i < 10; i++) assert.equal(checkRateLimit('alt', now), true);
  assert.equal(checkRateLimit('alt', now), false);
  // Mehr als MAX_KEYS frische Schluessel -> die Map wird hart begrenzt.
  for (let i = 0; i < 1100; i++) checkRateLimit(`flut${i}`, now);
  assert.equal(
    checkRateLimit('alt', now),
    true,
    'verdraengter Schluessel startet mit leerem Fenster statt unbegrenzt zu wachsen'
  );
});
