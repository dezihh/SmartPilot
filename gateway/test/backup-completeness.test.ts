// Rundlauf-Test fuer Sicherung/Ruecksicherung: jede Spalte, die eine Tabelle
// heute hat, muss den Export -> Wipe -> Restore ueberleben. Der PRAGMA-Teil
// schlaegt an, wenn eine kuenftige Migration eine Spalte hinzufuegt, die der
// Export nicht mitnimmt (Export liest SELECT *).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { initDb, closeDb, getDb } from '../src/db/schema.js';
import { packagesRoutes } from '../src/routes/packages.js';
import { config } from '../src/config.js';
import { tmpDb } from './_tmpdb.js';

closeDb();
initDb(tmpDb('backup-complete'));

const TABLES = ['settings', 'prompts', 'mcp_servers', 'tpl_functions', 'actions', 'packages', 'package_items'];

function columns(table: string): string[] {
  return (getDb().prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

function rows(table: string): Record<string, unknown>[] {
  return getDb().prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
}

test('Backup/Restore: alle Spalten ueberleben den Rundlauf', async () => {
  const db = getDb();
  db.prepare(
    `INSERT INTO mcp_servers (name,url,auth_token,transport,command,args,env,npm_spec,side_effect,enabled,headers)
     VALUES ('Roundtrip Srv','https://mcp.example.org/rpc','tok','http',NULL,NULL,NULL,'@scope/pkg','read',1,'{"X-Test":"1"}')`
  ).run();
  db.prepare(
    `INSERT INTO tpl_functions (name,description,template,parameters,budget,inventory_prompt,side_effect,enabled)
     VALUES ('roundtrip_fn','Beschreibung','{{ 1 }}','{"a":"b"}',7,'Inventar','read',1)`
  ).run();
  db.prepare(
    `INSERT INTO actions (name,mode,trigger_phrases,fuzzy_threshold,system_prompt,template,function_ref,function_args,tools,enabled)
     VALUES ('roundtrip_action','hybrid','["los"]',0.8,'System','Vorlage','roundtrip_fn','{"k":1}','["tool_x"]',1)`
  ).run();
  db.prepare("INSERT INTO settings (key, value) VALUES ('roundtrip_setting', 'Wert')").run();
  db.prepare("INSERT INTO prompts (key, content) VALUES ('roundtrip_prompt', 'Inhalt')").run();
  db.prepare(
    `INSERT INTO packages (id,version,source,registry_url,params,manifest,manifest_hash)
     VALUES ('roundtrip-pkg','1.2.3','import','https://registry.example','{"host":"h"}','{"id":"roundtrip-pkg"}','abc123')`
  ).run();
  const serverId = (db.prepare("SELECT id FROM mcp_servers WHERE name = 'Roundtrip Srv'").get() as { id: number }).id;
  db.prepare(
    `INSERT INTO package_items (package_id,kind,name,row_id,content_hash)
     VALUES ('roundtrip-pkg','server','Roundtrip Srv',?,'hash1')`
  ).run(serverId);

  // Originalzustand fuer den spaeteren Vergleich.
  const before: Record<string, Record<string, unknown>[]> = {};
  for (const t of TABLES) before[t] = rows(t);

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(packagesRoutes);
  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  const auth = { Authorization: `Bearer ${config.adminToken}`, 'Content-Type': 'application/json' };
  const base = `http://127.0.0.1:${port}/admin/api`;
  try {
    // tokens=1: vollstaendige Sicherung inkl. Secrets (sonst maskiert der
    // Export auth_token/env bewusst).
    const backup = (await (await fetch(`${base}/backup?tokens=1`, { headers: auth })).json()) as Record<string, unknown>;

    // Jede Datenspalte der Tabelle muss im Export auftauchen (SELECT *).
    // created_at/updated_at werden beim Restore bewusst neu gesetzt und sind
    // deshalb keine Backup-Daten.
    const regenerated = new Set(['created_at', 'updated_at']);
    const arrayTables: Array<[string, string]> = [
      ['prompts', 'prompts'],
      ['mcp_servers', 'servers'],
      ['tpl_functions', 'functions'],
      ['actions', 'actions'],
      ['packages', 'packages'],
      ['package_items', 'package_items'],
    ];
    for (const [table, key] of arrayTables) {
      const exported = backup[key] as Record<string, unknown>[];
      assert.ok(exported?.length, `${table}: Export fehlt`);
      for (const col of columns(table)) {
        if (regenerated.has(col)) continue;
        assert.ok(col in exported[0]!, `${table}.${col} fehlt im Backup`);
      }
    }

    // Wipe und Restore.
    for (const t of TABLES) db.prepare(`DELETE FROM ${t}`).run();
    const restore = await fetch(`${base}/backup/restore`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ backup, confirm: true }),
    });
    assert.equal(restore.status, 200, await restore.text());

    // Zeitstempel und Auto-IDs duerfen sich aendern; alles andere muss gleich sein.
    const ignore = new Set(['id', 'created_at', 'updated_at', 'row_id']);

    for (const [table, , keyCol] of [
      ['settings', 'settings', 'key'],
      ['prompts', 'prompts', 'key'],
      ['mcp_servers', 'servers', 'name'],
      ['tpl_functions', 'functions', 'name'],
      ['actions', 'actions', 'name'],
      ['packages', 'packages', 'id'],
      ['package_items', 'package_items', 'name'],
    ] as Array<[string, string, string]>) {
      const after = rows(table);
      assert.equal(after.length, before[table]!.length, `${table}: Zeilenanzahl`);
      for (const original of before[table]!) {
        const match = after.find((r) => r[keyCol] === original[keyCol]);
        assert.ok(match, `${table}: Zeile ${String(original[keyCol])} fehlt nach Restore`);
        for (const col of columns(table)) {
          if (ignore.has(col)) continue;
          assert.deepEqual(match[col], original[col], `${table}.${col} (${String(original[keyCol])})`);
        }
      }
    }

    // row_id wird auf die neu vergebene Server-ID aufgeloest.
    const item = getDb().prepare("SELECT row_id FROM package_items WHERE name = 'Roundtrip Srv'").get() as { row_id: number };
    const newServerId = (getDb().prepare("SELECT id FROM mcp_servers WHERE name = 'Roundtrip Srv'").get() as { id: number }).id;
    assert.equal(item.row_id, newServerId, 'package_items.row_id zeigt auf die neue ID');
  } finally {
    server.close();
  }
});
