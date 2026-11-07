import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeActionInput, normalizeFunctionInput, normalizeHeaders, parseHeaders } from '../src/core/normalize.js';

test('Action: raw-Trigger-Array landet als JSON-String', () => {
  const out = normalizeActionInput({ name: 'hausstatus', mode: 'deterministic', trigger_phrases: ['hausstatus'] });
  assert.equal(out.trigger_phrases, '["hausstatus"]');
  assert.equal(out.tools, null);
  assert.equal(out.enabled, 1);
});

test('Action: JSON-String-Trigger (GET-Body-Roundtrip) wird geparst', () => {
  const out = normalizeActionInput({ name: 'a', mode: 'llm', trigger_phrases: '["hilfe"]', system_prompt: 'x' });
  assert.equal(out.trigger_phrases, '["hilfe"]');
});

test('Action: bootstrap-Body mit triggers-Feld leert keine Trigger (Finding #12)', () => {
  const out = normalizeActionInput({ name: 'a', mode: 'hybrid', triggers: ['t1', 't2'], template: 'x' });
  assert.equal(out.trigger_phrases, '["t1","t2"]');
});

test('Action: explizit leeres tools-Array = bewusst ohne Tools', () => {
  const out = normalizeActionInput({ name: 'hilfe', mode: 'llm', tools: [] });
  assert.equal(out.tools, '[]');
});

test('Action: fehlende tools = null (unveraendert/alle)', () => {
  const out = normalizeActionInput({ name: 'a', mode: 'llm' });
  assert.equal(out.tools, null);
});

test('Action: ungültiger Modus wirft', () => {
  assert.throws(() => normalizeActionInput({ name: 'a', mode: 'search_summary' }), /Ungültiger Modus/);
});

test('Action: function_args-Objekt wird JSON-String', () => {
  const out = normalizeActionInput({ name: 'a', mode: 'hybrid', function_args: { group: 'all' } });
  assert.equal(out.function_args, '{"group":"all"}');
});

test('Headers: Zeilenformat wird zu JSON', () => {
  assert.equal(normalizeHeaders('X-Portainer-API-Key: ptr_abc'), '{"X-Portainer-API-Key":"ptr_abc"}');
  assert.equal(
    normalizeHeaders('A: 1\n# Kommentar\nB: zwei'),
    '{"A":"1","B":"zwei"}'
  );
});

test('Headers: Objekt und JSON werden akzeptiert', () => {
  assert.equal(normalizeHeaders({ A: '1' }), '{"A":"1"}');
  assert.equal(normalizeHeaders('{"A":"1"}'), '{"A":"1"}');
});

test('Headers: leer = null (bestehenden Wert behalten)', () => {
  assert.equal(normalizeHeaders(undefined), null);
  assert.equal(normalizeHeaders(''), null);
  assert.equal(normalizeHeaders('   '), null);
  assert.equal(normalizeHeaders({}), null);
});

test('Headers: ungültige Namen und Zeilenumbrüche werfen', () => {
  assert.throws(() => normalizeHeaders('X Bad: 1'), /ungültiger Name/);
  assert.throws(() => normalizeHeaders({ 'X-Test': 'a\nb' }), /Zeilenumbruch/);
  assert.throws(() => normalizeHeaders('kein-doppelpunkt'), /Name: Wert/);
});

test('parseHeaders: kaputtes JSON und Fremdtypen -> {}', () => {
  assert.deepEqual(parseHeaders(null), {});
  assert.deepEqual(parseHeaders('kaputt'), {});
  assert.deepEqual(parseHeaders('[1,2]'), {});
  assert.deepEqual(parseHeaders('{"X":"1"}'), { X: '1' });
});

test('Funktion: Namens-Regex', () => {
  assert.throws(() => normalizeFunctionInput({ name: 'BadName', template: 'x' }), /a-z/);
  assert.doesNotThrow(() => normalizeFunctionInput({ name: 'find_entities', template: 'x' }));
});

test('Funktion: Budget-Clamp (0/negativ = null)', () => {
  assert.equal(normalizeFunctionInput({ name: 'fn', template: 'x', budget: 0 }).budget, null);
  assert.equal(normalizeFunctionInput({ name: 'fn', template: 'x', budget: -2 }).budget, null);
  assert.equal(normalizeFunctionInput({ name: 'fn', template: 'x', budget: 3 }).budget, 3);
});

test('Funktion: Parameter-Objekt wird JSON-String', () => {
  const out = normalizeFunctionInput({ name: 'fn', template: 'x', parameters: { type: 'object' } });
  assert.equal(out.parameters, '{"type":"object"}');
});

test('Action: side_effect/confirm Defaults und Validierung (Issue #4)', () => {
  const def = normalizeActionInput({ name: 'a', mode: 'llm' });
  assert.equal(def.side_effect, 'write', 'Default bleibt verhaltensneutral');
  assert.equal(def.confirm, 0);
  const read = normalizeActionInput({ name: 'a', mode: 'llm', side_effect: 'read', confirm: true });
  assert.equal(read.side_effect, 'read');
  assert.equal(read.confirm, 1);
  const num = normalizeActionInput({ name: 'a', mode: 'llm', confirm: '1' });
  assert.equal(num.confirm, 1, 'GET-Roundtrip (1 als String) bleibt an');
  assert.throws(() => normalizeActionInput({ name: 'a', mode: 'llm', side_effect: 'kaputt' }), /side_effect/);
});

test('Action: tool_params (Issue #4 Stufe 3) - Objekt/JSON und Validierung', () => {
  const obj = normalizeActionInput({ name: 'a', mode: 'llm', tool_params: { tool_a: ['x', 'y'] } });
  assert.deepEqual(JSON.parse(String(obj.tool_params)), { tool_a: ['x', 'y'] });
  const str = normalizeActionInput({ name: 'a', mode: 'llm', tool_params: '{"tool_a":["x"]}' });
  assert.deepEqual(JSON.parse(String(str.tool_params)), { tool_a: ['x'] });
  assert.equal(normalizeActionInput({ name: 'a', mode: 'llm', tool_params: null }).tool_params, null);
  assert.throws(() => normalizeActionInput({ name: 'a', mode: 'llm', tool_params: '{kaputt' }), /tool_params/);
  assert.throws(() => normalizeActionInput({ name: 'a', mode: 'llm', tool_params: { tool_a: [] } }), /tool_params/);
  assert.throws(() => normalizeActionInput({ name: 'a', mode: 'llm', tool_params: { 'BAD TOOL': ['x'] } }), /tool_params/);
});
