import { createHash } from 'node:crypto';
import { getDb } from './schema.js';
import type { PackageManifest, PackageServer, PackageFunction, PackageAction } from '../core/packages.js';
import { substituteManifest, manifestDangerous, manifestHash } from '../core/packages.js';
import { getSetting, setSetting } from './settings.js';

export interface InstalledPackageRow {
  id: string;
  version: string;
  source: string;
  registry_url: string | null;
  params: string; // JSON ohne Secret-Werte
  manifest_hash: string;
  installed_at: string;
}

export interface PackageItemRow {
  package_id: string;
  kind: string; // server | function | action | index | allowTools
  name: string;
  row_id: number | null;
  content_hash: string;
}

export function listInstalledPackages(): InstalledPackageRow[] {
  return getDb().prepare('SELECT * FROM packages ORDER BY id').all() as InstalledPackageRow[];
}

export function getInstalledPackage(id: string): InstalledPackageRow | undefined {
  return getDb().prepare('SELECT * FROM packages WHERE id = ?').get(id) as InstalledPackageRow | undefined;
}

export function listPackageItems(id: string): PackageItemRow[] {
  return getDb().prepare('SELECT * FROM package_items WHERE package_id = ? ORDER BY kind, name').all(id) as PackageItemRow[];
}

export function listAllPackageItems(): PackageItemRow[] {
  return getDb().prepare('SELECT * FROM package_items ORDER BY package_id, kind, name').all() as PackageItemRow[];
}

function hashContent(kind: string, name: string, content: unknown): string {
  return createHash('sha256').update(JSON.stringify({ kind, name, content })).digest('hex').slice(0, 16);
}

// Server-Row-Content aus Manifest-Server (fuer Hash + Upsert identisch).
function serverContent(s: PackageServer): Record<string, unknown> {
  return {
    name: s.name,
    url: s.transport === 'http' ? (s.url ?? '') : '',
    auth_token: s.auth_token ?? null,
    transport: s.transport,
    command: s.transport === 'stdio' ? (s.command ?? '') : null,
    args: s.transport === 'stdio' && s.args?.length ? JSON.stringify(s.args) : null,
    env: s.transport === 'stdio' && s.env ? JSON.stringify(s.env) : null,
    inventory_prompt: s.inventory_prompt ?? null,
    side_effect: s.sideEffect === 'read' ? 'read' : 'write',
    enabled: s.enabled === false ? 0 : 1,
  };
}

function functionContent(f: PackageFunction): Record<string, unknown> {
  return {
    name: f.name,
    description: f.description ?? null,
    template: f.template,
    parameters: typeof f.parameters === 'object' && f.parameters ? JSON.stringify(f.parameters) : (f.parameters ?? null),
    budget: f.budget ?? 1,
    inventory_prompt: f.inventory_prompt ?? null,
    side_effect: f.sideEffect === 'read' ? 'read' : 'write',
    enabled: 1,
  };
}

function actionContent(a: PackageAction): Record<string, unknown> {
  return {
    name: a.name,
    mode: a.mode,
    trigger_phrases: a.trigger_phrases === undefined ? null : JSON.stringify(a.trigger_phrases),
    fuzzy_threshold: a.fuzzy_threshold ?? null,
    system_prompt: a.system_prompt ?? null,
    template: a.template ?? null,
    function_ref: a.function_ref ?? null,
    function_args:
      a.function_args === undefined ? null : typeof a.function_args === 'string' ? a.function_args : JSON.stringify(a.function_args),
    tools: a.tools === undefined ? null : JSON.stringify(a.tools),
    enabled: a.enabled === false ? 0 : 1,
  };
}

export interface PackageReport {
  created: string[];
  updated: string[];
  unchanged: string[];
  /** Items, die der Nutzer lokal geaendert hat (aktueller Stand != Paket-Stand). */
  conflicts: string[];
  /** Items, die auf Wunsch lokal behalten wurden (Install-Entscheidung 'keep'). */
  kept: string[];
  dangerous: boolean;
  dangerousItems: string[];
  infoItems: string[];
}

class DryRunSignal extends Error {}

// Items mit lokaler Abweichung: der aktuelle DB-Stand (Server/Funktion/Index)
// weicht vom zuletzt vom Paket gesetzten Inhalt (package_items.content_hash) ab.
// Nur solche Items brauchen beim (Re-)Install eine Entscheidung.
export function conflictItems(packageId: string): string[] {
  const conflicts: string[] = [];
  for (const item of listPackageItems(packageId)) {
    if (item.kind === 'allowTools') continue;
    let content: unknown = null;
    if (item.kind === 'server') content = serverRowContent(item.name);
    else if (item.kind === 'function') content = functionRowContent(item.name);
    else if (item.kind === 'action') content = actionRowContent(item.name);
    else if (item.kind === 'index') {
      const raw = getSetting(item.name);
      if (raw !== undefined) {
        try { content = JSON.parse(raw); } catch { content = raw; }
      }
    } else continue;
    if (content === null) continue; // Zeile fehlt -> wird neu angelegt, kein Konflikt
    if (hashContent(item.kind, item.name, content) !== item.content_hash) conflicts.push(`${item.kind}:${item.name}`);
  }
  return conflicts;
}

// Install = Upsert (mehrfach installieren ueberschreibt/aktualisiert).
// Provenienz in packages + package_items. dangerAck: bei shell()-Templates
// erforderlich. decisions: pro Item 'take' (Paket-Inhalt uebernehmen) oder
// 'keep' (lokale Aenderung behalten). Standard bei lokal geaenderten Zeilen
// (Konflikt) ist 'keep' - nur ein ausdrueckliches 'take' ueberschreibt sie.
// dryRun: nur Report berechnen, ohne zu schreiben (fuer die Diff-Vorschau).
export function installPackage(
  m: PackageManifest,
  opts: {
    source?: string;
    registryUrl?: string | null;
    values?: Record<string, string>;
    dangerousAck?: boolean;
    decisions?: Record<string, 'take' | 'keep'>;
    dryRun?: boolean;
  }
): PackageReport {
  const db = getDb();
  const applied = substituteManifest(m, opts.values ?? {});
  const danger = manifestDangerous(applied);
  if (danger.dangerous && !opts.dangerousAck) {
    throw new Error('Gefaehrliche Aktion: Bestaetigung erforderlich (dangerous_ack)');
  }
  const decisions = opts.decisions ?? {};
  // Lokal geaenderte Zeilen (Konflikt) bleiben per Default erhalten; eine
  // ausdrueckliche 'take'-Entscheidung ueberschreibt sie. Nicht-konfliktende
  // Zeilen werden weiterhin auf die Paket-Version aktualisiert.
  const conflicts = conflictItems(m.id);
  const conflictSet = new Set(conflicts);
  const keep = (key: string): boolean =>
    decisions[key] === 'keep' || (decisions[key] !== 'take' && conflictSet.has(key));
  const report: PackageReport = {
    created: [], updated: [], unchanged: [], kept: [], conflicts,
    dangerous: danger.dangerous, dangerousItems: danger.items, infoItems: danger.info,
  };

  const run = (): void => {
  db.transaction(() => {
    for (const s of applied.servers ?? []) {
      const content = serverContent(s);
      const key = `server:${s.name}`;
      const existing = db.prepare('SELECT id FROM mcp_servers WHERE name = ?').get(s.name) as { id: number } | undefined;
      if (existing && keep(key)) {
        report.kept.push(key);
      } else if (existing) {
        db.prepare(
          `UPDATE mcp_servers SET name = @name, url = @url, auth_token = @auth_token, transport = @transport,
           command = @command, args = @args, env = @env, inventory_prompt = @inventory_prompt, side_effect = @side_effect, enabled = @enabled
           WHERE id = @id`
        ).run({ ...content, id: existing.id });
        report.updated.push(key);
      } else {
        db.prepare(
          `INSERT INTO mcp_servers (name, url, auth_token, transport, command, args, env, inventory_prompt, side_effect, enabled)
           VALUES (@name, @url, @auth_token, @transport, @command, @args, @env, @inventory_prompt, @side_effect, @enabled)`
        ).run(content);
        report.created.push(key);
      }
      const row = db.prepare('SELECT id FROM mcp_servers WHERE name = ?').get(s.name) as { id: number } | undefined;
      recordItem(m.id, 'server', s.name, row?.id ?? null, hashContent('server', s.name, content));
    }
    for (const f of applied.functions ?? []) {
      const content = functionContent(f);
      const key = `function:${f.name}`;
      const existing = db.prepare('SELECT id FROM tpl_functions WHERE name = ?').get(f.name) as { id: number } | undefined;
      if (existing && keep(key)) {
        report.kept.push(key);
      } else if (existing) {
        db.prepare(
          `UPDATE tpl_functions SET name = @name, description = @description, template = @template,
           parameters = @parameters, budget = @budget, inventory_prompt = @inventory_prompt, side_effect = @side_effect, enabled = @enabled,
           updated_at = datetime('now') WHERE id = @id`
        ).run({ ...content, id: existing.id });
        report.updated.push(key);
      } else {
        db.prepare(
          `INSERT INTO tpl_functions (name, description, template, parameters, budget, inventory_prompt, side_effect, enabled)
           VALUES (@name, @description, @template, @parameters, @budget, @inventory_prompt, @side_effect, @enabled)`
        ).run(content);
        report.created.push(key);
      }
      const row = db.prepare('SELECT id FROM tpl_functions WHERE name = ?').get(f.name) as { id: number } | undefined;
      recordItem(m.id, 'function', f.name, row?.id ?? null, hashContent('function', f.name, content));
    }
    for (const a of applied.actions ?? []) {
      const content = actionContent(a);
      const key = `action:${a.name}`;
      const existing = db.prepare('SELECT id FROM actions WHERE name = ?').get(a.name) as { id: number } | undefined;
      if (existing && keep(key)) {
        report.kept.push(key);
      } else if (existing) {
        db.prepare(
          `UPDATE actions SET name = @name, mode = @mode, trigger_phrases = @trigger_phrases, fuzzy_threshold = @fuzzy_threshold,
           system_prompt = @system_prompt, template = @template, function_ref = @function_ref, function_args = @function_args,
           tools = @tools, enabled = @enabled, updated_at = datetime('now') WHERE id = @id`
        ).run({ ...content, id: existing.id });
        report.updated.push(key);
      } else {
        db.prepare(
          `INSERT INTO actions (name, mode, trigger_phrases, fuzzy_threshold, system_prompt, template, function_ref, function_args, tools, enabled)
           VALUES (@name, @mode, @trigger_phrases, @fuzzy_threshold, @system_prompt, @template, @function_ref, @function_args, @tools, @enabled)`
        ).run(content);
        report.created.push(key);
      }
      const row = db.prepare('SELECT id FROM actions WHERE name = ?').get(a.name) as { id: number } | undefined;
      recordItem(m.id, 'action', a.name, row?.id ?? null, hashContent('action', a.name, content));
    }
    for (const ix of applied.indexes ?? []) {
      const key = ix.key ? `entity_index_${ix.key}` : 'entity_index';
      const itemKey = `index:${key}`;
      const existed = getSetting(key) !== undefined;
      if (existed && keep(itemKey)) {
        report.kept.push(itemKey);
      } else {
        setSetting(key, JSON.stringify(ix.config));
        (existed ? report.updated : report.created).push(itemKey);
      }
      recordItem(m.id, 'index', key, null, hashContent('index', key, ix.config));
    }
    if (applied.allowTools?.length) {
      const current = (getSetting('agent_tools') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      const set = new Set(current);
      const fresh = applied.allowTools.filter((t) => !set.has(t));
      if (fresh.length) {
        setSetting('agent_tools', [...current, ...fresh].join(','));
        report.created.push(`allowTools:${fresh.join(',')}`);
      } else report.unchanged.push('allowTools');
      recordItem(m.id, 'allowTools', applied.allowTools.join(','), null, hashContent('allowTools', 'agent_tools', applied.allowTools));
    }
    const safeParams: Record<string, string> = {};
    for (const p of m.params ?? []) safeParams[p.key] = p.secret ? '(gesetzt)' : (opts.values?.[p.key] ?? p.default ?? '');
    db.prepare(
      `INSERT INTO packages (id, version, source, registry_url, params, manifest_hash, installed_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET version = excluded.version, source = excluded.source,
       registry_url = excluded.registry_url, params = excluded.params, manifest_hash = excluded.manifest_hash,
       installed_at = datetime('now')`
    ).run(m.id, m.version, opts.source ?? 'registry', opts.registryUrl ?? null, JSON.stringify(safeParams), manifestHash(applied));
    if (opts.dryRun) throw new DryRunSignal();
  })();
  };
  try {
    run();
  } catch (e) {
    if (!(e instanceof DryRunSignal)) throw e;
  }

  return report;
}

function recordItem(packageId: string, kind: string, name: string, rowId: number | null, hash: string): void {
  getDb().prepare(
    `INSERT INTO package_items (package_id, kind, name, row_id, content_hash) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(package_id, kind, name) DO UPDATE SET row_id = excluded.row_id, content_hash = excluded.content_hash`
  ).run(packageId, kind, name, rowId, hash);
}

function serverRowContent(name: string): Record<string, unknown> | null {
  const row = getDb().prepare('SELECT * FROM mcp_servers WHERE name = ?').get(name) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    name: row.name, url: row.url, auth_token: row.auth_token, transport: row.transport,
    command: row.command, args: row.args, env: row.env, inventory_prompt: row.inventory_prompt, side_effect: row.side_effect, enabled: row.enabled,
  };
}

function functionRowContent(name: string): Record<string, unknown> | null {
  const row = getDb().prepare('SELECT * FROM tpl_functions WHERE name = ?').get(name) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    name: row.name, description: row.description, template: row.template, parameters: row.parameters,
    budget: row.budget, inventory_prompt: row.inventory_prompt, side_effect: row.side_effect, enabled: row.enabled,
  };
}

function actionRowContent(name: string): Record<string, unknown> | null {
  const row = getDb().prepare('SELECT * FROM actions WHERE name = ?').get(name) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    name: row.name, mode: row.mode, trigger_phrases: row.trigger_phrases, fuzzy_threshold: row.fuzzy_threshold,
    system_prompt: row.system_prompt, template: row.template, function_ref: row.function_ref, function_args: row.function_args,
    tools: row.tools, enabled: row.enabled,
  };
}

export interface UninstallReport {
  removed: string[];
  kept: string[];
}

// Deinstall: entfernt nur unveranderte Paket-Zeilen (Hash-Vergleich); lokal
// geaenderte bleiben mit Warnung. agent_tools: Paket-Tools werden abgezogen,
// ausser andere installierte Pakete fuehren sie ebenfalls.
export function uninstallPackage(id: string): { removed: string[]; kept: string[] } {
  const db = getDb();
  const pkg = getInstalledPackage(id);
  if (!pkg) throw new Error(`Paket "${id}" ist nicht installiert`);
  const report = { removed: [] as string[], kept: [] as string[] };

  db.transaction(() => {
    const toolsOthersNeed = new Set<string>();
    for (const other of listInstalledPackages()) {
      if (other.id === id) continue;
      for (const item of listPackageItems(other.id)) {
        if (item.kind === 'allowTools') for (const t of item.name.split(',')) toolsOthersNeed.add(t);
      }
    }
    for (const item of listPackageItems(id)) {
      if (item.kind === 'allowTools') {
        const current = (getSetting('agent_tools') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
        const removable = item.name.split(',').filter((t) => !toolsOthersNeed.has(t));
        const set = new Set(current);
        const removed: string[] = [];
        for (const t of removable) if (set.delete(t)) removed.push(t);
        if (removed.length) {
          setSetting('agent_tools', [...set].join(','));
          report.removed.push(`allowTools:${removed.join(',')}`);
        }
        continue;
      }
      if (item.kind === 'index') {
        // Index-Setting nur entfernen, wenn es unveraendert ist (wie Server/
        // Funktionen) - sonst bliebe eine lokal angepasste Config nicht erhalten.
        const current = getSetting(item.name);
        if (current === undefined) {
          report.removed.push(`index:${item.name}`);
          continue;
        }
        let parsed: unknown = current;
        try { parsed = JSON.parse(current); } catch { /* Rohwert vergleichen */ }
        if (hashContent('index', item.name, parsed) === item.content_hash) {
          db.prepare('DELETE FROM settings WHERE key = ?').run(item.name);
          report.removed.push(`index:${item.name}`);
        } else {
          report.kept.push(`index:${item.name} (lokal geaendert - nicht geloescht)`);
        }
        continue;
      }
      const kind = item.kind as 'server' | 'function' | 'action';
      const content = kind === 'server' ? serverRowContent(item.name) : kind === 'function' ? functionRowContent(item.name) : actionRowContent(item.name);
      if (content == null) {
        report.removed.push(`${item.kind}:${item.name}`);
        continue;
      }
      if (hashContent(item.kind, item.name, content) === item.content_hash) {
        if (kind === 'server') db.prepare('DELETE FROM mcp_servers WHERE name = ?').run(item.name);
        else if (kind === 'function') db.prepare('DELETE FROM tpl_functions WHERE name = ?').run(item.name);
        else db.prepare('DELETE FROM actions WHERE name = ?').run(item.name);
        report.removed.push(`${item.kind}:${item.name}`);
      } else {
        report.kept.push(`${item.kind}:${item.name} (lokal geaendert - nicht geloescht)`);
      }
    }
    db.prepare('DELETE FROM package_items WHERE package_id = ?').run(id);
    db.prepare('DELETE FROM packages WHERE id = ?').run(id);
  })();

  return report;
}
