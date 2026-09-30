import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb, getDb } from '../src/db/schema.js';
import { createFunction } from '../src/db/functions.js';
import { setSetting, deleteSetting } from '../src/db/settings.js';
import { buildTools, buildMcpTools, sanitizeToolName } from '../src/core/tools.js';
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

function mcpWith(tools: { name: string; description?: string }[], serverName = 'srv1'): McpContext {
  return {
    servers: [
      {
        id: 1,
        name: serverName,
        sideEffect: 'write',
        tools: tools.map((t) => ({ ...t, inputSchema: { type: 'object' } })),
        client: client(),
      },
    ],
  };
}

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
