import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeXml, stripSsmlTags, withSsmlBreaks, parseAgentAnswer, containsToolCallSyntax } from '../src/core/response.js';

test('escapeXml maskiert XML-Sonderzeichen', () => {
  assert.equal(escapeXml('a & b < c > d'), 'a &amp; b &lt; c &gt; d');
});

test('stripSsmlTags entfernt speak/break/generische Tags', () => {
  assert.equal(stripSsmlTags('<speak>Hallo<break time="300ms"/> Welt</speak>'), 'Hallo Welt');
  assert.equal(stripSsmlTags('<speak>  viel\n\n  Leerraum  </speak>'), 'viel Leerraum');
});

test('withSsmlBreaks fasst Absaetze zu SSML zusammen', () => {
  const resp = { speech: 'Erster Absatz mit laengerem Text: Der Akkustand im Haus ist erfreulich, die Batterien liegen bei ueber achtzig Prozent Kapazitaet.\n\nZweiter Absatz mit laengerem Text: Die Photovoltaik liefert heute deutlich mehr Ertrag als gestern und der Verbrauch bleibt niedrig.\n\nDritter Teil.' };
  const out = withSsmlBreaks(resp);
  assert.equal(out.ssml, true);
  assert.ok(out.speech.startsWith('<speak>'));
  assert.ok(out.speech.includes('<break time="300ms"/>'));
});

test('withSsmlBreaks: kurzer Text ohne Struktur bleibt unveraendert', () => {
  const resp = { speech: 'Kurze Antwort.' };
  const out = withSsmlBreaks(resp);
  assert.equal(out.ssml, undefined);
  assert.equal(out.speech, 'Kurze Antwort.');
});

test('parseAgentAnswer: plain text', () => {
  const trace: unknown[] = [];
  const out = parseAgentAnswer('Es sind 22,4 Grad.', trace as never);
  assert.deepEqual(out, { speech: 'Es sind 22,4 Grad.' });
});

test('parseAgentAnswer: JSON-Objekt mit speech', () => {
  const out = parseAgentAnswer('{"needs_clarification": true, "speech": "Welches?", "keep_open": true}', []);
  assert.deepEqual(out, { speech: 'Welches?', followUp: true, keepOpen: true });
});

test('parseAgentAnswer: JSON ohne speech faellt auf Standard', () => {
  const trace: { step: string }[] = [];
  const out = parseAgentAnswer('{"needs_clarification": false}', trace as never);
  assert.equal(out.speech, 'Entschuldigung, dazu habe ich gerade nichts gefunden.');
  assert.ok(trace.some((t) => t.step === 'agent.empty_speech'));
});

test('parseAgentAnswer: leere Antwort', () => {
  const trace: { step: string }[] = [];
  const out = parseAgentAnswer('', trace as never);
  assert.equal(out.speech, 'Entschuldigung, dazu habe ich gerade nichts gefunden.');
  assert.ok(trace.some((t) => t.step === 'agent.empty_content'));
});

test('parseAgentAnswer: tool-call-Leak wird gefiltert', () => {
  const trace: { step: string }[] = [];
  const content = 'Hinweis <tool_call>{"name":"fn_x"}<|end_of_turn|>Ergebnis 22 Grad';
  const out = parseAgentAnswer(content, trace as never);
  assert.equal(out.speech, 'Hinweis Ergebnis 22 Grad');
assert.ok(trace.some((t) => t.step === 'agent.leak_filtered'));
});

// Issue #35: abgeschnittenes JSON (Suchtreffer) wurde als Rohtext vorgelesen.
test('parseAgentAnswer: kaputtes JSON wird nie vorgelesen', () => {
  const trace: { step: string }[] = [];
  const out = parseAgentAnswer('{"url":"https://faz.net/aktuell/politik/usa-unter-trump/attentat', trace as never);
  assert.equal(out.speech, 'Entschuldigung, dazu habe ich gerade nichts gefunden.');
  assert.equal(out.speech.includes('{'), false);
  assert.ok(trace.some((t) => t.step === 'agent.json_parse_error'));
});

test('parseAgentAnswer: JSON-Array wird nie vorgelesen', () => {
  const trace: { step: string }[] = [];
  const out = parseAgentAnswer('[{"url":"https://example.com/a","title":"Treffer"}]', trace as never);
  assert.equal(out.speech, 'Entschuldigung, dazu habe ich gerade nichts gefunden.');
  assert.ok(trace.some((t) => t.step === 'agent.empty_speech'));
});

test('parseAgentAnswer: URLs fliegen aus der Sprachausgabe', () => {
  const out = parseAgentAnswer('Die Meldung steht unter https://example.com/a und www.example.org.', []);
  assert.equal(out.speech, 'Die Meldung steht unter und.');
  assert.equal(out.speech.includes('http'), false);
});

test('parseAgentAnswer: Markdown-Link bleibt als Label sprechbar', () => {
  const out = parseAgentAnswer('Quelle: [FAZ](https://faz.net/a) berichtet.', []);
  assert.equal(out.speech, 'Quelle: FAZ berichtet.');
});

test('parseAgentAnswer: speech-Feld wird ebenfalls bereinigt', () => {
  const out = parseAgentAnswer('{"speech":"Mehr auf https://example.com"}', []);
  assert.equal(out.speech, 'Mehr auf');
});

test('parseAgentAnswer: Markdown-Link am Anfang ist kein JSON', () => {
  const out = parseAgentAnswer('[Quelle](https://example.com) sagt 22 Grad.', []);
  assert.equal(out.speech, 'Quelle sagt 22 Grad.');
});

// Issue #35 (Rezidiv): DeepSeek liefert den Tool-Aufruf als Text, mit vollen
// Balken (U+FF5C) und DSML-Marker statt ASCII-Pipes.
const DEEPSEEK_TOKENS =
  '<｜｜DSML｜｜tool_calls> <｜｜DSML｜｜invoke name="web_url_read"> <｜｜DSML｜｜parameter name="url" string="true"> </｜｜DSML｜｜invoke> </｜｜DSML｜｜tool_calls>';

test('parseAgentAnswer: DeepSeek-Tool-Tokens werden nie gesprochen', () => {
  const trace: { step: string }[] = [];
  const out = parseAgentAnswer(DEEPSEEK_TOKENS, trace as never);
  assert.equal(out.speech, 'Entschuldigung, dazu habe ich gerade nichts gefunden.');
  assert.equal(out.speech.includes('｜'), false);
  assert.equal(out.speech.includes('web_url_read'), false);
  assert.ok(trace.some((t) => t.step === 'agent.leak_filtered'));
});

test('parseAgentAnswer: Text vor einem Tool-Token bleibt erhalten', () => {
  const out = parseAgentAnswer('Kurz: 42. <｜｜DSML｜｜tool_calls> <｜｜DSML｜｜invoke name="x">', []);
  assert.equal(out.speech, 'Kurz: 42.');
});

test('parseAgentAnswer: ASCII-Variante <|invoke ...> wird ebenfalls gefiltert', () => {
  const out = parseAgentAnswer('<|invoke name="x"><|parameter name="y" string="true">', []);
  assert.match(out.speech, /nichts gefunden/);
});

test('containsToolCallSyntax erkennt beide Schreibweisen', () => {
  assert.equal(containsToolCallSyntax('<|tool_call>'), true);
  assert.equal(containsToolCallSyntax('<｜｜DSML｜｜invoke name="x">'), true);
  assert.equal(containsToolCallSyntax('Normale Antwort ohne Tokens.'), false);
});
