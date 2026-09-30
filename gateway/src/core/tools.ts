// Tool-Spec-Bau: MCP-Tools + Funktionen als LLM-Tool-Specs (Allowlist-Filter,
// Namens-Kollisionen, Budgets). Reine Bau-Funktion - kein LLM-Kontext.
import type { McpContext } from '../mcp/registry.js';
import type { ToolSpec } from '../llm/client.js';
import type { SideEffect } from '../types.js';
import { listFunctions } from '../db/functions.js';
import { getSetting } from '../db/settings.js';

export type ToolRoute =
  | { kind: 'mcp'; client: McpContext['servers'][number]['client']; toolName: string; sideEffect: SideEffect }
  | { kind: 'function'; name: string; sideEffect: SideEffect }
  | { kind: 'index_find' }
  | { kind: 'index_get' };

export type ToolRouteMap = { specs: ToolSpec[]; routes: Map<string, ToolRoute>; budgets: Map<string, number> };

// Leerer Code-Default: keine instanzspezifischen Tool-Namen im Kern (F-17).
export const LLM_BLOCKED_TOOLS = new Set<string>();

// Blockliste: per Setting 'llm_blocked_tools' (Komma-Liste) pflegbar.
// Nicht gesetzt = Code-Default (leer), leerer Wert = nichts blocken.
function blockedTools(): Set<string> {
  const raw = getSetting('llm_blocked_tools');
  if (raw === undefined) return LLM_BLOCKED_TOOLS;
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
}

export function sanitizeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function buildMcpTools(
  mcp: McpContext,
  allowlist: string[] | null,
  routes: Map<string, ToolRoute>,
  specs: ToolSpec[]
): void {
  const used = new Set(routes.keys());
  const blocked = blockedTools();
  for (const server of mcp.servers) {
    for (const def of server.tools) {
      if (blocked.has(def.name)) continue;
      let name = sanitizeToolName(def.name);
      if (routes.has(def.name) || used.has(name)) {
        name = `${sanitizeToolName(server.name)}__${sanitizeToolName(def.name)}`;
      }
      if (used.has(name)) continue;
      if (allowlist && !allowlist.includes(def.name) && !allowlist.includes(name)) continue;
      used.add(name);
      routes.set(name, { kind: 'mcp', client: server.client, toolName: def.name, sideEffect: server.sideEffect });
      specs.push({
        type: 'function',
        function: {
          name,
          description: (def.description ?? '').slice(0, 160),
          parameters: def.inputSchema ?? { type: 'object' },
        },
      });
    }
  }
}

// Basis-Werkzeuge (Variante A): die 2 Lesetools leben fest im Gateway-Code
// (core/indexTools.ts), unabhaengig von Datenbank und agent_tools - die
// Grundausstattung jeder Installation. DB-Funktionen mit gleichem Namen
// werden ignoriert (Built-Ins gewinnen).
const BASIS_TOOLS: Array<{ route: ToolRoute; name: string; description: string; parameters: ToolSpec['function']['parameters']; budget: number }> = [
  {
    route: { kind: 'index_find' },
    name: 'fn_find_entities',
    description:
      'Findet Eintraege im konfigurierten Index zu Stichworten (z. B. Name, Bereich, Typ) und liefert die gespeicherten Informationen dazu (max. 8 Treffer). IMMER zuerst bei Fragen, die ein konfigurierter Index beantworten kann (z. B. Zustaende, Messwerte, Status).',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: "Stichwörter, z. B. 'Schlafzimmer Temperatur' oder 'Zisterne'" },
        index: { type: 'string', description: 'Optional: Index-Schluessel, wenn mehrere Indizes konfiguriert sind (z. B. ma)' },
      },
      required: ['query'],
    },
    budget: 2,
  },
  {
    route: { kind: 'index_get' },
    name: 'fn_get_entity',
    description: 'Liest einen konkreten Index-Eintrag per Schluessel inkl. der gespeicherten Details.',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Schluessel des Eintrags, wie ihn fn_find_entities liefert' },
        index: { type: 'string', description: 'Optional: Index-Schluessel, wenn mehrere Indizes konfiguriert sind (z. B. ma)' },
      },
      required: ['key'],
    },
    budget: 3,
  },
];

export function buildBasisTools(routes: Map<string, ToolRoute>, specs: ToolSpec[], budgets: Map<string, number>): void {
  for (const basis of BASIS_TOOLS) {
    routes.set(basis.name, basis.route);
    if (basis.budget > 0) budgets.set(basis.name, basis.budget);
    specs.push({
      type: 'function',
      function: { name: basis.name, description: basis.description, parameters: basis.parameters },
    });
  }
}

export function buildTools(
  mcp: McpContext,
  allowlist: string[] | null
): ToolRouteMap {
  const routes = new Map<string, ToolRoute>();
  const specs: ToolSpec[] = [];
  const budgets = new Map<string, number>();
  // Basis-Werkzeuge nur, wenn ueberhaupt Tools angeboten werden: null = alle,
  // nicht-leere Liste = gefiltert. Explizit [] = bewusst KEINE Tools (z. B.
  // Hilfe-Action) - dann auch keine Basis-Werkzeuge.
  if (allowlist === null || allowlist.length > 0) buildBasisTools(routes, specs, budgets);
  buildMcpTools(mcp, allowlist, routes, specs);
  // Funktionen (Stufe 2.5): registrierte Funktionen als dynamische LLM-Tools,
  // optional mit Parameter-Schema; Argumente landen als args im Template.
  for (const fn of listFunctions(true)) {
    const toolName = `fn_${fn.name}`;
    if (routes.has(toolName)) continue; // Basis-Werkzeuge gewinnen
    if (allowlist && !allowlist.includes(fn.name) && !allowlist.includes(toolName)) continue;
    routes.set(toolName, { kind: 'function', name: fn.name, sideEffect: fn.side_effect });
    if (fn.budget && fn.budget > 0) budgets.set(toolName, fn.budget);
    specs.push({
      type: 'function',
      function: {
        name: toolName,
        description: (fn.description ?? `Funktion ${fn.name}`).slice(0, 300),
        parameters:
          fn.parameters && typeof fn.parameters === 'object'
            ? (fn.parameters as ToolSpec['function']['parameters'])
            : { type: 'object', properties: {} },
      },
    });
  }
  return { specs, routes, budgets };
}
