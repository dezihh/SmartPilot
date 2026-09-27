// Direkte Tests fuer indexAssistant.validateDraft (reine Funktion, kein Netz).
// Deckt die Draft-Validierung inkl. Read-only-Klassifikation und Fehlerpfade ab.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// config/auth lesen die Umgebung beim Import -> vor dem dynamischen Import setzen.
process.env.AUTH_TOKEN = 'test-secret';
process.env.LLM_BASE_URL = 'http://127.0.0.1:9/v1';
process.env.LLM_API_KEY = 'test-key';
process.env.LLM_MODEL = 'test-model';

const { validateDraft } = await import('../src/core/indexAssistant.js');
type McpContext = import('../src/mcp/registry.js').McpContext;
type McpTransport = import('../src/mcp/client.js').McpTransport;

function fakeMcp(
  toolNames: string[],
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>
): McpContext {
  const client = { init: async () => {}, listTools: async () => [], callTool } as unknown as McpTransport;
  return {
    servers: [{ id: 1, name: 'srv', sideEffect: 'read', client, tools: toolNames.map((n) => ({ name: n })) }],
  } as unknown as McpContext;
}

function textResult(text: string): unknown {
  return { content: [{ type: 'text', text }] };
}

const PIPE5 = 'a.1|R|on||A|\na.2|R|on||B|\na.3|R|on||C|\na.4|R|on||D|\na.5|R|on||E|';

test('validateDraft: fehlendes tool/args -> Fehler', async () => {
  const v = await validateDraft(fakeMcp([], async () => textResult('')), {} as never);
  assert.equal(v.ok, false);
  assert.ok(v.errors.length >= 2);
});

test('validateDraft: Tool nicht gefunden', async () => {
  const v = await validateDraft(fakeMcp(['other_tool'], async () => textResult(PIPE5)), { tool: 'x_get', args: {} });
  assert.equal(v.ok, false);
  assert.match(v.errors.join(' '), /keinem aktivierten MCP-Server gefunden/);
});

test('validateDraft: nicht lesendes Tool wird abgelehnt', async () => {
  const v = await validateDraft(fakeMcp(['ha_call_service'], async () => textResult(PIPE5)), {
    tool: 'ha_call_service',
    args: {},
  });
  assert.equal(v.ok, false);
  assert.match(v.errors.join(' '), /nicht erkennbar lesend/);
});

test('validateDraft: zu wenige Eintraege', async () => {
  const v = await validateDraft(fakeMcp(['ha_eval_template'], async () => textResult('a.1|R|on||A|\na.2|R|on||B|')), {
    tool: 'ha_eval_template',
    args: {},
  });
  assert.equal(v.ok, false);
  assert.match(v.errors.join(' '), /Nur 2 Eintraege/);
});

test('validateDraft: Erfolg mit Samples und Fuzzy-Treffern', async () => {
  const v = await validateDraft(fakeMcp(['ha_eval_template'], async () => textResult(PIPE5)), {
    tool: 'ha_eval_template',
    args: {},
    sampleQueries: ['licht im raum'],
  });
  assert.equal(v.ok, true);
  assert.equal(v.entryCount, 5);
  assert.equal(v.samples.length, 3);
  assert.equal(v.fuzzy.length, 1);
});

test('validateDraft: Probeausfuehrung wirft -> Fehlertext', async () => {
  const v = await validateDraft(
    fakeMcp(['ha_eval_template'], async () => {
      throw new Error('kaputt');
    }),
    { tool: 'ha_eval_template', args: {} }
  );
  assert.equal(v.ok, false);
  assert.match(v.errors.join(' '), /Probeausfuehrung fehlgeschlagen.*kaputt/);
});

test('validateDraft: transform-Fehler wird gemeldet', async () => {
  const v = await validateDraft(fakeMcp(['ha_get_states'], async () => textResult('kein json')), {
    tool: 'ha_get_states',
    args: {},
    transform: '{% for d in data %}{{ d.x }}{% endfor %}',
  });
  assert.equal(v.ok, false);
  assert.match(v.errors.join(' '), /Index-Tool meldet Fehler/);
});
