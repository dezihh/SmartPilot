import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SEED_AGENT_SYSTEM, SEED_AGENT_INVENTORY, SEED_HELP_TRIGGERS, SEED_HELP_PROMPT, SEED_SETTINGS } from './seeds.js';
import { runMigrations, type Migration } from './migrations/runner.js';
import { backupDatabase } from './migrations/backup.js';
import { logError } from '../core/logger.js';
import { hashContent, serverContentOld, serverContentNew, serverContentV6, type ServerHashRow } from './itemHash.js';

// DB-Handle + Migrationen: getDb() lazily nach initDb(path) - so ist die DB
// in Tests injizierbar (Temp-File) und im Runtime-Setup einmalig initialisiert.
let _db: Database.Database | null = null;

export function closeDb(): void {
  if (!_db) return;
  try {
    _db.close();
  } finally {
    _db = null;
  }
}

// Referenz-Defaults der Grundeinstellungen: eine Quelle in seeds.ts; hier nur
// re-exportiert (settings.ts/Admin-UI importieren sie aus schema).
export { SEED_SETTINGS };

export function initDb(path: string, withReferenceSeed = false): void {
  if (_db) return;
  mkdirSync(dirname(path), { recursive: true });
  const existed = existsSync(path);
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  const current = db.pragma('user_version', { simple: true }) as number;
  const target = MIGRATIONS[MIGRATIONS.length - 1]!.version;
  runMigrations(db, MIGRATIONS, () => {
    // Nur eine Bestands-DB (Datei existierte bereits) vor dem ersten Schritt
    // sichern - eine frisch angelegte DB braucht kein Backup.
    if (existed && current < target) {
      try {
        backupDatabase(db, path);
      } catch (e) {
        logError('DB-Backup vor Migration fehlgeschlagen', e);
      }
    }
  });
  if (withReferenceSeed) applyReferenceSeed(db);
  _db = db;
}

// Referenz-Seed fuer frische Installationen: statische Agent-Prompts + die
// generische Hilfe-Action. INSERT OR IGNORE - bestehende Edits bleiben.
function applyReferenceSeed(db: Database.Database): void {
  db.prepare('INSERT OR IGNORE INTO prompts (key, content) VALUES (?, ?)').run('agent_system', SEED_AGENT_SYSTEM);
  db.prepare('INSERT OR IGNORE INTO prompts (key, content) VALUES (?, ?)').run('agent_inventory', SEED_AGENT_INVENTORY);
  db.prepare(
    `INSERT OR IGNORE INTO actions (name, mode, trigger_phrases, fuzzy_threshold, system_prompt, template, function_ref, function_args, tools, enabled, side_effect, confirm)
     VALUES ('hilfe', 'llm', ?, 0.85, ?, NULL, NULL, NULL, '[]', 1, 'read', 0)`
  ).run(SEED_HELP_TRIGGERS, SEED_HELP_PROMPT);
}

// Migration 1 (Basis-Schema): Tabellen und Spalten - idempotent, damit frische
// und Bestands-DBs denselben Weg gehen.
// Fuegt eine Spalte nur hinzu, wenn sie fehlt. Ersetzt catch {}-basierte
// Existenzpruefungen, die auch echte Fehler verschlucken.
function addColumnIfMissing(db: Database.Database, table: string, column: string, definition: string): void {
  const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  // Tabelle existiert bei frischer DB noch nicht -> CREATE unten legt sie an.
  if (cols.length === 0) return;
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function applySchema(db: Database.Database): void {
// Migration: mode-Check-Constraint erneuern, damit search_summary entfaellt (idempotent)
{
  // Alte actions-Tabellen koennen function_ref/function_args noch nicht haben.
  addColumnIfMissing(db, 'actions', 'function_ref', 'TEXT');
  addColumnIfMissing(db, 'actions', 'function_args', 'TEXT');
  const modeLine = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='actions'").get() as { sql?: string })?.sql ?? '';
  if (modeLine.includes('search_summary')) {
    db.exec(`
      DROP TABLE IF EXISTS actions_new;
      CREATE TABLE actions_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        mode TEXT NOT NULL DEFAULT 'llm' CHECK (mode IN ('deterministic','llm','hybrid')),
        trigger_phrases TEXT,
        fuzzy_threshold REAL,
        system_prompt TEXT,
        template TEXT,
        function_ref TEXT,
        function_args TEXT,
        tools TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO actions_new (id, name, mode, trigger_phrases, fuzzy_threshold, system_prompt, template, function_ref, function_args, tools, enabled, created_at, updated_at)
        SELECT id, name, mode, trigger_phrases, fuzzy_threshold, system_prompt, template, function_ref, function_args, tools, enabled, created_at, updated_at FROM actions WHERE mode != 'search_summary';
      DROP TABLE actions;
      ALTER TABLE actions_new RENAME TO actions;
    `);
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS mcp_servers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    url TEXT NOT NULL,
    auth_token TEXT,
    transport TEXT NOT NULL DEFAULT 'http',
    command TEXT,
    args TEXT,
    env TEXT,
    npm_spec TEXT,
    side_effect TEXT NOT NULL DEFAULT 'write',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    mode TEXT NOT NULL DEFAULT 'llm' CHECK (mode IN ('deterministic','llm','hybrid')),
    trigger_phrases TEXT,
    fuzzy_threshold REAL,
    system_prompt TEXT,
    template TEXT,
    function_ref TEXT,
    function_args TEXT,
    tools TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tpl_functions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    template TEXT NOT NULL,
    parameters TEXT,
    budget INTEGER,
    inventory_prompt TEXT,
    side_effect TEXT NOT NULL DEFAULT 'write',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS prompts (
    key TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS packages (
    id TEXT PRIMARY KEY,
    version TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'registry',
    registry_url TEXT,
    params TEXT,
    manifest_hash TEXT,
    installed_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS package_items (
    package_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    row_id INTEGER,
    content_hash TEXT NOT NULL,
    PRIMARY KEY (package_id, kind, name)
  );

  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL DEFAULT (datetime('now')),
    session_id TEXT,
    query TEXT NOT NULL,
    route TEXT NOT NULL,
    action_id INTEGER,
    score REAL,
    response TEXT,
    duration_ms INTEGER,
    trace TEXT
  );
`);

// inventory_note -> inventory_prompt: umbenennen, oder - falls der ALTER-
// Loop die neue Spalte schon vorher angelegt hat - die Inhalte rueberkopieren
// und die alte Spalte fallen lassen. In allen Faellen idempotent.
{
  const cols = (t: string): string[] =>
    (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((r) => r.name);
  for (const t of ['tpl_functions', 'mcp_servers']) {
    if (cols(t).includes('inventory_note')) {
      if (!cols(t).includes('inventory_prompt')) {
        db.exec(`ALTER TABLE ${t} RENAME COLUMN inventory_note TO inventory_prompt`);
      } else {
        db.exec(`UPDATE ${t} SET inventory_prompt = inventory_note WHERE inventory_prompt IS NULL OR inventory_prompt = ''`);
        db.exec(`ALTER TABLE ${t} DROP COLUMN inventory_note`);
      }
    }
  }
}

const additions: Array<[string, string, string]> = [
  ['mcp_servers', 'transport', "TEXT NOT NULL DEFAULT 'http'"],
  ['mcp_servers', 'command', 'TEXT'],
  ['mcp_servers', 'args', 'TEXT'],
  ['mcp_servers', 'env', 'TEXT'],
  ['mcp_servers', 'npm_spec', 'TEXT'],
  ['actions', 'function_ref', 'TEXT'],
  ['actions', 'function_args', 'TEXT'],
  ['tpl_functions', 'parameters', 'TEXT'],
  ['tpl_functions', 'budget', 'INTEGER'],
  ['tpl_functions', 'inventory_prompt', 'TEXT'],
  ['mcp_servers', 'inventory_prompt', 'TEXT'],
  ['mcp_servers', 'side_effect', "TEXT NOT NULL DEFAULT 'write'"],
  ['tpl_functions', 'side_effect', "TEXT NOT NULL DEFAULT 'write'"],
  ['logs', 'prompt_tokens', 'INTEGER'],
  ['logs', 'completion_tokens', 'INTEGER'],
  ['logs', 'llm_model', 'TEXT'],
];
for (const [table, column, definition] of additions) {
  addColumnIfMissing(db, table, column, definition);
}

}

// Migration 2 (Daten/Prompts): idempotente Reparaturen an Bestandsdaten, die
// einmalige Legacy-Bereinigung und die Referenz-Settings.
function applyRepairs(db: Database.Database): void {

// (Die frueheren Inline-Seed-Bloecke fuer agent_system/agent_inventory sind
// entfernt - eine Quelle: SEED_AGENT_SYSTEM/SEED_AGENT_INVENTORY in seeds.ts.
// Die alten Texte trugen veraltete Tool-Namen und wuerden nur bei Leer-Daten-
// bank greifen, die Referenz-Seed nie sehen kann.)

// Tote Settings entfernen: warteton (steuert die Lambda via env vars),
// fastpath_model (News-Fastpath entfernt), fuel_sensor (Benzinpreis ueber Inventory),
// facade_mode (Tool-Angebot immer Facade + aktivierte MCP-Server; Feinsteuerung
// ueber die erlaubten Tools je Vorgang).
db.prepare("DELETE FROM settings WHERE key IN ('warteton', 'fastpath_model', 'fuel_sensor', 'facade_mode', 'tool_budgets')").run();

// Legacy-Bereinigung (v0.2.0) entfernt: instanzspezifische Daten und
// Prompt-Texte gehoeren nicht in den oeffentlichen Migrationscode.

// Bestands-DBs (22.09.): die frueher im Code hartcodierten HA-Domain-Hints in
// die entity_index-Konfiguration uebernehmen - der Code-Default ist jetzt
// systemneutral (kein Tool, keine Domains). Nur wenn eine HA-Index-Konfiguration
// ohne eigene domainHints existiert; eigene Hints bleiben unangetastet.
{
  const row = db.prepare("SELECT value FROM settings WHERE key = 'entity_index'").get() as { value?: string } | undefined;
  if (row?.value) {
    try {
      const cfg = JSON.parse(row.value) as { tool?: string; domainHints?: unknown };
      if (cfg.tool === 'ha_eval_template' && !cfg.domainHints) {
        cfg.domainHints = [
          { re: 'temperatur|warm|kalt|grad', domains: ['sensor', 'climate', 'weather'] },
          { re: 'feucht', domains: ['sensor'] },
          { re: 'verbrauch|leistung|energie|strom|kwh|watt', domains: ['sensor'] },
          { re: 'fullstand|zisterne|tank', domains: ['sensor'] },
          { re: 'licht|lampe|leuchte', domains: ['light'] },
          { re: 'steckdose|schalter', domains: ['switch', 'light'] },
          { re: 'rolladen|raffstore|jalousie', domains: ['cover'] },
          { re: 'thermostat|heizung|heizen', domains: ['climate'] },
          { re: 'lautsta|musik|radio|sprecher', domains: ['media_player'] },
        ];
        db.prepare("UPDATE settings SET value = ? WHERE key = 'entity_index'").run(JSON.stringify(cfg));
      }
    } catch {
      // ungueltiges Setting: loadConfig nutzt dann den generischen Default
    }
  }
}
// Toter Prompt-Key: fastpath_system gehoerte zum entfernten News-Fastpath.
db.prepare("DELETE FROM prompts WHERE key = 'fastpath_system'").run();

// Inline-Templates -> Funktionen: Bestehende Vorgangs-Templates in die
// Funktionen-Registry ueberfuehren (Funktion ist seither Pflicht fuer
// deterministic/hybrid). Existiert bereits eine Funktion mit dem Namen,
// wird sie wiederverwendet.
{
  const rows = db
    .prepare(
      "SELECT id, name, template FROM actions WHERE template IS NOT NULL AND template != '' AND (function_ref IS NULL OR function_ref = '')"
    )
    .all() as { id: number; name: string; template: string }[];
  for (const r of rows) {
    const fname = r.name.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '');
    const existing = db.prepare('SELECT id FROM tpl_functions WHERE name = ?').get(fname);
    if (!existing) {
      db.prepare('INSERT INTO tpl_functions (name, description, template, enabled) VALUES (?, ?, ?, 1)').run(
        fname,
        `Aus Vorgang "${r.name}" migriert`,
        r.template
      );
    }
    db.prepare("UPDATE actions SET function_ref = ?, template = NULL, updated_at = datetime('now') WHERE id = ?").run(fname, r.id);
  }
}


// Umbenennung der frueheren HA-praefigierten Lesetools (Funktion + Referenzen).
// Alte Row gewinnt (kann User-Aenderungen tragen): frisches Seed-Duplikat
// entfernen, dann umbenennen.
{
  const renames: [string, string][] = [['ha_find', 'find_entities'], ['ha_get', 'get_entity']];
  for (const [alt, neu] of renames) {
    const oldRow = db.prepare('SELECT 1 FROM tpl_functions WHERE name = ?').get(alt);
    if (!oldRow) continue;
    db.prepare('DELETE FROM tpl_functions WHERE name = ? AND name != ?').run(neu, alt);
    db.prepare('UPDATE tpl_functions SET name = ? WHERE name = ?').run(neu, alt);
    db.prepare('UPDATE actions SET function_ref = ? WHERE function_ref = ?').run(neu, alt);
  }
  for (const key of ['agent_system', 'agent_inventory']) {
    const row = db.prepare('SELECT content FROM prompts WHERE key = ?').get(key) as { content?: string } | undefined;
    if (row?.content && (row.content.includes('fn_ha_find') || row.content.includes('fn_ha_get'))) {
      const neu = row.content
        .replaceAll('fn_ha_find', 'fn_find_entities')
        .replaceAll('fn_ha_get', 'fn_get_entity');
      db.prepare('UPDATE prompts SET content = ?, updated_at = datetime(\'now\') WHERE key = ?').run(neu, key);
    }
  }
}

// Basis-Werkzeuge (Variante A, 22.09.): fn_find_entities/fn_get_entity leben
// fest im Gateway-Code (core/indexTools.ts) - keine DB-Zeilen mehr. Alt-Zeilen
// der Index-Basis-Fns aufraeumen; eigene Fn-Definitionen mit gleichem Namen
// und ANDEREM Template bleiben (die Built-Ins gewinnen im Tool-Bau).
for (const basisName of ['find_entities', 'get_entity']) {
  const basisRow = db.prepare('SELECT template FROM tpl_functions WHERE name = ?').get(basisName) as { template: string } | undefined;
  if (basisRow && (basisRow.template.includes('index.find') || basisRow.template.includes('index.get'))) {
    db.prepare('DELETE FROM tpl_functions WHERE name = ?').run(basisName);
  }
}

// Prompt-Migration: alte Facade-Lesetools -> parameterisierte Funktions-Tools.
{
  const sys = db.prepare("SELECT content FROM prompts WHERE key = 'agent_system'").get() as { content?: string } | undefined;
  if (sys?.content && sys.content.includes('find_ha_entities')) {
    const neu = sys.content
      .replaceAll('find_ha_entities', 'fn_find_entities')
      .replaceAll('get_ha_state', 'fn_get_entity');
    db.prepare("UPDATE prompts SET content = ?, updated_at = datetime('now') WHERE key = 'agent_system'").run(neu);
  }
  const inv = db.prepare("SELECT content FROM prompts WHERE key = 'agent_inventory'").get() as { content?: string } | undefined;
  if (inv?.content && inv.content.includes('find_ha_entities')) {
    const neu = inv.content
      .replaceAll('find_ha_entities', 'fn_find_entities')
      .replaceAll('get_ha_state', 'fn_get_entity');
    db.prepare("UPDATE prompts SET content = ?, updated_at = datetime('now') WHERE key = 'agent_inventory'").run(neu);
  }
}
for (const [key, value] of SEED_SETTINGS) {
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(key, value);
}
// News als deterministischer Fastpath entfernt (Konzept: Nachrichten/Fragen -> Agent).
// Bestehende Action-Datei ebenfalls aufraeumen.
db.prepare("DELETE FROM actions WHERE name = 'news_summary'").run();
// Migriere bestehende agent_system-Prompts: Nur den alten Blocker-Satz ersetzen
// (Kombinations-Antworten aufheben), sonst User-Anpassungen unangetastet lassen.
{
  const oldRule = 'kein weiteres Tool.';
  const row = db.prepare("SELECT content FROM prompts WHERE key = 'agent_system'").get() as { content?: string } | undefined;
  if (row?.content && row.content.includes(oldRule)) {
    const newRule =
      'Kombinierte Anfragen (z. B. "Nachrichten und dann der Hausstatus"): DER REIHHE NACH abarbeiten.';
    db.prepare("UPDATE prompts SET content = ?, updated_at = datetime('now') WHERE key = 'agent_system'").run(
      row.content.replace(oldRule, newRule)
    );
  }
}
// Bestands-DBs (22.09.): Systembezug aus der agent_system-Kopfzeile entfernen -
// der Seed ist systemneutral, die Bindung kommt aus den konfigurierten Tools.
{
  const row = db.prepare("SELECT content FROM prompts WHERE key = 'agent_system'").get() as { content?: string } | undefined;
  if (row?.content && row.content.includes('Sprachassistent für Home Assistant über Alexa')) {
    db.prepare("UPDATE prompts SET content = ?, updated_at = datetime('now') WHERE key = 'agent_system'").run(
      row.content.replace('Sprachassistent für Home Assistant über Alexa', 'Sprachassistent über Alexa')
    );
  }
}
// Bestands-DBs: Fakten-Regel schaerfen. Die alte Formulierung liess
// "Allgemeine Erklaerungsfragen" als Ausnahme zu breit zu, sodass veraenderliche
// Fakten (z. B. Amtsinhaber) aus Trainingswissen beantwortet wurden. Nur den
// alten Satz ersetzen, sonst Nutzer-Anpassungen unangetastet lassen.
{
  const oldTail = ' Allgemeine Erklärungsfragen (Alltagswissen, das sich nicht ändert): aus eigenem Wissen antworten, ohne Suche.';
  const newTail = '\n- Auch Fakten, die sich geändert haben können (Personen und Ämter, Orte, Preise, Produkte, Rekorde, Ereignisse, Nachrichten): vorher per Such-/Recherche-Tool prüfen und NIE aus Trainingswissen antworten. Nur zeitlose Erklärungen und Definitionen (z. B. "warum ist der Himmel blau") gehören ins eigene Wissen.';
  const row = db.prepare("SELECT content FROM prompts WHERE key = 'agent_system'").get() as { content?: string } | undefined;
  if (row?.content && row.content.includes(oldTail)) {
    db.prepare("UPDATE prompts SET content = ?, updated_at = datetime('now') WHERE key = 'agent_system'").run(
      row.content.replace(oldTail, newTail)
    );
  }
}
// Bestands-DBs: Tool-Ergebnisse als alleinige Faktenquelle verankern. Die alte
// Prompt-Fassung liess dem Modell zu viel Raum, vorhandene Suchtreffer zu
// ignorieren und aus Trainingswissen zu antworten.
{
  const anchor = 'gehören ins eigene Wissen.';
  const addition = '\n- Liegen Tool-Ergebnisse vor, sind SIE die einzige Faktenquelle: übernimm Namen, Zahlen und Aussagen daraus wörtlich, auch wenn sie deinem eigenen Wissen widersprechen. Ersetze einen Treffer niemals durch etwas aus dem Gedächtnis.';
  const row = db.prepare("SELECT content FROM prompts WHERE key = 'agent_system'").get() as { content?: string } | undefined;
  if (row?.content && row.content.includes(anchor) && !row.content.includes('einzige Faktenquelle')) {
    db.prepare("UPDATE prompts SET content = ?, updated_at = datetime('now') WHERE key = 'agent_system'").run(
      row.content.replace(anchor, anchor + addition)
    );
  }
}
// Bestands-DBs (22.09.): die Hilfe-Action braucht den {agent_inventory}-Marker,
// sonst wird das Nachschlagewerk nicht in den Prompt eingefuegt und sie kann
// keine Faehigkeiten auflisten. Marker ergaenzen, falls er fehlt.
{
  const row = db.prepare("SELECT system_prompt FROM actions WHERE name = 'hilfe'").get() as { system_prompt?: string } | undefined;
  if (row?.system_prompt && !row.system_prompt.includes('{agent_inventory}')) {
    db.prepare("UPDATE actions SET system_prompt = ?, updated_at = datetime('now') WHERE name = 'hilfe'").run(
      `${row.system_prompt}\n\n{agent_inventory}`
    );
  }
}
// Bestands-DBs: die Hilfe soll auch die freie Unterhaltung nennen (einzelne
// Frage ohne Kommando bzw. laufender Dialog per "starte chat modus"). Nur echte
// Seed-Prompts (Marker "Hilfe-Anfrage") ergaenzen, eigene Nutzer-Texte bleiben
// unangetastet. Einen evtl. vorhandenen alten Hinweis ersetzen.
{
  const row = db.prepare("SELECT system_prompt FROM actions WHERE name = 'hilfe'").get() as { system_prompt?: string } | undefined;
  const sp = row?.system_prompt;
  if (sp && sp.includes('Hilfe-Anfrage') && !sp.includes('starte chat modus')) {
    const hint = 'Erwaehne zusaetzlich die freie Unterhaltung: einzelne freie Fragen ohne Kommando ("frage smart pilot warum ist der himmel blau") sowie den Chat-Modus fuer ein laufendes Gespraech - Start mit "starte chat modus", Ende mit "chat beenden". ';
    const base = sp.replace(/Erwaehne zusaetzlich die freie Unterhaltung:.*?chat beenden"\)\.\s*/s, '');
    const neu = base.includes('Am Ende von speech')
      ? base.replace('Am Ende von speech', hint + 'Am Ende von speech')
      : `${base.trim()}\n\n${hint.trim()}`;
    db.prepare("UPDATE actions SET system_prompt = ?, updated_at = datetime('now') WHERE name = 'hilfe'").run(neu);
  }
}
// Bestands-DBs: den Hilfe-Hauptsatz haerten (kein Erfinden von Faehigkeiten).
// Nur die alte Seed-Formulierung ersetzen - Nutzer-Anpassungen bleiben erhalten
// (kein Voll-Ersetzen des Prompts).
{
  const row = db.prepare("SELECT system_prompt FROM actions WHERE name = 'hilfe'").get() as { system_prompt?: string } | undefined;
  const sp = row?.system_prompt;
  const alt = 'Beantworte das NUR aus dem Tool-Inventory (Nachschlagewerk unten) - KEINE Tool-Aufrufe.';
  const neu = 'Beantworte das NUR aus dem Nachschlagewerk unten - KEINE Tool-Aufrufe. Erfinde NIE Faehigkeiten, die dort nicht stehen.';
  if (sp && sp.includes(alt)) {
    db.prepare("UPDATE actions SET system_prompt = ?, updated_at = datetime('now') WHERE name = 'hilfe'").run(sp.replace(alt, neu));
  }
}
// (Die Referenz-Defaults der Settings werden weiter unten ueber SEED_SETTINGS
// gesetzt - einzeln geseedete Settings gab es nur in frueheren Stadien.)


}

// Migration 3/4: package_items-Hashes rebasen. Version 3 hebt auf die ab v0.3.0
// erweiterte Server-Feldform (inkl. npm_spec); Version 4 zieht zusaetzlich die
// args-Normalisierung ("[]" == null) nach. Nur wenn die Zeile nachweislich
// unveraendert ist (Alt-Form-Hash == gespeicherter Hash), wird der Hash
// fortgeschrieben - sonst bleibt eine echte lokale Aenderung als Konflikt erhalten.
function applyHashRebase(db: Database.Database): void {
  const items = db
    .prepare("SELECT package_id, name, content_hash FROM package_items WHERE kind = 'server'")
    .all() as { package_id: string; name: string; content_hash: string }[];
  for (const it of items) {
    const row = db.prepare('SELECT * FROM mcp_servers WHERE name = ?').get(it.name) as ServerHashRow | undefined;
    if (!row) continue;
    const oldHash = hashContent('server', it.name, serverContentOld(row));
    if (oldHash !== it.content_hash) continue; // echte lokale Aenderung: nicht anfassen
    const newHash = hashContent('server', it.name, serverContentNew(row));
    if (newHash === it.content_hash) continue;
    db.prepare("UPDATE package_items SET content_hash = ? WHERE package_id = ? AND kind = 'server' AND name = ?").run(
      newHash,
      it.package_id,
      it.name
    );
  }
}

// Zusaetzliche HTTP-Header fuer MCP-Server: Bestands-DBs nachziehen
// (Migration 1 legt die Spalte bei Neuinstallationen nicht mehr an).
function applyMcpHeaders(db: Database.Database): void {
  const cols = (db.prepare('PRAGMA table_info(mcp_servers)').all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('headers')) db.exec('ALTER TABLE mcp_servers ADD COLUMN headers TEXT');
}

// Persistiertes Paket-Manifest: erlaubt die Konfigurationsansicht auch ohne
// Registry-Zugriff. Bestands-DBs bekommen die Spalte nachgezogen.
function applyPackageManifest(db: Database.Database): void {
  addColumnIfMissing(db, 'packages', 'manifest', 'TEXT');
}

// Issue #4: Vorgangs-Sicherheit. side_effect/confirm sind deklarative
// Attribute; die Defaults (write/0) erhalten das bisherige Verhalten.
// Die geseedete Hilfe liest nur den Katalog und mutiert nichts.
function applyActionSecurity(db: Database.Database): void {
  addColumnIfMissing(db, 'actions', 'side_effect', "TEXT NOT NULL DEFAULT 'write' CHECK (side_effect IN ('read','write'))");
  addColumnIfMissing(db, 'actions', 'confirm', 'INTEGER NOT NULL DEFAULT 0');
  db.prepare("UPDATE actions SET side_effect = 'read' WHERE name = 'hilfe'").run();
}

// Issue #4 Stufe 3: optionale Parameter-Allowlist je Tool (JSON-Objekt
// Tool -> erlaubte Parameter-Keys). NULL = keine Einschraenkung.
function applyActionToolParams(db: Database.Database): void {
  addColumnIfMissing(db, 'actions', 'tool_params', 'TEXT');
}

// Header sind Teil des Server-Hashes geworden: bestehende, unveraenderte
// Items einmalig von der alten auf die neue Feldform umschreiben, damit
// installierte Pakete nicht als lokal geaendert gelten.
function applyHeadersHashRebase(db: Database.Database): void {
  const items = db
    .prepare("SELECT package_id, name, content_hash FROM package_items WHERE kind = 'server'")
    .all() as { package_id: string; name: string; content_hash: string }[];
  for (const it of items) {
    const row = db.prepare('SELECT * FROM mcp_servers WHERE name = ?').get(it.name) as ServerHashRow | undefined;
    if (!row) continue;
    if (hashContent('server', it.name, serverContentV6(row)) !== it.content_hash) continue; // echte lokale Aenderung
    const newHash = hashContent('server', it.name, serverContentNew(row));
    if (newHash === it.content_hash) continue;
    db.prepare("UPDATE package_items SET content_hash = ? WHERE package_id = ? AND kind = 'server' AND name = ?").run(
      newHash,
      it.package_id,
      it.name
    );
  }
}

const MIGRATIONS: Migration[] = [
  { version: 1, name: 'base-schema', up: applySchema },
  { version: 2, name: 'data-repairs', up: applyRepairs },
  { version: 3, name: 'rebase-package-item-hashes', up: applyHashRebase },
  { version: 4, name: 'rebase-package-item-hashes-args', up: applyHashRebase },
  { version: 5, name: 'mcp-server-headers', up: applyMcpHeaders },
  { version: 6, name: 'package-manifest', up: applyPackageManifest },
  { version: 7, name: 'rebase-package-item-hashes-headers', up: applyHeadersHashRebase },
  { version: 8, name: 'action-security', up: applyActionSecurity },
  { version: 9, name: 'action-tool-params', up: applyActionToolParams },
];

// Aktuelle Zielversion (letzter Migrationsschritt). Tests und Aufrufer sollen
// nicht die konkrete Zahl hartcodieren.
export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

export function getDb(): Database.Database {
  if (!_db) throw new Error('DB nicht initialisiert - initDb(path) zuerst rufen');
  return _db;
}

// Aktuelle Schema-Version der geladenen DB (fuer /healthz und Admin-UI).
export function getSchemaVersion(): number {
  return getDb().pragma('user_version', { simple: true }) as number;
}
