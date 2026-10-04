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
  inventory_prompt: unknown;
  side_effect: unknown;
  enabled: unknown;
}

// Aktuelle Feldform (inkl. npm_spec) - entspricht dem, was serverRowContent()
// aus der DB liest und serverContent() aus dem Manifest schreibt.
export function serverContentNew(row: ServerHashRow): Record<string, unknown> {
  return {
    name: row.name, url: row.url, auth_token: row.auth_token, transport: row.transport,
    command: row.command, args: normalizeArgs(row.args), env: row.env, npm_spec: row.npm_spec,
    inventory_prompt: row.inventory_prompt, side_effect: row.side_effect, enabled: row.enabled,
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
