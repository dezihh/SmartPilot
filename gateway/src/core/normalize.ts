// Input-Normalisierung der Admin-Write-API: reine Funktionen (kein Express,
// keine DB). So verhalten sich REST-Endpoint und Tests identisch.
import type { ActionMode } from '../types.js';
import type { ActionInput } from '../db/actions.js';
import type { FunctionInput } from '../db/functions.js';

export function normalizeActionInput(body: Record<string, unknown>): ActionInput {
  const mode = String(body.mode ?? '');
  if (mode !== 'deterministic' && mode !== 'llm' && mode !== 'hybrid') {
    throw new Error(`Ungültiger Modus: ${mode}`);
  }
  // Akzeptiert raw- (trigger_phrases/tools) UND geparste Felder (triggers/toolList),
  // damit ein PUT mit dem Bootstrap-Body keine Trigger leert (Finding #12).
  // Auch JSON-Strings von der GET-API werden geparst.
  const parseMaybeJsonArray = (v: unknown): unknown[] | null => {
    if (Array.isArray(v)) return v.map(String);
    if (typeof v === 'string') {
      try {
        const parsed = JSON.parse(v) as unknown;
        if (Array.isArray(parsed)) return parsed.map(String);
      } catch {
        /* kein JSON - ignorieren */
      }
    }
    return null;
  };
  const triggers = parseMaybeJsonArray(body.trigger_phrases)
    ?? parseMaybeJsonArray(body.triggers)
    ?? [];
  const tools = parseMaybeJsonArray(body.tools)
    ?? parseMaybeJsonArray(body.toolList);
  const functionArgs =
    body.function_args && typeof body.function_args === 'object' && !Array.isArray(body.function_args)
      ? JSON.stringify(body.function_args)
      : null;
  const ft = Number(body.fuzzy_threshold);
  return {
    name: String(body.name ?? '').trim(),
    mode: mode as ActionMode,
    trigger_phrases: JSON.stringify(triggers),
    // Schwellwert nur im sinnvollen Bereich (0,1] akzeptieren; sonst Default.
    fuzzy_threshold: body.fuzzy_threshold == null || !Number.isFinite(ft) || ft <= 0 ? null : Math.min(1, ft),
    system_prompt: body.system_prompt == null ? null : String(body.system_prompt),
    template: body.template == null ? null : String(body.template),
    function_ref: body.function_ref == null ? null : String(body.function_ref).trim() || null,
    function_args: functionArgs,
    // Explizit leeres Array '[]' = bewusst OHNE Tools (z. B. Hilfe-Action);
    // null (Feld fehlt) = unveraendert/alle Tools.
    tools: tools ? JSON.stringify(tools) : null,
    // GET-Roundtrip liefert enabled als Zahl 0/1 -> 0 muss "aus" bleiben.
    enabled: body.enabled === false || body.enabled === 0 || body.enabled === '0' || body.enabled === 'false' ? 0 : 1,
  };
}

const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,64}$/;

/**
 * Normalisiert zusaetzliche HTTP-Header aus der Admin-API.
 * Akzeptiert ein Objekt, einen JSON-String oder Zeilen "Name: Wert".
 * Rueckgabe: JSON-String oder null (leer = bestehenden Wert behalten).
 */
export function normalizeHeaders(input: unknown): string | null {
  if (input === undefined || input === null) return null;
  let entries: [string, string][];
  if (typeof input === 'object' && !Array.isArray(input)) {
    entries = Object.entries(input as Record<string, unknown>).map(([k, v]) => [k, String(v)]);
  } else if (typeof input === 'string') {
    const raw = input.trim();
    if (!raw) return null;
    if (raw.startsWith('{')) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error('headers: ungültiges JSON');
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('headers: JSON-Objekt erwartet');
      }
      entries = Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, String(v)]);
    } else {
      entries = [];
      for (const line of raw.split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const i = t.indexOf(':');
        if (i <= 0) throw new Error(`headers: Zeile ohne "Name: Wert": ${t.slice(0, 60)}`);
        entries.push([t.slice(0, i).trim(), t.slice(i + 1).trim()]);
      }
    }
  } else {
    throw new Error('headers: Objekt, JSON oder "Name: Wert"-Zeilen erwartet');
  }
  const out: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (!HEADER_NAME_RE.test(name)) throw new Error(`headers: ungültiger Name "${name}"`);
    if (/[\r\n]/.test(value)) throw new Error(`headers: Wert für "${name}" enthält Zeilenumbruch`);
    out[name] = value;
  }
  return Object.keys(out).length ? JSON.stringify(out) : null;
}

/** Parst die in der DB gespeicherten Header; ungültige/leere Werte -> {}. */
export function parseHeaders(raw: string | null): Record<string, string> {
  try {
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (HEADER_NAME_RE.test(k) && !/[\r\n]/.test(String(v))) out[k] = String(v);
    }
    return out;
  } catch {
    return {};
  }
}

export function normalizeFunctionInput(body: Record<string, unknown>): FunctionInput {
  const name = String(body.name ?? '').trim();
  if (!/^[a-z0-9_]{2,40}$/.test(name)) {
    throw new Error('Name: 2-40 Zeichen, nur a-z, 0-9, _');
  }
  const template = String(body.template ?? '').trim();
  if (!template) throw new Error('Template fehlt');
  let parameters: string | null = null;
  if (body.parameters != null && typeof body.parameters === 'object') {
    parameters = JSON.stringify(body.parameters);
  }
  let budget: number | null = null;
  if (body.budget != null && Number.isFinite(Number(body.budget))) {
    const b = Math.floor(Number(body.budget));
    budget = b > 0 ? b : null;
  }
  return {
    name,
    description: body.description == null ? null : String(body.description).trim() || null,
    template,
    parameters,
    budget,
    inventory_prompt: body.inventory_prompt == null ? null : String(body.inventory_prompt).trim() || null,
    // Default 'write' (konservativ): nur explizites 'read' verwirft den Index-Cache nicht.
    side_effect: body.side_effect === 'read' ? 'read' : 'write',
    enabled: body.enabled === false || body.enabled === 0 || body.enabled === '0' || body.enabled === 'false' ? 0 : 1,
  };
}
