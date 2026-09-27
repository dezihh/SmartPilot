import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetSessionsForTests, priorTurns, rememberTurn, isChatSession, setChatMode, HISTORY_MAX_MESSAGES, HISTORY_MAX_SESSIONS } from '../src/core/session.js';

beforeEach(() => resetSessionsForTests());

test('rememberTurn/priorTurns: Rundecken auf HISTORY_MAX_MESSAGES', () => {
  for (let i = 0; i < 10; i++) rememberTurn('s1', `frage ${i}`, `antwort ${i}`);
  const t = priorTurns('s1');
  assert.equal(t.length, HISTORY_MAX_MESSAGES);
  assert.equal(t[0]!.content, 'frage 6');
  assert.equal(t[t.length - 1]!.content, 'antwort 9');
});

test('Sessions ohne Eintrag = leer', () => {
  assert.deepEqual(priorTurns('unbekannt'), []);
  assert.equal(isChatSession('unbekannt'), false);
});

test('Chat-Modus setzen/loeschen', () => {
  setChatMode('s1', true);
  assert.equal(isChatSession('s1'), true);
  setChatMode('s1', false);
  assert.equal(isChatSession('s1'), false);
});

test('TTL: Session alterniert und wird weggeprunt', () => {
  const old = Date.now() - 3 * 60 * 60_000; // > SESSION_TTL_MS (2 h)
  rememberTurn('alt', 'q', 'a', old);
  setChatMode('alt', true, old);
  // Prune laeuft erst bei aktivitaet mit JETZT-Zeit: die alte Session fliegt.
  rememberTurn('neu', 'q', 'a');
  assert.deepEqual(priorTurns('alt'), []);
  assert.equal(isChatSession('alt'), false);
  // Die neue Session lebt.
  assert.ok(priorTurns('neu').length > 0);
});

test('Hart-Deckel: aelteste Session fliegt zuerst', () => {
  const now = Date.now();
  for (let i = 0; i < HISTORY_MAX_SESSIONS + 5; i++) {
    rememberTurn(`s${i}`, 'q', 'a', now + i);
  }
  assert.deepEqual(priorTurns('s0'), []);
  assert.ok(priorTurns(`s${HISTORY_MAX_SESSIONS + 4}`).length > 0);
});
