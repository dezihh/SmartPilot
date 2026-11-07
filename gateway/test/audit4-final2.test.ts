// Restliche Coverage (Audit F-001): Redaktion, Antwort-Helfer und Session-Auth.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb } from '../src/db/schema.js';
import { setSetting, deleteSetting } from '../src/db/settings.js';
import { redactTrace } from '../src/db/logs.js';
import { withDisplay, parseAgentAnswer, stripSsmlTags, escapeXml } from '../src/core/response.js';
import { createSession, sessionValid, cookieFor } from '../src/auth.js';
import type { TraceEvent } from '../src/types.js';
import { tmpDb } from './_tmpdb.js';

const DB_PATH = tmpDb('audit4-final2');

before(() => {
  closeDb();
  initDb(DB_PATH);
});

test('redactTrace: Secret-Schluessel werden maskiert, auch verschachtelt', () => {
  const redacted = redactTrace({
    token: 'geheim',
    nested: [{ api_key: 'x', value: 'ok' }],
  }) as { token: string; nested: { api_key: string; value: string }[] };
  assert.equal(redacted.token, '***');
  assert.equal(redacted.nested[0]!.api_key, '***');
  assert.equal(redacted.nested[0]!.value, 'ok');
});

test('redactTrace: Primitive und null bleiben unveraendert', () => {
  assert.equal(redactTrace('text'), 'text');
  assert.equal(redactTrace(42), 42);
  assert.equal(redactTrace(null), null);
});

test('parseAgentAnswer: Tool-Call-Leak wird gefiltert und vermerkt', () => {
  const trace: TraceEvent[] = [];
  const out = parseAgentAnswer('Hallo <|tool_call>{"x":1}<tool_call|> Welt', trace);
  assert.equal(out.speech, 'Hallo  Welt');
  assert.ok(trace.some((t) => t.step === 'agent.leak_filtered'));
});

test('parseAgentAnswer: JSON-Objekt wird als Antwort gelesen', () => {
  const out = parseAgentAnswer('{"speech":"Antwort","needs_clarification":true}', []);
  assert.equal(out.speech, 'Antwort');
  assert.equal(out.followUp, true);
  assert.equal(out.display, undefined);
});

test('withDisplay: SSML wird fuer die Anzeige entpackt', () => {
  const out = withDisplay({ speech: '<speak>Hallo <break time="300ms"/>Welt</speak>', ssml: true });
  assert.equal(out.display?.text, 'Hallo Welt');
  assert.ok(out.display?.title);
});

test('withDisplay: gesetzter Anzeigetitel gewinnt', () => {
  setSetting('display_title', 'Titel-X');
  try {
    const out = withDisplay({ speech: 'Hallo', ssml: false });
    assert.equal(out.display?.title, 'Titel-X');
  } finally {
    deleteSetting('display_title');
  }
});

test('stripSsmlTags und escapeXml: Randfaelle', () => {
  assert.equal(stripSsmlTags('<speak>&amp; &lt;x&gt;</speak>'), '& <x>');
  assert.equal(escapeXml('a & b < c'), 'a &amp; b &lt; c');
});

test('createSession: falsches Token liefert null', () => {
  assert.equal(createSession('falsches-token'), null);
});

test('sessionValid: ohne Cookie false', () => {
  assert.equal(sessionValid({ headers: {} } as never), false);
});

test('cookieFor: ohne Secure-Flag fuer LAN-HTTP', () => {
  const cookie = cookieFor('abc', false);
  assert.match(cookie, /va_session=abc/);
  assert.doesNotMatch(cookie, /Secure/);
});
