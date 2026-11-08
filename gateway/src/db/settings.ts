import { getDb, SEED_SETTINGS } from './schema.js';

// Settings, die ein Geheimnis tragen. Sie werden in Admin-Antworten maskiert
// und im Backup nur mit tokens=1 exportiert.
export const SECRET_SETTING_KEYS = new Set(['http_headers']);
export const MASKED_SETTING = '(gesetzt)';

export function getSettings(): Record<string, string> {
  const rows = getDb().prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export function deleteSetting(key: string): void {
  getDb().prepare('DELETE FROM settings WHERE key = ?').run(key);
}

/** Admin-Ansicht: Geheim-Settings nur als gesetzt/nicht gesetzt. */
export function maskSettings(settings: Record<string, string>): Record<string, string> {
  const out = { ...settings };
  for (const key of SECRET_SETTING_KEYS) if (out[key]) out[key] = MASKED_SETTING;
  return out;
}

/** Zusatzinfo fuer die UI: gesetzt, auch wenn der Wert maskiert ist. */
export function secretSettingFlags(settings: Record<string, string>): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const key of SECRET_SETTING_KEYS) out[key] = !!settings[key];
  return out;
}

/** Backup ohne tokens=1: Geheim-Settings weglassen statt maskiert speichern. */
export function stripSecretSettings(settings: Record<string, string>): Record<string, string | null> {
  const out: Record<string, string | null> = { ...settings };
  for (const key of SECRET_SETTING_KEYS) if (key in out) out[key] = null;
  return out;
}

export function getSetting(key: string): string | undefined {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

// Settings-Override mit Fallback: DB-Wert (Web-UI) gewinnt, Code/.env liefert
// den Default. Leerer String zaehlt als "nicht gesetzt".
export function getSettingNum(key: string, fallback: number): number {
  const v = getSetting(key);
  if (v == null || v.trim() === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function setSetting(key: string, value: string): void {
  getDb()
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

// Alle Settings auf Referenz-Defaults (SEED_SETTINGS aus schema.ts)
// zuruecksetzen. Index-Konfiguration (entity_index*) bleibt unangetastet -
// sie wird in eigener UI gepflegt. Konfigurierte .env-/Code-Felder
// (llm_model etc.) fallen auf "leer = Default" zurueck.
export function restoreDefaultSettings(): void {
  const db = getDb();
  db.prepare("DELETE FROM settings WHERE key NOT LIKE 'entity_index%'").run();
  for (const [key, value] of SEED_SETTINGS) {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, value);
  }
}

export function getPrompt(key: string): string | undefined {
  const row = getDb().prepare('SELECT content FROM prompts WHERE key = ?').get(key) as
    | { content: string }
    | undefined;
  return row?.content;
}

export function setPrompt(key: string, content: string): void {
  getDb().prepare(
    'INSERT INTO prompts (key, content) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET content = excluded.content, updated_at = datetime(\'now\')'
  ).run(key, content);
}

export function listPrompts(): { key: string; content: string; updated_at: string }[] {
  return getDb().prepare('SELECT key, content, updated_at FROM prompts ORDER BY key').all() as {
    key: string;
    content: string;
    updated_at: string;
  }[];
}
