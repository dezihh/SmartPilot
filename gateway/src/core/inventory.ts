// Inventory-Generator: der Faehigkeits-Katalog des Agenten entsteht aus den
// registrierten Funktionen selbst (inventory_prompt), nicht aus einer langen
// Handpflege-Datei. `agent_inventory` bleibt der Regel-Block (Verhalten,
// Kaskaden, Alias-Listen); der Marker {{AGENT_FNS}} wird durch die
// Objekt-Zeilen ersetzt (Fallback: ans Ende).
// Reihenfolge/Inhalt deterministisch (fn.id), damit der LLM-Prefix stabil ist.
import { listFunctions, type ParsedFunction } from '../db/functions.js';
import { getPrompt, getSetting } from '../db/settings.js';
import { listMcpServers } from '../db/mcpServers.js';

const FNS_MARKER = '{{AGENT_FNS}}';
// Klartext, wenn nichts eingerichtet ist - verhindert, dass der rohe Marker im
// Prompt landet und das LLM Faehigkeiten erfindet (Issue: Hilfe ohne Pakete).
const EMPTY_INVENTORY_NOTE = 'Zurzeit sind keine Funktionen oder Systeme eingerichtet.';

function toolNameFor(fn: ParsedFunction): string {
  return `fn_${fn.name}`;
}

// Nur fns, die der Agent auch aufrufen darf (agent_tools-Allowlist-Semantik:
// nicht gesetzt/'alle' = alle, 'keine' = keine, Liste = exakt diese).
export function agentFnAllowlist(): string[] | null {
  const raw = (getSetting('agent_tools') ?? '').trim().toLowerCase();
  if (!raw || raw === 'alle') return null;
  if (raw === 'keine') return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function fnLines(allowlist: string[] | null): string[] {
  const lines: string[] = [];
  for (const fn of listFunctions(true)) {
    const note = (fn.inventory_prompt ?? '').trim();
    if (!note) continue;
    const toolName = toolNameFor(fn);
    if (allowlist && !allowlist.includes(fn.name) && !allowlist.includes(toolName)) continue;
    lines.push(`- ${toolName}: ${note}`);
  }
  return lines;
}

// System-Regeln (Kaskaden, Eigenheiten) leben am MCP-Server selbst.
// only: Namen der Systeme, deren Tools der Agent dieses Aufrufs tatsächlich
// anbietet (null = alle, Liste = gefiltert) - nutzlose Noten sparen Prompt.
export function systemLines(only?: string[] | null): string[] {
  const lines: string[] = [];
  for (const server of listMcpServers(true)) {
    const note = (server.inventory_prompt ?? '').trim();
    if (!note) continue;
    if (Array.isArray(only) && !only.includes(server.name)) continue;
    lines.push(`- ${server.name}: ${note}`);
  }
  return lines;
}

export function buildInventoryPrompt(activeServers?: string[] | null): string {
  const rules = getPrompt('agent_inventory') ?? '';
  const lines = fnLines(agentFnAllowlist());
  const systems = systemLines(activeServers === undefined ? null : activeServers);
  const blocks: string[] = [];
  if (lines.length > 0) {
    blocks.push(`## Werkzeuge (aus den registrierten Funktionen)\n${lines.join('\n')}`);
  }
  if (systems.length > 0) {
    blocks.push(`## Systeme (Kaskaden und Eigenheiten)\n${systems.join('\n')}`);
  }
  if (rules.includes(FNS_MARKER)) {
    const body = blocks.length > 0 ? blocks.join('\n\n') : EMPTY_INVENTORY_NOTE;
    return rules.split(FNS_MARKER).join(body);
  }
  if (blocks.length === 0) return rules;
  return `${rules}\n\n${blocks.join('\n\n')}`;
}
