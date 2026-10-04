import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { initDb, closeDb, getDb } from '../src/db/schema.js';
import {
  installPackage,
  uninstallPackage,
  listInstalledPackages,
  listPackageItems,
  listAllPackageItems,
  conflictItems,
  packageDiff,
  existingParams,
} from '../src/db/packages.js';
import { packagesRoutes } from '../src/routes/packages.js';
import { config } from '../src/config.js';
import {
  parseManifest,
  validateManifest,
  substituteParams,
  meetsMinVersion,
  manifestDangerous,
  manifestItems,
  paramValues,
  manifestHash,
} from '../src/core/packages.js';
import { getSetting, setSetting } from '../src/db/settings.js';
import { tmpDb } from './_tmpdb.js';

const DB_PATH = tmpDb('packages');

const OK_MANIFEST = {
  id: 'test-package',
  version: '1.0.0',
  name: 'Test-Paket',
  summary: 'Kurz',
  description: 'Lang',
  params: [
    { key: 'host', label: 'Host', default: '127.0.0.1', required: true },
    { key: 'token', label: 'Token', secret: true, default: 'geheim' },
  ],
  servers: [{ name: 'Test MCP', transport: 'http', url: 'http://${host}:8086/mcp', auth_token: '${token}' }],
  functions: [{ name: 'test_fn', template: 'Server ${host} meldet sich.', parameters: { type: 'object', properties: {} }, budget: 1 }],
  indexes: [{ key: '', config: { tool: 'x_tool', args: {} } }],
  allowTools: ['x_tool', 'fn_test_fn'],
};

before(() => {
  closeDb();
  initDb(DB_PATH);
  const db = getDb();
  db.exec("DELETE FROM packages WHERE id = 'test-package'");
  db.exec("DELETE FROM package_items WHERE package_id = 'test-package'");
  db.exec("DELETE FROM mcp_servers WHERE name = 'Test MCP'");
  db.exec("DELETE FROM tpl_functions WHERE name = 'test_fn'");
  db.exec("DELETE FROM settings WHERE key IN ('entity_index_test', 'entity_index', 'agent_tools')");
});

test('Manifest-Validierung: korrekt + ungueltig', () => {
  const ok = validateManifest(OK_MANIFEST);
  assert.equal(ok.ok, true);
  const bad = validateManifest({ id: 'x', version: 'no' });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.length >= 2);
});

test('Substitution ersetzt Platzhalter; fehlende werfen', () => {
  assert.equal(substituteParams('http://${host}:${port}/mcp', { host: 'h', port: '8' }), 'http://h:8/mcp');
  assert.throws(() => substituteParams('${fehlt}', {}));
});

test('manifestDangerous: shell = gefaehrlich, http = Info', () => {
  const d = manifestDangerous({ id: 'a', version: '1.0.0', name: 'a', summary: 's', description: 'd', functions: [{ name: 'f', template: "{{ shell('ls') }}" }] });
  assert.equal(d.dangerous, true);
  assert.equal(d.items.length, 1);
  const h = manifestDangerous({ id: 'a', version: '1.0.0', name: 'a', summary: 's', description: 'd', functions: [{ name: 'f', template: "{{ http('https://x') }}" }] });
  assert.equal(h.dangerous, false);
  assert.equal(h.info.length, 1);
});

test('#2: manifestDangerous markiert jeden stdio-Server als gefaehrlich', () => {
  const stdio = manifestDangerous({
    id: 'a',
    version: '1.0.0',
    name: 'a',
    summary: 's',
    description: 'd',
    servers: [{ name: 'sh', transport: 'stdio', command: 'sh' }],
  });
  assert.equal(stdio.dangerous, true);
  assert.equal(stdio.items.length, 1);
  // http-Server bleiben harmlos (nur externe Aufrufe).
  const http = manifestDangerous({
    id: 'a',
    version: '1.0.0',
    name: 'a',
    summary: 's',
    description: 'd',
    servers: [{ name: 'web', transport: 'http', url: 'https://x/mcp' }],
  });
  assert.equal(http.dangerous, false);
});

test('parseManifest: JSON + Fehler-Faelle', () => {
  const ok = parseManifest(JSON.stringify(OK_MANIFEST));
  assert.equal(ok.ok, true);
  const bad = parseManifest('{ defekt');
  assert.equal(bad.ok, false);
});

test('manifestItems fuehrt alle Artefakte', () => {
  const items = manifestItems(OK_MANIFEST as never);
  assert.deepEqual(items.map((i) => i.kind).sort(), ['allowTools', 'function', 'index', 'server']);
});

test('paramValues: Defaults + required', () => {
  const values = paramValues(OK_MANIFEST as never);
  assert.equal(values.host, '127.0.0.1');
  assert.equal(values.token, 'geheim');
});

test('manifestHash stabil', () => {
  assert.equal(manifestHash(OK_MANIFEST as never), manifestHash(OK_MANIFEST as never));
  assert.notEqual(manifestHash(OK_MANIFEST as never), manifestHash({ ...OK_MANIFEST, version: '2.0.0' } as never));
});

test('Install: Upsert + Provenienz + agent_tools-Merge; Reinstall aktualisiert', () => {
  setSetting('agent_tools', 'web_url_read');
  const report = installPackage(OK_MANIFEST as never, { source: 'registry', values: { host: '10.0.0.5', token: 'tok' } });
  assert.deepEqual(report.created.sort(), ['allowTools:x_tool,fn_test_fn', 'function:test_fn', 'index:entity_index', 'server:Test MCP'].sort());
  // Server-URL substituiert, Token in auth_token
  const row = getDb().prepare("SELECT url, auth_token FROM mcp_servers WHERE name = 'Test MCP'").get() as { url: string; auth_token: string };
  assert.equal(row.url, 'http://10.0.0.5:8086/mcp');
  assert.equal(row.auth_token, 'tok');
  const fnRow = getDb().prepare("SELECT template FROM tpl_functions WHERE name = 'test_fn'").get() as { template: string };
  assert.equal(fnRow.template, 'Server 10.0.0.5 meldet sich.');
  // agent_tools: vereinigt, alte bleiben
  const tools = (getSetting('agent_tools') ?? '').split(',').map((s) => s.trim());
  assert.ok(tools.includes('web_url_read'));
  assert.ok(tools.includes('x_tool'));
  // Neu-Install: updated statt created
  const report2 = installPackage(OK_MANIFEST as never, { source: 'registry', values: { host: '10.0.0.5', token: 'tok' } });
  assert.deepEqual(report2.updated.sort(), ['function:test_fn', 'index:entity_index', 'server:Test MCP'].sort());
  // Provenienz
  const pkgs = listInstalledPackages();
  assert.equal(pkgs.length, 1);
  assert.equal(pkgs[0]!.id, 'test-package');
  assert.ok(pkgs[0]!.params.includes('10.0.0.5'));
  // Secret-Wert nicht in der Provenienz
  const safe = JSON.parse(pkgs[0]!.params) as Record<string, string>;
  assert.equal(safe.token, '(gesetzt)');
  assert.equal(safe.host, '10.0.0.5');
  const items = listPackageItems('test-package');
  assert.equal(items.length, 4); // server, function, index, allowTools
});

test('Deinstall-Schutz: lokal geaenderte Zeile bleibt', () => {
  const db = getDb();
  // Funktion lokal aendern (Hash weicht ab)
  db.prepare("UPDATE tpl_functions SET template = 'GEAENDERT' WHERE name = 'test_fn'").run();
  const report = uninstallPackage('test-package');
  assert.equal(report.removed.includes('server:Test MCP'), true);
  assert.equal(report.kept.length, 1);
  const fn = db.prepare("SELECT template FROM tpl_functions WHERE name = 'test_fn'").get() as { template: string } | undefined;
  assert.ok(fn);
  assert.equal(fn.template, 'GEAENDERT');
  const pkgs = listInstalledPackages();
  assert.equal(pkgs.length, 0);
});

test('Paket-Actions: Install (Upsert) + Validierung + lokaler Schutz beim Deinstall', () => {
  const db = getDb();
  const m = {
    id: 'action-pack',
    version: '1.0.0',
    name: 'Action-Paket',
    summary: 's',
    description: 'd',
    functions: [{ name: 'af_fn', template: 'hallo' }],
    actions: [
      { name: 'af_action', mode: 'deterministic', trigger_phrases: ['af test'], fuzzy_threshold: 0.8, function_ref: 'af_fn', tools: [], enabled: true },
    ],
  };
  db.prepare("DELETE FROM packages WHERE id = 'action-pack'").run();
  db.prepare("DELETE FROM package_items WHERE package_id = 'action-pack'").run();
  db.prepare("DELETE FROM actions WHERE name = 'af_action'").run();
  db.prepare("DELETE FROM tpl_functions WHERE name = 'af_fn'").run();

  const r = installPackage(m as never, { source: 'registry' });
  assert.ok(r.created.includes('action:af_action'));
  assert.ok(manifestItems(m as never).some((i) => i.kind === 'action' && i.name === 'af_action'));
  const row = db.prepare("SELECT mode, trigger_phrases, function_ref, enabled FROM actions WHERE name = 'af_action'").get() as {
    mode: string; trigger_phrases: string; function_ref: string; enabled: number;
  };
  assert.equal(row.mode, 'deterministic');
  assert.equal(row.trigger_phrases, '["af test"]');
  assert.equal(row.function_ref, 'af_fn');
  assert.equal(row.enabled, 1);

  // Validierung: unbekannter Modus wird abgelehnt
  assert.equal(validateManifest({ id: 'x', version: '1.0.0', name: 'x', summary: 's', description: 'd', actions: [{ name: 'a', mode: 'nope' }] }).ok, false);

  // Reinstall: unveraendert -> updated
  const r2 = installPackage(m as never, { source: 'registry' });
  assert.ok(r2.updated.includes('action:af_action'));

  // lokal geaendert -> Konflikt, bleibt beim Deinstall erhalten
  db.prepare("UPDATE actions SET mode = 'llm' WHERE name = 'af_action'").run();
  assert.deepEqual(conflictItems('action-pack'), ['action:af_action']);
  const rep = uninstallPackage('action-pack');
  assert.ok(rep.kept.some((k) => k.startsWith('action:af_action')));
  assert.equal((db.prepare("SELECT count(*) c FROM actions WHERE name = 'af_action'").get() as { c: number }).c, 1);

  // Zustand aufraeumen
  db.prepare("DELETE FROM actions WHERE name = 'af_action'").run();
  db.prepare("DELETE FROM tpl_functions WHERE name = 'af_fn'").run();
});

test('Backup-Roundtrip (Export -> Restore) ueber Route-Logik simuliert', () => {
  // Minimale Sicherungsstruktur wiederherstellen: settings ersetzt
  const db = getDb();
  db.prepare('DELETE FROM settings').run();
  db.prepare("INSERT INTO settings (key, value) VALUES ('x1', 'a')").run();
  const backup = { kind: 'smartpilot-config-backup', settings: [{ key: 'x1', value: 'b' }], prompts: [], servers: [], functions: [], actions: [] };
  db.transaction(() => {
    if (Array.isArray(backup.settings)) {
      db.prepare('DELETE FROM settings').run();
      for (const s of backup.settings as { key: string; value: string }[]) {
        db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(s.key, s.value);
      }
    }
  })();
  assert.equal(getSetting('x1'), 'b');
});

test('Reinstall-Diff: lokal geaenderte Zeile wird gemeldet; Entscheidung take/keep; dryRun schreibt nicht', () => {
  const db = getDb();
  db.prepare("DELETE FROM tpl_functions WHERE name = 'test_fn'").run();
  db.prepare("DELETE FROM mcp_servers WHERE name = 'Test MCP'").run();
  db.prepare("DELETE FROM packages WHERE id = 'test-package'").run();
  db.prepare("DELETE FROM package_items WHERE package_id = 'test-package'").run();
  const opts = { source: 'registry', values: { host: '10.0.0.5', token: 'tok' } } as const;
  installPackage(OK_MANIFEST as never, opts);

  // lokal aendern -> Konflikt
  db.prepare("UPDATE tpl_functions SET template = 'LOKAL' WHERE name = 'test_fn'").run();
  assert.deepEqual(conflictItems('test-package'), ['function:test_fn']);

  // Reinstall ohne Entscheidung: lokal geaenderte Zeile bleibt erhalten (Default keep)
  const r1 = installPackage(OK_MANIFEST as never, opts);
  assert.deepEqual(r1.conflicts, ['function:test_fn']);
  assert.deepEqual(r1.kept, ['function:test_fn']);
  let fn = db.prepare("SELECT template FROM tpl_functions WHERE name = 'test_fn'").get() as { template: string };
  assert.equal(fn.template, 'LOKAL');

  // ausdrueckliches 'take' uebernimmt die Paket-Version
  installPackage(OK_MANIFEST as never, { ...opts, decisions: { 'function:test_fn': 'take' } });
  fn = db.prepare("SELECT template FROM tpl_functions WHERE name = 'test_fn'").get() as { template: string };
  assert.equal(fn.template, 'Server 10.0.0.5 meldet sich.');

  // erneut lokal aendern, diesmal 'keep'
  db.prepare("UPDATE tpl_functions SET template = 'LOKAL2' WHERE name = 'test_fn'").run();
  const r2 = installPackage(OK_MANIFEST as never, { ...opts, decisions: { 'function:test_fn': 'keep' } });
  assert.deepEqual(r2.kept, ['function:test_fn']);
  fn = db.prepare("SELECT template FROM tpl_functions WHERE name = 'test_fn'").get() as { template: string };
  assert.equal(fn.template, 'LOKAL2');

  // dryRun berechnet den Report, schreibt aber nichts
  const dry = installPackage(OK_MANIFEST as never, { ...opts, dryRun: true });
  const nach = db.prepare("SELECT template FROM tpl_functions WHERE name = 'test_fn'").get() as { template: string };
  assert.equal(nach.template, 'LOKAL2', 'dryRun schreibt nicht');
  assert.deepEqual(dry.conflicts, ['function:test_fn']);
});

test('Backup/Restore: Paket-Provenienz wird mitgesichert und wiederhergestellt', async () => {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(packagesRoutes);
  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  const auth = { Authorization: `Bearer ${config.adminToken}`, 'Content-Type': 'application/json' };
  const base = `http://127.0.0.1:${port}`;
  try {
    const install = await fetch(`${base}/admin/api/packages/test-package/install`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ manifest: OK_MANIFEST, params: { host: '10.0.0.5', token: 'tok' } }),
    });
    assert.equal(install.status, 200);
    assert.equal(listInstalledPackages().length, 1);
    setSetting('probe_restore', 'BACKUP');

    const backup = (await (await fetch(`${base}/admin/api/backup`, { headers: auth })).json()) as Record<string, unknown>;
    assert.equal((backup.packages as unknown[]).length, 1, 'Backup enthaelt Paket-Provenienz');
    const itemCount = (backup.package_items as unknown[]).length;
    assert.ok(itemCount >= 3, 'Backup enthaelt package_items');

    setSetting('probe_restore', 'GEAENDERT');
    getDb().prepare('DELETE FROM packages').run();
    getDb().prepare('DELETE FROM package_items').run();
    const restore = await fetch(`${base}/admin/api/backup/restore`, {
      method: 'POST', headers: auth, body: JSON.stringify({ backup, confirm: true }),
    });
    assert.equal(restore.status, 200, await restore.text());
    assert.equal(listInstalledPackages().length, 1, 'Provenienz restauriert');
    assert.equal(listAllPackageItems().length, itemCount);
    assert.equal(getSetting('probe_restore'), 'BACKUP', 'Settings restauriert');

    // Sicherung ohne Provenienz-Felder -> bewusst verworfen
    const ohneProvenienz = { ...backup };
    delete ohneProvenienz.packages;
    delete ohneProvenienz.package_items;
    const restore2 = await fetch(`${base}/admin/api/backup/restore`, {
      method: 'POST', headers: auth, body: JSON.stringify({ backup: ohneProvenienz, confirm: true }),
    });
    assert.equal(restore2.status, 200);
    assert.equal(listInstalledPackages().length, 0, 'ohne Provenienz verworfen');
  } finally {
    server.close();
  }
});

test('Vertrauens-/Sprachfelder: semver-Vergleich + Manifest-Validierung', () => {
  assert.equal(meetsMinVersion('0.1.0', '0.1.0'), true);
  assert.equal(meetsMinVersion('0.1.0', '0.2.0'), false);
  assert.equal(meetsMinVersion('1.2.3', '1.2.2'), true);
  assert.equal(meetsMinVersion('0.1.0', undefined), true);
  assert.equal(validateManifest({ ...OK_MANIFEST, author: 'x', license: 'MIT', language: 'de', homepage: 'https://x', minGatewayVersion: '0.1.0' }).ok, true);
  assert.equal(validateManifest({ ...OK_MANIFEST, language: 'DEUTSCH' }).ok, false);
  assert.equal(validateManifest({ ...OK_MANIFEST, minGatewayVersion: 'v1' }).ok, false);
});

test('args-Normalisierung: "[]" == null -> kein Scheinkonflikt; echte Aenderung bleibt', () => {
  const pkg = { ...OK_MANIFEST, id: 'args-norm', servers: [{ name: 'SearXNG-Test', transport: 'stdio' as const, command: 'node_modules/.bin/mcp-searxng' }], functions: [], indexes: [], allowTools: [] };
  installPackage(pkg, { source: 'import', dangerousAck: true });
  // Bestandszeile "[]" simulieren (wie aus alter Admin-UI-Installation).
  getDb().prepare("UPDATE mcp_servers SET args='[]' WHERE name='SearXNG-Test'").run();
  assert.deepEqual(conflictItems('args-norm'), [], 'leeres args darf keinen Konflikt ergeben');
  // Echte lokale Aenderung bleibt Konflikt.
  getDb().prepare("UPDATE mcp_servers SET command='custom' WHERE name='SearXNG-Test'").run();
  assert.deepEqual(conflictItems('args-norm'), ['server:SearXNG-Test']);
  getDb().prepare("DELETE FROM mcp_servers WHERE name='SearXNG-Test'").run();
  db_cleanup('args-norm');
});

test('restartRequired: stdio mit npm_spec -> Hinweis, sonst nicht', () => {
  const withNpm = { ...OK_MANIFEST, id: 'npm-test', servers: [{ name: 'NPM Test', transport: 'stdio' as const, command: 'node_modules/.bin/x', npmSpec: 'x@1.0.0' }], functions: [], indexes: [], allowTools: [] };
  const r = installPackage(withNpm, { source: 'import', dangerousAck: true });
  assert.equal(r.restartRequired, true);
  assert.deepEqual(r.npmServers, ['NPM Test']);
  const withoutNpm = { ...OK_MANIFEST, id: 'npm-test2', servers: [{ name: 'HTTP Test', transport: 'http' as const, url: 'http://x' }], functions: [], indexes: [], allowTools: [] };
  const r2 = installPackage(withoutNpm, { source: 'import', dangerousAck: true });
  assert.equal(r2.restartRequired, false);
  getDb().prepare("DELETE FROM mcp_servers WHERE name IN ('NPM Test','HTTP Test')").run();
  db_cleanup('npm-test'); db_cleanup('npm-test2');
});

test('packageDiff: Status changed + Felder; secrets maskiert', () => {
  const pkg = { ...OK_MANIFEST, id: 'diff-test', servers: [{ name: 'Diff Srv', transport: 'stdio' as const, command: 'node_modules/.bin/a', npmSpec: 'a@1.0.0', auth_token: 'secret-a' }], functions: [], indexes: [], allowTools: [] };
  installPackage(pkg, { source: 'import', dangerousAck: true });
  const target = { ...pkg, version: '1.0.1', servers: [{ name: 'Diff Srv', transport: 'stdio' as const, command: 'node_modules/.bin/b', npmSpec: 'a@2.0.0', auth_token: 'secret-b' }] };
  const srv = packageDiff(target).find((d) => d.key === 'server:Diff Srv');
  assert.equal(srv?.status, 'changed');
  const fields = (srv?.fields ?? []).map((f) => f.field).sort();
  assert.ok(fields.includes('command') && fields.includes('npm_spec') && fields.includes('auth_token'));
  const tokenField = srv?.fields.find((f) => f.field === 'auth_token');
  assert.equal(tokenField?.from, '***');
  assert.equal(tokenField?.to, '***');
  getDb().prepare("DELETE FROM mcp_servers WHERE name='Diff Srv'").run();
  db_cleanup('diff-test');
});

// Paket-Reste entfernen (Item-Hashes + Paket-Zeile).
function db_cleanup(id: string): void {
  uninstallPackage(id);
}

const PARAM_MANIFEST = {
  ...OK_MANIFEST,
  id: 'reinstall-test',
  params: [
    { key: 'base_url', label: 'Basis-URL', required: true },
    { key: 'api_key', label: 'API-Key', secret: true, required: true },
  ],
  servers: [{ name: 'Reinstall Srv', transport: 'stdio' as const, command: 'node_modules/.bin/x', env: { BASE_URL: '${base_url}', API_KEY: '${api_key}' } }],
  functions: [],
  indexes: [],
  allowTools: [],
};

test('existingParams: nicht-geheim aus params, Secret aus Server-Env', () => {
  installPackage(PARAM_MANIFEST, { source: 'import', dangerousAck: true, values: { base_url: 'http://h', api_key: 'secret123' } });
  const cur = existingParams('reinstall-test', PARAM_MANIFEST);
  assert.equal(cur.base_url, 'http://h', 'nicht-geheimer Wert aus packages.params');
  assert.equal(cur.api_key, 'secret123', 'Secret aus Server-Env zurueckgemappt');
  getDb().prepare("DELETE FROM mcp_servers WHERE name='Reinstall Srv'").run();
  db_cleanup('reinstall-test');
});

test('Reinstall ohne erneute Parameter bleibt erhalten; Neu ohne Wert scheitert', async () => {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(packagesRoutes);
  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  const auth = { Authorization: `Bearer ${config.adminToken}`, 'Content-Type': 'application/json' };
  const url = (id: string): string => `http://127.0.0.1:${port}/admin/api/packages/${id}/install`;
  try {
    const first = await fetch(url('reinstall-test'), { method: 'POST', headers: auth, body: JSON.stringify({ manifest: PARAM_MANIFEST, params: { base_url: 'http://h', api_key: 'secret123' }, dangerousAck: true }) });
    assert.equal(first.status, 200);
    // Reinstall ohne params: bestehende Werte werden uebernommen.
    const again = await fetch(url('reinstall-test'), { method: 'POST', headers: auth, body: JSON.stringify({ manifest: PARAM_MANIFEST, dangerousAck: true }) });
    assert.equal(again.status, 200, 'Reinstall ohne erneute Eingabe');
    const env = (getDb().prepare("SELECT env FROM mcp_servers WHERE name='Reinstall Srv'").get() as { env: string }).env;
    assert.match(env, /secret123/, 'Secret bleibt erhalten');
    // Neuinstallation ohne Pflichtwert scheitert weiterhin.
    const fresh = await fetch(url('fresh-test'), { method: 'POST', headers: auth, body: JSON.stringify({ manifest: { ...PARAM_MANIFEST, id: 'fresh-test' }, dangerousAck: true }) });
    assert.equal(fresh.status, 400);
    const body = (await fresh.json()) as { error?: string };
    assert.match(body.error ?? '', /erforderlich/);
  } finally {
    getDb().prepare("DELETE FROM mcp_servers WHERE name='Reinstall Srv'").run();
    db_cleanup('reinstall-test');
    server.close();
  }
});

test('Install: zu altes Gateway wird abgelehnt (minGatewayVersion)', async () => {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(packagesRoutes);
  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  const auth = { Authorization: `Bearer ${config.adminToken}`, 'Content-Type': 'application/json' };
  try {
    const res = await fetch(`http://127.0.0.1:${port}/admin/api/packages/future/install`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ manifest: { ...OK_MANIFEST, id: 'future', minGatewayVersion: '99.0.0' }, params: { host: 'h' } }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: string };
    assert.match(body.error ?? '', /benoetigt Gateway/);
  } finally {
    server.close();
  }
});