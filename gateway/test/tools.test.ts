import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb, getDb } from '../src/db/schema.js';
import { createFunction } from '../src/db/functions.js';
import { setSetting, deleteSetting } from '../src/db/settings.js';
import { buildTools, buildMcpTools, sanitizeToolName, toolSpecStats } from '../src/core/tools.js';
import type { ToolSpec } from '../src/llm/client.js';
import type { McpContext, McpServerContext } from '../src/mcp/registry.js';
import type { ToolRoute } from '../src/core/tools.js';
import { tmpDb } from './_tmpdb.js';

const DB_PATH = tmpDb('tools');

before(() => {
  closeDb();
  initDb(DB_PATH);
  getDb().exec('DELETE FROM tpl_functions');
  createFunction({
    name: 'recherche',
    description: 'Sehr lange Beschreibung, die deutlich ueber die Beschneidungsgrenze hinaus geht und deshalb abgeschnitten werden muss damit der Prompt nicht explodiert.'.repeat(3),
    template: 'test',
    parameters: '{"type":"object","properties":{"query":{"type":"string"}}}',
    budget: 2,
    inventory_prompt: null,
    enabled: 1,
  });
  createFunction({
    name: 'ohne_budget',
    description: null,
    template: 'test',
    parameters: null,
    budget: null,
    inventory_prompt: null,
    enabled: 1,
  });
});

after(() => {
  getDb().exec("DELETE FROM tpl_functions WHERE name LIKE 'test%' OR name IN ('recherche','ohne_budget')");
  closeDb();
});

function client(): McpServerContext['client'] {
  return {
    init: async () => {},
    listTools: async () => [],
    callTool: async () => ({}),
  };
}

function mcpWith(tools: { name: string; description?: string; inputSchema?: unknown }[], serverName = 'srv1'): McpContext {
  return {
    servers: [
      {
        id: 1,
        name: serverName,
        sideEffect: 'write',
        tools: tools.map((t) => ({ ...t, inputSchema: t.inputSchema ?? { type: 'object' } })),
        client: client(),
      },
    ],
  };
}

test('Issue #4 Stufe 3: toolParams filtert das Tool-Schema', () => {
  const schema = { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } }, required: ['a', 'b'] };
  const { specs } = buildTools(mcpWith([{ name: 'tool_a', inputSchema: schema }]), null, {
    toolParams: { tool_a: ['a'] },
  });
  const spec = specs.find((s) => s.function.name === 'tool_a');
  assert.ok(spec);
  const params = spec!.function.parameters as { properties: Record<string, unknown>; required: string[] };
  assert.deepEqual(Object.keys(params.properties), ['a']);
  assert.deepEqual(params.required, ['a']);
  assert.deepEqual(Object.keys(schema.properties), ['a', 'b'], 'Original-Schema bleibt unberuehrt');
  const frei = buildTools(mcpWith([{ name: 'tool_b', inputSchema: schema }]), null, { toolParams: { tool_a: ['a'] } });
  const specB = frei.specs.find((s) => s.function.name === 'tool_b')!;
  assert.deepEqual(
    Object.keys((specB.function.parameters as { properties: Record<string, unknown> }).properties),
    ['a', 'b']
  );
});

test('sanitizeToolName: Sonderzeichen werden Unterstrich', () => {
  assert.equal(sanitizeToolName('brave.web/search:x'), 'brave_web_search_x');
});

test('buildMcpTools: alle Tools werden Specs+Routes', () => {
  const routes = new Map<string, ToolRoute>();
  const specs: ToolSpec[] = [];
  buildMcpTools(mcpWith([{ name: 'tool_a', description: 'Beschreibung A' }, { name: 'tool_b' }]), null, routes, specs);
  assert.deepEqual([...routes.keys()].sort(), ['tool_a', 'tool_b']);
  assert.equal(specs.length, 2);
  const specA = specs.find((s) => s.function.name === 'tool_a');
  assert.equal(specA?.function.description, 'Beschreibung A');
});

test('buildMcpTools: Blocklist-Tools fehlen komplett', () => {
  const blocked = 'tool_blocked_x';
  setSetting('llm_blocked_tools', blocked);
  try {
    const routes = new Map<string, ToolRoute>();
    const specs: ToolSpec[] = [];
    buildMcpTools(mcpWith([{ name: 'tool_a' }, { name: blocked }]), null, routes, specs);
    assert.equal(routes.has(blocked), false);
    assert.equal(specs.length, 1);
  } finally {
    deleteSetting('llm_blocked_tools');
  }
});

test('buildMcpTools: Namenskollision -> erster Server behaelt freien Namen, Folgeserver bekommen Praefix', () => {
  const routes = new Map<string, ToolRoute>();
  const specs: ToolSpec[] = [];
  const ctx = {
    servers: [
      { id: 1, name: 'srv_a', tools: [{ name: 'tool_x', inputSchema: {} }], client: client() },
      { id: 2, name: 'srv_b', tools: [{ name: 'tool_x', inputSchema: {} }], client: client() },
    ],
  };
  buildMcpTools(ctx as McpContext, null, routes, specs);
  assert.deepEqual([...routes.keys()].sort(), ['srv_b__tool_x', 'tool_x']);
  assert.ok(routes.get('tool_x'), 'srv_a mit Rohname');
  const prefixed = routes.get('srv_b__tool_x');
  assert.ok(prefixed && prefixed.kind === 'mcp', 'srv_b mit Praefix zeigt aufs gleiche Tool');
  assert.equal(prefixed.toolName, 'tool_x', 'srv_b mit Praefix zeigt aufs gleiche Tool');
  assert.equal(specs.length, 2);
});

test('buildMcpTools: Allowlist filtert nach Roh- und sanitisiertem Namen', () => {
  const routes = new Map<string, ToolRoute>();
  const specs: ToolSpec[] = [];
  buildMcpTools(mcpWith([{ name: 'tool.a' }, { name: 'tool_b' }]), ['tool.a'], routes, specs);
  // 'tool.a' matcht via Rohname, 'tool_b' faellt raus
  assert.deepEqual([...routes.keys()], ['tool_a']);
});

test('buildTools: Funktionen bekommen fn_-Praefix + Budget + Schema', () => {
  const { specs, routes, budgets } = buildTools(mcpWith([]), null);
  const recherche = routes.get('fn_recherche');
  assert.ok(recherche);
  assert.equal(recherche.kind, 'function');
  assert.equal(budgets.get('fn_recherche'), 2);
  const spec = specs.find((s) => s.function.name === 'fn_recherche');
  assert.ok(spec);
  assert.equal((spec.function.description ?? '').length, 300);
  assert.deepEqual((spec.function.parameters as { type: string }).type, 'object');
  assert.ok(routes.has('fn_ohne_budget'));
  assert.equal(budgets.has('fn_ohne_budget'), false);
});

test('buildTools: Allowlist schliesst Funktionen aus', () => {
  const { routes } = buildTools(mcpWith([]), ['recherche']);
  assert.ok(routes.has('fn_recherche'));
  assert.equal(routes.has('fn_ohne_budget'), false);
});

test('buildTools: leere Allowlist [] = bewusst keine Tools (auch keine Basis-Werkzeuge)', () => {
  const { specs, routes } = buildTools(mcpWith([{ name: 'tool_a' }]), []);
  assert.equal(specs.length, 0);
  assert.equal(routes.size, 0);
});

test('buildTools: Basis-Werkzeuge sind bei null/gefilterter Liste dabei', () => {
  const alle = buildTools(mcpWith([]), null);
  assert.ok(alle.routes.has('fn_find_entities') && alle.routes.has('fn_get_entity'), 'bei null');
  assert.equal(alle.routes.get('fn_find_entities')?.kind, 'index_find');
  const gefiltert = buildTools(mcpWith([]), ['recherche']);
  assert.ok(gefiltert.routes.has('fn_find_entities'), 'Basis-Werkzeug trotz Allowlist');
});

test('agent_tool_limit: Vorgangs-Tools (applyAgentToolLimit: false) bleiben vollstaendig', () => {
  setSetting('agent_tool_limit', '1');
  try {
    const tools = [{ name: 't1' }, { name: 't2' }, { name: 't3' }];
    const action = buildTools(mcpWith(tools), ['t3', 't2'], { applyAgentToolLimit: false });
    assert.ok(action.routes.has('t2') && action.routes.has('t3'), 'explizite Vorgangs-Tools bleiben');
    // Gleiche Liste ohne Opt-out: der Deckel greift (alphabetisch erste bleibt).
    const trimmed = buildTools(mcpWith(tools), ['t3', 't2']);
    assert.ok(trimmed.routes.has('t2'));
    assert.equal(trimmed.routes.has('t3'), false);
  } finally {
    deleteSetting('agent_tool_limit');
  }
});

test('toolSpecStats: zaehlt Specs, Zeichen und Naeherungstokens', () => {
  const specs: ToolSpec[] = [
    { type: 'function', function: { name: 'a', description: 'abcd', parameters: { type: 'object' } } },
    { type: 'function', function: { name: 'bb', parameters: { type: 'object' } } },
  ];
  const stats = toolSpecStats(specs);
  assert.equal(stats.count, 2);
  assert.ok(stats.chars > 0, 'Zeichen werden gezaehlt');
  assert.equal(stats.approxTokens, Math.ceil(stats.chars / 4));
});

test('agent_tool_limit: begrenzt nur MCP-Tools, Basis und fn_* bleiben', () => {
  setSetting('agent_tool_limit', '2');
  try {
    const { specs, routes } = buildTools(mcpWith([{ name: 't1' }, { name: 't2' }, { name: 't3' }]), null);
    const mcpNames = [...routes.entries()]
      .filter(([, r]) => r.kind === 'mcp')
      .map(([name]) => name)
      .sort();
    assert.deepEqual(mcpNames, ['t1', 't2'], 'deterministisch die ersten beiden');
    assert.ok(routes.has('fn_find_entities'), 'Basis-Werkzeug bleibt');
    assert.ok(routes.has('fn_recherche'), 'Funktion bleibt');
    assert.ok(specs.some((s) => s.function.name === 'fn_find_entities'));
    assert.equal(specs.some((s) => s.function.name === 't3'), false);
  } finally {
    deleteSetting('agent_tool_limit');
  }
});

test('agent_tool_limit: 0 oder leer = unbegrenzt', () => {
  setSetting('agent_tool_limit', '0');
  try {
    const { routes } = buildTools(mcpWith([{ name: 't1' }, { name: 't2' }, { name: 't3' }]), null);
    assert.equal([...routes.entries()].filter(([, r]) => r.kind === 'mcp').length, 3);
  } finally {
    deleteSetting('agent_tool_limit');
  }
});

test('agent_tool_limit: ungueltige oder negative Werte bedeuten unbegrenzt', () => {
  for (const raw of ['', '-1', 'viele', 'NaN']) {
    setSetting('agent_tool_limit', raw);
    try {
      const { routes } = buildTools(mcpWith([{ name: 't1' }, { name: 't2' }]), null);
      assert.equal(
        [...routes.entries()].filter(([, r]) => r.kind === 'mcp').length,
        2,
        `Wert ${JSON.stringify(raw)} darf nicht als Deckel wirken`,
      );
    } finally {
      deleteSetting('agent_tool_limit');
    }
  }
});

test('agent_tool_limit groesser als das Angebot schneidet nichts ab', () => {
  setSetting('agent_tool_limit', '10');
  try {
    const { routes, specs } = buildTools(mcpWith([{ name: 't1' }, { name: 't2' }]), null);
    assert.equal([...routes.entries()].filter(([, r]) => r.kind === 'mcp').length, 2);
    assert.equal(specs.filter((s) => s.function.name.startsWith('t')).length, 2);
  } finally {
    deleteSetting('agent_tool_limit');
  }
});
