import { Router } from 'express';
import { requireAdminAuth } from '../auth.js';
import {
  installPackage,
  listInstalledPackages,
  listPackageItems,
  listAllPackageItems,
  uninstallPackage,
  conflictItems,
  packageDiff,
  existingParams,
  getInstalledPackage,
  parseStoredManifest,
  deriveCategory,
  parseManifest,
  validateManifest,
  manifestDangerous,
  manifestItems,
  paramValues,
  requiredParams,
  getSetting,
  getSettings,
  listActions,
  listFunctions,
  listMcpServers,
  listPrompts,
  getDb,
  type PackageManifest,
} from '../db.js';
import { invalidateMcpCache } from '../mcp/registry.js';
import { invalidateIndex } from '../core/entityIndex.js';
import { meetsMinVersion } from '../core/packages.js';
import { GATEWAY_VERSION } from '../version.js';
import { config } from '../config.js';

export const packagesRoutes = Router();

// Registry-URL: Default ist unser Repo (main); per PACKAGES_REGISTRY_URL z. B.
// auf einen Test-Branch umstellbar (dann kommen die Pakete von dort). Pakete
// liegen sprachspezifisch unter packages/<lang>/<id>/; die Sprache kommt aus dem
// Setting registry_language (Default "de").
const REGISTRY_URL = config.packagesRegistryUrl;
const REGISTRY_CACHE_MS = 60_000;

interface RegistryEntry {
  id: string;
  name: string;
  summary: string;
  version: string;
  category?: 'driver' | 'function' | 'mixed';
}
interface RegistryIndex {
  registryVersion: number;
  packages: RegistryEntry[];
}

let registryCache: { at: number; lang: string; data: RegistryIndex } | null = null;

function registryLanguage(): string {
  const v = (getSetting('registry_language') ?? 'de').trim().toLowerCase();
  return /^[a-z]{2}(-[a-z]{2})?$/.test(v) ? v : 'de';
}

function registryUrl(): string {
  return `${REGISTRY_URL.replace(/\/$/, '')}/${registryLanguage()}`;
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} bei ${url}`);
  return res.json() as unknown;
}

async function registryEntries(force: boolean): Promise<RegistryEntry[]> {
  const lang = registryLanguage();
  const base = registryUrl().replace(/\/$/, '');
  if (!force && registryCache && registryCache.lang === lang && Date.now() - registryCache.at < REGISTRY_CACHE_MS) {
    return registryCache.data.packages ?? [];
  }
  const idx = (await fetchJson(`${base}/index.json`)) as RegistryIndex;
  registryCache = { at: Date.now(), lang, data: idx };
  return idx.packages ?? [];
}

async function fetchManifest(id: string): Promise<PackageManifest> {
  const base = registryUrl().replace(/\/$/, '');
  const raw = (await fetchJson(`${base}/${id}/manifest.json`)) as unknown;
  const parsed = validateManifest(raw);
  if (!parsed.ok) throw new Error(parsed.errors.join('; '));
  return parsed.manifest;
}

// Verfuegbare Pakete (Registry).
packagesRoutes.get('/admin/api/packages/registry', requireAdminAuth, async (_req, res) => {
  try {
    res.json({ packages: await registryEntries(true) });
  } catch (e) {
    res.status(400).json({ error: String(e instanceof Error ? e.message : e) });
  }
});

// Manifest eines Registry-Pakets (fuer die Vorschau).
packagesRoutes.get('/admin/api/packages/manifest/:id', requireAdminAuth, async (req, res) => {
  try {
    const m = await fetchManifest(String(req.params.id ?? ''));
    const danger = manifestDangerous(m);
    res.json({
      manifest: {
        id: m.id, version: m.version, name: m.name, summary: m.summary,
        description: m.description, requires: m.requires, setupDocs: m.setupDocs, params: m.params ?? [],
        author: m.author, license: m.license, language: m.language ?? 'de', homepage: m.homepage,
        minGatewayVersion: m.minGatewayVersion, changelog: m.changelog,
      },
      items: manifestItems(m),
      dangerous: danger.dangerous,
      dangerousItems: danger.items,
      infoItems: danger.info,
    });
  } catch (e) {
    res.status(502).json({ error: `Manifest nicht ladbar (${String(e instanceof Error ? e.message : e)})` });
  }
});

// Vorschau fuer Offline-Manifest (im Body).
packagesRoutes.post('/admin/api/packages/preview', requireAdminAuth, (req, res) => {
  try {
    const body = req.body as { manifest?: unknown };
    const parsed = parseManifest(JSON.stringify(body.manifest ?? {}));
    if (!parsed.ok) return res.status(400).json({ error: parsed.errors.join('; ') });
    const m = parsed.manifest;
    const danger = manifestDangerous(m);
    res.json({
      manifest: {
        id: m.id, version: m.version, name: m.name, summary: m.summary,
        description: m.description, requires: m.requires, setupDocs: m.setupDocs, params: m.params ?? [],
        author: m.author, license: m.license, language: m.language ?? 'de', homepage: m.homepage,
        minGatewayVersion: m.minGatewayVersion, changelog: m.changelog,
      },
      items: manifestItems(m),
      dangerous: danger.dangerous,
      dangerousItems: danger.items,
      infoItems: danger.info,
      requiredParams: requiredParams(m),
    });
  } catch (e) {
    res.status(400).json({ error: String(e instanceof Error ? e.message : e) });
  }
});

// Install: Registry-Id ODER Offline-Manifest im Body; Parameter per Body.
packagesRoutes.post('/admin/api/packages/:id/install', requireAdminAuth, async (req, res) => {
  try {
    const body = req.body as { manifest?: unknown; params?: Record<string, string>; dangerousAck?: boolean; dryRun?: boolean; decisions?: Record<string, 'take' | 'keep'> };
    let manifest: PackageManifest;
    if (body.manifest) {
      const parsed = parseManifest(JSON.stringify(body.manifest));
      if (!parsed.ok) return res.status(400).json({ error: parsed.errors.join('; ') });
      manifest = parsed.manifest;
    } else {
      manifest = await fetchManifest(String(req.params.id ?? ''));
    }
    if (!meetsMinVersion(GATEWAY_VERSION, manifest.minGatewayVersion)) {
      return res.status(400).json({ error: `Paket ${manifest.id} benoetigt Gateway >= ${manifest.minGatewayVersion} (installiert: ${GATEWAY_VERSION}). Bitte zuerst das Gateway aktualisieren.` });
    }
    // Reinstall: leere Felder mit den bestehenden Werten (inkl. Secrets)
    // auffuellen -> keine erneute Eingabe noetig. Neuinstallation ohne Wert
    // wirft weiterhin "erforderlich".
    const provided = body.params ?? {};
    const current = existingParams(manifest.id, manifest);
    const merged: Record<string, string> = {};
    for (const p of manifest.params ?? []) {
      const v = provided[p.key];
      const keep = current[p.key];
      if (v == null || String(v).trim() === '') {
        if (keep) merged[p.key] = keep;
      } else {
        merged[p.key] = String(v);
      }
    }
    const values = paramValues(manifest, merged);
    const report = installPackage(manifest, {
      source: body.manifest ? 'import' : 'registry',
      registryUrl: body.manifest ? null : registryUrl(),
      values,
      dangerousAck: body.dangerousAck,
      decisions: body.decisions,
      dryRun: body.dryRun,
    });
    if (!body.dryRun) {
      invalidateMcpCache();
      invalidateIndex();
    }
    res.json({ report });
  } catch (e) {
    res.status(400).json({ error: String(e instanceof Error ? e.message : e) });
  }
});

packagesRoutes.post('/admin/api/packages/:id/uninstall', requireAdminAuth, (req, res) => {
  try {
    res.json({ report: uninstallPackage(String(req.params.id)) });
    invalidateMcpCache();
    invalidateIndex();
  } catch (e) {
    res.status(400).json({ error: String(e instanceof Error ? e.message : e) });
  }
});

// Installierte Pakete inkl. Items.
packagesRoutes.get('/admin/api/packages', requireAdminAuth, async (_req, res) => {
  // Manifest nicht in die Liste aufnehmen (Groesse); Name/Kategorie daraus
  // ableiten, damit die UI Klartext statt technischer IDs zeigt.
  const installed = listInstalledPackages().map(({ manifest, ...p }) => {
    const parsed = manifest ? parseStoredManifest(manifest) : null;
    return {
      ...p,
      name: parsed?.name ?? p.id,
      category: parsed?.category ?? (parsed ? deriveCategory(parsed) : undefined),
      items: listPackageItems(p.id).map((i) => ({ kind: i.kind, name: i.name, hash: i.content_hash })),
    };
  });
  let registry: RegistryEntry[] | null = null;
  try {
    registry = await registryEntries(false);
  } catch {
    registry = null;
  }
  res.json({ installed, registry, language: registryLanguage() });
});

// Lokale Abweichungen eines installierten Pakets (Diff vor dem Reinstall).
packagesRoutes.get('/admin/api/packages/:id/conflicts', requireAdminAuth, (req, res) => {
  try {
    res.json({ conflicts: conflictItems(String(req.params.id ?? '')) });
  } catch (e) {
    res.status(400).json({ error: String(e instanceof Error ? e.message : e) });
  }
});

// Vorschau-Diff: welche Items/Felder wuerde ein Install aendern (kein Schreiben).
packagesRoutes.post('/admin/api/packages/:id/diff', requireAdminAuth, async (req, res) => {
  try {
    const body = req.body as { manifest?: unknown };
    let manifest: PackageManifest;
    if (body.manifest) {
      const parsed = parseManifest(JSON.stringify(body.manifest));
      if (!parsed.ok) throw new Error(parsed.errors.join('; '));
      manifest = parsed.manifest;
    } else {
      manifest = await fetchManifest(String(req.params.id ?? ''));
    }
    const npmServers = (manifest.servers ?? [])
      .filter((s) => s.transport === 'stdio' && s.npmSpec)
      .map((s) => s.name);
    res.json({ diffs: packageDiff(manifest), restartRequired: npmServers.length > 0, npmServers });
  } catch (e) {
    res.status(502).json({ error: `Diff nicht moeglich (${String(e instanceof Error ? e.message : e)})` });
  }
});

// Konfigurationsansicht: Parameter + Manifest-Metadaten eines installierten
// Pakets. Faellt bei fehlendem lokalem Manifest auf die Registry zurueck.
packagesRoutes.get('/admin/api/packages/:id/config', requireAdminAuth, async (req, res) => {
  try {
    const id = String(req.params.id ?? '');
    const pkg = getInstalledPackage(id);
    if (!pkg) return res.status(404).json({ error: `Paket "${id}" ist nicht installiert` });
    let manifest = pkg.manifest ? parseStoredManifest(pkg.manifest) : null;
    let manifestSource: 'stored' | 'registry' = 'stored';
    if (!manifest) {
      manifest = await fetchManifest(id);
      manifestSource = 'registry';
    }
    const values = existingParams(id, manifest);
    // Secrets maskiert ausgeben; nicht-geheime Werte im Klartext.
    const safeValues: Record<string, string> = {};
    for (const p of manifest.params ?? []) {
      const v = values[p.key];
      safeValues[p.key] = p.secret ? (v ? '(gesetzt)' : '') : (v ?? '');
    }
    const danger = manifestDangerous(manifest);
    res.json({
      id,
      version: pkg.version,
      source: pkg.source,
      manifestSource,
      params: manifest.params ?? [],
      values: safeValues,
      dangerous: danger.dangerous,
      dangerousItems: danger.items,
    });
  } catch (e) {
    res.status(400).json({ error: String(e instanceof Error ? e.message : e) });
  }
});

// Konfiguration speichern: nur Parameter/Manifest, keine Versionsaenderung.
packagesRoutes.patch('/admin/api/packages/:id/config', requireAdminAuth, async (req, res) => {
  try {
    const id = String(req.params.id ?? '');
    const pkg = getInstalledPackage(id);
    if (!pkg) return res.status(404).json({ error: `Paket "${id}" ist nicht installiert` });
    let manifest = pkg.manifest ? parseStoredManifest(pkg.manifest) : null;
    if (!manifest) manifest = await fetchManifest(id);
    if (manifest.id !== id) throw new Error(`Manifest-id "${manifest.id}" passt nicht zu "${id}"`);
    const body = req.body as { params?: Record<string, string>; dangerousAck?: boolean };
    const provided = body.params ?? {};
    const current = existingParams(id, manifest);
    const merged: Record<string, string> = {};
    for (const p of manifest.params ?? []) {
      const v = provided[p.key];
      const keep = current[p.key];
      if (v == null || String(v).trim() === '') {
        if (keep) merged[p.key] = keep;
      } else {
        merged[p.key] = String(v);
      }
    }
    const values = paramValues(manifest, merged);
    const report = installPackage(manifest, {
      source: pkg.source,
      registryUrl: pkg.registry_url,
      values,
      dangerousAck: body.dangerousAck,
      configOnly: true,
    });
    invalidateMcpCache();
    invalidateIndex();
    res.json({ report });
  } catch (e) {
    res.status(400).json({ error: String(e instanceof Error ? e.message : e) });
  }
});

// --- Sicherung / Rücksicherung (logischer JSON-Export, ohne Logs) ---

packagesRoutes.get('/admin/api/backup', requireAdminAuth, (req, res) => {
  const includeTokens = String(req.query.tokens ?? '0') === '1';
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="smartpilot-config-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json({
    kind: 'smartpilot-config-backup',
    formatVersion: 1,
    created: new Date().toISOString(),
    includeTokens,
    settings: getSettings(),
    prompts: listPrompts(),
    servers: listMcpServers(false, true).map((s) => ({
      ...s,
      auth_token: includeTokens ? s.auth_token : null,
      env: includeTokens ? s.env : null,
      // Header koennen Secrets tragen (z. B. API-Key) und werden wie die
      // uebrigen Zugangsdaten nur mit tokens=1 exportiert.
      headers: includeTokens ? s.headers : null,
    })),
    functions: listFunctions(false).map((f) => ({ ...f, enabled: f.enabled ? 1 : 0, parameters: f.parameters ? JSON.stringify(f.parameters) : null })),
    actions: listActions(false),
    packages: listInstalledPackages(),
    package_items: listAllPackageItems(),
  });
});

packagesRoutes.post('/admin/api/backup/restore', requireAdminAuth, (req, res) => {
  const body = req.body as { backup?: Record<string, unknown>; confirm?: boolean };
  if (!body.confirm) return res.status(400).json({ error: 'Bestaetigung erforderlich (confirm: true)' });
  const backup = body.backup;
  if (!backup || backup.kind !== 'smartpilot-config-backup') {
    return res.status(400).json({ error: 'Keine gueltige Sicherung (kind fehlt)' });
  }
  const db = getDb();
  try {
  db.transaction(() => {
    if (backup.settings && typeof backup.settings === 'object') {
      db.prepare('DELETE FROM settings').run();
      // Export liefert ein Objekt {key: value}; aeltere/externe Sicherungen ggf. ein Array.
      const entries = Array.isArray(backup.settings)
        ? (backup.settings as { key: string; value: string }[])
        : Object.entries(backup.settings as Record<string, string>).map(([key, value]) => ({ key, value }));
      for (const s of entries) {
        db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(s.key, String(s.value));
      }
    }
    if (Array.isArray(backup.prompts)) {
      db.prepare('DELETE FROM prompts').run();
      for (const p of backup.prompts as { key: string; content: string }[]) {
        db.prepare('INSERT INTO prompts (key, content) VALUES (?, ?)').run(p.key, p.content);
      }
    }
    if (Array.isArray(backup.servers)) {
      db.prepare('DELETE FROM mcp_servers').run();
      for (const s of backup.servers as Record<string, unknown>[]) {
        if (!s.name) continue;
        db.prepare(
          'INSERT INTO mcp_servers (name, url, auth_token, transport, command, args, env, headers, npm_spec, inventory_prompt, side_effect, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(s.name as string, (s.url as string) ?? '', (s.auth_token as string | null) ?? null, (s.transport as string) ?? 'http', (s.command as string | null) ?? null, (s.args as string | null) ?? null, (s.env as string | null) ?? null, (s.headers as string | null) ?? null, (s.npm_spec as string | null) ?? null, (s.inventory_prompt as string | null) ?? null, (s.side_effect as string) ?? 'write', (s.enabled as number) ?? 1);
      }
    }
    if (Array.isArray(backup.functions)) {
      db.prepare('DELETE FROM tpl_functions').run();
      for (const f of backup.functions as Record<string, unknown>[]) {
        if (!f.name || !f.template) continue;
        const params = f.parameters == null ? null : typeof f.parameters === 'object' ? JSON.stringify(f.parameters) : String(f.parameters);
        const fnEnabled = f.enabled === false || f.enabled === 0 ? 0 : 1;
        db.prepare(
          'INSERT INTO tpl_functions (name, description, template, parameters, budget, inventory_prompt, side_effect, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(f.name as string, (f.description as string | null) ?? null, f.template as string, params, (f.budget as number | null) ?? null, (f.inventory_prompt as string | null) ?? null, (f.side_effect as string) ?? 'write', fnEnabled);
      }
    }
    if (Array.isArray(backup.actions)) {
      db.prepare('DELETE FROM actions').run();
      for (const a of backup.actions as Record<string, unknown>[]) {
        if (!a.name) continue;
        const fnArgs =
          a.function_args == null
            ? null
            : typeof a.function_args === 'object'
              ? JSON.stringify(a.function_args)
              : String(a.function_args);
        db.prepare(
          'INSERT INTO actions (name, mode, trigger_phrases, fuzzy_threshold, system_prompt, template, function_ref, function_args, tools, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(a.name as string, (a.mode as string) ?? 'llm', (a.trigger_phrases as string | null) ?? null, (a.fuzzy_threshold as number | null) ?? null, (a.system_prompt as string | null) ?? null, (a.template as string | null) ?? null, (a.function_ref as string | null) ?? null, fnArgs, (a.tools as string | null) ?? null, (a.enabled as number) ?? 1);
      }
    }
    // Paket-Provenienz: mit der Konfiguration ersetzen. Alte Sicherungen ohne
    // diese Felder: die Metadaten passen nicht mehr zur ersetzten Konfiguration
    // und werden bewusst verworfen.
    db.prepare('DELETE FROM packages').run();
    db.prepare('DELETE FROM package_items').run();
    for (const p of (backup.packages as Record<string, unknown>[] | undefined) ?? []) {
      if (!p.id) continue;
      db.prepare(
        'INSERT INTO packages (id, version, source, registry_url, params, manifest, manifest_hash, installed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(p.id as string, (p.version as string) ?? '', (p.source as string) ?? 'registry', (p.registry_url as string | null) ?? null, (p.params as string | null) ?? null, (p.manifest as string | null) ?? null, (p.manifest_hash as string | null) ?? null, (p.installed_at as string) ?? new Date().toISOString());
    }
    for (const i of (backup.package_items as Record<string, unknown>[] | undefined) ?? []) {
      if (!i.package_id || !i.kind || !i.name) continue;
      const kind = String(i.kind);
      const name = String(i.name);
      const table =
        kind === 'server' ? 'mcp_servers' : kind === 'function' ? 'tpl_functions' : kind === 'action' ? 'actions' : null;
      // row_id zeigt nach dem Restore auf die neu vergebenen IDs; anhand des
      // Namens neu aufloesen statt die alte ID aus der Sicherung zu uebernehmen.
      const rowId = table
        ? ((db.prepare(`SELECT id FROM ${table} WHERE name = ?`).get(name) as { id?: number } | undefined)?.id ?? null)
        : null;
      db.prepare(
        'INSERT INTO package_items (package_id, kind, name, row_id, content_hash) VALUES (?, ?, ?, ?, ?)'
      ).run(i.package_id as string, kind, name, rowId, (i.content_hash as string) ?? '');
    }
  })();
  invalidateMcpCache();
  invalidateIndex();
  res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: String(e instanceof Error ? e.message : e) });
  }
});