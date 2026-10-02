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