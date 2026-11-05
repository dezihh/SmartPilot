import { chatCompletion } from '../llm/client.js';
import type { ChatMessage } from '../llm/client.js';
import { config } from '../config.js';
import { getMcpContext, type McpContext } from '../mcp/registry.js';
import { parseIndexResult, scoreEntries, fmtEntry, invalidateIndex } from './entityIndex.js';
import { setSetting } from '../db.js';
import type { SideEffect } from '../types.js';

// Index-Assistent (Phase 2): LLM-gestuetztes Einbinden neuer Index-Quellen.
// Rollenverteilung: Das LLM ENTWERFT ein Draft (Tool + Argumente + Aliase),
// der deterministische Validator PRUEFT es live gegen den Server und den
// Datenvertrag (id|area|state|unit|name|key=value;...). Fehler gehen mit
// Self-Correction zurueck ans LLM (max. 3 Iterationen). Speichern passiert
// nur durch den Apply-Endpoint nach Admin-Bestaetigung.

export interface IndexDraft {
  tool: string;
  args: Record<string, unknown>;
  // Optional: nunjucks-Template (variable `data` = geparstes JSON des
  // Tool-Results), das Pipe-Zeilen im Datenvertrag erzeugt. Fuer Server,
  // deren Tools JSON liefern statt Template-Text (z. B. Music Assistant).
  transform?: string;
  ttlMs?: number;
  aliases?: Record<string, string>;
  sampleQueries?: string[];
}

export interface DraftValidation {
  ok: boolean;
  errors: string[];
  entryCount: number;
  samples: string[];
  fuzzy: { query: string; top: string | null }[];
}

// Konservative Klassifikation: nur erkennbar lesende Tools duerfen vom
// Assistenten probehalber ausgefuehrt werden. Der Server-sideEffect ist die
// primaere Quelle; der Namens-Regex bleibt als Schutz gegen falsch als "read"
// markierte Server. Beschreibungen enthalten Beispiel-Code (z. B.
// alarm_control_panel in Jinja-Snippets), gegen den Regex-Klassifikation nicht
// haltbar ist. Beidseitige Letter-Boundaries verhindern Substring-Fehltreffer
// ("expressions"->press, "IMPORTANT"->import), snake_case bleibt wirksam
// (ha_call_service).
const WRITE_HINT_RE =
  /(?<![A-Za-z])(create|set_|update|delete|remove|write|call_service|execute|turn|control|restart|reload|press|toggle|send|add_|save|import|restore|backup)(?![A-Za-z])/i;
const READ_NAME_RE = /eval|template|get|list|search|overview|state|history|context|read/i;

function isReadOnlyTool(name: string, serverSideEffect: SideEffect | null): boolean {
  if (WRITE_HINT_RE.test(name)) return false;
  if (serverSideEffect === 'read') return true;
  if (serverSideEffect === 'write') return false;
  return READ_NAME_RE.test(name);
}

function toolCatalog(mcp: McpContext): string {
  const parts: string[] = [];
  for (const server of mcp.servers) {
    const lines: string[] = [];
    for (const t of server.tools) {
      const schema = (t.inputSchema ?? {}) as {
        properties?: Record<string, { type?: string; description?: string }>;
        required?: string[];
      };
      const props = Object.entries(schema.properties ?? {})
        .slice(0, 8)
        .map(([k, v]) => `${k}:${v.type ?? '?'}${schema.required?.includes(k) ? '*' : ''}`)
        .join(', ');
      lines.push(`- ${t.name} | ${String(t.description ?? '').slice(0, 160)} | args: ${props || '(keine)'}`);
    }
    parts.push(`Server "${server.name}":\n${lines.join('\n')}`);
  }
  return parts.join('\n\n');
}

export async function validateDraft(
  mcp: McpContext,
  draft: IndexDraft,
  indexKey = ''
): Promise<DraftValidation> {
  const errors: string[] = [];
  const fuzzy: { query: string; top: string | null }[] = [];
  let samples: string[] = [];
  let entryCount = 0;

  if (!draft?.tool || typeof draft.tool !== 'string') {
    errors.push('Draft ohne gueltiges Feld "tool".');
  }
  if (!draft?.args || typeof draft.args !== 'object' || Array.isArray(draft.args)) {
    errors.push('Draft ohne gueltiges Feld "args" (Objekt).');
  }
  if (errors.length === 0) {
    let client: McpContext['servers'][number]['client'] | null = null;
    let serverSideEffect: SideEffect | null = null;
    for (const server of mcp.servers) {
      if (server.tools.some((t) => t.name === draft.tool)) {
        client = server.client;
        serverSideEffect = server.sideEffect;
        break;
      }
    }
    if (!client) {
      errors.push(`Tool ${draft.tool} auf keinem aktivierten MCP-Server gefunden.`);
    } else if (!isReadOnlyTool(draft.tool, serverSideEffect)) {
      errors.push(`Tool ${draft.tool} ist nicht erkennbar lesend - Probeausfuehrung abgelehnt.`);
    } else {
      try {
        const result = await client.callTool(draft.tool, draft.args ?? {});
        const { entries, error } = parseIndexResult(result, draft.transform);
        if (error) {
          errors.push(`Index-Tool meldet Fehler: ${error}`);
        }
        entryCount = entries.length;
        if (entries.length < 5) {
          errors.push(`Nur ${entries.length} Eintraege geparst (mind. 5 erwartet) - Extraktion passt nicht zum Datenvertrag id|area|state|unit|name|key=value;...`);
        }
        samples = entries.slice(0, 3).map(fmtEntry);
        for (const q of (draft.sampleQueries ?? []).slice(0, 3)) {
          const hits = scoreEntries(entries, String(q ?? ''), 1, indexKey);
          fuzzy.push({ query: q, top: hits[0] ? fmtEntry(hits[0]) : null });
        }
      } catch (e) {
        errors.push(`Probeausfuehrung fehlgeschlagen: ${String(e).slice(0, 300)}`);
      }
    }
  }
  return { ok: errors.length === 0, errors, entryCount, samples, fuzzy };
}

const ASSISTANT_SYSTEM_PROMPT = `Du konfigurierst den Entity-Index eines universellen MCP-Gateways.
Aufgabe: Finde auf den angegebenen MCP-Servern das Tool, das eine VOLLSTAENDIGE LISTE aller Eintraege liefert (States/Entities/Medien/...), und entwirf die Argumente, damit das Ergebnis folgendem Datenvertrag entspricht:
- EINE Zeile pro Eintrag
- Format: id|area|state|unit|name|key=value;key=value  (Pipe-getrennt, letzte Spalte optional)
- "state" ist der aktuelle Zustand, "area" der Raum/Standort (leer erlaubt)

Antworte NUR mit einem JSON-Objekt (kein Markdown, kein Text davor/danach):
{
  "tool": "<exakter Toolname>",
  "args": { ... Argumente fuer tools/call ... },
  "transform": "<optional: nunjucks-Template, das JSON in Pipe-Zeilen rendert>",
  "ttlMs": 60000,
  "aliases": { "mundartlichesWoerter": "imIndexVerwendetesWort", "...": "..." },
  "sampleQueries": ["<2-3 deutsche Suchanfragen eines Sprachassistenten>"]
}

Hinweise:
- Bei Jinja-faehigen Servern (Home Assistant) eignet sich ein Template-Tool mit
  "{% for e in states %}{{ e.entity_id }}|{{ area_name(e.entity_id) }}|{{ e.state }}|{{ e.attributes.get('unit_of_measurement','') }}|{{ e.attributes.get('friendly_name', e.entity_id) }}|{% endfor %}"
  und sinnvollen Attributen als sechste Spalte. Bei Template-Tools IMMER ein
  grosszuegiges Timeout-Argument mitgeben (z. B. timeout: 15), sonst bricht die
  Auswertung ueber grosse Instanzen mit success=false ab.
- Liefern die Tools des Servers NUR strukturiertes JSON (Array oder Objekt,
  z. B. Music Assistant) und gibt es kein Template-Tool, das Pipe-Text
  erzeugen kann, dann setze "transform": ein nunjucks-Template, das das
  geparste JSON unter der Variable data bekommt und EINE Zeile pro Eintrag
  im Format id|area|state|unit|name|key=value;... rendert. Beispiel:
  "{% for p in data %}{{ p.player_id }}|{{ p.group_name or '' }}|{{ p.state }}|{{ p.volume_level }}|{{ p.name }}|{% endfor %}"
  Kein transform, wenn das Tool bereits Pipe-Text liefert.
- Aliase abbilden Alltagsbegriffe auf Begriffe aus den Entity-Namen (z. B. draussen->aussen). Umlaute im Alias-Schluessel sind erlaubt.
- Wähle als sampleQueries typische kurze Sprachbefehle, die der Index treffen sollte.`;

function extractJson(text: string): IndexDraft | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as IndexDraft;
  } catch {
    return null;
  }
}

export interface AssistResult {
  goal: string;
  indexKey: string;
  draft: IndexDraft | null;
  validation: DraftValidation | null;
  iterations: number;
}

export async function assistIndex(goal: string, indexKey = ''): Promise<AssistResult> {
  const mcp = await getMcpContext();
  const catalog = toolCatalog(mcp);
  const ziel = `${goal || 'Entity-Index fuer die verbundenen Systeme einrichten.'}${
    indexKey ? ` (Dieser Index wird unter dem Key "${indexKey}" gespeichert - richte ihn ausschliesslich fuer diese Quelle ein.)` : ''
  }`;
  const messages: ChatMessage[] = [
    { role: 'system', content: ASSISTANT_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Verfuegbare MCP-Tools:\n\n${catalog}\n\nZiel des Admins: ${ziel}`,
    },
  ];

  let draft: IndexDraft | null = null;
  let validation: DraftValidation | null = null;
  const MAX_ITERATIONS = 3;
  for (let i = 1; i <= MAX_ITERATIONS; i++) {
    // Bewusst ein festes, grosszuegiges Token-Budget: der Katalog-Prompt ist
    // gross und das Draft enthaelt das komplette Extraktions-Template.
    const result = await chatCompletion(messages, undefined, 90_000, config.llm.model, 4000);
    const text = result.message.content ?? '';
    const candidate = extractJson(text);
    if (!candidate) {
      messages.push({ role: 'assistant', content: text.slice(0, 2000) });
      messages.push({
        role: 'user',
        content: 'Antwort war kein gueltiges JSON-Objekt. Antworte NUR mit dem JSON-Objekt nach Schema.',
      });
      continue;
    }
    draft = candidate;
    validation = await validateDraft(mcp, draft, indexKey);
    if (validation.ok) return { goal, indexKey, draft, validation, iterations: i };
    messages.push({ role: 'assistant', content: JSON.stringify(draft) });
    messages.push({
      role: 'user',
      content: `Validierung fehlgeschlagen:\n- ${validation.errors.join('\n- ')}\n\nKorrigiere das Draft (anteilige Ausgabe der letzten Probe: ${(validation.samples[0] ?? '(leer)').slice(0, 200)}) und antworte wieder NUR mit dem JSON-Objekt.`,
    });
  }
  return { goal, indexKey, draft, validation, iterations: MAX_ITERATIONS };
}

// Nur nach Admin-Bestaetigung aufrufen: validiert erneut und speichert das
// Draft als entity_index-Setting (mit Index-Key: 'ma' -> "entity_index_ma").
export async function applyDraft(draft: IndexDraft, indexKey = ''): Promise<DraftValidation> {
  const mcp = await getMcpContext();
  const validation = await validateDraft(mcp, draft, indexKey);
  if (!validation.ok) return validation;
  const setting = {
    tool: draft.tool,
    args: draft.args,
    ...(typeof draft.transform === 'string' && draft.transform.trim() ? { transform: draft.transform } : {}),
    ...(typeof draft.ttlMs === 'number' && draft.ttlMs > 0 ? { ttlMs: draft.ttlMs } : {}),
    ...(draft.aliases && Object.keys(draft.aliases).length > 0 ? { aliases: draft.aliases } : {}),
  };
  setSetting(indexKey ? `entity_index_${indexKey}` : 'entity_index', JSON.stringify(setting));
  invalidateIndex();
  return validation;
}
