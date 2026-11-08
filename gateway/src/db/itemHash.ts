// Hash-Basis fuer package_items: eine Quelle fuer Install (packages.ts) und die
// Hash-Rebase-Migration (schema.ts). Die Feldreihenfolge ist Teil des Hashes
// (JSON.stringify), daher hier zentral und stabil halten.
import { createHash } from 'node:crypto';

export function hashContent(kind: string, name: string, content: unknown): string {
  return createHash('sha256').update(JSON.stringify({ kind, name, content })).digest('hex').slice(0, 16);
}

// args normalisieren: leeres Array, "[]" und null/undefined sind gleichwertig
// (=> gleicher Hash). Verhindert Scheinkonflikte, wenn die Bestandszeile "[]"
// traegt, das Manifest aber kein args-Feld hat (serverContent -> null).
export function normalizeArgs(raw: unknown): unknown {
  if (raw === null || raw === undefined) return null;
  if (Array.isArray(raw)) return raw.length === 0 ? null : JSON.stringify(raw);
  const s = String(raw).trim();
  if (s === '' || s === '[]') return null;
  try {
    const parsed = JSON.parse(s) as unknown;
    if (Array.isArray(parsed) && parsed.length === 0) return null;
  } catch {
    // kein JSON: unveraendert lassen
  }
  return raw;
}

export interface ServerHashRow {
  name: unknown;
  url: unknown;
  auth_token: unknown;
  transport: unknown;
  command: unknown;
  args: unknown;
  env: unknown;
  npm_spec: unknown;
  headers: unknown;
  inventory_prompt: unknown;
  side_effect: unknown;
  enabled: unknown;
}

// Kanonische Form der Header (sortierte Schluessel) - Reihenfolge im Manifest
// darf den Hash nicht veraendern. Leere Objekte/Null zaehlen als "keine".
export function normalizeHeaders(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (s === '' || s === '{}') return null;
    try {
      obj = JSON.parse(s) as unknown;
    } catch {
      return s;
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const entries = Object.entries(obj as Record<string, unknown>)
    .filter(([, v]) => v !== null && v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (!entries.length) return null;
  return JSON.stringify(Object.fromEntries(entries));
}

// Aktuelle Feldform (inkl. npm_spec und headers) - entspricht dem, was
// serverRowContent() aus der DB liest und serverContent() aus dem Manifest schreibt.
export function serverContentNew(row: ServerHashRow): Record<string, unknown> {
  return {
    name: row.name, url: row.url, auth_token: row.auth_token, transport: row.transport,
    command: row.command, args: normalizeArgs(row.args), env: row.env, npm_spec: row.npm_spec,
    headers: normalizeHeaders(row.headers),
    inventory_prompt: row.inventory_prompt, side_effect: row.side_effect, enabled: row.enabled,
  };
}

// Feldform vor Migration 7 (ohne headers) - fuer den einmaligen Hash-Rebase.
export function serverContentV6(row: ServerHashRow): Record<string, unknown> {
  return {
    name: row.name, url: row.url, auth_token: row.auth_token, transport: row.transport,
    command: row.command, args: normalizeArgs(row.args), env: row.env, npm_spec: row.npm_spec,
    inventory_prompt: row.inventory_prompt, side_effect: row.side_effect, enabled: row.enabled,
  };
}

// Feldform von Action-Items vor Migration 10 (ohne side_effect/confirm/
// tool_params) - fuer den einmaligen Hash-Rebase.
export interface ActionHashRow {
  name: unknown;
  mode: unknown;
  trigger_phrases: unknown;
  fuzzy_threshold: unknown;
  system_prompt: unknown;
  template: unknown;
  function_ref: unknown;
  function_args: unknown;
  tools: unknown;
  enabled: unknown;
  side_effect: unknown;
  confirm: unknown;
  tool_params: unknown;
}

// Aktuelle Feldform inkl. der Sicherheitsattribute (ab Migration 10).
export function actionContentNew(row: ActionHashRow): Record<string, unknown> {
  return {
    ...actionContentV9(row),
    side_effect: row.side_effect,
    confirm: row.confirm,
    tool_params: row.tool_params,
  };
}

export function actionContentV9(row: ActionHashRow): Record<string, unknown> {
  return {
    name: row.name, mode: row.mode, trigger_phrases: row.trigger_phrases, fuzzy_threshold: row.fuzzy_threshold,
    system_prompt: row.system_prompt, template: row.template, function_ref: row.function_ref,
    function_args: row.function_args, tools: row.tools, enabled: row.enabled,
  };
}

// Alte Feldform (v0.2.1, ohne npm_spec) - fuer den einmaligen Hash-Rebase.
export function serverContentOld(row: ServerHashRow): Record<string, unknown> {
  return {
    name: row.name, url: row.url, auth_token: row.auth_token, transport: row.transport,
    command: row.command, args: normalizeArgs(row.args), env: row.env,
    inventory_prompt: row.inventory_prompt, side_effect: row.side_effect, enabled: row.enabled,
  };
}
