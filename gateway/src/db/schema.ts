import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SEED_AGENT_SYSTEM, SEED_AGENT_INVENTORY, SEED_HELP_TRIGGERS, SEED_HELP_PROMPT } from './seeds.js';

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

// Referenz-Defaults der Grundeinstellungen (eine Quelle fuer Init-Seed,
// Frisch-Install-Fill und 'Defaults wiederherstellen' in der Web-UI).
export const SEED_SETTINGS: [string, string][] = [
  ['assistant_name', 'Dein SmartPilot'],
  ['fuzzy_global', '1'],
  ['session_followup', 'beides'],
  ['session_keywords', 'zusammenfassung,neuigkeiten,liste,bericht,news,tipps,hintergründe'],
  ['debug_logging', '0'],
  ['memory_turns', '4'],
  ['memory_minutes', '30'],
];

export function initDb(path: string, withReferenceSeed = false): void {
  if (_db) return;
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');

// Migrationen in einer Transaktion: ein Abbruch laesst kein halb migriertes
// Schema zurueck (F-26).
db.transaction(() => {
// Migration: actions um handler_config + search_summary-Mode erweitern (idempotent)
{
  const cols = (db.prepare('PRAGMA table_info(actions)').all() as { name: string }[]).map((c) => c.name);
  if (cols.length > 0 && !cols.includes('handler_config')) {
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
        tools TEXT,
        handler_config TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO actions_new (id, name, mode, trigger_phrases, fuzzy_threshold, system_prompt, template, tools, enabled, created_at, updated_at)
        SELECT id, name, mode, trigger_phrases, fuzzy_threshold, system_prompt, template, tools, enabled, created_at, updated_at FROM actions WHERE mode != 'search_summary';
      DROP TABLE actions;
      ALTER TABLE actions_new RENAME TO actions;
    `);
  }
}

// Migration: mode-Check-Constraint erneuern, damit search_summary entfaellt (idempotent)
{
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
        tools TEXT,
        handler_config TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO actions_new (id, name, mode, trigger_phrases, fuzzy_threshold, system_prompt, template, tools, handler_config, enabled, created_at, updated_at)
        SELECT id, name, mode, trigger_phrases, fuzzy_threshold, system_prompt, template, tools, handler_config, enabled, created_at, updated_at FROM actions WHERE mode != 'search_summary';
      DROP TABLE actions;
      ALTER TABLE actions_new RENAME TO actions;
    `);
  }
}
})();

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
    tools TEXT,
    handler_config TEXT,
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

for (const stmt of [
  "ALTER TABLE mcp_servers ADD COLUMN transport TEXT NOT NULL DEFAULT 'http'",
  'ALTER TABLE mcp_servers ADD COLUMN command TEXT',
  'ALTER TABLE mcp_servers ADD COLUMN args TEXT',
  'ALTER TABLE mcp_servers ADD COLUMN env TEXT',
  'ALTER TABLE actions ADD COLUMN function_ref TEXT',
  'ALTER TABLE actions ADD COLUMN function_args TEXT',
  'ALTER TABLE tpl_functions ADD COLUMN parameters TEXT',
  'ALTER TABLE tpl_functions ADD COLUMN budget INTEGER',
  'ALTER TABLE tpl_functions ADD COLUMN inventory_prompt TEXT',
  'ALTER TABLE mcp_servers ADD COLUMN inventory_prompt TEXT',
  "ALTER TABLE mcp_servers ADD COLUMN side_effect TEXT NOT NULL DEFAULT 'write'",
  "ALTER TABLE tpl_functions ADD COLUMN side_effect TEXT NOT NULL DEFAULT 'write'",
]) {
  try {
    db.exec(stmt);
  } catch {
    // Spalte existiert bereits
  }
}

for (const stmt of [
  'ALTER TABLE logs ADD COLUMN prompt_tokens INTEGER',
  'ALTER TABLE logs ADD COLUMN completion_tokens INTEGER',
  'ALTER TABLE logs ADD COLUMN llm_model TEXT',
]) {
  try {
    db.exec(stmt);
  } catch {
    // Spalte existiert bereits
  }
}

// Fresh-Install-Fill: die statischen Agent-Prompts und die generische Hilfe-
// Action. Domaenen-spezifisches (Systeme/MCP-Server, Funktionen, weitere
// Vorgaenge, Index-Quellen) wird bewusst NICHT geseedet - es gehoert in die
// aktive Konfiguration. INSERT OR IGNORE - bestehende Datenbanken (und
// User-Edits) bleiben unangetastet.
if (withReferenceSeed) {
  db.prepare('INSERT OR IGNORE INTO prompts (key, content) VALUES (?, ?)').run('agent_system', SEED_AGENT_SYSTEM);
  db.prepare('INSERT OR IGNORE INTO prompts (key, content) VALUES (?, ?)').run('agent_inventory', SEED_AGENT_INVENTORY);
  db.prepare(
    `INSERT OR IGNORE INTO actions (name, mode, trigger_phrases, fuzzy_threshold, system_prompt, template, function_ref, function_args, tools, enabled)
     VALUES ('hilfe', 'llm', ?, 0.85, ?, NULL, NULL, NULL, '[]', 1)`
  ).run(SEED_HELP_TRIGGERS, SEED_HELP_PROMPT);
}

// (Die frueheren Inline-Seed-Bloecke fuer agent_system/agent_inventory sind
// entfernt - eine Quelle: SEED_AGENT_SYSTEM/SEED_AGENT_INVENTORY in seeds.ts.
// Die alten Texte trugen veraltete Tool-Namen und wuerden nur bei Leer-Daten-
// bank greifen, die Referenz-Seed nie sehen kann.)

// Tote Settings entfernen: warteton (steuert die Lambda via env vars),
// fastpath_model (News-Fastpath entfernt), fuel_sensor (Benzinpreis ueber Inventory),
// facade_mode (Tool-Angebot immer Facade + aktivierte MCP-Server; Feinsteuerung
// ueber die erlaubten Tools je Vorgang).
db.prepare("DELETE FROM settings WHERE key IN ('warteton', 'fastpath_model', 'fuel_sensor', 'facade_mode', 'tool_budgets')").run();

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
// (Die Referenz-Defaults der Settings werden weiter unten ueber SEED_SETTINGS
// gesetzt - einzeln geseedete Settings gab es nur in frueheren Stadien.)

// Facade-Abbau: agent_system + agent_inventory auf rohe MCP-Tools und
// dynamische Funktions-Tools (fn_*) umschreiben - nur falls noch alter Text
// mit den entfernten Facade-Tools drinsteht.
{
  const sys = db.prepare("SELECT content FROM prompts WHERE key = 'agent_system'").get() as { content?: string } | undefined;
  if (sys?.content && sys.content.includes('control_device')) {
    const neu = `Du bist {assistant_name}, ein deutscher Sprachassistent für Home Assistant über Alexa.
Identität: Du bist {assistant_name} - wenn du gefragt wirst, wer du bist oder wie du heisst, sage WOERTLICH: "Ich bin {assistant_name}".
Deine FINALE Antwort (sobald keine Tool-Aufrufe mehr nötig) ist AUSSCHLIESSLICH ein JSON-Objekt: {"needs_clarification": <true|false>, "speech": "<Antwort>", "keep_open": <true|false>}.
Die speech ist kurz, präzise und sprechbar (keine Listen, Zahlen wie "22,4 Grad"). needs_clarification=true nur bei echter Mehrdeutigkeit.
Anreden am Anfang ("{assistant_name}", "Smart Pilot") sind kein Teil der Frage. "mehr dazu" bezieht sich auf das letzte Thema.

Tool-Regeln (sparsam: genug gewusst -> sofort antworten):
- Messwerte/Zustände (Temperatur, Füllstand, Verbrauch, an/aus): NIEMALS aus eigenem Wissen. find_ha_entities mit Stichworten - Treffer enthalten den aktuellen Zustand, daraus sofort antworten (max. 1 Aufruf pro Frage).
- Schalten (Licht, Schalter, Rolladen, Klima): HassTurnOn / HassTurnOff mit name (z. B. "Stehlampe") oder area. Detail: Helligkeit/Farbtemperatur HassLightSet, Zieltemperatur HassClimateSetTemperature, Rolladenposition HassSetPosition.
- Hausstatus (Akku, Verbrauch, Solar, Benzin): fn_hausstatus_gw, Bericht sinngemäß wiedergeben.
- Benzinpreis (OneShot, z. B. "was kostet Super E10"): get_ha_state mit entity_id "sensor.nordoel_sieker_landstrasse_178_super_e10".
- Nachrichten/Suche: searxng_web_search (language "de", num_results 5; time_range "week" bei Nachrichten; bei konkreter Quelle direkt darauf zielen). web_url_read ausschliesslich wenn der Nutzer eine konkrete Seite/URL nennt.
- Kombinierte Anfragen (z. B. "Nachrichten und dann der Hausstatus"): DER REIHENFOLGE NACH abarbeiten - fuer den zweiten Teil weitere Tool-Aufrufe erlaubt.
- Mehrteilige Antworten (Nachrichten, Listen, mehrere Themen): Trenne logische Teile mit Zeilenumbruechen (\\n\\n) zwischen den Teilen.`;
    db.prepare("UPDATE prompts SET content = ?, updated_at = datetime('now') WHERE key = 'agent_system'").run(neu);
  }
  const inv = db.prepare("SELECT content FROM prompts WHERE key = 'agent_inventory'").get() as { content?: string } | undefined;
  if (inv?.content && inv.content.includes('control_device')) {
    const neu = `Nimm dieses Nachschlagewerk als Pflicht-Referenz, bevor du ein Tool aufrufst:

- Hauswerte lesen (Temperatur, Verbrauch, Füllstand, Status): find_ha_entities mit Stichworten - Treffer enthalten den aktuellen Zustand, sofort antworten. Konkrete entity_id: get_ha_state.
- Schalten (Licht, Schalter, Rolladen, Klima): HassTurnOn / HassTurnOff mit name (z. B. "Stehlampe") oder area. Detail: HassLightSet (Helligkeit/Farbtemperatur), HassClimateSetTemperature (Thermostat), HassSetPosition (Rolladen).
- Hausstatus (Akkustand, Verbrauch, Solar, Benzin): fn_hausstatus_gw (fertiger Bericht, keinen eigenen Bericht bauen).
- Benzinpreis (OneShot, z. B. "was kostet Super E10", "sollte ich jetzt tanken"): get_ha_state auf entity_id "sensor.nordoel_sieker_landstrasse_178_super_e10".
- Boersen-/Finanznachrichten (onvista, boerse.de, finanzen.net): searxng_web_search gezielt auf die Quelle (z. B. "onvista news").
- Allgemeine Nachrichten/Recherche: searxng_web_search (time_range "week"), aus Snippets mit Quelle antworten.
- Konkrete Seite/URL lesen: web_url_read (nur auf ausdruecklichen Wunsch).

Kombinationen (z. B. "News und dann Hausstatus"): jeder Teil nutzt das jeweils zustaendige Tool - der Reihenfolge nach, nicht abbrechen.`;
    db.prepare("UPDATE prompts SET content = ?, updated_at = datetime('now') WHERE key = 'agent_inventory'").run(neu);
  }
}

  _db = db;
}

export function getDb(): Database.Database {
  if (!_db) throw new Error('DB nicht initialisiert - initDb(path) zuerst rufen');
  return _db;
}
